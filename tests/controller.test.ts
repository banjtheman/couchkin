import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppCommand } from '../src/shared/types';

const bridges = vi.hoisted(() => ({
  capture: vi.fn(),
  respond: vi.fn(),
  cancel: vi.fn(),
  synthesize: vi.fn(),
}));
const fileGate = vi.hoisted(() => ({
  nextFrameWrite: null as null | { entered: () => void; released: Promise<void> },
}));

// Keep real disk I/O, with one controllable await boundary inside a frame write.
// Settings and startup cleanup are deliberately exercised against the filesystem.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const gate = String(args[0]).includes('/runtime/frame-') ? fileGate.nextFrameWrite : null;
      if (gate) fileGate.nextFrameWrite = null;
      await actual.writeFile(...args);
      if (gate) {
        gate.entered();
        await gate.released;
      }
    },
  };
});
vi.mock('../src/main/codex', () => ({
  CodexBridge: class {
    respond = bridges.respond;
    cancel = bridges.cancel;
    status = vi.fn(async () => ({ available: true, authenticated: true, message: 'Test session' }));
    generateCharacter = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock('../src/main/obs', () => ({
  ObsBridge: class {
    private listener: ((connected: boolean, message: string) => void) | undefined;
    capture = bridges.capture;
    async connect() {
      this.listener?.(true, 'Test OBS');
    }
    async disconnect() {
      this.listener?.(false, 'Test OBS disconnected');
    }
    async listSources() {
      return ['Game', 'Other game'];
    }
    onStatus(callback: (connected: boolean, message: string) => void) {
      this.listener = callback;
      return () => {
        this.listener = undefined;
      };
    }
  },
}));
vi.mock('../src/main/twitch', () => ({
  TwitchBridge: class {
    async connect() {}
    disconnect() {}
    onStatus() {
      return () => {};
    }
    onMessage() {
      return () => {};
    }
  },
}));
vi.mock('../src/main/speech', () => ({
  LocalSpeech: class {
    synthesize = bridges.synthesize;
    cancel = vi.fn();
  },
}));

import { Controller } from '../src/main/controller';

type Capture = { dataUrl: string; capturedAt: number };
const controllers = new Set<Controller>();
const directories: string[] = [];
const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;
const capture = (capturedAt = 1): Capture => ({ dataUrl: jpeg, capturedAt });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function makeDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'couchkin-controller-test-'));
  directories.push(directory);
  return directory;
}

async function makeController(directory?: string) {
  const controller = new Controller(directory ?? (await makeDirectory()));
  controllers.add(controller);
  await controller.initialize();
  controller.state.settings.obsSource = 'Game';
  controller.state.settings.voiceEnabled = false;
  controller.state.obs = { state: 'connected', message: 'Test OBS' };
  controller.state.codex = { state: 'connected', message: 'Test Codex' };
  return controller;
}

async function frames(controller: Controller) {
  return (await readdir(join(controller.directory, 'runtime'))).filter((name) =>
    name.startsWith('frame-'),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  bridges.capture.mockReset().mockResolvedValue(capture());
  bridges.respond.mockReset().mockResolvedValue({ text: '', expression: 'idle', sources: [] });
  bridges.synthesize.mockReset().mockResolvedValue(null);
  fileGate.nextFrameWrite = null;
});

afterEach(async () => {
  await Promise.all([...controllers].map((controller) => controller.dispose()));
  controllers.clear();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  fileGate.nextFrameWrite = null;
});

describe('observation cancellation', () => {
  it('does not send a capture that completes after Quiet to Codex', async () => {
    const controller = await makeController();
    const pending = deferred<Capture>();
    bridges.capture.mockReturnValueOnce(pending.promise);

    const observation = controller.request({ type: 'observe' });
    expect(controller.state.session.observing).toBe(true);
    expect((await controller.request({ type: 'quiet' })).ok).toBe(true);
    pending.resolve(capture());
    await observation;

    expect(bridges.respond).not.toHaveBeenCalled();
    expect(controller.state.frameUrl).toBeNull();
    expect(controller.state.session.observing).toBe(false);
    expect(await frames(controller)).toEqual([]);
  });

  it('keeps a replacement observation active when the canceled observation finishes', async () => {
    const controller = await makeController();
    const oldCapture = deferred<Capture>();
    const newCapture = deferred<Capture>();
    bridges.capture.mockReturnValueOnce(oldCapture.promise).mockReturnValueOnce(newCapture.promise);

    const oldObservation = controller.request({ type: 'observe' });
    await controller.request({ type: 'quiet' });
    const newObservation = controller.request({ type: 'observe' });
    expect(bridges.capture).toHaveBeenCalledTimes(2);

    oldCapture.resolve(capture(1));
    await oldObservation;
    expect(controller.state.session.observing).toBe(true);
    expect(bridges.respond).not.toHaveBeenCalled();

    newCapture.resolve(capture(2));
    await newObservation;
    expect(bridges.respond).toHaveBeenCalledTimes(1);
    const request = bridges.respond.mock.calls[0]![0] as { imagePaths: string[] };
    expect(request.imagePaths).toHaveLength(1);
    expect(request.imagePaths[0]).toContain('/frame-2-');
    expect(await readFile(request.imagePaths[0]!)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    expect(controller.state.session.observing).toBe(false);
  });

  const interruptions: Array<{ name: string; command: AppCommand }> = [
    { name: 'Quiet', command: { type: 'quiet' } },
    { name: 'pause', command: { type: 'pause-session' } },
    {
      name: 'a source change',
      command: { type: 'save-settings', settings: { obsSource: 'Other game' } },
    },
    { name: 'an OBS disconnect', command: { type: 'disconnect-obs' } },
  ];

  it.each(interruptions)(
    'deletes a frame and skips Codex when $name occurs during its write',
    async ({ command }) => {
      const controller = await makeController();
      const entered = deferred<void>();
      const release = deferred<void>();
      fileGate.nextFrameWrite = { entered: () => entered.resolve(), released: release.promise };

      const observation = controller.request({ type: 'observe' });
      await entered.promise;
      expect(await frames(controller)).toHaveLength(1);
      expect((await controller.request(command)).ok).toBe(true);
      release.resolve();
      await observation;

      expect(bridges.respond).not.toHaveBeenCalled();
      expect(controller.state.frameUrl).toBeNull();
      expect(await frames(controller)).toEqual([]);
    },
  );
});

describe('temporary media cleanup', () => {
  const clearingCommands: Array<{ name: string; command: AppCommand }> = [
    { name: 'pausing', command: { type: 'pause-session' } },
    {
      name: 'changing the source',
      command: { type: 'save-settings', settings: { obsSource: 'Other game' } },
    },
    { name: 'disconnecting OBS', command: { type: 'disconnect-obs' } },
  ];

  it.each(clearingCommands)('removes retained frames after $name', async ({ command }) => {
    const controller = await makeController();
    await controller.request({ type: 'observe' });
    expect(await frames(controller)).toHaveLength(1);

    await controller.request(command);
    await vi.waitFor(async () => expect(await frames(controller)).toEqual([]));
    expect(controller.state.frameUrl).toBeNull();
  });

  it('retains at most the three most recent completed observations', async () => {
    const controller = await makeController();
    for (let timestamp = 1; timestamp <= 4; timestamp++) {
      bridges.capture.mockResolvedValueOnce(capture(timestamp));
      await controller.request({ type: 'observe' });
    }
    await vi.waitFor(async () => expect(await frames(controller)).toHaveLength(3));
    expect((await frames(controller)).some((name) => name.startsWith('frame-1-'))).toBe(false);
    const latest = bridges.respond.mock.calls.at(-1)![0] as { imagePaths: string[] };
    expect(latest.imagePaths).toHaveLength(3);
    expect(latest.imagePaths.map((path) => /frame-(\d+)-/.exec(path)?.[1])).toEqual([
      '2',
      '3',
      '4',
    ]);
  });

  it('purges crash leftovers at startup while preserving character art and unrelated files', async () => {
    const directory = await makeDirectory();
    await Promise.all(
      ['runtime', 'audio', 'characters'].map((folder) => mkdir(join(directory, folder))),
    );
    await Promise.all([
      writeFile(join(directory, 'runtime', 'frame-old.jpg'), 'old private frame'),
      writeFile(join(directory, 'runtime', 'keep.json'), '{}'),
      writeFile(join(directory, 'audio', 'interrupted.wav'), 'old speech'),
      writeFile(join(directory, 'characters', 'buddy.png'), 'character art'),
    ]);

    const controller = await makeController(directory);
    expect(await frames(controller)).toEqual([]);
    expect(await readdir(join(directory, 'audio'))).toEqual([]);
    expect(await readFile(join(directory, 'characters', 'buddy.png'), 'utf8')).toBe(
      'character art',
    );
    expect(await readFile(join(directory, 'runtime', 'keep.json'), 'utf8')).toBe('{}');
  });

  it('purges retained frames and unfinished audio at shutdown', async () => {
    const controller = await makeController();
    await controller.request({ type: 'observe' });
    await mkdir(join(controller.directory, 'audio'));
    await writeFile(join(controller.directory, 'audio', 'interrupted.wav'), 'partial speech');

    await controller.dispose();
    controllers.delete(controller);
    expect(await frames(controller)).toEqual([]);
    expect(await readdir(join(controller.directory, 'audio'))).toEqual([]);
  });
});

describe('caption and speech replacement', () => {
  it('keeps a new text-only reply visible but clears it on an explicit Quiet', async () => {
    const controller = await makeController();
    const quiet = vi.fn();
    controller.attachOverlay(
      { publish: vi.fn(), quiet } as unknown as import('../src/main/overlay').OverlayServer,
      'http://127.0.0.1:43128',
    );
    bridges.respond.mockResolvedValueOnce({
      text: 'The crystals look expensive.',
      expression: 'happy',
    });
    const result = await controller.request({
      type: 'send-message',
      text: 'What is beside the merchant?',
    });
    expect(result.ok).toBe(true);
    expect(result.state.messages.at(-1)?.text).toBe('The crystals look expensive.');
    expect(quiet).toHaveBeenLastCalledWith(false);
    await controller.request({ type: 'quiet' });
    expect(quiet).toHaveBeenLastCalledWith(true);
  });
});
