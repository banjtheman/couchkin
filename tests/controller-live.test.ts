import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const controls = vi.hoisted(() => ({
  live: [] as any[],
  twitch: [] as any[],
  capture: vi.fn(),
  observation: vi.fn(),
  memory: vi.fn(),
  chatReply: vi.fn(),
  closeGate: null as Promise<void> | null,
  frameWriteGate: null as null | { entered: () => void; released: Promise<void> },
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const gate = String(args[0]).includes('/runtime/frame-') ? controls.frameWriteGate : null;
      if (gate) controls.frameWriteGate = null;
      await actual.writeFile(...args);
      if (gate) {
        gate.entered();
        await gate.released;
      }
    },
  };
});
vi.mock('../src/main/game-observer', () => ({ observeGame: controls.observation }));
vi.mock('../src/main/memory-extractor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/memory-extractor')>()),
  extractMemories: controls.memory,
}));
vi.mock('../src/main/twitch-reply', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/twitch-reply')>()),
  generateTwitchReply: controls.chatReply,
}));
vi.mock('../src/main/live', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    LiveBridge: class extends EventEmitter {
      connected = false;
      connect = vi.fn(async (_options: unknown) => {
        this.emit('status', { state: 'connecting', message: 'Connecting' });
        this.connected = true;
        this.emit('status', { state: 'connected', message: 'Live test' });
      });
      close = vi.fn(async () => {
        this.connected = false;
        if (controls.closeGate) await controls.closeGate;
        this.emit('status', { state: 'disconnected', message: 'Live closed' });
      });
      appendAudio = vi.fn(() => this.connected);
      sendText = vi.fn();
      addContext = vi.fn((text: string) => {
        if (text.length > 1200) throw new Error('Live context is empty or too long.');
      });
      submitToolResult = vi.fn();
      say = vi.fn();
      constructor() {
        super();
        controls.live.push(this);
      }
    },
  };
});
vi.mock('../src/main/codex', () => ({
  CodexBridge: class {
    status = vi.fn(async () => ({ available: true, authenticated: true, message: 'Test' }));
    cancel = vi.fn();
    dispose = vi.fn();
    respond = vi.fn();
    generateCharacter = vi.fn();
  },
}));
vi.mock('../src/main/speech', () => ({
  LocalSpeech: class {
    cancel = vi.fn();
    synthesize = vi.fn(async () => null);
  },
}));
vi.mock('../src/main/obs', () => ({
  ObsBridge: class {
    listener?: (connected: boolean, message: string) => void;
    capture = controls.capture;
    onStatus(callback: (connected: boolean, message: string) => void) {
      this.listener = callback;
      return () => {};
    }
    async disconnect() {
      this.listener?.(false, 'OBS disconnected');
    }
    async connect() {
      this.listener?.(true, 'OBS test');
    }
    async listSources() {
      return ['Game', 'Other game'];
    }
  },
}));
vi.mock('../src/main/twitch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/twitch')>()),
  TwitchBridge: class {
    onDiagnostic() { return () => {}; }
    listener?: (message: { id: string; user: string; text: string }) => void;
    statusListener?: (connected: boolean, message: string) => void;
    chatAccess = { canSend: false, username: null as string | null };
    sendReply = vi.fn(async () => ({ messageId: 'posted' }));
    constructor() {
      controls.twitch.push(this);
    }
    onStatus(callback: (connected: boolean, message: string) => void) {
      this.statusListener = callback;
      return () => {};
    }
    onMessage(callback: (message: { id: string; user: string; text: string }) => void) {
      this.listener = callback;
      return () => {};
    }
    async connect() {}
    disconnect() {
      this.chatAccess = { canSend: false, username: null };
      this.statusListener?.(false, 'Disconnected');
    }
  },
}));
import { Controller } from '../src/main/controller';
import type { OverlayServer } from '../src/main/overlay';
import {
  getPersonalityProfile,
  personalityIds,
  personalityInstructions,
} from '../src/shared/personalities';

