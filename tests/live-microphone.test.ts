import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const react = vi.hoisted(() => ({
  effects: [] as (() => (() => void) | undefined)[],
  effectDependencies: [] as unknown[][],
  stateChanges: [] as unknown[],
}));
vi.mock('react', () => ({
  useEffect: (effect: () => (() => void) | undefined, dependencies: unknown[]) => {
    react.effects.push(effect);
    react.effectDependencies.push(dependencies);
  },
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => {
    let current = initial;
    return [
      current,
      (value: unknown) => {
        current = typeof value === 'function' ? value(current) : value;
        react.stateChanges.push(current);
      },
    ];
  },
}));
import { useLiveMicrophone, type LiveMicrophoneOptions } from '../src/renderer/useLiveMicrophone';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const track = { label: 'Blue Snowball', stop: vi.fn(), onended: null as null | (() => void) };
const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
let getUserMedia: ReturnType<typeof vi.fn>;
let loadWorklet: ReturnType<typeof vi.fn>;
let resumeContext: ReturnType<typeof vi.fn>;
let closeContext: ReturnType<typeof vi.fn>;
let microphoneNode: any;
let audioContext: any;

beforeEach(() => {
  vi.useFakeTimers();
  react.effects.length = 0;
  react.effectDependencies.length = 0;
  react.stateChanges.length = 0;
  track.stop.mockClear();
  track.onended = null;
  getUserMedia = vi.fn(async () => stream);
  loadWorklet = vi.fn(async () => {});
  resumeContext = vi.fn(async () => {});
  closeContext = vi.fn(async () => {});
  microphoneNode = null;
  audioContext = null;
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('window', { location: { href: 'file:///app/out/renderer/index.html' } });
  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'running';
      currentTime = 0;
      audioWorklet = { addModule: loadWorklet };
      destination = {};
      close = closeContext;
      resume = resumeContext;
      constructor() {
        audioContext = this;
      }
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
    },
  );
  vi.stubGlobal(
    'AudioWorkletNode',
    class {
      port = { onmessage: null, postMessage: vi.fn(), close: vi.fn() };
      connect = vi.fn();
      disconnect = vi.fn();
      constructor() {
        microphoneNode = this;
      }
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
function start(options: Partial<LiveMicrophoneOptions> = {}) {
  const onError = vi.fn(),
    onChunk = vi.fn();
  const effectIndex = react.effects.length;
  useLiveMicrophone({ enabled: true, onError, onChunk, ...options });
  const cleanup = react.effects[effectIndex]() ?? (() => {});
  return { cleanup, onError, onChunk };
}

describe('live microphone startup lifecycle', () => {
  it('times out a permission request and stops a stream granted after cancellation', async () => {
    const permission = deferred<typeof stream>();
    getUserMedia.mockReturnValue(permission.promise);
    const { onError, cleanup } = start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('permission prompt'));
    permission.resolve(stream);
    await settle();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(audioContext).toBeNull();
    cleanup();
  });

  it('cancels a pending permission request without a late error or audio stream', async () => {
    const permission = deferred<typeof stream>();
    getUserMedia.mockReturnValue(permission.promise);
    const { onError, cleanup } = start();
    await settle();
    cleanup();
    await vi.advanceTimersByTimeAsync(20_000);
    permission.resolve(stream);
    await settle();
    expect(onError).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(audioContext).toBeNull();
  });

  it('waits for native permission before opening browser capture', async () => {
    const permission = deferred<{ allowed: boolean; status: string }>();
    const prepareMicrophone = vi.fn(() => permission.promise);
    (window as any).couchkin = { prepareMicrophone };
    const { cleanup } = start();
    expect(prepareMicrophone).toHaveBeenCalledOnce();
    expect(getUserMedia).not.toHaveBeenCalled();
    permission.resolve({ allowed: true, status: 'granted' });
    await settle();
    expect(getUserMedia).toHaveBeenCalledOnce();
    cleanup();
  });

  it('reports denied native permission without opening browser capture', async () => {
    (window as any).couchkin = {
      prepareMicrophone: vi.fn(async () => ({ allowed: false, status: 'denied' })),
    };
    const { onError, cleanup } = start();
    await settle();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('access is denied'));
    expect(getUserMedia).not.toHaveBeenCalled();
    cleanup();
  });

  it('does not open browser capture after native permission resolves beyond the deadline', async () => {
    const permission = deferred<{ allowed: boolean; status: string }>();
    (window as any).couchkin = { prepareMicrophone: vi.fn(() => permission.promise) };
    const { onError, cleanup } = start();
    await vi.advanceTimersByTimeAsync(20_000);
    permission.resolve({ allowed: true, status: 'granted' });
    await settle();
    expect(onError).toHaveBeenCalledOnce();
    expect(getUserMedia).not.toHaveBeenCalled();
    cleanup();
  });

  it('identifies a stalled worklet and releases the opened microphone', async () => {
    loadWorklet.mockReturnValue(new Promise(() => {}));
    const { onError, cleanup } = start();
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('processor did not load'));
    expect(track.stop).toHaveBeenCalledOnce();
    expect(closeContext).toHaveBeenCalledOnce();
    cleanup();
  });

  it('identifies a suspended audio device separately from permission', async () => {
    resumeContext.mockReturnValue(new Promise(() => {}));
    const { onError, cleanup } = start();
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('audio device did not start'));
    expect(microphoneNode.disconnect).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    cleanup();
  });

  it('waits for actual PCM frames and identifies a silent startup failure', async () => {
    const { onError, cleanup } = start();
    await settle();
    expect(react.stateChanges).not.toContain('listening');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('no audio frames arrived'));
    cleanup();
  });

  it('clears the deadline when first PCM arrives, including a valid silent frame', async () => {
    const { onError, onChunk, cleanup } = start();
    await settle();
    microphoneNode.port.onmessage({ data: { pcm: new ArrayBuffer(1920), level: 0, at: 0 } });
    expect(react.stateChanges).toContain('listening');
    expect(onChunk).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onError).not.toHaveBeenCalled();
    cleanup();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(closeContext).toHaveBeenCalledOnce();
  });
});

