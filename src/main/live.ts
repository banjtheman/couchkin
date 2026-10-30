import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  diagnosticOutgoingType,
  sanitizeLiveTransportDiagnostic,
  type LiveDiagnosticOutgoingType,
  type LiveTransportDiagnostic,
} from './live-diagnostics';
export { sanitizeLiveTransportDiagnostic, type LiveTransportDiagnostic } from './live-diagnostics';

// GPT-Live is a continuous audio session, not the turn-based Realtime protocol.
// https://developers.openai.com/api/docs/guides/voice-websockets?api=live
// https://developers.openai.com/api/docs/guides/live-delegation
const LIVE_URL = 'wss://api.openai.com/v1/live/sessions';
const START_TIMEOUT_MS = 20_000;
const CLOSE_TIMEOUT_MS = 5_000;
const MAX_AUDIO_BASE64 = 128_000;
// A permitted screenshot/tool result can itself be 3 MiB. Leave room for that
// single frame plus control/audio events, while still bounding a stalled socket.
const MAX_SOCKET_BUFFER = 4 * 1024 * 1024;
const MAX_RECENT_TOOL_CALLS = 1024;
const MAX_PENDING_TOOL_CALLS = 8;
const MAX_DIAGNOSTIC_EVENTS = 128;
const ACKNOWLEDGEMENT_DELAY_MS = 800;
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : null;

export type LiveContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: 'low' | 'high' | 'auto' };
export interface LiveHistoryMessage {
  role: 'user' | 'assistant' | 'developer';
  text: string;
}
export interface LiveConnectOptions {
  apiKey: string;
  voice?: string;
  instructions: string;
  backendInstructions: string;
  tools: RecordValue[];
  backendModel?: string;
  history?: LiveHistoryMessage[];
}
export interface LiveToolCall {
  callId: string;
  name: string;
  arguments: RecordValue;
  delegationId: string | null;
  responseId: string | null;
}
export interface LiveTranscript {
  role: 'user' | 'companion';
  delta: string;
  startMs: number;
  endMs: number;
}
export interface LiveUsage {
  final: boolean;
  voiceSeconds?: number;
  backend?: { responseId: string; inputTokens: number; outputTokens: number; totalTokens: number };
}
export interface LiveStatus {
  state: 'connecting' | 'connected' | 'disconnected' | 'error';
  message: string;
  code?: string;
  intentional?: boolean;
  closeCode?: number;
}

function checkedText(text: string, limit: number): string {
  if (typeof text !== 'string' || !text.trim() || text.length > limit)
    throw new Error('Live context is empty or too long.');
  return text;
}
function validPcm(value: unknown): value is string {
  if (typeof value !== 'string' || !value.length || value.length > MAX_AUDIO_BASE64) return false;
  if (value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.length % 2 === 0 && bytes.toString('base64') === value;
}
function safeCode(value: unknown): string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,70}$/.test(value)
    ? value
    : 'request_failed';
}
function errorMessage(code: string): string {
  if (/auth|api_key/.test(code)) return 'OpenAI rejected the API key. Check your local .env file.';
  if (/quota|billing|rate_limit/.test(code))
    return 'OpenAI usage or rate limit reached. Check your API project billing and limits.';
  if (/model|permission|access/.test(code))
    return 'This OpenAI project cannot use the selected Live or backend model.';
  if (code === 'responses_validation_failed')
    return 'OpenAI could not validate the Live tool backend. Check its model and tool configuration.';
  return `OpenAI Live could not complete a request (${code}).`;
}
const closeReasons: Record<string, string> = {
  expired: 'OpenAI’s live-session time limit was reached. Resume to start a new session.',
  content: 'OpenAI ended this Live session after a safety check. Resume when ready.',
  remote_hangup: 'OpenAI ended the Live session remotely. Resume to reconnect.',
  connection_lost: 'The Live session lost its connection. Check your network, then Resume.',
  close_requested: 'The Live session was closed outside this app. Resume to reconnect.',
};