const clients: Controller[] = [];
const directories: string[] = [];
const fixtureImage = 'data:image/jpeg;base64,/9j/2Q==';
const privateKey = 'private-fixture-key-not-for-renderer';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function make() {
  const directory = await mkdtemp(join(tmpdir(), 'couchkin-live-controller-'));
  directories.push(directory);
  const controller = new Controller(directory, { apiKey: privateKey });
  clients.push(controller);
  await controller.initialize();
  controller.state.settings.voiceProvider = 'live';
  controller.state.settings.obsSource = 'Game';
  controller.state.obs = { state: 'connected', message: 'OBS test' };
  const overlay = {
    publish: vi.fn(),
    quiet: vi.fn(),
    play: vi.fn(() => 'overlay'),
    resetAudioRouting: vi.fn(),
    registerFile: vi.fn(),
    forgetFile: vi.fn(),
  };
  controller.attachOverlay(
    overlay as unknown as OverlayServer,
    'http://127.0.0.1:43128/?overlay=1&token=test-fixture',
  );
  return { controller, live: controls.live.at(-1), twitch: controls.twitch.at(-1), overlay };
}
beforeEach(() => {
  controls.live.length = controls.twitch.length = 0;
  controls.closeGate = null;
  controls.frameWriteGate = null;
  controls.capture
    .mockReset()
    .mockImplementation(async () => ({ dataUrl: fixtureImage, capturedAt: Date.now() }));
  controls.observation
    .mockReset()
    .mockResolvedValue({ summary: 'Map screen. HP 32/70.', reaction: '', usageTokens: 20 });
  controls.memory.mockReset().mockResolvedValue({ memories: [], usageTokens: 0 });
  controls.chatReply.mockReset().mockResolvedValue('That deck has commitment issues.');
});
afterEach(async () => {
  controls.closeGate = null;
  for (const controller of clients.splice(0)) await controller.dispose();
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe('Live controller lifecycle and context', () => {
  it('keeps the connected channel and its evidence when invalid reconnect input is rejected', async () => {
    const { controller, live, twitch } = await make();
    await controller.request({
      type: 'connect-twitch',
      channel: 'valid_channel',
      username: '',
      token: '',
    });
    twitch.statusListener(true, 'Joined');
    await controller.request({ type: 'start-session' });
    twitch.listener({ id: 'real', user: 'viewer', text: 'Real current-channel words.' });
    const rejected = await controller.request({
      type: 'connect-twitch',
      channel: 'not a channel',
      username: '',
      token: '',
    });
    expect(rejected.ok).toBe(false);
    twitch.statusListener(true, 'Still joined');
    live.emit('tool', { callId: 'chat', name: 'get_recent_chat', arguments: {} });
    expect(live.submitToolResult.mock.calls.at(-1)[1]).toMatchObject({
      connected: true,
      channel: 'valid_channel',
      status: 'messages',
      messages: [{ text: 'Real current-channel words.' }],
    });
  });
  it('reads real chat independently of long voice dialogue and never treats conversation as chat evidence', async () => {
    const { controller, live, twitch } = await make();
    await controller.request({
      type: 'connect-twitch',
      channel: 'test_channel',
      username: '',
      token: '',
    });
    twitch.statusListener(true, 'Joined');
    await controller.request({ type: 'start-session' });
    twitch.listener({ id: 'real', user: 'viewer', text: 'Try the poison card.' });
    expect(controller.state.twitchRead).toMatchObject({
      receivedCount: 1,
      lastReceivedAt: expect.any(Number),
      lastMessage: { user: 'viewer', text: 'Try the poison card.' },
    });
    for (let i = 0; i < 30; i++)
      controller.state.messages.push({
        id: `voice-${i}`,
        role: 'companion',
        text: 'An unrelated spoken remark.',
        at: Date.now(),
      });
    live.emit('tool', { callId: 'chat', name: 'get_recent_chat', arguments: {} });
    expect(live.submitToolResult.mock.calls.at(-1)[1]).toMatchObject({
      connected: true,
      channel: 'test_channel',
      status: 'messages',
      messages: [
        {
          id: 'real',
          user: 'viewer',
          text: 'Try the poison card.',
          receivedAt: expect.any(Number),
        },
      ],
    });
    live.emit('tool', { callId: 'context', name: 'get_stream_context', arguments: {} });
    expect(live.submitToolResult.mock.calls.at(-1)[1].context.twitchChat.messages).toHaveLength(1);
    twitch.statusListener(false, 'Disconnected');
    expect(controller.state.twitchRead).toEqual({
      receivedCount: 0,
      lastReceivedAt: null,
      lastMessage: null,
    });
    live.emit('tool', { callId: 'offline', name: 'get_recent_chat', arguments: {} });
    expect(live.submitToolResult.mock.calls.at(-1)[1]).toMatchObject({
      connected: false,
      status: 'disconnected',
      messages: [],
    });
    expect(live.addContext.mock.calls.at(-1)[0]).toContain('disconnected; you cannot read chat');
    twitch.statusListener(true, 'Rejoined');
    live.emit('tool', { callId: 'empty', name: 'get_recent_chat', arguments: {} });
    expect(live.submitToolResult.mock.calls.at(-1)[1]).toMatchObject({
      connected: true,
      status: 'waiting',
      messages: [],
    });
  });

  it('keeps stale viewer messages out of a replacement voice session history', async () => {
    const { controller, live, twitch } = await make();
    twitch.listener({ id: 'old-channel', user: 'viewer', text: 'Old viewer words.' });
    await controller.request({ type: 'start-session' });
    expect(live.connect.mock.calls.at(-1)[0].instructions).toContain(
      'Twitch chat at connection start: disconnected',
    );
    expect(JSON.stringify(live.connect.mock.calls.at(-1)[0].history)).not.toContain(
      'Old viewer words',
    );
    live.emit('tool', { callId: 'chat', name: 'get_recent_chat', arguments: {} });
    expect(live.submitToolResult.mock.calls.at(-1)[1].messages).toEqual([]);
  });

  it('saves settled direct Live dialogue with no chat/research/history in the extractor input', async () => {
    vi.useFakeTimers();
    const { controller, live, twitch } = await make();
    controller.state.messages.push({
      id: 'old',
      role: 'user',
      text: 'Earlier-session words.',
      at: Date.now(),
    });
    await controller.request({ type: 'start-session' });
    controls.memory.mockResolvedValueOnce({
      memories: ['Prefers poison builds.'],
      usageTokens: 123,
    });
    twitch.listener({
      id: 'fixture-viewer-message',
      user: 'viewer',
      text: 'Private viewer words.',
    });
    live.emit('transcript', {
      role: 'user',
      delta: 'I prefer poison builds.',
      startMs: 0,
      endMs: 500,
    });
    live.emit('transcript', {
      role: 'companion',
      delta: 'Poison it is.',
      startMs: 600,
      endMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(5999);
    expect(controls.memory).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() =>
      expect(controller.state.memoryStatus.message).toBe('Shared memory saved.'),
    );
    const options = controls.memory.mock.calls[0][0];
    expect(options.dialogue.map((m: { role: string }) => m.role)).toEqual(['user', 'companion']);
    expect(JSON.stringify(options.dialogue)).not.toContain('Earlier-session');
    expect(JSON.stringify(options.dialogue)).not.toContain('Private viewer');
    expect(controller.state.memories.map((m) => m.text)).toEqual(['Prefers poison builds.']);
    expect(controller.state.liveUsage.backendTokens).toBe(123);
    expect(live.addContext.mock.calls.at(-1)[0]).toContain('CONFIRMED_SAVED_MEMORIES');
    const stored = JSON.parse(await readFile(join(controller.directory, 'settings.json'), 'utf8'));
    expect(stored.memories).toEqual(controller.state.memories);
    expect(controller.state.memoryStatus.lastSavedAt).not.toBeNull();
  });

  it('never extracts memories for startup, companion-only or viewer-only activity', async () => {
    vi.useFakeTimers();
    const { controller, live, twitch } = await make();
    await controller.request({ type: 'start-session' });
    live.emit('transcript', {
      role: 'companion',
      delta: 'We won that imaginary fight.',
      startMs: 0,
      endMs: 1000,
    });
    twitch.listener({
      id: 'fixture-viewer-message',
      user: 'viewer',
      text: 'Remember my favorite strategy.',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(controls.memory).not.toHaveBeenCalled();
    expect(controller.state.memories).toEqual([]);
  });

  it('batches streamer fragments and starts at most one extraction every 45 seconds', async () => {
    vi.useFakeTimers();
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    const gate = deferred<{ memories: string[]; usageTokens: number }>();
    controls.memory.mockReturnValueOnce(gate.promise);
    live.emit('transcript', { role: 'user', delta: 'I prefer', startMs: 0, endMs: 300 });
    await vi.advanceTimersByTimeAsync(3000);
    live.emit('transcript', { role: 'user', delta: ' poison builds.', startMs: 300, endMs: 800 });
    await vi.advanceTimersByTimeAsync(6000);
    expect(controls.memory).toHaveBeenCalledTimes(1);
    expect(controls.memory.mock.calls[0][0].dialogue[0].text).toBe('I prefer poison builds.');
    live.emit('transcript', {
      role: 'user',
      delta: 'I also like defensive decks.',
      startMs: 3000,
      endMs: 4000,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(controls.memory).toHaveBeenCalledTimes(1);
    gate.resolve({ memories: [], usageTokens: 10 });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(34_999);
    expect(controls.memory).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(controls.memory).toHaveBeenCalledTimes(2);
    expect(
      controls.memory.mock.calls[1][0].dialogue
        .filter((m: { role: string }) => m.role === 'user')
        .map((m: { text: string }) => m.text),
    ).toEqual(['I also like defensive decks.']);
    expect(live.connect).toHaveBeenCalledTimes(1);
  });

  it('flushes an eligible final batch after an explicit pause without reopening voice', async () => {
    vi.useFakeTimers();
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    controls.memory.mockResolvedValueOnce({
      memories: ['Won the boss fight with one HP.'],
      usageTokens: 25,
    });
    live.emit('transcript', {
      role: 'user',
      delta: 'We won that boss fight with one HP!',
      startMs: 0,
      endMs: 900,
    });
    await controller.request({ type: 'pause-session' });
    expect(controller.state.session.status).toBe('paused');
    expect(live.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(controller.state.memories).toHaveLength(1));
    expect(controls.memory).toHaveBeenCalledTimes(1);
    expect(controller.state.liveUsage.backendTokens).toBe(25);
    expect(live.connect).toHaveBeenCalledTimes(1);
  });

  it('drops pending extraction on unexpected loss instead of making a final paid request', async () => {
    vi.useFakeTimers();
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    live.emit('transcript', {
      role: 'user',
      delta: 'I prefer poison builds.',
      startMs: 0,
      endMs: 500,
    });
    live.connected = false;
    live.emit('status', { state: 'disconnected', message: 'Connection lost.', intentional: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(controls.memory).not.toHaveBeenCalled();
    expect(controller.state.memories).toEqual([]);
  });

  it.each(['off', 'delete', 'clear', 'game', 'dispose'] as const)(
    'invalidates an in-flight memory suggestion on %s',
    async (action) => {
      vi.useFakeTimers();
      const { controller, live } = await make();
      await controller.request({ type: 'start-session' });
      const gate = deferred<{ memories: string[]; usageTokens: number }>();
      controls.memory.mockReturnValueOnce(gate.promise);
      live.emit('transcript', {
        role: 'user',
        delta: 'I prefer poison builds.',
        startMs: 0,
        endMs: 500,
      });
      await vi.advanceTimersByTimeAsync(6000);
      expect(controls.memory).toHaveBeenCalledTimes(1);
      const signal = controls.memory.mock.calls[0][0].signal;
      if (action === 'off')
        await controller.request({ type: 'save-settings', settings: { rememberMoments: false } });
      if (action === 'delete')
        await controller.request({ type: 'delete-memory', id: 'old-memory' });
      if (action === 'clear') await controller.request({ type: 'clear-memories' });
      if (action === 'game')
        await controller.request({
          type: 'save-settings',
          settings: { gameTitle: 'Another game' },
        });
      if (action === 'dispose') await controller.dispose();
      expect(signal.aborted).toBe(true);
      gate.resolve({ memories: ['Prefers poison builds.'], usageTokens: 12 });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.state.memories).toEqual([]);
      expect(
        live.addContext.mock.calls.some((args: string[]) =>
          args[0].includes('CONFIRMED_SAVED_MEMORIES'),
        ),
      ).toBe(false);
    },
  );

  it('does not resave deleted memories from later fragments of a previously buffered message', async () => {
    vi.useFakeTimers();
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    live.emit('transcript', {
      role: 'user',
      delta: 'I prefer poison builds.',
      startMs: 0,
      endMs: 500,
    });
    await controller.request({ type: 'clear-memories' });
    live.emit('transcript', {
      role: 'user',
      delta: ' They are my favorite.',
      startMs: 500,
      endMs: 1200,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(controls.memory).not.toHaveBeenCalled();
    live.emit('transcript', {
      role: 'user',
      delta: 'I like playing on hard difficulty.',
      startMs: 4000,
      endMs: 5000,
    });
    await vi.advanceTimersByTimeAsync(6000);
    expect(controls.memory).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(controls.memory.mock.calls[0][0].dialogue)).not.toContain('poison');
  });

  it('keeps automatic memory errors separate from voice status and does not retry without new dialogue', async () => {
    vi.useFakeTimers();
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    controls.memory.mockRejectedValueOnce(new Error(`private failure ${privateKey}`));
    live.emit('transcript', {
      role: 'user',
      delta: 'I prefer poison builds.',
      startMs: 0,
      endMs: 500,
    });
    await vi.advanceTimersByTimeAsync(6000);
    expect(controller.state.memoryStatus.state).toBe('error');
    expect(controller.state.notice).toBeNull();
    expect(controller.state.live.state).toBe('connected');
    expect(controller.state.session.status).toBe('live');
    expect(JSON.stringify(controller.state.memoryStatus)).not.toContain(privateKey);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(controls.memory).toHaveBeenCalledTimes(1);
  });

  it('adds memories locally with automatic saving off, deduplicates, and keeps at most forty', async () => {
    const { controller } = await make();
    controller.state.settings.rememberMoments = false;
    controller.state.memories = Array.from({ length: 40 }, (_, i) => ({
      id: `memory-${i}`,
      text: `Old memory ${i}`,
    }));
    expect(
      (await controller.request({ type: 'add-memory', text: '  Prefers   poison builds. ' })).ok,
    ).toBe(true);
    expect(
      (await controller.request({ type: 'add-memory', text: 'PREFERS POISON BUILDS.' })).ok,
    ).toBe(true);
    expect(controller.state.memories).toHaveLength(40);
    expect(controller.state.memories.at(-1)?.text).toBe('Prefers poison builds.');
    expect(controller.state.memories.some((m) => m.id === 'memory-0')).toBe(false);
    expect(controls.memory).not.toHaveBeenCalled();
  });

  it.each(['add-memory', 'delete-memory', 'clear-memories'] as const)(
    'restores saved memories and reports failure if %s cannot persist',
    async (type) => {
      const { controller } = await make();
      const original = [{ id: 'kept', text: 'Prefer poison builds.' }];
      controller.state.memories = original;
      vi.spyOn(controller.store, 'save').mockRejectedValueOnce(new Error('Disk unavailable.'));
      const command =
        type === 'add-memory'
          ? { type, text: 'Prefers hard mode.' }
          : type === 'delete-memory'
            ? { type, id: 'kept' }
            : { type };
      const result = await controller.request(command);
      expect(result.ok).toBe(false);
      expect(controller.state.memories).toEqual(original);
      expect(controller.state.memoryStatus.state).toBe('error');
    },
  );

  it('does not save local Codex memories when remembering is off or cleared during the reply', async () => {
    const { controller } = await make();
    controller.state.settings.voiceProvider = 'local';
    controller.state.settings.rememberMoments = false;
    vi.mocked(controller.codex.respond).mockResolvedValueOnce({
      text: 'Nice.',
      expression: 'idle',
      memory: 'Unwanted memory.',
    });
    await controller.request({ type: 'send-message', text: 'I prefer poison builds.' });
    expect(controller.state.memories).toEqual([]);
    controller.state.settings.rememberMoments = true;
    const gate = deferred<{ text: string; expression: 'idle'; memory: string }>();
    vi.mocked(controller.codex.respond).mockReturnValueOnce(gate.promise);
    const reply = controller.request({ type: 'send-message', text: 'Remember this.' });
    await controller.request({ type: 'clear-memories' });
    gate.resolve({ text: 'Got it.', expression: 'idle', memory: 'Late unwanted memory.' });
    await reply;
    expect(controller.state.memories).toEqual([]);
  });

  it.each(personalityIds)(
    'applies the %s behavior to both Live and its reasoning backend',
    async (personality) => {
      const { controller, live } = await make();
      controller.state.character = { ...controller.state.character, personality };
      await controller.request({ type: 'start-session' });
      const options = live.connect.mock.calls[0][0];
      const behavior = personalityInstructions(controller.state.character);
      expect(options.instructions).toContain(
        `Trusted application personality instructions:\n${behavior}`,
      );
      expect(options.backendInstructions).toContain(
        `Trusted application personality instructions:\n${behavior}`,
      );
      expect(options.tools.some((tool: { name?: string }) => tool.name === 'capture_game')).toBe(
        true,
      );
      expect(live.say).not.toHaveBeenCalled();
    },
  );

  it('closes the active session on personality changes and applies the new behavior only on resume', async () => {
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    const character = { ...controller.state.character, personality: 'deadpan' as const };
    const result = await controller.request({ type: 'save-character', character });
    expect(result.ok).toBe(true);
    expect(controller.state.session.status).toBe('paused');
    expect(live.close).toHaveBeenCalledTimes(1);
    expect(live.connect).toHaveBeenCalledTimes(1);
    await controller.request({ type: 'start-session' });
    expect(live.connect).toHaveBeenCalledTimes(2);
    expect(live.connect.mock.calls[1][0].instructions).toContain(
      personalityInstructions(character),
    );
    expect(live.connect.mock.calls[1][0].backendInstructions).toContain(
      personalityInstructions(character),
    );
    expect(live.connect.mock.calls[1][0].instructions).not.toBe(
      live.connect.mock.calls[0][0].instructions,
    );
  });

  it('passes the selected behavior to the local Codex path without opening Live voice', async () => {
    const { controller, live } = await make();
    controller.state.settings.voiceProvider = 'local';
    controller.state.character = { ...controller.state.character, personality: 'trash-talker' };
    vi.mocked(controller.codex.respond).mockResolvedValueOnce({ text: '', expression: 'idle' });
    const result = await controller.request({
      type: 'send-message',
      text: 'Be serious: what is my best option?',
    });
    expect(result.ok).toBe(true);
    expect(controller.codex.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        character: controller.state.character,
        text: 'Be serious: what is my best option?',
      }),
    );
    expect(live.connect).not.toHaveBeenCalled();
  });

  it.each([
    { personality: 'deadpan' as const },
    { name: 'Riff' },
    { backseating: 10 },
    { noSpoilers: false },
    { palette: 'ember' as const },
  ])('discards an old local reply when character preferences change (%j)', async (change) => {
    const { controller, live } = await make();
    controller.state.settings.voiceProvider = 'local';
    const pending = deferred<{ text: string; expression: 'happy' }>();
    vi.mocked(controller.codex.respond).mockReturnValueOnce(pending.promise);
    const reply = controller.request({ type: 'send-message', text: 'What do you think?' });
    const cancellations = vi.mocked(controller.codex.cancel).mock.calls.length;
    await controller.request({
      type: 'save-character',
      character: { ...controller.state.character, ...change },
    });
    expect(controller.codex.cancel).toHaveBeenCalledTimes(cancellations + 1);
    pending.resolve({ text: 'A reply in the old personality.', expression: 'happy' });
    await reply;
    expect(
      controller.state.messages.some((message) => message.text.includes('old personality')),
    ).toBe(false);
    expect(controller.speech.synthesize).not.toHaveBeenCalled();
    expect(live.connect).not.toHaveBeenCalled();
  });

  it('does not interrupt a local reply when saving unchanged character preferences', async () => {
    const { controller } = await make();
    controller.state.settings.voiceProvider = 'local';
    const pending = deferred<{ text: string; expression: 'happy' }>();
    vi.mocked(controller.codex.respond).mockReturnValueOnce(pending.promise);
    const reply = controller.request({ type: 'send-message', text: 'What do you think?' });
    const cancellations = vi.mocked(controller.codex.cancel).mock.calls.length;
    await controller.request({
      type: 'save-character',
      character: { ...controller.state.character },
    });
    expect(controller.codex.cancel).toHaveBeenCalledTimes(cancellations);
    pending.resolve({ text: 'Still the selected personality.', expression: 'happy' });
    await reply;
    expect(
      controller.state.messages.some(
        (message) => message.text === 'Still the selected personality.',
      ),
    ).toBe(true);
  });

  it('invalidates a connecting Live session when the selected personality changes', async () => {
    const { controller, live } = await make();
    const gate = deferred<void>();
    live.connect.mockImplementationOnce(async () => {
      live.emit('status', { state: 'connecting', message: 'Connecting' });
      await gate.promise;
      live.connected = true;
      live.emit('status', { state: 'connected', message: 'Live test' });
    });
    const start = controller.request({ type: 'start-session' });
    expect(controller.state.live.state).toBe('connecting');
    await controller.request({
      type: 'save-character',
      character: { ...controller.state.character, personality: 'deadpan' },
    });
    gate.resolve();
    expect((await start).ok).toBe(false);
    expect(live.connected).toBe(false);
    expect(controller.state.session.status).not.toBe('live');
    expect(live.connect).toHaveBeenCalledTimes(1);
    expect(live.appendAudio).not.toHaveBeenCalled();
    await controller.request({ type: 'start-session' });
    expect(live.connect.mock.calls[1][0].instructions).toContain(
      personalityInstructions(controller.state.character),
    );
  });

  it('uses the selected personality introduction for the voice preview', async () => {
    const { controller, live } = await make();
    controller.state.character = { ...controller.state.character, personality: 'deadpan' };
    await controller.request({ type: 'audition' });
    expect(live.say).toHaveBeenCalledWith(
      `I'm ${controller.state.character.name}. ${getPersonalityProfile('deadpan').tagline}`,
    );
    expect(live.say.mock.calls[0][0]).not.toContain('warm, playful voice');
  });

  it('does not resurrect an active session or silence pump after pause races startup', async () => {
    vi.useFakeTimers();
    const { controller, live } = await make();
    const start = controller.request({ type: 'start-session' });
    const pause = controller.request({ type: 'pause-session' });
    await Promise.all([start, pause]);
    await vi.advanceTimersByTimeAsync(100);
    expect(controller.state.session.status).toBe('paused');
    expect(controller.state.live.state).toBe('disconnected');
    expect(live.appendAudio).not.toHaveBeenCalled();
  });

  it('stops microphone data, playback and the paced audio pump on pause', async () => {
    vi.useFakeTimers();
    const { controller, live, overlay } = await make();
    await controller.request({ type: 'start-session' });
    controller.liveMicrophone(true);
    controller.appendLiveAudio(Buffer.alloc(960, 1).toString('base64'));
    await vi.advanceTimersByTimeAsync(20);
    expect(Buffer.from(live.appendAudio.mock.calls.at(-1)[0], 'base64')).toEqual(
      Buffer.alloc(960, 1),
    );
    live.emit('audio', { delta: 'AAAAAA==', sampleRate: 24000 });
    controller.livePlayback(true, 'overlay');
    expect(controller.state.speaking).toBe(true);
    await controller.request({ type: 'pause-session' });
    const sent = live.appendAudio.mock.calls.length;
    controller.appendLiveAudio(Buffer.alloc(960, 2).toString('base64'));
    await vi.advanceTimersByTimeAsync(100);
    expect(live.appendAudio).toHaveBeenCalledTimes(sent);
    expect(controller.state.speaking).toBe(false);
    expect(overlay.quiet).toHaveBeenCalled();
    expect(live.close).toHaveBeenCalled();
  });

  it('cancels a queued reconnect while the previous session is still closing', async () => {
    vi.useFakeTimers();
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    const gate = deferred<void>();
    controls.closeGate = gate.promise;
    const closing = controller.request({ type: 'disconnect-live' });
    const reconnect = controller.request({ type: 'start-session' });
    const pause = controller.request({ type: 'pause-session' });
    controls.closeGate = null;
    gate.resolve();
    await Promise.all([closing, reconnect, pause]);
    await vi.advanceTimersByTimeAsync(100);
    expect(live.connect).toHaveBeenCalledTimes(1);
    expect(live.appendAudio).not.toHaveBeenCalled();
    expect(controller.state.session.status).toBe('paused');
  });

  it('keeps explicit disconnect from reconnecting through automatic observation', async () => {
    vi.useFakeTimers();
    const { controller, live } = await make();
    controller.state.settings.autoObserve = true;
    await controller.request({ type: 'start-session' });
    await controller.request({ type: 'disconnect-live' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(controls.capture).not.toHaveBeenCalled();
    expect(live.connect).toHaveBeenCalledTimes(1);
  });

  it('pauses on an unknown Live failure instead of automatically opening another paid session', async () => {
    vi.useFakeTimers();
    const { controller, live } = await make();
    controller.state.settings.autoObserve = true;
    await controller.request({ type: 'start-session' });
    live.connected = false;
    live.emit('status', { state: 'error', message: 'The Live backend is unavailable.' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(controller.state.session.status).toBe('paused');
    expect(controller.state.live).toEqual({
      state: 'error',
      message: 'The Live backend is unavailable.',
    });
    expect(controls.capture).not.toHaveBeenCalled();
    expect(live.connect).toHaveBeenCalledTimes(1);
    expect(live.close).not.toHaveBeenCalled();
  });

  function loseConnection(live: any) {
    live.connected = false;
    live.emit('status', {
      state: 'disconnected',
      code: 'connection_lost',
      closeCode: 1006,
      intentional: false,
      message: 'Connection lost.',
    });
  }

  it('recovers a dropped connection without replaying audio or letting chat bypass backoff', async () => {
    vi.useFakeTimers();
    const { controller, live, twitch, overlay } = await make();
    controller.state.settings.autoObserve = true;
    await controller.request({ type: 'start-session' });
    controller.liveMicrophone(true);
    controller.appendLiveAudio(Buffer.alloc(960, 7).toString('base64'));
    controller.state.frameUrl = fixtureImage;
    loseConnection(live);
    expect(controller.state.session.status).toBe('live');
    expect(controller.state.live).toMatchObject({
      state: 'connecting',
      message: 'Reconnecting voice (1/3)…',
    });
    expect(controller.state.frameUrl).toBeNull();
    expect(overlay.quiet).toHaveBeenCalled();
    twitch.listener({ id: 'during-drop', user: 'viewer', text: 'Pip, say hi' });
    const typed = await controller.request({ type: 'send-message', text: 'Hello?' });
    expect(typed.ok).toBe(false);
    expect(controller.state.messages.some((message) => message.text === 'Hello?')).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(live.connect).toHaveBeenCalledTimes(1);
    expect(live.sendText).not.toHaveBeenCalled();
    expect(controls.capture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(live.connect).toHaveBeenCalledTimes(2);
    expect(controller.state.live.state).toBe('connected');
    expect(controller.state.session.status).toBe('live');
    expect(controller.state.notice).toBeNull();
    // Renderer must explicitly re-enable the mic; the old queue is gone.
    await vi.advanceTimersByTimeAsync(20);
    expect(Buffer.from(live.appendAudio.mock.calls.at(-1)[0], 'base64')).toEqual(Buffer.alloc(960));
    controller.liveMicrophone(true);
    controller.appendLiveAudio(Buffer.alloc(960, 2).toString('base64'));
    await vi.advanceTimersByTimeAsync(20);
    expect(Buffer.from(live.appendAudio.mock.calls.at(-1)[0], 'base64')).toEqual(
      Buffer.alloc(960, 2),
    );
  });

  it('bounds rapid reconnect flapping and resets the budget on explicit Resume', async () => {
    vi.useFakeTimers();
    const { controller, live } = await make();
    controller.state.settings.autoObserve = false;
    await controller.request({ type: 'start-session' });
    for (const delay of [1000, 3000, 7000]) {
      const before = live.connect.mock.calls.length;
      loseConnection(live);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(live.connect).toHaveBeenCalledTimes(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(live.connect).toHaveBeenCalledTimes(before + 1);
    }
    loseConnection(live);
    expect(controller.state.session.status).toBe('paused');
    expect(controller.state.live.message).toContain('after 3 retries');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(live.connect).toHaveBeenCalledTimes(4);
    await controller.request({ type: 'start-session' });
    loseConnection(live);
    await vi.advanceTimersByTimeAsync(1000);
    expect(live.connect).toHaveBeenCalledTimes(6);
  });

  it('allows a fresh retry budget after a stable minute', async () => {
    vi.useFakeTimers();
    const { controller, live } = await make();
    controller.state.settings.autoObserve = false;
    await controller.request({ type: 'start-session' });
    loseConnection(live);
    await vi.advanceTimersByTimeAsync(1000);
    vi.setSystemTime(Date.now() + 60_000);
    loseConnection(live);
    expect(controller.state.live.message).toBe('Reconnecting voice (1/3)…');
    await vi.advanceTimersByTimeAsync(1000);
    expect(live.connect).toHaveBeenCalledTimes(3);
  });

  it('bounds failed reconnection handshakes without an unhandled rejection', async () => {
    vi.useFakeTimers();
    const { controller, live } = await make();
    controller.state.settings.autoObserve = false;
    await controller.request({ type: 'start-session' });
    live.connect.mockImplementation(async () => {
      live.emit('status', { state: 'connecting', message: 'Connecting' });
      live.emit('status', {
        state: 'error',
        code: 'connection_failed',
        message: 'Network unavailable.',
        intentional: false,
      });
      throw new Error('Network unavailable.');
    });
    loseConnection(live);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(live.connect).toHaveBeenCalledTimes(4);
    expect(controller.state.session.status).toBe('paused');
    expect(controller.state.live.message).toContain('after 3 retries');
  });

  it.each([
    'pause-session',
    'quiet',
    'disconnect-live',
    'settings',
    'character',
    'obs',
    'overlay',
    'dispose',
  ])('cancels backoff on %s and cannot be revived by an observation tick', async (action) => {
    vi.useFakeTimers();
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    loseConnection(live);
    if (action === 'settings')
      await controller.request({ type: 'save-settings', settings: { gameTitle: 'Another game' } });
    else if (action === 'character')
      await controller.request({
        type: 'save-character',
        character: { ...controller.state.character, name: 'Riff' },
      });
    else if (action === 'obs') await controller.obs.disconnect();
    else if (action === 'overlay') {
      controller.ownerLost();
      controller.ownerReady();
    } else if (action === 'dispose') await controller.dispose();
    else await controller.request({ type: action });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(live.connect).toHaveBeenCalledTimes(1);
    expect(controller.state.session.status).toBe('paused');
    expect(controls.capture).not.toHaveBeenCalled();
  });

  it('cancels an automatic handshake when the user pauses', async () => {
    vi.useFakeTimers();
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    const gate = deferred<void>();
    live.connect.mockImplementationOnce(async () => {
      live.emit('status', { state: 'connecting', message: 'Connecting' });
      await gate.promise;
      live.connected = true;
      live.emit('status', { state: 'connected', message: 'Connected' });
    });
    loseConnection(live);
    await vi.advanceTimersByTimeAsync(1000);
    await controller.request({ type: 'pause-session' });
    gate.resolve();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(live.connected).toBe(false);
    expect(controller.state.session.status).toBe('paused');
    expect(live.connect).toHaveBeenCalledTimes(2);
    expect(live.appendAudio).not.toHaveBeenCalled();
  });

  it.each([
    'invalid_api_key',
    'insufficient_quota',
    'rate_limit_exceeded',
    'content',
    'expired',
    'responses_validation_failed',
  ])('does not retry a non-network stop (%s)', async (code) => {
    vi.useFakeTimers();
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    live.connected = false;
    live.emit('status', {
      state: 'disconnected',
      code,
      intentional: false,
      message: 'Action required.',
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(live.connect).toHaveBeenCalledTimes(1);
    expect(controller.state.session.status).toBe('paused');
    expect(controller.state.live.message).toBe('Action required.');
  });

  it('pauses immediately on OBS overlay loss so chat cannot reopen a closing session', async () => {
    vi.useFakeTimers();
    const { controller, live, twitch } = await make();
    controller.state.settings.autoObserve = true;
    await controller.request({ type: 'start-session' });
    const gate = deferred<void>();
    controls.closeGate = gate.promise;
    controller.ownerLost();
    expect(controller.state.session.status).toBe('paused');
    twitch.listener({
      id: 'fixture-viewer-message',
      user: 'viewer',
      text: 'Pip, describe what is happening.',
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(live.connect).toHaveBeenCalledTimes(1);
    expect(live.sendText).not.toHaveBeenCalled();
    expect(controls.capture).not.toHaveBeenCalled();
    controls.closeGate = null;
    gate.resolve();
    await Promise.resolve();
    expect(controller.state.notice).toBe(
      'OBS overlay disconnected. Reopen it, then resume the session.',
    );
  });

  it('handles a rejected addressed-chat reply without leaking its error or rejecting globally', async () => {
    const { controller, live, twitch } = await make();
    await controller.request({ type: 'start-session' });
    live.sendText.mockImplementationOnce(() => {
      throw new Error(`transport failure ${privateKey}`);
    });
    twitch.listener({
      id: 'fixture-viewer-message',
      user: 'viewer',
      text: 'Pip, what do you think?',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(live.sendText).toHaveBeenCalledTimes(1);
    expect(controller.state.notice).toBe(
      'Could not answer that chat message. Check the voice connection and try again.',
    );
    expect(JSON.stringify(controller.state)).not.toContain(privateKey);
  });

  it('does not submit an old capture after the selected game changes', async () => {
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    const pending = deferred<{ dataUrl: string; capturedAt: number }>();
    controls.capture.mockReturnValueOnce(pending.promise);
    live.emit('tool', { callId: 'old_capture', name: 'capture_game', arguments: {} });
    await controller.request({ type: 'save-settings', settings: { obsSource: 'Other game' } });
    pending.resolve({ dataUrl: fixtureImage, capturedAt: Date.now() });
    await Promise.resolve();
    expect(live.submitToolResult).not.toHaveBeenCalled();
    expect(controller.state.frameUrl).toBeNull();
  });

  it.each([fixtureImage, 'data:image/jpeg;base64,/9j/2w=='])(
    'does not overwrite a newer tool frame when an older observation finishes writing (%s)',
    async (newImage) => {
      const { controller, live } = await make();
      await controller.request({ type: 'start-session' });
      const now = Date.now();
      controls.capture
        .mockResolvedValueOnce({ dataUrl: fixtureImage, capturedAt: now - 1000 })
        .mockResolvedValueOnce({ dataUrl: newImage, capturedAt: now });
      const entered = deferred<void>();
      const release = deferred<void>();
      controls.frameWriteGate = { entered: () => entered.resolve(), released: release.promise };
      const observation = (controller as any).observe(true);
      await entered.promise;
      live.emit('tool', { callId: 'newer', name: 'capture_game', arguments: {} });
      await vi.waitFor(() => expect(live.submitToolResult).toHaveBeenCalledTimes(1));
      release.resolve();
      await observation;
      expect(controller.state.frameUrl).toBe(newImage);
      expect(controls.observation).not.toHaveBeenCalled();
      expect(live.addContext).not.toHaveBeenCalled();
      expect(
        (await readdir(join(controller.directory, 'runtime'))).filter((f) =>
          f.startsWith('frame-'),
        ),
      ).toEqual([]);
      live.emit('tool', { callId: 'context', name: 'get_stream_context', arguments: {} });
      expect(live.submitToolResult.mock.calls.at(-1)[1].capturedAt).toBe(now);
    },
  );

  it('returns newer captured evidence when a tool capture completes out of order', async () => {
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    const now = Date.now();
    const oldCapture = deferred<{ dataUrl: string; capturedAt: number }>();
    const newImage = 'data:image/jpeg;base64,/9j/2w==';
    controls.capture
      .mockReturnValueOnce(oldCapture.promise)
      .mockResolvedValueOnce({ dataUrl: newImage, capturedAt: now });
    live.emit('tool', { callId: 'slow', name: 'capture_game', arguments: {} });
    await (controller as any).observe(true);
    oldCapture.resolve({ dataUrl: fixtureImage, capturedAt: now - 1000 });
    await vi.waitFor(() => expect(live.submitToolResult).toHaveBeenCalledTimes(1));
    const result = live.submitToolResult.mock.calls[0][1];
    expect(JSON.parse(result[0].text).capturedAt).toBe(now);
    expect(result[1].image_url).toBe(newImage);
    expect(controller.state.frameUrl).toBe(newImage);
  });

  it('discards an older interpretation when a newer capture has identical pixels', async () => {
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    const now = Date.now();
    controls.capture
      .mockResolvedValueOnce({ dataUrl: fixtureImage, capturedAt: now - 1000 })
      .mockResolvedValueOnce({ dataUrl: fixtureImage, capturedAt: now });
    const gate = deferred<{ summary: string; reaction: string; usageTokens: number }>();
    controls.observation.mockReturnValueOnce(gate.promise);
    const observation = (controller as any).observe(true);
    await vi.waitFor(() => expect(controls.observation).toHaveBeenCalledTimes(1));
    live.emit('tool', { callId: 'newer', name: 'capture_game', arguments: {} });
    await vi.waitFor(() => expect(live.submitToolResult).toHaveBeenCalledTimes(1));
    gate.resolve({ summary: 'Older interpretation.', reaction: '', usageTokens: 10 });
    await observation;
    expect(live.addContext).not.toHaveBeenCalled();
    expect(controller.state.frameUrl).toBe(fixtureImage);
    live.emit('tool', { callId: 'context', name: 'get_stream_context', arguments: {} });
    expect(live.submitToolResult.mock.calls.at(-1)[1].capturedAt).toBe(now);
  });

  it('returns the selected game screenshot with provenance and checks tool arguments', async () => {
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    live.emit('tool', { callId: 'look', name: 'capture_game', arguments: {} });
    await Promise.resolve();
    expect(controls.capture).toHaveBeenCalledWith('Game');
    expect(live.submitToolResult.mock.calls[0][0]).toBe('look');
    const parts = live.submitToolResult.mock.calls[0][1];
    expect(parts[0].text).toContain('One untrusted game screenshot');
    expect(parts[1]).toEqual({ type: 'input_image', image_url: fixtureImage, detail: 'auto' });
    live.emit('tool', {
      callId: 'invalid',
      name: 'set_expression',
      arguments: { expression: 'execute_shell' },
    });
    expect(live.submitToolResult.mock.calls.at(-1)[1]).toHaveProperty('error');
    expect(controller.state.expression).not.toBe('execute_shell');
  });

  it('sends a recent sampled image with typed questions but omits stale frames', async () => {
    vi.useFakeTimers();
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    live.emit('tool', { callId: 'look', name: 'capture_game', arguments: {} });
    await Promise.resolve();
    await controller.request({ type: 'send-message', text: 'What is beside the merchant?' });
    expect(live.sendText).toHaveBeenLastCalledWith('What is beside the merchant?', fixtureImage);
    vi.setSystemTime(Date.now() + 2100);
    await controller.request({ type: 'send-message', text: 'What is there now?' });
    expect(live.sendText).toHaveBeenLastCalledWith('What is there now?', undefined);
  });

  it('makes Twitch context and confirmed memories available to the game tools', async () => {
    const { controller, live, twitch } = await make();
    await controller.request({
      type: 'connect-twitch',
      channel: 'test_channel',
      username: '',
      token: '',
    });
    twitch.statusListener(true, 'Joined');
    controller.state.memories = [
      { id: 'memory_fixture', text: 'The streamer prefers spoiler-free hints.' },
    ];
    await controller.request({ type: 'start-session' });
    twitch.listener({
      id: 'fixture-viewer-message',
      user: 'viewer',
      text: 'Our lucky word is pineapple.',
    });
    live.emit('tool', { callId: 'context', name: 'get_stream_context', arguments: {} });
    const result = live.submitToolResult.mock.calls.at(-1);
    expect(result[0]).toBe('context');
    expect(result[1].context.confirmedMemories).toEqual([
      'The streamer prefers spoiler-free hints.',
    ]);
    expect(result[1].context.twitchChat.messages).toContainEqual({
      id: 'fixture-viewer-message',
      user: 'viewer',
      text: 'Our lucky word is pineapple.',
      receivedAt: expect.any(Number),
    });
    expect(result[1].context.recentConversation).toEqual([]);
    expect(live.addContext.mock.calls.at(-1)[0]).toContain('Untrusted Twitch viewer message');
    expect(JSON.stringify(result)).not.toContain(privateKey);
  });

  it('groups each speaker independently during overlapping transcript fragments', async () => {
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    live.emit('transcript', { role: 'user', delta: 'I think', startMs: 100, endMs: 400 });
    live.emit('transcript', { role: 'companion', delta: ' Yeah?', startMs: 300, endMs: 600 });
    live.emit('transcript', { role: 'user', delta: ' that is it.', startMs: 450, endMs: 1000 });
    live.emit('transcript', { role: 'companion', delta: ' Good call.', startMs: 700, endMs: 1400 });
    expect(controller.state.messages.map((message) => [message.role, message.text])).toEqual([
      ['user', 'I think that is it.'],
      ['companion', ' Yeah? Good call.'],
    ]);
    live.emit('transcript', { role: 'user', delta: 'New topic.', startMs: 4000, endMs: 5000 });
    expect(controller.state.messages).toHaveLength(3);
  });

  it('bounds serialized Twitch context without letting callback errors escape', async () => {
    const { controller, live, twitch } = await make();
    await controller.request({ type: 'connect-live' });
    expect(() =>
      twitch.listener({ id: 'fixture-viewer-message', user: 'viewer', text: '\n'.repeat(600) }),
    ).not.toThrow();
    expect(live.addContext).toHaveBeenCalled();
    expect(live.addContext.mock.calls.at(-1)[0].length).toBeLessThanOrEqual(1200);
  });

  it('never places the API key in renderer state, overlay state, or persisted settings', async () => {
    const { controller, live, overlay } = await make();
    const published: unknown[] = [];
    controller.on('state', (value) => published.push(value));
    await controller.request({ type: 'start-session' });
    const result = await controller.request({ type: 'state' });
    expect(live.connect.mock.calls[0][0].apiKey).toBe(privateKey);
    expect(JSON.stringify(result)).not.toContain(privateKey);
    expect(JSON.stringify(published)).not.toContain(privateKey);
    expect(JSON.stringify(overlay.publish.mock.calls)).not.toContain(privateKey);
    for (const file of await readdir(controller.directory)) {
      if (file.endsWith('.json'))
        expect(await readFile(join(controller.directory, file), 'utf8')).not.toContain(privateKey);
    }
  });

  it('keeps an interruption reason after state reads and overlay reconnection', async () => {
    const { controller } = await make();
    await controller.request({ type: 'start-session' });
    controller.ownerLost();
    const reason = controller.state.notice;
    await controller.request({ type: 'state' });
    controller.ownerReady();
    await Promise.resolve();
    expect(controller.state.notice).toBe(reason);
    expect(controller.state.live.message).toBe(reason);
    expect(controller.state.session.status).toBe('paused');
    expect(controller.state.moments.some((moment) => moment.text === reason)).toBe(true);
  });

  it('does not open a paid voice session when Look is used while paused', async () => {
    const { controller, live } = await make();
    const result = await controller.request({ type: 'observe' });
    expect(result.ok).toBe(false);
    expect(live.connect).not.toHaveBeenCalled();
    expect(controls.capture).not.toHaveBeenCalled();
    expect(controller.state.notice).toContain('Resume the session');
  });

  it('requires an active session before the first typed Live message', async () => {
    const { controller, live } = await make();
    const result = await controller.request({ type: 'send-message', text: 'What should I play?' });
    expect(result.ok).toBe(false);
    expect(controller.state.notice).toBe('Resume the session before sending Pip a message.');
    expect(controller.state.session.status).toBe('idle');
    expect(controller.state.messages).toHaveLength(0);
    expect(live.connect).not.toHaveBeenCalled();
    expect(live.sendText).not.toHaveBeenCalled();
  });

  it('does not queue a typed or suggested message reconnect while pausing or after pause', async () => {
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    const gate = deferred<void>();
    controls.closeGate = gate.promise;
    const pausing = controller.request({ type: 'pause-session' });
    const duringClose = await controller.request({
      type: 'send-message',
      text: 'Which card should I choose?',
    });
    expect(duringClose.ok).toBe(false);
    expect(live.connect).toHaveBeenCalledTimes(1);
    gate.resolve();
    await pausing;
    const afterClose = await controller.request({
      type: 'send-message',
      text: 'Hey, ready to hang out?',
    });
    expect(afterClose.ok).toBe(false);
    expect(controller.state.session.status).toBe('paused');
    expect(controller.state.messages).toHaveLength(0);
    expect(live.connect).toHaveBeenCalledTimes(1);
    expect(live.sendText).not.toHaveBeenCalled();
  });

  it('updates quiet background context without generating a user turn and skips identical frames', async () => {
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    await (controller as any).observe(true);
    await (controller as any).observe(true);
    expect(controls.observation).toHaveBeenCalledTimes(1);
    expect(live.sendText).not.toHaveBeenCalled();
    expect(live.say).not.toHaveBeenCalled();
    expect(live.addContext.mock.calls[0][0]).toContain('BACKGROUND_SCREEN_UPDATE');
    expect(live.addContext.mock.calls[0][0]).toContain('HP 32/70');
    expect(controller.state.liveUsage.backendTokens).toBe(20);
    await controller.request({ type: 'observe' });
    expect(live.sendText).toHaveBeenCalledTimes(1);
  });

  it('allows a meaningful passive reaction after cooldown but yields to recent human speech', async () => {
    vi.useFakeTimers();
    const { controller, live } = await make();
    controls.observation.mockResolvedValue({
      summary: 'An enemy has been defeated.',
      reaction: 'That poison earned its keep.',
      usageTokens: 20,
    });
    await controller.request({ type: 'start-session' });
    vi.setSystemTime(Date.now() + 60_000);
    await (controller as any).observe(true);
    expect(live.say).toHaveBeenCalledWith('That poison earned its keep.');
    vi.setSystemTime(Date.now() + 60_000);
    live.emit('transcript', {
      role: 'user',
      delta: 'What card should I take?',
      startMs: 10,
      endMs: 20,
    });
    controls.capture.mockResolvedValueOnce({
      dataUrl: 'data:image/jpeg;base64,/9j/2w==',
      capturedAt: Date.now(),
    });
    await (controller as any).observe(true);
    expect(live.say).toHaveBeenCalledTimes(1);
  });

  it('aborts passive perception on pause and discards a late result', async () => {
    const { controller, live } = await make();
    const gate = deferred<{ summary: string; reaction: string; usageTokens: number }>();
    controls.observation.mockReturnValueOnce(gate.promise);
    await controller.request({ type: 'start-session' });
    const observing = (controller as any).observe(true);
    await vi.waitFor(() => expect(controls.observation).toHaveBeenCalled());
    const signal = controls.observation.mock.calls[0][0].signal;
    await controller.request({ type: 'pause-session' });
    expect(signal.aborted).toBe(true);
    gate.resolve({ summary: 'Late data', reaction: 'Late reaction', usageTokens: 20 });
    await observing;
    expect(live.addContext).not.toHaveBeenCalled();
    expect(live.say).not.toHaveBeenCalled();
  });

  it('persists transport and observation metadata without forwarding raw fields to diagnostics', async () => {
    const { controller, live } = await make();
    live.emit('transport-diagnostic', {
      kind: 'unexpected_close',
      sessionElapsedMs: 761750,
      lastReceivedAgeMs: 1540,
      bufferedBytes: 0,
      pendingToolCount: 0,
      pendingContextCount: 1,
      closeCode: 1006,
      message: 'private error content',
      audio: 'private audio content',
    });
    controller.emit('observation-diagnostic', {
      trigger: 'speech',
      outcome: 'failed',
      phase: 'interpretation',
      durationMs: 85,
      code: 'observation_network_error',
      transportCode: 'ECONNRESET',
      summary: 'private screen content',
    });
    await (controller as any).runtimeDiagnostics.flush();
    const raw = await readFile(
      join(controller.directory, 'runtime', 'live-diagnostics.json'),
      'utf8',
    );
    const entries = JSON.parse(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0].data).toMatchObject({ kind: 'unexpected_close', closeCode: 1006 });
    expect(entries[1].data).toMatchObject({
      code: 'observation_network_error',
      transportCode: 'ECONNRESET',
    });
    expect(raw).not.toContain('private');
  });

  it('refreshes quietly on the first spoken fragment even while Pip or its backend is busy', async () => {
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    controller.liveMicrophone(true);
    controller.state.session.thinking = true;
    controller.state.speaking = true;
    controls.observation.mockResolvedValue({
      summary: 'A new card reward is visible.',
      reaction: 'Pick that one!',
      usageTokens: 12,
    });
    live.emit('transcript', { role: 'user', delta: 'Which', startMs: 0, endMs: 200 });
    expect(controls.capture).toHaveBeenCalledWith('Game');
    await vi.waitFor(() => expect(live.addContext).toHaveBeenCalledTimes(1));
    expect(live.addContext.mock.calls[0][0]).toContain('speech refresh; captured');
    expect(live.addContext.mock.calls[0][0]).toContain('A new card reward');
    expect(live.say).not.toHaveBeenCalled();
    expect(live.sendText).not.toHaveBeenCalled();
    expect(live.connect).toHaveBeenCalledTimes(1);
  });

  it('coalesces transcript fragments and serializes a newer speech refresh behind cancelled work', async () => {
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    controller.liveMicrophone(true);
    const gate = deferred<{ summary: string; reaction: string; usageTokens: number }>();
    controls.observation.mockReturnValueOnce(gate.promise);
    live.emit('transcript', { role: 'user', delta: 'Which', startMs: 0, endMs: 200 });
    await vi.waitFor(() => expect(controls.observation).toHaveBeenCalledTimes(1));
    live.emit('transcript', { role: 'user', delta: ' card?', startMs: 200, endMs: 600 });
    expect(controls.capture).toHaveBeenCalledTimes(1);
    const firstSignal = controls.observation.mock.calls[0][0].signal;
    expect(firstSignal.aborted).toBe(false);
    live.emit('transcript', { role: 'user', delta: 'Actually', startMs: 2000, endMs: 2200 });
    live.emit('transcript', { role: 'user', delta: 'This one', startMs: 4000, endMs: 4200 });
    expect(firstSignal.aborted).toBe(true);
    expect(controls.capture).toHaveBeenCalledTimes(1);
    gate.resolve({ summary: 'Old card reward.', reaction: 'Old advice.', usageTokens: 10 });
    await vi.waitFor(() => expect(live.addContext).toHaveBeenCalledTimes(1));
    expect(controls.capture).toHaveBeenCalledTimes(2);
    expect(controls.observation).toHaveBeenCalledTimes(2);
    expect(live.addContext.mock.calls[0][0]).not.toContain('Old card reward');
    expect(live.say).not.toHaveBeenCalled();
  });

  it('prioritizes spoken refresh over a pending periodic observation', async () => {
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    controller.liveMicrophone(true);
    const gate = deferred<{ summary: string; reaction: string; usageTokens: number }>();
    controls.observation.mockReturnValueOnce(gate.promise);
    const periodic = (controller as any).observe(true);
    await vi.waitFor(() => expect(controls.observation).toHaveBeenCalledTimes(1));
    live.emit('transcript', { role: 'user', delta: 'What now?', startMs: 0, endMs: 600 });
    expect(controls.observation.mock.calls[0][0].signal.aborted).toBe(true);
    gate.resolve({ summary: 'Old scene.', reaction: 'Old reaction.', usageTokens: 10 });
    await periodic;
    await vi.waitFor(() => expect(live.addContext).toHaveBeenCalledTimes(1));
    expect(live.addContext.mock.calls[0][0]).toContain('speech refresh');
    expect(live.addContext.mock.calls[0][0]).not.toContain('Old scene');
    expect(live.say).not.toHaveBeenCalled();
  });

  it('drops a speech refresh and its queued replacement when paused during OBS capture', async () => {
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    controller.liveMicrophone(true);
    const gate = deferred<{ dataUrl: string; capturedAt: number }>();
    controls.capture.mockReturnValueOnce(gate.promise);
    live.emit('transcript', { role: 'user', delta: 'Look', startMs: 0, endMs: 200 });
    live.emit('transcript', { role: 'user', delta: 'Now', startMs: 2000, endMs: 2200 });
    const pending = (controller as any).observationTask;
    await controller.request({ type: 'pause-session' });
    gate.resolve({ dataUrl: fixtureImage, capturedAt: Date.now() });
    await pending;
    await Promise.resolve();
    expect(controls.capture).toHaveBeenCalledTimes(1);
    expect(controls.observation).not.toHaveBeenCalled();
    expect(live.addContext).not.toHaveBeenCalled();
    expect(live.connect).toHaveBeenCalledTimes(1);
    expect(controller.state.frameUrl).toBeNull();
  });

  it('does not refresh speech frames with the microphone off or a paused session', async () => {
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    live.emit('transcript', { role: 'user', delta: 'Buffered words', startMs: 0, endMs: 200 });
    expect(controls.capture).not.toHaveBeenCalled();
    await controller.request({ type: 'pause-session' });
    controller.liveMicrophone(true);
    live.emit('transcript', { role: 'user', delta: 'More words', startMs: 2000, endMs: 2200 });
    expect(controls.capture).not.toHaveBeenCalled();
    expect(live.connect).toHaveBeenCalledTimes(1);
  });

  it('discards a speech observation after the selected game source changes', async () => {
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    controller.liveMicrophone(true);
    const gate = deferred<{ summary: string; reaction: string; usageTokens: number }>();
    controls.observation.mockReturnValueOnce(gate.promise);
    live.emit('transcript', { role: 'user', delta: 'Which target?', startMs: 0, endMs: 600 });
    await vi.waitFor(() => expect(controls.observation).toHaveBeenCalledTimes(1));
    const pending = (controller as any).observationTask;
    await controller.request({ type: 'save-settings', settings: { obsSource: 'Other game' } });
    gate.resolve({ summary: 'Previous game.', reaction: '', usageTokens: 10 });
    await pending;
    expect(live.addContext).not.toHaveBeenCalled();
    expect(controller.state.frameUrl).toBeNull();
    expect(controller.state.session.status).toBe('paused');
  });

  it('reports a failed speech capture without reopening voice or forwarding an old frame', async () => {
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    controller.liveMicrophone(true);
    const diagnostics = vi.fn();
    controller.on('observation-diagnostic', diagnostics);
    controls.capture.mockRejectedValueOnce(new Error('Could not capture the game.'));
    live.emit('transcript', { role: 'user', delta: 'What now?', startMs: 0, endMs: 400 });
    await vi.waitFor(() => expect(controller.state.notice).toBe('Could not capture the game.'));
    expect(controls.observation).not.toHaveBeenCalled();
    expect(live.addContext).not.toHaveBeenCalled();
    expect(live.sendText).not.toHaveBeenCalled();
    expect(live.connect).toHaveBeenCalledTimes(1);
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'speech',
        outcome: 'failed',
        phase: 'capture',
        code: 'observation_capture_failed',
      }),
    );
  });

  it('discards summaries older than six seconds and reports content-free timing metadata', async () => {
    vi.useFakeTimers();
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    const diagnostics = vi.fn();
    controller.on('observation-diagnostic', diagnostics);
    const gate = deferred<{ summary: string; reaction: string; usageTokens: number }>();
    controls.observation.mockReturnValueOnce(gate.promise);
    const task = (controller as any).observe(true);
    await vi.waitFor(() => expect(controls.observation).toHaveBeenCalledTimes(1));
    vi.setSystemTime(Date.now() + 6100);
    gate.resolve({
      summary: 'Private stale scene.',
      reaction: 'Private stale reaction.',
      usageTokens: 17,
    });
    await task;
    expect(live.addContext).not.toHaveBeenCalled();
    expect(live.say).not.toHaveBeenCalled();
    expect(controller.state.liveUsage.backendTokens).toBe(17);
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'periodic',
        outcome: 'stale',
        phase: 'interpretation',
        capturedAt: expect.any(Number),
        durationMs: expect.any(Number),
      }),
    );
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('Private stale');
  });

  it('does not rejuvenate a stored frame after a failed automatic capture', async () => {
    vi.useFakeTimers();
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    live.emit('tool', { callId: 'first', name: 'capture_game', arguments: {} });
    await Promise.resolve();
    const capturedAt = Date.now();
    vi.setSystemTime(Date.now() + 5000);
    controls.capture.mockRejectedValueOnce(new Error('OBS could not capture.'));
    await expect((controller as any).observe(true)).rejects.toThrow('OBS could not capture');
    await controller.request({ type: 'send-message', text: 'What is there now?' });
    expect(live.sendText).toHaveBeenLastCalledWith('What is there now?', undefined);
    live.emit('tool', { callId: 'context', name: 'get_stream_context', arguments: {} });
    expect(live.submitToolResult.mock.calls.at(-1)[1].capturedAt).toBe(capturedAt);
  });

  it('records bounded connection metadata without conversation, key, image or raw reasons', async () => {
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    live.emit('transcript', {
      role: 'user',
      delta: 'private spoken words',
      startMs: 10,
      endMs: 20,
    });
    live.emit('status', {
      state: 'disconnected',
      message: 'Voice connection was interrupted. Resume to reconnect.',
      code: 'socket_closed',
      intentional: false,
      closeCode: 1006,
    });
    await (controller as any).diagnosticWrites;
    const saved = await readFile(
      join(controller.directory, 'runtime', 'connection-events.json'),
      'utf8',
    );
    expect(JSON.parse(saved).at(-1)).toMatchObject({
      component: 'voice',
      state: 'disconnected',
      code: 'socket_closed',
      closeCode: 1006,
      intentional: false,
    });
    expect(saved).not.toContain(privateKey);
    expect(saved).not.toContain('private spoken words');
    expect(saved).not.toContain(fixtureImage);
    expect(saved).not.toContain('Voice connection was interrupted');
  });

  it('records expected context cancellation without replacing the pause notice, and logs actual faults', async () => {
    const { controller, live } = await make();
    await controller.request({ type: 'start-session' });
    await controller.request({ type: 'pause-session' });
    const notice = controller.state.notice;
    live.emit('diagnostic', { code: 'context_injection_cancelled', intentional: true });
    expect(controller.state.notice).toBe(notice);
    live.emit('fault', {
      code: 'context_injection_incomplete',
      message: 'A game context update did not complete.',
    });
    expect(controller.state.notice).toBe('A game context update did not complete.');
    await (controller as any).diagnosticWrites;
    const entries = JSON.parse(
      await readFile(join(controller.directory, 'runtime', 'connection-events.json'), 'utf8'),
    );
    expect(entries.slice(-2)).toMatchObject([
      {
        component: 'voice',
        state: 'cancelled',
        code: 'context_injection_cancelled',
        intentional: true,
      },
      { component: 'voice', state: 'error', code: 'context_injection_incomplete' },
    ]);
    expect(JSON.stringify(entries)).not.toContain('A game context update did not complete.');
  });
});

describe('public Twitch replies', () => {
  async function ready() {
    const fixture = await make();
    fixture.controller.state.character.name = 'Riff';
    fixture.controller.state.settings.twitchChatReplies = true;
    fixture.twitch.chatAccess = { canSend: true, username: 'streamer' };
    fixture.twitch.statusListener(true, 'Signed in');
    await fixture.controller.request({ type: 'start-session' });
    return fixture;
  }
  const message = (id: string, text = 'Riff, thoughts on this deck?') => ({
    id,
    user: 'Viewer',
    text,
  });
  const flush = async () => {
    for (let n = 0; n < 8; n++) await Promise.resolve();
  };

  it('replies to an addressed viewer with an attributed threaded message and no private dialogue', async () => {
    const { controller, twitch, live } = await ready();
    controller.state.messages.push({
      id: 'private',
      role: 'user',
      text: 'PRIVATE STREAMER WORDS',
      at: Date.now(),
    });
    controller.state.memories.push({ id: 'memory', text: 'PRIVATE MEMORY' });
    twitch.listener(message('viewer-1'));
    await flush();
    expect(twitch.sendReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Riff: That deck has commitment issues.',
        replyToId: 'viewer-1',
      }),
    );
    expect(live.sendText).toHaveBeenCalledTimes(1);
    expect(controller.state.twitchChat.state).toBe('sent');
    expect(JSON.stringify(controls.chatReply.mock.calls)).not.toMatch(
      /PRIVATE STREAMER|PRIVATE MEMORY/,
    );
  });

  it('drops a burst and never queues it; cooldown restarts at confirmed send', async () => {
    vi.useFakeTimers();
    const { twitch } = await ready();
    const gate = deferred<string>();
    controls.chatReply.mockReturnValueOnce(gate.promise);
    twitch.listener(message('first'));
    for (let i = 0; i < 50; i++) twitch.listener(message(`burst-${i}`));
    expect(controls.chatReply).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    gate.resolve('Nice deck. Shame about the pilot.');
    await flush();
    await vi.advanceTimersByTimeAsync(44_999);
    twitch.listener(message('early'));
    expect(twitch.sendReply).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    twitch.listener(message('later'));
    await flush();
    expect(twitch.sendReply).toHaveBeenCalledTimes(2);
  });

  it('keeps the cooldown after an uncertain send and does not retry it', async () => {
    vi.useFakeTimers();
    const { twitch, controller } = await ready();
    const gate = deferred<string>();
    controls.chatReply.mockReturnValueOnce(gate.promise);
    twitch.sendReply.mockRejectedValueOnce(
      new Error('Twitch did not confirm this reply. It will not be retried.'),
    );
    twitch.listener(message('first'));
    await vi.advanceTimersByTimeAsync(5000);
    gate.resolve('This is fine. Probably.');
    await flush();
    expect(controller.state.twitchChat.state).toBe('error');
    await vi.advanceTimersByTimeAsync(40_000);
    twitch.listener(message('too-soon'));
    await flush();
    expect(twitch.sendReply).toHaveBeenCalledTimes(1);
  });

  it.each(['pause-session', 'quiet', 'disconnect-twitch', 'off', 'character', 'channel'] as const)(
    'cancels a delayed reply on %s',
    async (action) => {
      const { controller, twitch } = await ready();
      const gate = deferred<string>();
      controls.chatReply.mockReturnValueOnce(gate.promise);
      twitch.listener(message('first'));
      if (action === 'off')
        await controller.request({ type: 'save-settings', settings: { twitchChatReplies: false } });
      else if (action === 'character')
        await controller.request({
          type: 'save-character',
          character: { ...controller.state.character, personality: 'chill' },
        });
      else if (action === 'channel')
        await controller.request({
          type: 'connect-twitch',
          channel: 'other',
          username: '',
          token: '',
        });
      else await controller.request({ type: action });
      expect(controls.chatReply.mock.calls[0][0].signal.aborted).toBe(true);
      gate.resolve('Late reply');
      await flush();
      expect(twitch.sendReply).not.toHaveBeenCalled();
    },
  );

  it('does not post for guest connections, disabled replies, idle sessions, or incidental name substrings', async () => {
    const { controller, twitch } = await make();
    controller.state.character.name = 'Riff';
    controller.state.settings.twitchChatReplies = true;
    twitch.listener(message('idle'));
    await controller.request({ type: 'start-session' });
    twitch.listener(message('substring', 'That riffraff deck'));
    twitch.listener(message('guest'));
    await flush();
    expect(controls.chatReply).not.toHaveBeenCalled();
    controller.state.settings.twitchChatReplies = false;
    twitch.chatAccess = { canSend: true, username: 'streamer' };
    twitch.statusListener(true, 'Ready');
    twitch.listener(message('disabled'));
    await flush();
    expect(twitch.sendReply).not.toHaveBeenCalled();
  });

  it('does not publish duplicate text or replay a seen viewer message', async () => {
    vi.useFakeTimers();
    const { twitch } = await ready();
    twitch.listener(message('same-id'));
    await flush();
    await vi.advanceTimersByTimeAsync(46_000);
    twitch.listener(message('same-id'));
    twitch.listener(message('new-id'));
    await flush();
    expect(controls.chatReply).toHaveBeenCalledTimes(2);
    expect(twitch.sendReply).toHaveBeenCalledTimes(1);
  });

  it('disconnects the previous channel during authorization and cancels an authorized connection', async () => {
    const { controller, twitch } = await ready();
    vi.spyOn(controller.twitchAuth, 'begin').mockResolvedValue({
      userCode: 'TEST',
      verificationUri: 'https://www.twitch.tv/activate',
      expiresAt: Date.now() + 60000,
    });
    const result = await controller.request({
      type: 'connect-twitch-account',
      channel: 'newchannel',
      clientId: 'publicclientfixture',
    });
    expect(result.ok).toBe(true);
    expect(controller.state.twitchChat.canSend).toBe(false);
    const pending = deferred<void>();
    vi.spyOn(twitch, 'connect').mockReturnValue(pending.promise);
    const disconnect = vi.spyOn(twitch, 'disconnect');
    controller.twitchAuth.emit('authorized', { username: 'streamer', token: 'fixture-token' });
    await controller.request({ type: 'cancel-twitch-auth' });
    expect(disconnect).toHaveBeenCalled();
    pending.resolve();
    await flush();
    expect(controller.state.twitchAuth.message).not.toBe('Signed in as streamer.');
  });
});
