import { beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  states: [] as any[],
  stateCursor: 0,
  refs: [] as { current: any }[],
  refCursor: 0,
  effectDeps: [] as unknown[][],
  effectCursor: 0,
  effects: [] as (() => void)[],
}));
vi.mock('react', () => ({
  useState(initial: unknown) {
    const index = hooks.stateCursor++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [
      hooks.states[index],
      (value: unknown) => {
        hooks.states[index] = value;
      },
    ];
  },
  useRef(initial: unknown) {
    const index = hooks.refCursor++;
    return (hooks.refs[index] ??= { current: initial });
  },
  useCallback: (callback: unknown) => callback,
  useEffect(effect: () => void, deps: unknown[]) {
    const index = hooks.effectCursor++;
    if (!hooks.effectDeps[index] || deps.some((value, i) => value !== hooks.effectDeps[index][i])) {
      hooks.effectDeps[index] = deps;
      hooks.effects.push(effect);
    }
  },
}));
import { useSessionMicrophone } from '../src/renderer/useSessionMicrophone';

type Options = Parameters<typeof useSessionMicrophone>[0];
let options: Options;
function render(patch: Partial<Options> = {}) {
  Object.assign(options, patch);
  hooks.stateCursor = hooks.refCursor = hooks.effectCursor = 0;
  const result = useSessionMicrophone(options);
  for (const effect of hooks.effects.splice(0)) effect();
  return result;
}
function micIntent() {
  return render().requested;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  hooks.states = [];
  hooks.refs = [];
  hooks.effectDeps = [];
  hooks.effects = [];
  options = {
    liveVoice: true,
    sessionActive: false,
    onSessionPage: false,
    request: vi.fn(async () => true),
    showSession: vi.fn(() => {
      render({ onSessionPage: true });
    }),
  };
});

describe('one-action live session and microphone', () => {
  it('waits for a successful Start, then enables the selected mic without a second action', async () => {
    const start = deferred<boolean>();
    options.request = vi.fn(() => start.promise);
    const mic = render();
    const pending = mic.request({ type: 'start-session' });
    expect(options.showSession).toHaveBeenCalledOnce();
    expect(micIntent()).toBe(false);
    render({ sessionActive: true });
    start.resolve(true);
    expect(await pending).toBe(true);
    expect(micIntent()).toBe(true);
  });

  it('does not enable capture after failed Start or in Codex mode', async () => {
    options.request = vi.fn(async () => false);
    expect(await render().request({ type: 'start-session' })).toBe(false);
    expect(micIntent()).toBe(false);
    options.request = vi.fn(async () => true);
    const mic = render({ liveVoice: false, sessionActive: true });
    await mic.request({ type: 'start-session' });
    expect(micIntent()).toBe(false);
  });

  it('keeps a muted mic muted across automatic transport recovery, but explicit Resume enables it', async () => {
    let mic = render({ onSessionPage: true, sessionActive: true });
    await mic.request({ type: 'start-session' });
    expect(micIntent()).toBe(true);
    mic = render();
    mic.setRequested(false);
    // Transport loss/recovery does not change an active session or the user's mic choice.
    expect(micIntent()).toBe(false);
    expect(micIntent()).toBe(false);
    await render().request({ type: 'start-session' });
    expect(micIntent()).toBe(true);
  });

  it('preserves an enabled mic intent during recovery while capture can be gated by the transport', async () => {
    await render({ onSessionPage: true, sessionActive: true }).request({ type: 'start-session' });
    expect(micIntent()).toBe(true);
    expect(micIntent()).toBe(true);
  });

  it('turns the mic off immediately when Pause is pressed, without waiting for the backend', async () => {
    await render({ onSessionPage: true, sessionActive: true }).request({ type: 'start-session' });
    const pause = deferred<boolean>();
    options.request = vi.fn(() => pause.promise);
    const pending = render().request({ type: 'pause-session' });
    expect(micIntent()).toBe(false);
    pause.resolve(true);
    await pending;
  });

  it.each([{ onSessionPage: false }, { sessionActive: false }, { liveVoice: false }])(
    'stops listening after leaving the active live flow: %j',
    async (patch) => {
      await render({ onSessionPage: true, sessionActive: true }).request({ type: 'start-session' });
      expect(micIntent()).toBe(true);
      render(patch);
      expect(micIntent()).toBe(false);
      render({ onSessionPage: true, sessionActive: true, liveVoice: true });
      expect(micIntent()).toBe(false);
    },
  );

  it('does not reopen the mic when an old Start completes after Pause', async () => {
    const start = deferred<boolean>();
    options.request = vi.fn((command) =>
      command.type === 'start-session' ? start.promise : Promise.resolve(true),
    );
    const pending = render().request({ type: 'start-session' });
    await render().request({ type: 'pause-session' });
    start.resolve(true);
    await pending;
    expect(micIntent()).toBe(false);
  });

  it('does not reopen the mic when Start completes after navigating away', async () => {
    const start = deferred<boolean>();
    options.request = vi.fn(() => start.promise);
    const pending = render().request({ type: 'start-session' });
    render({ onSessionPage: false });
    start.resolve(true);
    await pending;
    expect(micIntent()).toBe(false);
  });
});
