import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { PcmPlayer, pcm16Base64ToFloat32, pcmBytesToBase64 } from '../src/renderer/liveAudio';

function chunk(seconds: number, value = 16384) {
  const buffer = Buffer.alloc(Math.round(seconds * 24000) * 2);
  for (let i = 0; i < buffer.length; i += 2) buffer.writeInt16LE(value, i);
  return buffer.toString('base64');
}

class MockAudioContext {
  static instances: MockAudioContext[] = [];
  static startSuspended = false;
  currentTime = 0;
  state = MockAudioContext.startSuspended ? 'suspended' : 'running';
  destination = {};
  sources: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
    buffer: unknown;
  }[] = [];
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  constructor() {
    MockAudioContext.instances.push(this);
  }
  createBuffer(_channels: number, samples: number, rate: number) {
    return { duration: samples / rate, copyToChannel: vi.fn() };
  }
  createBufferSource() {
    const source = {
      start: vi.fn(),
      stop: vi.fn(),
      disconnect: vi.fn(),
      connect: vi.fn(),
      onended: null,
      buffer: null,
    };
    this.sources.push(source);
    return source;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  MockAudioContext.instances = [];
  MockAudioContext.startSuspended = false;
  vi.stubGlobal('AudioContext', MockAudioContext);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('live PCM playback', () => {
  it('decodes signed little-endian samples and rejects odd byte counts', () => {
    const bytes = Uint8Array.from([0, 128, 0, 0, 255, 127]);
    expect([...pcm16Base64ToFloat32(pcmBytesToBase64(bytes))]).toEqual([-1, 0, 32767 / 32768]);
    expect(() => pcm16Base64ToFloat32('AA==')).toThrow('Incomplete');
  });

  it('schedules chunks in order and reports speaking only when audible samples play', async () => {
    const onActivity = vi.fn();
    const player = new PcmPlayer({ onActivity });
    await Promise.all([player.push(chunk(0.1)), player.push(chunk(0.1, 0))]);
    const audio = MockAudioContext.instances[0];
    expect(audio.sources[0].start).toHaveBeenCalledWith(0.035);
    expect(audio.sources[1].start).toHaveBeenCalledWith(0.135);
    expect(onActivity).not.toHaveBeenCalled();
    audio.currentTime = 0.06;
    vi.advanceTimersByTime(25);
    expect(onActivity).toHaveBeenLastCalledWith(true);
    expect(player.playedMilliseconds).toBeCloseTo(25);
    audio.currentTime = 0.27;
    vi.advanceTimersByTime(25);
    expect(onActivity).toHaveBeenLastCalledWith(false);
    expect(player.playedMilliseconds).toBeCloseTo(200);
    await player.dispose();
  });

  it('does not animate for a continuous silent audio stream', async () => {
    const onActivity = vi.fn();
    const player = new PcmPlayer({ onActivity });
    for (let index = 0; index < 10; index++) {
      await player.push(chunk(0.04, 0));
      MockAudioContext.instances[0].currentTime += 0.04;
      vi.advanceTimersByTime(40);
    }
    expect(onActivity).not.toHaveBeenCalled();
    await player.dispose();
  });

  it('stops stale pending chunks before they can reach an audio device', async () => {
    const player = new PcmPlayer();
    const pending = player.push(chunk(0.1));
    player.stop();
    await pending;
    expect(MockAudioContext.instances).toHaveLength(0);
    await player.push(chunk(0.1));
    const source = MockAudioContext.instances[0].sources[0];
    player.stop();
    expect(source.stop).toHaveBeenCalledOnce();
    await player.dispose();
  });

  it('bounds queued audio instead of replaying an arbitrarily late backlog', async () => {
    const onError = vi.fn();
    const player = new PcmPlayer({ maxQueueSeconds: 1, onError });
    await player.push(chunk(0.6));
    await player.push(chunk(0.6));
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('fell behind'));
    expect(MockAudioContext.instances[0].sources[0].stop).toHaveBeenCalledOnce();
    await player.dispose();
  });
});

describe('live microphone worklet', () => {
  const script = readFileSync(
    new URL('../src/renderer/public/live-microphone-worklet.js', import.meta.url),
    'utf8',
  );
  function processor(rate: number) {
    const messages: { pcm: ArrayBuffer; level: number; at: number }[] = [];
    let Processor: any;
    const scope = {
      sampleRate: rate,
      currentTime: 0,
      AudioWorkletProcessor: class {
        port = {
          postMessage: (message: (typeof messages)[number]) => messages.push(message),
          onmessage: null,
        };
      },
      registerProcessor: (_name: string, value: unknown) => {
        Processor = value;
      },
    };
    runInNewContext(script, scope);
    return { processor: new Processor(), messages, scope };
  }

  it.each([16000, 24000, 44100, 48000])(
    'preserves duration across render quanta at %i Hz',
    (rate) => {
      const { processor: mic, messages, scope } = processor(rate);
      for (let offset = 0; offset < rate; offset += 128) {
        const input = new Float32Array(Math.min(128, rate - offset)).fill(0.5);
        scope.currentTime = offset / rate;
        mic.process([[input]], [[new Float32Array(input.length)]]);
      }
      expect(messages).toHaveLength(25);
      expect(messages.every((message) => message.pcm.byteLength === 1920)).toBe(true);
      expect(messages[0].level).toBeCloseTo(0.5);
      for (const message of messages) {
        const view = new DataView(message.pcm);
        expect(view.getInt16(0, true)).toBe(16384);
        expect(view.getInt16(1918, true)).toBe(16384);
      }
    },
  );

  it('streams silence without passing microphone audio to local speakers', () => {
    const { processor: mic, messages } = processor(48000);
    const output = new Float32Array(128);
    for (let i = 0; i < 15; i++) mic.process([], [[output]]);
    expect(messages).toHaveLength(1);
    expect(messages[0].level).toBe(0);
    expect([...new Uint8Array(messages[0].pcm)].every((v) => v === 0)).toBe(true);
    expect([...output].every((v) => v === 0)).toBe(true);
    mic.port.onmessage({ data: 'stop' });
    expect(mic.process([], [[output]])).toBe(false);
  });
});
