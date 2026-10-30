import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  call: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => void>(),
}));
vi.mock('obs-websocket-js', () => ({
  default: class {
    connect = mock.connect;
    disconnect = mock.disconnect;
    call = mock.call;
    on(event: string, callback: (...args: unknown[]) => void) {
      mock.handlers.set(event, callback);
      return this;
    }
  },
}));
import { ObsBridge, normalizeObsAddress, validateScreenshot } from '../src/main/obs';

const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;

beforeEach(() => {
  vi.clearAllMocks();
  mock.handlers.clear();
  mock.connect.mockResolvedValue({});
  mock.disconnect.mockResolvedValue(undefined);
});

describe('local OBS boundaries', () => {
  it('accepts only loopback WebSocket endpoints', () => {
    expect(normalizeObsAddress(' ws://localhost:4455/ ')).toBe('ws://localhost:4455');
    expect(normalizeObsAddress('wss://[::1]:4455')).toBe('wss://[::1]:4455');
    expect(normalizeObsAddress('ws://127.0.0.1')).toBe('ws://127.0.0.1:4455');
    for (const url of [
      'https://localhost:4455',
      'ws://evil.example:4455',
      'ws://localhost.evil.example:4455',
      'ws://192.168.1.2:4455',
      'ws://user:secret@localhost:4455',
      'ws://localhost:4455/path',
      'ws://localhost:4455?password=secret',
      'ws://localhost:4455#x',
    ]) {
      expect(() => normalizeObsAddress(url)).toThrow();
    }
  });

  it('rejects invalid or huge images before observation', () => {
    expect(validateScreenshot(jpeg)).toBe(jpeg);
    expect(validateScreenshot(jpeg.replace('image/jpeg', 'image/jpg'))).toBe(jpeg);
    for (const value of [
      null,
      'data:text/html;base64,SGk=',
      'data:image/jpeg;base64,SGk=',
      'data:image/jpeg;base64,!!!',
      'data:image/jpeg;base64,AAAA',
      'data:image/png;base64,AAAA',
      'x'.repeat(12 * 1024 * 1024),
    ]) {
      expect(() => validateScreenshot(value)).toThrow();
    }
  });
});

describe('OBS read-only lifecycle', () => {
  it('lists named inputs and sends only a bounded screenshot request', async () => {
    const obs = new ObsBridge();
    await obs.connect('ws://127.0.0.1:4455', 'secret');
    mock.call.mockResolvedValueOnce({
      inputs: [
        { inputName: 'Game' },
        { inputName: 'Camera' },
        { inputName: 'Couchkin Overlay' },
        { inputName: 'Game' },
        { inputName: 10 },
        {},
      ],
    });
    expect(await obs.listSources()).toEqual(['Camera', 'Game']);
    mock.call.mockResolvedValueOnce({ imageData: jpeg });
    expect((await obs.capture('Game')).dataUrl).toBe(jpeg);
    expect(mock.call).toHaveBeenLastCalledWith('GetSourceScreenshot', {
      sourceName: 'Game',
      imageFormat: 'jpeg',
      imageWidth: 1280,
      imageCompressionQuality: 80,
    });
    expect(mock.connect).toHaveBeenCalledWith('ws://127.0.0.1:4455', 'secret', {
      rpcVersion: 1,
      eventSubscriptions: 0,
    });
    await obs.disconnect();
    await expect(obs.capture('Game')).rejects.toThrow('Connect to OBS');
  });

  it('discards a screenshot completed after disconnection', async () => {
    const obs = new ObsBridge();
    await obs.connect('ws://localhost:4455', '');
    let complete!: (value: { imageData: string }) => void;
    mock.call.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const capture = obs.capture('Game');
    await obs.disconnect();
    complete({ imageData: jpeg });
    await expect(capture).rejects.toThrow('Could not capture');
  });

  it('includes OBS response delay in frame age instead of timestamping receipt as a fresh capture', async () => {
    const obs = new ObsBridge();
    await obs.connect('ws://localhost:4455', '');
    let complete!: (value: { imageData: string }) => void;
    mock.call.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const pending = obs.capture('Game');
      clock.mockReturnValue(8000);
      complete({ imageData: jpeg });
      await expect(pending).resolves.toEqual({ dataUrl: jpeg, capturedAt: 1000 });
    } finally {
      clock.mockRestore();
      await obs.disconnect();
    }
  });

  it('does not surface raw authentication details', async () => {
    const obs = new ObsBridge();
    const status = vi.fn();
    obs.onStatus(status);
    mock.connect.mockRejectedValueOnce(
      Object.assign(new Error('secret-from-server'), { code: 4008 }),
    );
    await expect(obs.connect('ws://localhost:4455', 'secret-from-server')).rejects.toThrow(
      'OBS rejected the password',
    );
    expect(JSON.stringify(status.mock.calls)).not.toContain('secret-from-server');
  });
});