describe('live microphone input selection', () => {
  it('requires the selected input and reports the actual captured track label', async () => {
    const { cleanup } = start({ deviceId: 'snowball-device' });
    await settle();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        deviceId: { exact: 'snowball-device' },
      },
      video: false,
    });
    expect(react.stateChanges).toContain('Blue Snowball');
    expect(react.effectDependencies[0]).toContain('snowball-device');
    cleanup();
  });

  it.each([undefined, '', 'default'])(
    'uses the system default for selection %s',
    async (deviceId) => {
      const { cleanup } = start({ deviceId });
      await settle();
      expect(getUserMedia.mock.calls[0][0].audio.deviceId).toBeUndefined();
      cleanup();
    },
  );

  it('never requests permission or capture when changing a disabled input', async () => {
    const prepareMicrophone = vi.fn();
    (window as any).couchkin = { prepareMicrophone };
    start({ enabled: false, deviceId: 'old-device' });
    start({ enabled: false, deviceId: 'snowball-device' });
    await settle();
    expect(prepareMicrophone).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(audioContext).toBeNull();
  });

  it.each(['NotFoundError', 'OverconstrainedError'])(
    'reports an unavailable explicit input for %s without falling back',
    async (name) => {
      getUserMedia.mockRejectedValue(new DOMException('private-device-detail', name));
      const { onError, cleanup } = start({ deviceId: 'missing-device' });
      await settle();
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(
        'The selected microphone is unavailable. Reconnect it or choose another input, then enable your mic again.',
      );
      expect(JSON.stringify(onError.mock.calls)).not.toContain('private-device-detail');
      expect(audioContext).toBeNull();
      cleanup();
    },
  );

  it('stops the old capture before opening a newly selected input and drops stale frames', async () => {
    const first = start({ deviceId: 'old-device' });
    await settle();
    const oldNode = microphoneNode;
    const oldOnMessage = oldNode.port.onmessage;
    first.cleanup();
    const nextTrack = { label: 'New Snowball', stop: vi.fn(), onended: null };
    const nextStream = { getTracks: () => [nextTrack], getAudioTracks: () => [nextTrack] };
    getUserMedia.mockImplementationOnce(async () => {
      expect(track.stop).toHaveBeenCalledOnce();
      expect(oldNode.disconnect).toHaveBeenCalledOnce();
      return nextStream;
    });
    const second = start({ deviceId: 'snowball-device' });
    await settle();
    expect(getUserMedia.mock.calls[1][0].audio.deviceId).toEqual({ exact: 'snowball-device' });
    oldOnMessage({ data: { pcm: new ArrayBuffer(1920), level: 0.5, at: 0 } });
    expect(first.onChunk).not.toHaveBeenCalled();
    microphoneNode.port.onmessage({ data: { pcm: new ArrayBuffer(1920), level: 0.5, at: 0 } });
    expect(second.onChunk).toHaveBeenCalledOnce();
    expect(nextTrack.stop).not.toHaveBeenCalled();
    expect(react.stateChanges).toContain('New Snowball');
    second.cleanup();
    expect(nextTrack.stop).toHaveBeenCalledOnce();
  });

  it('discards a previous device that opens after a newer selection is already active', async () => {
    const pending = deferred<typeof stream>();
    getUserMedia.mockReturnValueOnce(pending.promise);
    const first = start({ deviceId: 'old-device' });
    await settle();
    first.cleanup();
    const nextTrack = { label: 'New Snowball', stop: vi.fn(), onended: null };
    getUserMedia.mockResolvedValueOnce({
      getTracks: () => [nextTrack],
      getAudioTracks: () => [nextTrack],
    });
    const second = start({ deviceId: 'snowball-device' });
    await settle();
    const activeNode = microphoneNode;
    const changeCount = react.stateChanges.length;
    pending.resolve(stream);
    await settle();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(nextTrack.stop).not.toHaveBeenCalled();
    expect(microphoneNode).toBe(activeNode);
    expect(react.stateChanges).toHaveLength(changeCount);
    second.cleanup();
  });

  it('refreshes default capture only when the default input changes, and removes the listener', async () => {
    const events = new EventTarget();
    const input = {
      kind: 'audioinput',
      deviceId: 'default',
      groupId: 'built-in',
      label: 'Default - Built-in',
    };
    const enumerateDevices = vi.fn(async () => [input]);
    const removeEventListener = vi.fn(events.removeEventListener.bind(events));
    Object.assign(navigator.mediaDevices, {
      enumerateDevices,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener,
    });
    const { onError, cleanup } = start();
    await settle();
    expect(enumerateDevices).toHaveBeenCalledOnce();
    enumerateDevices.mockResolvedValue([
      input,
      { ...input, kind: 'audiooutput', label: 'New speaker' },
    ]);
    events.dispatchEvent(new Event('devicechange'));
    await vi.advanceTimersByTimeAsync(150);
    expect(track.stop).not.toHaveBeenCalled();
    enumerateDevices.mockResolvedValue([
      { ...input, groupId: 'snowball', label: 'Default - Blue Snowball' },
    ]);
    events.dispatchEvent(new Event('devicechange'));
    events.dispatchEvent(new Event('devicechange'));
    await vi.advanceTimersByTimeAsync(150);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(closeContext).toHaveBeenCalledOnce();
    expect(react.stateChanges.at(-1)).toBe(1); // One capture-effect refresh, not a device-event loop.
    expect(react.stateChanges).toContain('requesting');
    expect(removeEventListener).toHaveBeenCalledWith('devicechange', expect.any(Function));
    expect(onError).not.toHaveBeenCalled();
    const checks = enumerateDevices.mock.calls.length;
    events.dispatchEvent(new Event('devicechange'));
    await vi.advanceTimersByTimeAsync(150);
    expect(enumerateDevices).toHaveBeenCalledTimes(checks);
    cleanup();
  });

  it('never changes an explicitly selected input in response to system device events', async () => {
    const enumerateDevices = vi.fn();
    const addEventListener = vi.fn();
    Object.assign(navigator.mediaDevices, { enumerateDevices, addEventListener });
    const { cleanup } = start({ deviceId: 'snowball-device' });
    await settle();
    expect(enumerateDevices).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
    cleanup();
  });

  it('ignores a default-device check that finishes after capture is disabled', async () => {
    const devices = deferred<unknown[]>();
    Object.assign(navigator.mediaDevices, {
      enumerateDevices: vi.fn(() => devices.promise),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const { cleanup } = start();
    await settle();
    cleanup();
    const changeCount = react.stateChanges.length;
    devices.resolve([
      { kind: 'audioinput', deviceId: 'default', groupId: 'snowball', label: 'Blue Snowball' },
    ]);
    await settle();
    expect(react.stateChanges).toHaveLength(changeCount);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenCalledOnce();
  });
});