/** Credentials never leave this main-process transport or enter emitted state. */
export class LiveBridge extends EventEmitter {
  private socket: WebSocket | null = null;
  private epoch = 0;
  private ready = false;
  private closing = false;
  private finalized = false;
  private lastSeconds = 0;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private settleStart: ((error?: Error) => void) | null = null;
  private finishClose: (() => void) | null = null;
  private closingPromise: Promise<void> | null = null;
  private pending = new Map<string, LiveToolCall>();
  private seenCalls = new Set<string>();
  private seenEvents = new Set<string>();
  private allowedFunctions = new Set<string>();
  private responseIds = new Map<string, string>();
  private backendUsageIds = new Set<string>();
  private pendingContextEvents = new Set<string>();
  private lastApiError: { code: string; message: string; at: number } | null = null;
  private diagnosticStartedAt: number | null = null;
  private diagnosticLastReceivedAt: number | null = null;
  // Correlation stores local IDs and fixed event names only, never request bodies.
  private diagnosticOutgoing = new Map<string, LiveDiagnosticOutgoingType>();

  get connected() {
    return this.ready && !this.closing && this.socket?.readyState === WebSocket.OPEN;
  }

  async connect(options: LiveConnectOptions): Promise<void> {
    if (this.socket)
      throw new Error('Close the current Live voice session before connecting again.');
    if (typeof options.apiKey !== 'string' || !options.apiKey.trim())
      throw new Error('Add OPENAI_API_KEY to your local .env file to use Live voice.');
    checkedText(options.instructions, 32_000);
    checkedText(options.backendInstructions, 32_000);
    if (!Array.isArray(options.tools) || options.tools.length > 16)
      throw new Error('Invalid Live tool configuration.');
    for (const tool of options.tools) {
      if (tool.type === 'web_search') continue;
      if (
        tool.type !== 'function' ||
        typeof tool.name !== 'string' ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)
      )
        throw new Error('Only configured functions and web search are available to Live voice.');
    }
    const epoch = ++this.epoch;
    this.ready = false;
    this.closing = false;
    this.finalized = false;
    this.lastSeconds = 0;
    this.lastApiError = null;
    this.diagnosticStartedAt = Date.now();
    this.diagnosticLastReceivedAt = null;
    this.diagnosticOutgoing.clear();
    this.pending.clear();
    this.seenCalls.clear();
    this.seenEvents.clear();
    this.responseIds.clear();
    this.backendUsageIds.clear();
    this.pendingContextEvents.clear();
    this.allowedFunctions = new Set(
      options.tools.filter((t) => t.type === 'function').map((t) => t.name as string),
    );
    const socket = new WebSocket(LIVE_URL, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
      maxPayload: 4 * 1024 * 1024,
      handshakeTimeout: START_TIMEOUT_MS,
      followRedirects: false,
    });
    this.socket = socket;
    const current = () => this.socket === socket && this.epoch === epoch;
    this.emit('status', { state: 'connecting', message: 'Connecting to GPT-Live…' });
    const started = new Promise<void>((resolve, reject) => {
      this.settleStart = (error) => {
        if (this.startTimer) clearTimeout(this.startTimer);
        this.startTimer = null;
        this.settleStart = null;
        if (error) reject(error);
        else resolve();
      };
      this.startTimer = setTimeout(() => {
        if (current())
          this.fail('start_timeout', 'GPT-Live did not become ready. Try connecting again.');
      }, START_TIMEOUT_MS);
    });
    socket.once('open', () => {
      if (!current() || this.closing) return;
      let historyBytes = 0;
      const history = (options.history ?? [])
        .slice(-48)
        .reverse()
        .filter((message) => {
          const bytes = Buffer.byteLength(message.text.slice(0, 1000));
          if (historyBytes + bytes > 7500) return false;
          historyBytes += bytes;
          return true;
        })
        .reverse()
        .map((message) => ({
          type: 'message',
          role: message.role,
          content: [
            {
              type: message.role === 'assistant' ? 'output_text' : 'input_text',
              text: message.text.slice(0, 1000),
            },
          ],
        }));
      this.send(
        {
          type: 'session.start',
          event_id: randomUUID(),
          session: {
            model: 'gpt-live-1',
            instructions: options.instructions,
            input: history,
            store: false,
            audio: {
              format: { type: 'audio/pcm', rate: 24000 },
              output: { voice: options.voice ?? 'marin' },
            },
            delegation: {
              type: 'responses',
              acknowledgement_delay_ms: ACKNOWLEDGEMENT_DELAY_MS,
              responses: {
                model: options.backendModel ?? 'gpt-6-luna',
                instructions: options.backendInstructions,
                tools: options.tools,
                tool_choice: 'auto',
                parallel_tool_calls: false,
                max_output_tokens: 1200,
              },
            },
          },
        },
        true,
      );
    });
    socket.on('message', (raw) => {
      if (!current()) return;
      this.diagnosticLastReceivedAt = Date.now();
      let event: RecordValue | null;
      try {
        event = object(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      if (!event || typeof event.type !== 'string') return;
      if (typeof event.event_id === 'string') {
        if (this.seenEvents.has(event.event_id)) return;
        this.seenEvents.add(event.event_id);
        if (this.seenEvents.size > 1024)
          this.seenEvents.delete(this.seenEvents.values().next().value!);
      }
      this.receive(event);
    });
    socket.on('error', (error) => {
      if (current() && !this.closing) {
        this.transportDiagnostic('socket_error', { socketErrorCode: object(error)?.code });
        this.fail(
          'connection_failed',
          this.ready
            ? 'The OpenAI Live connection was interrupted. Check your network, then Resume.'
            : 'Could not connect to OpenAI Live. Check your API access and network.',
        );
      }
    });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      if (!current()) return;
      const status = response.statusCode ?? 0;
      this.transportDiagnostic('handshake_error', { httpStatus: status });
      const code =
        status === 401
          ? 'invalid_api_key'
          : status === 403
            ? 'access_denied'
            : status === 429
              ? 'rate_limit_exceeded'
              : 'connection_failed';
      this.fail(code, errorMessage(code));
    });
    socket.on('close', (rawCode: unknown) => {
      if (!current()) return;
      const intentional = this.closing;
      const closeCode =
        typeof rawCode === 'number' &&
        Number.isInteger(rawCode) &&
        rawCode >= 1000 &&
        rawCode <= 4999
          ? rawCode
          : undefined;
      const recentError =
        this.lastApiError && Date.now() - this.lastApiError.at < 30_000 ? this.lastApiError : null;
      const code = intentional ? 'close_requested' : (recentError?.code ?? 'connection_lost');
      if (!intentional)
        this.transportDiagnostic('unexpected_close', {
          closeCode,
          apiErrorCode: recentError?.code,
        });
      const closeDetail = closeCode === undefined ? '' : ` (WebSocket ${closeCode})`;
      const message = intentional
        ? 'Live voice stopped; final API usage was not confirmed.'
        : recentError
          ? `${recentError.message} The connection then ended${closeDetail}; final API usage was not confirmed.`
          : `Live connection ended unexpectedly${closeDetail}. Check your connection, then Resume. Final API usage was not confirmed.`;
      this.settleStart?.(new Error('GPT-Live closed before it was ready.'));
      if (!this.finalized)
        this.emit('usage', { final: false, voiceSeconds: this.lastSeconds } satisfies LiveUsage);
      this.cleanup(socket);
      if (!intentional) this.emit('fault', { code, message });
      this.emit('status', {
        state: 'disconnected',
        message,
        code,
        intentional,
        closeCode,
      } satisfies LiveStatus);
    });
    return started;
  }

  /** Caller supplies continuously paced raw PCM16LE at 24 kHz, including silence. */
  appendAudio(audio: string): boolean {
    if (!this.connected || !validPcm(audio)) return false;
    return this.send({ type: 'session.input_audio.append', audio });
  }

  /** Quiet factual context. Appends are capped below the API's 500-token limit. */
  addContext(text: string): void {
    this.appendContext('session.thinking.append', text);
  }
  /** Speakable context may be paraphrased; acceptance does not prove audible speech. */
  say(text: string): void {
    this.appendContext('session.commentary.append', text);
  }
  private appendContext(type: string, text: string) {
    this.requireReady();
    checkedText(text, 1200);
    this.send({ type, event_id: randomUUID(), delegation_id: null, content: text });
  }

  /** Typed requests/images go to the Responses backend, whose answer feeds Live speech. */
  sendText(text: string, imageDataUrl?: string): void {
    this.requireReady();
    checkedText(text, 12_000);
    const content: LiveContent[] = [{ type: 'input_text', text }];
    if (imageDataUrl) {
      if (
        !/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(imageDataUrl) ||
        imageDataUrl.length > 3 * 1024 * 1024
      )
        throw new Error('The game image is invalid or too large for Live context.');
      content.push({ type: 'input_image', image_url: imageDataUrl, detail: 'auto' });
    }
    this.send({
      type: 'response.item.create',
      event_id: randomUUID(),
      item: { type: 'message', role: 'user', content },
    });
    this.send({ type: 'response.create', event_id: randomUUID() });
  }

  /** Results are accepted only for a known, unfinished call in this session. */
  submitToolResult(callId: string, output: string | RecordValue | LiveContent[]): boolean {
    if (!this.connected || !this.pending.has(callId)) return false;
    const value =
      Array.isArray(output) || typeof output === 'string' ? output : JSON.stringify(output);
    if (JSON.stringify(value).length > 3 * 1024 * 1024)
      throw new Error('Live tool output is too large.');
    if (
      !this.send({
        type: 'response.item.create',
        event_id: randomUUID(),
        item: { type: 'function_call_output', call_id: callId, output: value },
      })
    )
      return false;
    this.pending.delete(callId);
    if (this.pending.size === 0) this.send({ type: 'response.create', event_id: randomUUID() });
    return true;
  }

  muteInput(muted: boolean): void {
    this.requireReady();
    this.send({
      type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute',
      event_id: randomUUID(),
    });
  }

  /** Closing also cancels queued backend work. Stop local playback immediately in the caller. */
  interrupt(): Promise<void> {
    return this.close();
  }
  close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    const socket = this.socket;
    if (!socket) return Promise.resolve();
    this.closing = true;
    this.settleStart?.(new Error('Live connection was cancelled.'));
    const promise = new Promise<void>((resolve) => {
      this.finishClose = resolve;
    });
    this.closingPromise = promise;
    if (!this.ready || socket.readyState !== WebSocket.OPEN) {
      this.cleanup(socket);
      socket.terminate();
      this.emit('status', {
        state: 'disconnected',
        message: 'Live connection cancelled.',
        code: 'close_requested',
        intentional: true,
      } satisfies LiveStatus);
      return promise;
    }
    this.closeTimer = setTimeout(() => {
      if (this.socket !== socket) return;
      this.emit('usage', { final: false, voiceSeconds: this.lastSeconds } satisfies LiveUsage);
      this.emit('status', {
        state: 'disconnected',
        message: 'Live voice stopped; final API usage was not confirmed.',
        code: 'close_timeout',
        intentional: true,
      } satisfies LiveStatus);
      this.cleanup(socket);
      socket.terminate();
    }, CLOSE_TIMEOUT_MS);
    this.send({ type: 'session.close', event_id: randomUUID() }, true);
    return promise;
  }
  dispose(): Promise<void> {
    return this.close();
  }

  private requireReady() {
    if (!this.connected) throw new Error('Connect Live voice before sending context.');
  }
  private send(event: RecordValue, lifecycle = false): boolean {
    const socket = this.socket;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      (!lifecycle && (!this.ready || this.closing))
    )
      return false;
    const encoded = JSON.stringify(event);
    if (
      event.type !== 'session.close' &&
      socket.bufferedAmount + Buffer.byteLength(encoded) > MAX_SOCKET_BUFFER
    ) {
      this.fail(
        'audio_backpressure',
        'Live audio fell behind the network. Reconnect to avoid delayed speech.',
      );
      return false;
    }
    try {
      socket.send(encoded);
      const diagnosticType = diagnosticOutgoingType(event.type);
      if (diagnosticType && typeof event.event_id === 'string') {
        this.diagnosticOutgoing.set(event.event_id, diagnosticType);
        if (this.diagnosticOutgoing.size > MAX_DIAGNOSTIC_EVENTS)
          this.diagnosticOutgoing.delete(this.diagnosticOutgoing.keys().next().value!);
      }
      if (
        [
          'session.thinking.append',
          'session.commentary.append',
          'session.instructions.append',
        ].includes(String(event.type)) &&
        typeof event.event_id === 'string'
      ) {
        this.pendingContextEvents.add(event.event_id);
        // Track IDs only, never the context itself. Overflow remains visible as
        // an uncorrelated error rather than turning into an automatic dismissal.
        if (this.pendingContextEvents.size > 128)
          this.pendingContextEvents.delete(this.pendingContextEvents.values().next().value!);
      }
      return true;
    } catch {
      if (this.closing) {
        this.emit('usage', { final: false, voiceSeconds: this.lastSeconds } satisfies LiveUsage);
        this.cleanup(socket);
        socket.terminate();
        this.emit('status', {
          state: 'disconnected',
          message: 'Live voice stopped; final API usage was not confirmed.',
          code: 'close_interrupted',
          intentional: true,
        } satisfies LiveStatus);
      } else this.fail('connection_failed', 'Live audio connection was interrupted.');
      return false;
    }
  }
  private fail(code: string, message: string) {
    this.settleStart?.(new Error(message));
    this.emit('fault', { code, message });
    this.emit('status', { state: 'error', message, code, intentional: false } satisfies LiveStatus);
    const socket = this.socket;
    if (socket) {
      this.emit('usage', { final: false, voiceSeconds: this.lastSeconds } satisfies LiveUsage);
      this.cleanup(socket);
      socket.terminate();
    }
  }
  private transportDiagnostic(kind: LiveTransportDiagnostic['kind'], details: RecordValue = {}) {
    const now = Date.now();
    const diagnostic = sanitizeLiveTransportDiagnostic({
      ...details,
      kind,
      sessionElapsedMs: this.diagnosticStartedAt === null ? 0 : now - this.diagnosticStartedAt,
      lastReceivedAgeMs:
        this.diagnosticLastReceivedAt === null ? null : now - this.diagnosticLastReceivedAt,
      bufferedBytes: this.socket?.bufferedAmount ?? 0,
      pendingToolCount: this.pending.size,
      pendingContextCount: this.pendingContextEvents.size,
    });
    if (diagnostic) this.emit('transport-diagnostic', diagnostic);
  }
  private apiDiagnostic(error: RecordValue | null, clientEventId?: unknown) {
    const outgoingEventType =
      typeof clientEventId === 'string' ? this.diagnosticOutgoing.get(clientEventId) : undefined;
    this.transportDiagnostic('api_error', {
      outgoingEventType,
      apiErrorCode: error?.code,
      apiErrorType: error?.type,
      apiErrorParam: error?.param,
    });
  }
  private cleanup(socket: WebSocket) {
    if (this.socket !== socket) return;
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.startTimer = this.closeTimer = null;
    this.socket = null;
    this.ready = false;
    this.pending.clear();
    this.pendingContextEvents.clear();
    this.diagnosticOutgoing.clear();
    this.finishClose?.();
    this.finishClose = null;
    this.closingPromise = null;
    this.emit('backend', { active: false, kind: 'closed' });
  }
  private receive(event: RecordValue) {
    if (event.type === 'session.started') {
      if (this.closing || this.ready) return;
      this.ready = true;
      this.settleStart?.();
      this.emit('status', { state: 'connected', message: 'GPT-Live connected · OpenAI API' });
    } else if (event.type === 'session.output_audio.delta') {
      if (!this.closing && validPcm(event.delta))
        this.emit('audio', { delta: event.delta, sampleRate: 24000 });
    } else if (
      event.type === 'session.input_transcript.delta' ||
      event.type === 'session.output_transcript.delta'
    ) {
      if (
        typeof event.delta !== 'string' ||
        event.delta.length > 16_000 ||
        !Number.isFinite(event.start_ms) ||
        !Number.isFinite(event.end_ms)
      )
        return;
      this.emit('transcript', {
        role: event.type === 'session.input_transcript.delta' ? 'user' : 'companion',
        delta: event.delta,
        startMs: event.start_ms,
        endMs: event.end_ms,
      } as LiveTranscript);
    } else if (
      event.type === 'session.input_audio.muted' ||
      event.type === 'session.input_audio.unmuted'
    ) {
      this.emit('input-muted', event.type === 'session.input_audio.muted');
    } else if (event.type === 'session.usage.updated' || event.type === 'session.closed') {
      const usage = object(event.usage);
      if (
        typeof usage?.seconds === 'number' &&
        Number.isFinite(usage.seconds) &&
        usage.seconds >= 0
      )
        this.lastSeconds = usage.seconds;
      const final = event.type === 'session.closed';
      this.finalized = final;
      this.emit('usage', { final, voiceSeconds: this.lastSeconds } satisfies LiveUsage);
      if (final) {
        const intentional = this.closing;
        // Never surface arbitrary close text: these are the documented reasons.
        const reason =
          typeof event.reason === 'string' && Object.hasOwn(closeReasons, event.reason)
            ? event.reason
            : 'session_ended';
        const code = intentional && reason === 'session_ended' ? 'close_requested' : reason;
        const message = intentional
          ? 'Live voice stopped.'
          : (closeReasons[reason] ??
            'OpenAI ended the Live session unexpectedly. Resume to reconnect.');
        this.settleStart?.(new Error('GPT-Live ended before becoming ready.'));
        const socket = this.socket;
        if (socket) {
          this.cleanup(socket);
          socket.close();
        }
        if (!intentional) this.emit('fault', { code, message });
        this.emit('status', {
          state: 'disconnected',
          message,
          code,
          intentional,
        } satisfies LiveStatus);
      }
    } else if (event.type === 'session.delegation.created') {
      if (!this.connected) return;
      const delegation = object(event.delegation);
      if (typeof delegation?.id !== 'string') return;
      if (typeof delegation.response_id === 'string')
        this.responseIds.set(delegation.id, delegation.response_id);
      if (delegation.target === 'responses') {
        // An empty thinking update cancels pending automatic acknowledgements.
        // Responses delegation requires null, not this delegation's ID.
        if (
          !this.send({
            type: 'session.thinking.append',
            event_id: randomUUID(),
            delegation_id: null,
            content: '',
          })
        )
          return;
      }
      this.emit('backend', { active: true, kind: 'delegated', delegationId: delegation.id });
    } else if (
      [
        'session.thinking.appended',
        'session.commentary.appended',
        'session.instructions.appended',
      ].includes(String(event.type))
    ) {
      if (typeof event.client_event_id === 'string')
        this.pendingContextEvents.delete(event.client_event_id);
    } else if (event.type === 'response.event') {
      this.receiveBackend(event);
    } else if (event.type === 'error') {
      const error = object(event.error);
      const code = safeCode(error?.code);
      const clientEventId =
        typeof error?.client_event_id === 'string' ? error.client_event_id : event.client_event_id;
      const pendingContext =
        typeof clientEventId === 'string' && this.pendingContextEvents.delete(clientEventId);
      if (this.closing && code === 'context_injection_incomplete' && pendingContext) {
        // The API rejects still-pending context when the application closes.
        // Classify only a known outgoing append cancelled by our own stop.
        this.emit('diagnostic', { code: 'context_injection_cancelled', intentional: true });
        return;
      }
      this.apiDiagnostic(error, clientEventId);
      const message = errorMessage(code);
      this.lastApiError = { code, message, at: Date.now() };
      if (!this.ready || code === 'responses_validation_failed') this.fail(code, message);
      else this.emit('fault', { code, message });
    }
  }
  private receiveBackend(envelope: RecordValue) {
    const event = object(envelope.event);
    if (!event || typeof event.type !== 'string') return;
    const delegationId = typeof envelope.delegation_id === 'string' ? envelope.delegation_id : null;
    const response = object(event.response);
    if (event.type === 'response.created' && typeof response?.id === 'string') {
      this.responseIds.set(delegationId ?? '', response.id);
      if (this.responseIds.size > 128)
        this.responseIds.delete(this.responseIds.keys().next().value!);
      this.emit('backend', {
        active: true,
        kind: 'response',
        delegationId,
        responseId: response.id,
      });
    }
    const responseId =
      typeof response?.id === 'string'
        ? response.id
        : (this.responseIds.get(delegationId ?? '') ?? null);
    if (event.type === 'response.output_item.done') {
      const item = object(event.item);
      if (!item) return;
      if (
        item.type === 'function_call' &&
        typeof item.call_id === 'string' &&
        typeof item.name === 'string'
      ) {
        if (this.closing || this.pending.has(item.call_id) || this.seenCalls.has(item.call_id))
          return;
        if (this.pending.size >= MAX_PENDING_TOOL_CALLS) {
          this.fail(
            'tool_limit',
            'Too many Live tools are waiting for results. Resume to clear the stalled requests.',
          );
          return;
        }
        this.seenCalls.add(item.call_id);
        if (this.seenCalls.size > MAX_RECENT_TOOL_CALLS)
          this.seenCalls.delete(this.seenCalls.values().next().value!);
        let args: RecordValue | null = null;
        if (typeof item.arguments === 'string' && item.arguments.length <= 16_000) {
          try {
            args = object(JSON.parse(item.arguments));
          } catch {
            /* Invalid arguments are returned as a tool error. */
          }
        }
        const call: LiveToolCall = {
          callId: item.call_id,
          name: item.name,
          arguments: args ?? {},
          delegationId,
          responseId,
        };
        this.pending.set(call.callId, call);
        if (!this.allowedFunctions.has(call.name) || !args) {
          this.submitToolResult(call.callId, { error: 'Tool unavailable or invalid arguments.' });
          return;
        }
        this.emit('tool', call);
      } else if (item.type === 'message' && Array.isArray(item.content)) {
        const text = item.content
          .map((part) => {
            const p = object(part);
            return p?.type === 'output_text' && typeof p.text === 'string' ? p.text : '';
          })
          .join('')
          .slice(0, 12000);
        const sources: { title: string; url: string }[] = [];
        for (const part of item.content) {
          const annotations = object(part)?.annotations;
          if (!Array.isArray(annotations)) continue;
          for (const annotation of annotations) {
            const a = object(annotation);
            if (
              a?.type === 'url_citation' &&
              typeof a.url === 'string' &&
              a.url.startsWith('https://')
            )
              sources.push({
                title: typeof a.title === 'string' ? a.title.slice(0, 200) : 'Source',
                url: a.url.slice(0, 2000),
              });
          }
        }
        this.emit('backend-text', {
          text,
          sources: sources.slice(0, 12),
          responseId,
          delegationId,
        });
      }
    }
    if (event.type.startsWith('response.web_search_call.'))
      this.emit('backend', { active: true, kind: 'web_search', delegationId, responseId });
    if (
      event.type === 'response.completed' ||
      event.type === 'response.failed' ||
      event.type === 'response.incomplete'
    ) {
      this.emit('backend', {
        active: this.pending.size > 0,
        kind: event.type.slice(9),
        delegationId,
        responseId,
      });
      const usage = object(response?.usage);
      if (usage && responseId && !this.backendUsageIds.has(responseId)) {
        this.backendUsageIds.add(responseId);
        if (this.backendUsageIds.size > 128)
          this.backendUsageIds.delete(this.backendUsageIds.values().next().value!);
        const count = (v: unknown) =>
          typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
        this.emit('usage', {
          final: false,
          backend: {
            responseId,
            inputTokens: count(usage.input_tokens),
            outputTokens: count(usage.output_tokens),
            totalTokens: count(usage.total_tokens),
          },
        } satisfies LiveUsage);
      }
      if (event.type !== 'response.completed') {
        const incompleteReason = object(response?.incomplete_details)?.reason;
        const apiError = object(response?.error);
        if (apiError) this.apiDiagnostic(apiError, apiError.client_event_id);
        const code =
          incompleteReason === 'max_output_tokens'
            ? 'backend_output_limit'
            : incompleteReason === 'content_filter'
              ? 'backend_content_filter'
              : apiError
                ? safeCode(apiError.code)
                : 'backend_failed';
        const message =
          code === 'backend_output_limit'
            ? 'The game lookup ran out of response space before finishing. Try a shorter question.'
            : code === 'backend_content_filter'
              ? 'OpenAI could not complete that game lookup after a safety check.'
              : apiError
                ? errorMessage(code)
                : 'The Live research or game-context request did not finish. Try again.';
        this.emit('fault', { code, message });
      }
    }
  }
}
