import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ sockets: [] as any[] }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    default: class extends EventEmitter {
      static OPEN = 1;
      readyState = 0;
      bufferedAmount = 0;
      sent: any[] = [];
      constructor(
        public url: string,
        public options: unknown,
      ) {
        super();
        state.sockets.push(this);
      }
      send(raw: string) {
        this.sent.push(JSON.parse(raw));
      }
      close() {
        this.readyState = 3;
        this.emit('close');
      }
      terminate() {
        this.close();
      }
      open() {
        this.readyState = 1;
        this.emit('open');
      }
      server(event: unknown) {
        this.emit('message', Buffer.from(JSON.stringify(event)));
      }
    },
  };
});
import {
  LiveBridge,
  sanitizeLiveTransportDiagnostic,
  type LiveConnectOptions,
  type LiveTransportDiagnostic,
} from '../src/main/live';

const options: LiveConnectOptions = {
  apiKey: 'local-test-key-never-sent',
  instructions: 'Be Pip, a concise friendly companion. Delegate questions about the game.',
  backendInstructions: 'Use the capture_game tool for fresh visual evidence.',
  tools: [
    { type: 'web_search' },
    {
      type: 'function',
      name: 'capture_game',
      description: 'Read the selected game input.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
};
const clients: LiveBridge[] = [];
function make() {
  const bridge = new LiveBridge();
  clients.push(bridge);
  return bridge;
}
async function ready(bridge = make()) {
  const promise = bridge.connect(options);
  const socket = state.sockets.at(-1);
  socket.open();
  socket.server({ type: 'session.started', session: { id: 'live_test', model: 'gpt-live-1' } });
  await promise;
  return { bridge, socket };
}
const backend = (event: unknown) => ({ type: 'response.event', delegation_id: 'del_1', event });
const call = (id = 'call_1', name = 'capture_game', args = '{}') =>
  backend({
    type: 'response.output_item.done',
    item: { type: 'function_call', call_id: id, name, arguments: args },
  });

beforeEach(() => {
  state.sockets.length = 0;
});
afterEach(async () => {
  for (const bridge of clients) {
    const closing = bridge.close();
    for (const socket of state.sockets)
      if (socket.readyState === 1) socket.server({ type: 'session.closed', usage: { seconds: 1 } });
    await closing;
  }
  clients.length = 0;
  vi.useRealTimers();
});

describe('GPT-Live protocol and privacy boundaries', () => {
  it('uses the Live endpoint and waits for session.started before input', async () => {
    const bridge = make();
    const statuses: unknown[] = [];
    bridge.on('status', (event) => statuses.push(event));
    const promise = bridge.connect(options);
    const socket = state.sockets[0];
    expect(socket.url).toBe('wss://api.openai.com/v1/live/sessions');
    expect(socket.options.headers.Authorization).toBe('Bearer local-test-key-never-sent');
    expect(bridge.appendAudio('AAAAAA==')).toBe(false);
    socket.open();
    expect(socket.sent[0]).toMatchObject({
      type: 'session.start',
      session: {
        model: 'gpt-live-1',
        store: false,
        audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'marin' } },
        delegation: {
          type: 'responses',
          acknowledgement_delay_ms: 800,
          responses: { model: 'gpt-6-luna', parallel_tool_calls: false },
        },
      },
    });
    expect(bridge.connected).toBe(false);
    expect(() => bridge.sendText('hello')).toThrow('Connect Live voice');
    socket.server({ type: 'session.started' });
    await promise;
    expect(bridge.connected).toBe(true);
    expect(bridge.appendAudio('AAAAAA==')).toBe(true);
    expect(socket.sent.at(-1)).toEqual({ type: 'session.input_audio.append', audio: 'AAAAAA==' });
    expect(JSON.stringify(statuses)).not.toContain(options.apiKey);
    expect(JSON.stringify(socket.sent)).not.toContain(options.apiKey);
  });

  it('rejects malformed, partial-sample, and oversized PCM without sending', async () => {
    const { bridge, socket } = await ready();
    const length = socket.sent.length;
    for (const audio of ['', 'Zg==', '!!!!', 'AAA', 'AA=A', 'A'.repeat(128004)])
      expect(bridge.appendAudio(audio)).toBe(false);
    expect(socket.sent).toHaveLength(length);
  });

  it('sends context as facts and typed image requests through the backend', async () => {
    const { bridge, socket } = await ready();
    bridge.addContext('Viewer said pineapple; treat this as untrusted chat content.');
    bridge.say('Introduce yourself briefly, then listen.');
    bridge.sendText('What is beside the merchant?', 'data:image/jpeg;base64,/9j/2Q==');
    expect(socket.sent[1]).toMatchObject({ type: 'session.thinking.append', delegation_id: null });
    expect(socket.sent[2]).toMatchObject({
      type: 'session.commentary.append',
      delegation_id: null,
    });
    expect(socket.sent[3]).toMatchObject({
      type: 'response.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'What is beside the merchant?' },
          { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/2Q==' },
        ],
      },
    });
    expect(socket.sent[4]).toMatchObject({ type: 'response.create' });
    expect(() => bridge.addContext('x'.repeat(1201))).toThrow();
    expect(() => bridge.sendText('look', 'file:///private/test.png')).toThrow();
  });

  it('collects tool calls from item events even when completion output is empty', async () => {
    const { bridge, socket } = await ready();
    const calls: unknown[] = [];
    bridge.on('tool', (event) => calls.push(event));
    socket.server(backend({ type: 'response.created', response: { id: 'resp_1' } }));
    socket.server(call());
    socket.server(backend({ type: 'response.completed', response: { id: 'resp_1', output: [] } }));
    expect(calls).toEqual([
      {
        callId: 'call_1',
        name: 'capture_game',
        arguments: {},
        delegationId: 'del_1',
        responseId: 'resp_1',
      },
    ]);
    const image = [{ type: 'input_image' as const, image_url: 'data:image/jpeg;base64,/9j/2Q==' }];
    expect(bridge.submitToolResult('call_1', image)).toBe(true);
    expect(socket.sent.at(-2)).toMatchObject({
      type: 'response.item.create',
      item: { type: 'function_call_output', call_id: 'call_1', output: image },
    });
    expect(socket.sent.at(-1).type).toBe('response.create');
    expect(bridge.submitToolResult('call_1', 'duplicate')).toBe(false);
    socket.server(call());
    expect(calls).toHaveLength(1);
  });

  it('waits for all known pending tool results and rejects unknown functions', async () => {
    const { bridge, socket } = await ready();
    const run = vi.fn();
    bridge.on('tool', run);
    socket.server(call('a'));
    socket.server(call('b'));
    const count = socket.sent.length;
    bridge.submitToolResult('a', { ok: true });
    expect(socket.sent.slice(count).map((x: any) => x.type)).toEqual(['response.item.create']);
    bridge.submitToolResult('b', { ok: true });
    expect(socket.sent.at(-1).type).toBe('response.create');
    socket.server(call('c', 'run_shell', '{"command":"bad"}'));
    socket.server(call('d', 'capture_game', '[]'));
    expect(run).toHaveBeenCalledTimes(2);
    expect(socket.sent.at(-2).item.output).toContain('Tool unavailable');
  });

  it('does not end a healthy long session after successful tool calls', async () => {
    const { bridge, socket } = await ready();
    const run = vi.fn();
    const fault = vi.fn();
    bridge.on('tool', run);
    bridge.on('fault', fault);
    // Leave one slow operation pending while the recent completed-call history rotates.
    socket.server(call('slow'));
    for (let i = 0; i < 1050; i++) {
      socket.server(call(`completed_${i}`));
      expect(bridge.submitToolResult(`completed_${i}`, { ok: true })).toBe(true);
    }
    socket.server(call('slow'));
    socket.server(call('completed_1049'));
    expect(run).toHaveBeenCalledTimes(1051);
    expect(bridge.submitToolResult('slow', { ok: true })).toBe(true);
    expect(bridge.connected).toBe(true);
    expect(fault).not.toHaveBeenCalled();
  });

  it('still bounds unfinished tool work', async () => {
    const { bridge, socket } = await ready();
    const run = vi.fn();
    const fault = vi.fn();
    bridge.on('tool', run);
    bridge.on('fault', fault);
    for (let i = 0; i < 9; i++) socket.server(call(`pending_${i}`));
    expect(run).toHaveBeenCalledTimes(8);
    expect(bridge.connected).toBe(false);
    expect(fault).toHaveBeenCalledWith(expect.objectContaining({ code: 'tool_limit' }));
  });

  it('quietly cancels pending automatic acknowledgements for Responses delegations', async () => {
    const { socket } = await ready();
    socket.server({
      type: 'session.delegation.created',
      event_id: 'delegation_event',
      delegation: { id: 'del_1', target: 'responses', response_id: 'resp_1' },
    });
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'session.thinking.append',
      delegation_id: null,
      content: '',
    });
    const count = socket.sent.length;
    socket.server({
      type: 'session.delegation.created',
      event_id: 'delegation_event',
      delegation: { id: 'del_1', target: 'responses' },
    });
    socket.server({
      type: 'session.delegation.created',
      delegation: { id: 'del_client', target: 'client' },
    });
    expect(socket.sent).toHaveLength(count);
  });

  it('does not mark backend work active after its acknowledgement update loses the connection', async () => {
    const { bridge, socket } = await ready();
    const activity = vi.fn();
    bridge.on('backend', activity);
    socket.bufferedAmount = 5 * 1024 * 1024;
    socket.server({
      type: 'session.delegation.created',
      delegation: { id: 'del_1', target: 'responses' },
    });
    expect(bridge.connected).toBe(false);
    expect(activity).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }));
  });

  it('keeps duplex transcript fragments and audio separate without inventing done events', async () => {
    const { bridge, socket } = await ready();
    const transcripts: unknown[] = [],
      audio: unknown[] = [];
    bridge.on('transcript', (event) => transcripts.push(event));
    bridge.on('audio', (event) => audio.push(event));
    socket.server({
      type: 'session.input_transcript.delta',
      event_id: 'a',
      delta: 'I think',
      start_ms: 100,
      end_ms: 200,
    });
    socket.server({
      type: 'session.output_transcript.delta',
      event_id: 'b',
      delta: ' Sure.',
      start_ms: 150,
      end_ms: 300,
    });
    socket.server({
      type: 'session.input_transcript.delta',
      event_id: 'a',
      delta: 'I think',
      start_ms: 100,
      end_ms: 200,
    });
    socket.server({ type: 'session.output_audio.delta', delta: 'AAAAAA==' });
    expect(transcripts).toEqual([
      { role: 'user', delta: 'I think', startMs: 100, endMs: 200 },
      { role: 'companion', delta: ' Sure.', startMs: 150, endMs: 300 },
    ]);
    expect(audio).toEqual([{ delta: 'AAAAAA==', sampleRate: 24000 }]);
  });

  it('records cumulative voice usage and confirms only session.closed finalization', async () => {
    const { bridge, socket } = await ready();
    const usage: unknown[] = [];
    const status = vi.fn(),
      fault = vi.fn();
    bridge.on('status', status);
    bridge.on('fault', fault);
    bridge.on('usage', (event) => usage.push(event));
    socket.server({ type: 'session.usage.updated', usage: { seconds: 12 } });
    socket.server({ type: 'session.usage.updated', usage: { seconds: 15 } });
    const promise = bridge.close();
    expect(socket.readyState).toBe(1);
    expect(socket.sent.at(-1).type).toBe('session.close');
    expect(bridge.appendAudio('AAAAAA==')).toBe(false);
    socket.server({ type: 'session.closed', usage: { seconds: 16 }, reason: 'close_requested' });
    await promise;
    expect(usage).toEqual([
      { final: false, voiceSeconds: 12 },
      { final: false, voiceSeconds: 15 },
      { final: true, voiceSeconds: 16 },
    ]);
    expect(socket.readyState).toBe(3);
    expect(status).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: 'close_requested', intentional: true }),
    );
    expect(fault).not.toHaveBeenCalled();
  });

  it.each([
    ['expired', 'time limit'],
    ['content', 'safety check'],
    ['remote_hangup', 'remotely'],
    ['connection_lost', 'lost its connection'],
    ['close_requested', 'outside this app'],
  ])(
    'preserves the server close reason %s and asks for an explicit restart',
    async (reason, explanation) => {
      const { bridge, socket } = await ready();
      const status = vi.fn(),
        fault = vi.fn(),
        usage = vi.fn();
      bridge.on('status', status);
      bridge.on('fault', fault);
      bridge.on('usage', usage);
      socket.server({ type: 'session.closed', reason, usage: { seconds: 240 } });
      expect(bridge.connected).toBe(false);
      expect(status).toHaveBeenLastCalledWith(
        expect.objectContaining({
          state: 'disconnected',
          code: reason,
          intentional: false,
          message: expect.stringContaining(explanation),
        }),
      );
      expect(fault).toHaveBeenCalledOnce();
      expect(usage).toHaveBeenLastCalledWith({ final: true, voiceSeconds: 240 });
    },
  );

  it('does not expose arbitrary close reasons or WebSocket error text', async () => {
    const { bridge, socket } = await ready();
    const status = vi.fn(),
      fault = vi.fn();
    bridge.on('status', status);
    bridge.on('fault', fault);
    socket.emit('close', 1006, Buffer.from(`private audio ${options.apiKey}`));
    expect(status).toHaveBeenLastCalledWith(
      expect.objectContaining({
        code: 'connection_lost',
        closeCode: 1006,
        intentional: false,
        message: expect.stringContaining('WebSocket 1006'),
      }),
    );
    await ready(bridge);
    state.sockets
      .at(-1)
      .server({ type: 'session.closed', reason: options.apiKey, usage: { seconds: 1 } });
    expect(status).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: 'session_ended', intentional: false }),
    );
    expect(JSON.stringify([status.mock.calls, fault.mock.calls])).not.toContain(options.apiKey);
    expect(JSON.stringify([status.mock.calls, fault.mock.calls])).not.toContain('private audio');
  });

  it('keeps a recent sanitized API error when the connection subsequently closes', async () => {
    const { bridge, socket } = await ready();
    const status = vi.fn();
    bridge.on('status', status);
    socket.server({
      type: 'error',
      error: { code: 'rate_limit_exceeded', message: options.apiKey },
    });
    socket.emit('close', 1011, Buffer.from(options.apiKey));
    expect(status).toHaveBeenLastCalledWith(
      expect.objectContaining({
        code: 'rate_limit_exceeded',
        closeCode: 1011,
        intentional: false,
        message: expect.stringContaining('billing and limits'),
      }),
    );
    expect(JSON.stringify(status.mock.calls)).not.toContain(options.apiKey);
  });

  it('reports incomplete backend work without closing the voice conversation', async () => {
    const { bridge, socket } = await ready();
    const fault = vi.fn();
    bridge.on('fault', fault);
    socket.server(
      backend({
        type: 'response.incomplete',
        response: {
          id: 'resp_short',
          incomplete_details: { reason: 'max_output_tokens' },
        },
      }),
    );
    expect(fault).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: 'backend_output_limit' }),
    );
    socket.server(
      backend({
        type: 'response.failed',
        response: {
          id: 'resp_error',
          error: { code: 'rate_limit_exceeded', message: options.apiKey },
        },
      }),
    );
    expect(fault).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: 'rate_limit_exceeded' }),
    );
    expect(JSON.stringify(fault.mock.calls)).not.toContain(options.apiKey);
    expect(bridge.connected).toBe(true);
  });

  it('bounds close latency and ignores stale events after reconnect', async () => {
    vi.useFakeTimers();
    const { bridge, socket } = await ready();
    const usage: unknown[] = [];
    bridge.on('usage', (event) => usage.push(event));
    const closing = bridge.close();
    await vi.advanceTimersByTimeAsync(5000);
    await closing;
    expect(usage.at(-1)).toEqual({ final: false, voiceSeconds: 0 });
    await ready(bridge);
    const transcript = vi.fn();
    bridge.on('transcript', transcript);
    socket.server({
      type: 'session.output_transcript.delta',
      delta: 'old',
      start_ms: 1,
      end_ms: 2,
    });
    expect(transcript).not.toHaveBeenCalled();
    expect(bridge.submitToolResult('stale', 'old')).toBe(false);
  });

  it('keeps an intentional stop distinct when sending the close request fails', async () => {
    const { bridge, socket } = await ready();
    const status = vi.fn(),
      fault = vi.fn(),
      usage = vi.fn();
    bridge.on('status', status);
    bridge.on('fault', fault);
    bridge.on('usage', usage);
    socket.send = () => {
      throw new Error(`private ${options.apiKey}`);
    };
    await bridge.close();
    expect(status).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: 'close_interrupted', intentional: true }),
    );
    expect(usage).toHaveBeenLastCalledWith({ final: false, voiceSeconds: 0 });
    expect(fault).not.toHaveBeenCalled();
    expect(JSON.stringify(status.mock.calls)).not.toContain(options.apiKey);
    expect(bridge.connected).toBe(false);
  });

  it.each(['nested', 'outer'])(
    'classifies a known pending context append cancelled by close (%s event ID)',
    async (location) => {
      const { bridge, socket } = await ready();
      const fault = vi.fn(),
        diagnostic = vi.fn(),
        transportDiagnostic = vi.fn();
      bridge.on('fault', fault);
      bridge.on('diagnostic', diagnostic);
      bridge.on('transport-diagnostic', transportDiagnostic);
      bridge.addContext('Private game context');
      const eventId = socket.sent.at(-1).event_id;
      const closing = bridge.close();
      socket.server({
        type: 'error',
        ...(location === 'outer' ? { client_event_id: eventId } : {}),
        error: {
          code: 'context_injection_incomplete',
          message: `private ${options.apiKey}`,
          ...(location === 'nested' ? { client_event_id: eventId } : {}),
        },
      });
      expect(fault).not.toHaveBeenCalled();
      expect(transportDiagnostic).not.toHaveBeenCalled();
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
        code: 'context_injection_cancelled',
        intentional: true,
      });
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('Private game context');
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(options.apiKey);
      socket.server({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 20 } });
      await closing;
    },
  );

  it('still surfaces incomplete context during an active session and unknown close-time errors', async () => {
    const { bridge, socket } = await ready();
    const fault = vi.fn(),
      diagnostic = vi.fn();
    bridge.on('fault', fault);
    bridge.on('diagnostic', diagnostic);
    bridge.addContext('Current scene');
    const activeId = socket.sent.at(-1).event_id;
    socket.server({
      type: 'error',
      error: { code: 'context_injection_incomplete', client_event_id: activeId },
    });
    expect(fault).toHaveBeenCalledTimes(1);
    expect(bridge.connected).toBe(true);
    bridge.say('A verified game reaction');
    const acknowledgedId = socket.sent.at(-1).event_id;
    socket.server({ type: 'session.commentary.appended', client_event_id: acknowledgedId });
    bridge.addContext('Another update');
    const otherId = socket.sent.at(-1).event_id;
    const closing = bridge.close();
    for (const clientEventId of [undefined, 'unknown_event', acknowledgedId]) {
      socket.server({
        type: 'error',
        error: { code: 'context_injection_incomplete', client_event_id: clientEventId },
      });
    }
    socket.server({
      type: 'error',
      error: { code: 'invalid_request_error', client_event_id: otherId },
    });
    expect(fault).toHaveBeenCalledTimes(5);
    expect(diagnostic).not.toHaveBeenCalled();
    socket.server({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 20 } });
    await closing;
  });

  it('sanitizes server error text and fails asynchronous backend validation', async () => {
    const { bridge, socket } = await ready();
    const fault = vi.fn();
    bridge.on('fault', fault);
    socket.server({
      type: 'error',
      error: {
        code: 'responses_validation_failed',
        message: `untrusted ${options.apiKey} private prompt`,
        param: 'tools',
      },
    });
    expect(bridge.connected).toBe(false);
    expect(fault).toHaveBeenCalledWith({
      code: 'responses_validation_failed',
      message:
        'OpenAI could not validate the Live tool backend. Check its model and tool configuration.',
    });
    expect(JSON.stringify(fault.mock.calls)).not.toContain(options.apiKey);
  });

  it.each(['nested', 'outer'])(
    'correlates an API rejection with an outgoing event type without retaining content (%s ID)',
    async (location) => {
      const { bridge, socket } = await ready();
      const diagnostics: LiveTransportDiagnostic[] = [];
      bridge.on('transport-diagnostic', (event) => diagnostics.push(event));
      bridge.addContext(`Private screen and chat: ${options.apiKey}`);
      const eventId = socket.sent.at(-1).event_id;
      socket.server({
        type: 'error',
        ...(location === 'outer' ? { client_event_id: eventId } : {}),
        error: {
          code: 'invalid_request_error',
          type: 'invalid_request_error',
          param: 'delegation_id',
          message: `Private failure: ${options.apiKey}`,
          ...(location === 'nested' ? { client_event_id: eventId } : {}),
        },
      });
      expect(diagnostics).toEqual([
        {
          kind: 'api_error',
          sessionElapsedMs: expect.any(Number),
          lastReceivedAgeMs: 0,
          bufferedBytes: 0,
          pendingToolCount: 0,
          pendingContextCount: 0,
          outgoingEventType: 'session.thinking.append',
          apiErrorCode: 'invalid_request_error',
          apiErrorType: 'invalid_request_error',
          apiErrorParam: 'delegation_id',
        },
      ]);
      expect(bridge.connected).toBe(true);
      const serialized = JSON.stringify(diagnostics);
      for (const privateValue of [eventId, options.apiKey, 'Private screen', 'Private failure'])
        expect(serialized).not.toContain(privateValue);
    },
  );

  it('bounds control-event correlation and does not log or retain continuously sent audio', async () => {
    const { bridge, socket } = await ready();
    const diagnostic = vi.fn();
    bridge.on('transport-diagnostic', diagnostic);
    bridge.addContext('Old private context');
    const oldId = socket.sent.at(-1).event_id;
    for (let index = 0; index < 128; index++) bridge.say(`Private reaction ${index}`);
    const recentId = socket.sent.at(-1).event_id;
    for (let index = 0; index < 300; index++) bridge.appendAudio('AQACAA==');
    expect(diagnostic).not.toHaveBeenCalled();
    for (const client_event_id of [oldId, recentId])
      socket.server({
        type: 'error',
        error: { code: 'invalid_request_error', client_event_id },
      });
    expect(diagnostic.mock.calls[0][0]).not.toHaveProperty('outgoingEventType');
    expect(diagnostic.mock.calls[1][0]).toMatchObject({
      kind: 'api_error',
      outgoingEventType: 'session.commentary.append',
    });
    const serialized = JSON.stringify(diagnostic.mock.calls);
    for (const privateValue of [oldId, recentId, 'AQACAA==', 'Private reaction', 'Old private'])
      expect(serialized).not.toContain(privateValue);
    const closing = bridge.close();
    socket.server({ type: 'session.closed', reason: 'close_requested' });
    await closing;
    const next = await ready(bridge);
    next.socket.server({
      type: 'error',
      error: { code: 'invalid_request_error', client_event_id: recentId },
    });
    expect(diagnostic.mock.calls.at(-1)?.[0]).not.toHaveProperty('outgoingEventType');
  });

  it('snapshots transport timing and queue metadata before unexpected-close cleanup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { bridge, socket } = await ready();
    const diagnostic = vi.fn();
    bridge.on('transport-diagnostic', diagnostic);
    bridge.addContext('Private observation');
    socket.server(call('private_call_id'));
    await vi.advanceTimersByTimeAsync(2000);
    socket.server({ type: 'session.output_audio.delta', delta: 'AQACAA==' });
    await vi.advanceTimersByTimeAsync(750);
    socket.bufferedAmount = 1234;
    socket.emit('close', 1006, Buffer.from(options.apiKey));
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
      kind: 'unexpected_close',
      sessionElapsedMs: 2750,
      lastReceivedAgeMs: 750,
      bufferedBytes: 1234,
      pendingToolCount: 1,
      pendingContextCount: 1,
      closeCode: 1006,
    });
    expect(bridge.connected).toBe(false);
  });

  it('retains known socket errno only, never arbitrary socket errors', async () => {
    const diagnostic = vi.fn();
    for (const [code, expected] of [
      ['ECONNRESET', 'ECONNRESET'],
      [options.apiKey, 'unknown'],
    ]) {
      const { bridge, socket } = await ready();
      bridge.on('transport-diagnostic', diagnostic);
      socket.emit('error', Object.assign(new Error(options.apiKey), { code }));
      expect(diagnostic).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'socket_error', socketErrorCode: expected }),
      );
      expect(bridge.connected).toBe(false);
    }
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(options.apiKey);
  });

  it('records only the HTTP status when the WebSocket handshake is rejected', async () => {
    const bridge = make();
    const diagnostic = vi.fn();
    bridge.on('transport-diagnostic', diagnostic);
    const connecting = bridge.connect(options);
    const rejected = expect(connecting).rejects.toThrow('OpenAI Live could not complete');
    const socket = state.sockets.at(-1);
    socket.emit(
      'unexpected-response',
      { key: options.apiKey },
      {
        statusCode: 503,
        headers: { 'private-header': options.apiKey },
        resume: vi.fn(),
      },
    );
    await rejected;
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
      kind: 'handshake_error',
      sessionElapsedMs: expect.any(Number),
      lastReceivedAgeMs: null,
      bufferedBytes: 0,
      pendingToolCount: 0,
      pendingContextCount: 0,
      httpStatus: 503,
    });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(options.apiKey);
  });

  it('rejects arbitrary diagnostic fields and malicious API strings at the sanitizer boundary', async () => {
    const secret = 'private_content_that_looks_like_a_code';
    const safe = sanitizeLiveTransportDiagnostic({
      kind: 'api_error',
      sessionElapsedMs: -20,
      lastReceivedAgeMs: Number.NaN,
      bufferedBytes: Number.POSITIVE_INFINITY,
      pendingToolCount: 1.5,
      pendingContextCount: 2,
      outgoingEventType: secret,
      apiErrorCode: secret,
      apiErrorType: secret,
      apiErrorParam: `item.content.${secret}`,
      socketErrorCode: secret,
      closeCode: 999,
      httpStatus: 900,
      client_event_id: secret,
      message: secret,
      content: secret,
      audio: secret,
    });
    expect(safe).toEqual({
      kind: 'api_error',
      sessionElapsedMs: 0,
      lastReceivedAgeMs: 0,
      bufferedBytes: 0,
      pendingToolCount: 1,
      pendingContextCount: 2,
      apiErrorCode: 'unknown',
      apiErrorType: 'unknown',
      apiErrorParam: 'unknown',
      socketErrorCode: 'unknown',
    });
    expect(sanitizeLiveTransportDiagnostic({ kind: secret })).toBeNull();
    const { bridge, socket } = await ready();
    const diagnostic = vi.fn();
    bridge.on('transport-diagnostic', diagnostic);
    socket.server({
      type: 'error',
      client_event_id: secret,
      error: { code: secret, type: secret, param: `tools[${secret}]`, message: secret },
    });
    expect(diagnostic).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'api_error',
        apiErrorCode: 'unknown',
        apiErrorType: 'unknown',
        apiErrorParam: 'unknown',
      }),
    );
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(secret);
  });

  it('times out startup and prevents unbounded queued audio', async () => {
    vi.useFakeTimers();
    const bridge = make();
    const started = bridge.connect(options).catch((error) => error.message);
    state.sockets.at(-1).open();
    await vi.advanceTimersByTimeAsync(20000);
    expect(await started).toMatch('did not become ready');
    const { socket } = await ready(bridge);
    socket.bufferedAmount = 5 * 1024 * 1024;
    expect(bridge.appendAudio('AAAAAA==')).toBe(false);
    expect(bridge.connected).toBe(false);
  });

  it('allows one valid screenshot burst without mistaking it for stalled audio', async () => {
    const { bridge, socket } = await ready();
    const send = socket.send.bind(socket);
    socket.send = (raw: string) => {
      send(raw);
      if (JSON.parse(raw).type === 'response.item.create')
        socket.bufferedAmount = Buffer.byteLength(raw);
    };
    bridge.sendText('What is visible?', `data:image/jpeg;base64,${'A'.repeat(2.5 * 1024 * 1024)}`);
    expect(socket.sent.at(-1).type).toBe('response.create');
    expect(bridge.appendAudio('AAAAAA==')).toBe(true);
    expect(bridge.connected).toBe(true);
    // Graceful shutdown must remain possible even when regular sends are backpressured.
    socket.bufferedAmount = 5 * 1024 * 1024;
    const closing = bridge.close();
    expect(socket.sent.at(-1).type).toBe('session.close');
    socket.server({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 1 } });
    await closing;
  });
});
