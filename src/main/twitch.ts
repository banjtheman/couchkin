import { randomInt, randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const TWITCH_IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';
const MAX_BUFFER = 256 * 1024;
const MAX_LINE = 64 * 1024;
const CONNECT_TIMEOUT_MS = 20_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const API_TIMEOUT_MS = 12_000;
const VALIDATION_INTERVAL_MS = 60 * 60 * 1000;
const REPLY_ECHO_WINDOW_MS = 60_000;
const MAX_PENDING_REPLY_ECHOES = 32;
const PROBE_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 15_000;
const MESSAGE_DIAGNOSTIC_INTERVAL_MS = 5_000;

interface PendingReplyEcho {
  channel: string;
  username: string;
  text: string;
  expiresAt: number;
}

interface TwitchIdentity {
  clientId: string;
  userId: string;
  username: string;
  canSend: boolean;
  expiresAt: number;
}

class TwitchRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
  }
}

export interface IrcMessage {
  tags: Record<string, string>;
  prefix: string;
  command: string;
  params: string[];
}
export interface TwitchMessage {
  id: string;
  user: string;
  text: string;
}
export interface TwitchCredentials {
  channel: string;
  username: string;
  token: string;
}
export interface TwitchTransportDiagnostic {
  event:
    | 'joined'
    | 'probe_sent'
    | 'probe_ack'
    | 'probe_timeout'
    | 'message_received'
    | 'message_filtered'
    | 'socket_closed'
    | 'socket_error';
  receivedFrames: number;
  /** Parsed PRIVMSG commands, before routing and reply-echo filtering. */
  parsedMessages: number;
  acceptedMessages: number;
  duplicateMessages: number;
  echoMessages: number;
  lastFrameAt: number | null;
  /** Last chat message accepted for the application. */
  lastMessageAt: number | null;
  lastProbeAckAt: number | null;
}

export function decodeIrcTag(value: string): string {
  return value.replace(
    /\\(.|$)/g,
    (_match: string, escaped: string) =>
      ({ s: ' ', ':': ';', r: '\r', n: '\n', '\\': '\\' })[escaped] ?? escaped,
  );
}

/** Parse one IRC line. The transport owns CRLF framing and bounds its buffer. */
export function parseIrcLine(line: string): IrcMessage | null {
  if (!line || line.length > MAX_LINE || /[\r\n\0]/.test(line)) return null;
  let remaining = line;
  const tags: Record<string, string> = Object.create(null) as Record<string, string>;
  let prefix = '';
  if (remaining.startsWith('@')) {
    const end = remaining.indexOf(' ');
    if (end < 2) return null;
    for (const tag of remaining.slice(1, end).split(';')) {
      const equals = tag.indexOf('=');
      const name = equals < 0 ? tag : tag.slice(0, equals);
      if (!/^[A-Za-z0-9_+./-]+$/.test(name)) continue;
      tags[name] = equals < 0 ? '' : decodeIrcTag(tag.slice(equals + 1));
    }
    remaining = remaining.slice(end + 1).trimStart();
  }
  if (remaining.startsWith(':')) {
    const end = remaining.indexOf(' ');
    if (end < 2) return null;
    prefix = remaining.slice(1, end);
    remaining = remaining.slice(end + 1).trimStart();
  }
  const commandMatch = /^([A-Za-z]+|\d{3})(?: +|$)/.exec(remaining);
  if (!commandMatch) return null;
  const command = commandMatch[1]!.toUpperCase();
  remaining = remaining.slice(commandMatch[0].length);
  const params: string[] = [];
  while (remaining) {
    if (remaining.startsWith(':')) {
      params.push(remaining.slice(1));
      break;
    }
    const space = remaining.indexOf(' ');
    if (space === -1) {
      params.push(remaining);
      break;
    }
    params.push(remaining.slice(0, space));
    remaining = remaining.slice(space + 1).trimStart();
    if (params.length > 15) return null;
  }
  return params.length <= 15 ? { tags, prefix, command, params } : null;
}

export function validateTwitchCredentials(input: TwitchCredentials): TwitchCredentials {
  if (
    !input ||
    typeof input.channel !== 'string' ||
    typeof input.username !== 'string' ||
    typeof input.token !== 'string'
  ) {
    throw new Error(
      'Enter a Twitch channel. Account credentials are optional for guest listening.',
    );
  }
  const channel = input.channel.trim().replace(/^#/, '').toLowerCase();
  const username = input.username.trim().toLowerCase();
  const token = input.token.trim().replace(/^oauth:/i, '');
  if (!/^[a-z0-9_]{1,25}$/.test(channel)) {
    throw new Error('Use Twitch login names, without a URL or spaces.');
  }
  // Guest mode is deliberate: never silently discard a partially entered login.
  if (!username && !token) return { channel, username: '', token: '' };
  if (!/^[a-z0-9_]{1,25}$/.test(username)) {
    throw new Error(
      'Enter the account username for this token, or leave both account fields empty to listen as a guest.',
    );
  }
  if (!/^[A-Za-z0-9_-]{20,512}$/.test(token)) {
    throw new Error('Enter a valid Twitch user access token with chat:read access.');
  }
  return { channel, username, token };
}

export function ircChatMessage(message: IrcMessage, channel: string): TwitchMessage | null {
  if (
    message.command !== 'PRIVMSG' ||
    message.params[0]?.toLowerCase() !== `#${channel}` ||
    message.params.length !== 2
  )
    return null;
  const text = message.params[1];
  const login = message.prefix.split('!')[0] ?? '';
  if (!text || !/^[A-Za-z0-9_]{1,25}$/.test(login)) return null;
  const display = (message.tags['display-name'] || login)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 64);
  return {
    id: message.tags.id?.slice(0, 128) || randomUUID(),
    user: display,
    text: text.slice(0, 2000),
  };
}

export class TwitchBridge {
  private socket: WebSocket | null = null;
  private cancelPending: (() => void) | null = null;
  private wanted: TwitchCredentials | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private joined = false;
  private identity: TwitchIdentity | null = null;
  private broadcasterId: string | null = null;
  private validationTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly requests = new Set<AbortController>();
  private sending: AbortController | null = null;
  private readonly pendingReplyEchoes = new Set<PendingReplyEcho>();
  private readonly seen = new Set<string>();
  private readonly messages = new Set<(message: TwitchMessage) => void>();
  private readonly statuses = new Set<(connected: boolean, message: string) => void>();
  private readonly diagnostics = new Set<(diagnostic: TwitchTransportDiagnostic) => void>();
  private cancelHeartbeat: (() => void) | null = null;

  get chatAccess(): { canSend: boolean; username: string | null } {
    return {
      canSend: !!(
        this.joined &&
        this.socket?.readyState === WebSocket.OPEN &&
        this.identity?.canSend &&
        this.identity.expiresAt > Date.now() &&
        this.broadcasterId
      ),
      username: this.identity?.username ?? null,
    };
  }

  private async requestJson(
    url: string,
    init: RequestInit,
    failure: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const abort = new AbortController();
    this.requests.add(abort);
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) abort.abort();
    const timer = setTimeout(cancel, API_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...init, signal: abort.signal, redirect: 'error' });
      if (!response.ok) throw new TwitchRequestError(failure, response.status);
      const value: unknown = await response.json();
      if (abort.signal.aborted) throw new Error('cancelled');
      return value;
    } catch (error) {
      // Never expose remote response bodies, fetch URLs, or authorization headers.
      if (error instanceof TwitchRequestError) throw error;
      throw new TwitchRequestError(
        abort.signal.aborted ? 'Twitch request was cancelled or timed out.' : failure,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      this.requests.delete(abort);
    }
  }

  private async validateIdentity(credentials: TwitchCredentials): Promise<TwitchIdentity> {
    const data = await this.requestJson(
      'https://id.twitch.tv/oauth2/validate',
      { headers: { Authorization: `OAuth ${credentials.token}` } },
      'Twitch could not validate this login. Sign in again or use a fresh token.',
    );
    const value = data as Record<string, unknown> | null;
    if (
      !value ||
      typeof value.client_id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(value.client_id) ||
      typeof value.user_id !== 'string' ||
      !/^\d{1,30}$/.test(value.user_id) ||
      typeof value.login !== 'string' ||
      value.login.toLowerCase() !== credentials.username ||
      !Array.isArray(value.scopes) ||
      !value.scopes.every((scope) => typeof scope === 'string') ||
      typeof value.expires_in !== 'number' ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 0
    )
      throw new TwitchRequestError(
        'Use a valid Twitch user token for the account username entered.',
      );
    if (!value.scopes.includes('chat:read')) {
      throw new TwitchRequestError('This Twitch login needs chat:read permission to listen.');
    }
    return {
      clientId: value.client_id,
      userId: value.user_id,
      username: credentials.username,
      canSend: value.scopes.includes('user:write:chat'),
      expiresAt: Date.now() + value.expires_in * 1000,
    };
  }

  private scheduleValidation(credentials: TwitchCredentials): void {
    if (this.validationTimer) clearTimeout(this.validationTimer);
    if (!this.identity || this.wanted !== credentials) return;
    this.validationTimer = setTimeout(
      () => {
        this.validationTimer = null;
        void this.validateIdentity(credentials)
          .then((identity) => {
            if (this.wanted !== credentials) return;
            if (
              identity.clientId !== this.identity?.clientId ||
              identity.userId !== this.identity.userId
            ) {
              throw new TwitchRequestError('Twitch account changed. Reconnect chat.');
            }
            this.identity = identity;
            if (!identity.canSend) this.sending?.abort();
            this.scheduleValidation(credentials);
            if (this.joined) this.status(true, this.connectedMessage(credentials));
          })
          .catch(() => {
            if (this.wanted !== credentials) return;
            this.disconnect();
            this.status(false, 'Twitch login could not be verified. Reconnect chat to continue.');
          });
      },
      Math.max(1000, Math.min(VALIDATION_INTERVAL_MS, this.identity.expiresAt - Date.now())),
    );
    this.validationTimer.unref?.();
  }

  private connectedMessage(credentials: TwitchCredentials): string {
    return this.chatAccess.canSend
      ? `Listening to #${credentials.channel} as a guest; replies as ${credentials.username}.`
      : `Listening to #${credentials.channel} as a guest (read-only).`;
  }

  /** One confirmed API send, with no retries: an ambiguous network failure may have delivered. */
  async sendReply(input: {
    text: string;
    replyToId: string;
    signal?: AbortSignal;
  }): Promise<{ messageId: string }> {
    if (
      !input ||
      typeof input.text !== 'string' ||
      !input.text.trim() ||
      input.text.length > 450 ||
      /[\u0000-\u001f\u007f\u2028\u2029]/.test(input.text) ||
      typeof input.replyToId !== 'string' ||
      !/^[A-Za-z0-9-]{1,128}$/.test(input.replyToId)
    )
      throw new Error(
        'Chat replies must be one line, at most 450 characters, and reply to a valid message.',
      );
    const credentials = this.wanted;
    const identity = this.identity;
    const broadcasterId = this.broadcasterId;
    if (!this.chatAccess.canSend || !credentials || !identity || !broadcasterId) {
      throw new Error('Connect a Twitch account with user:write:chat permission to send replies.');
    }
    if (this.sending) throw new Error('A Twitch reply is already being sent.');
    if (input.signal?.aborted) throw new Error('Twitch reply was cancelled.');
    const abort = new AbortController();
    this.sending = abort;
    const cancel = () => abort.abort();
    input.signal?.addEventListener('abort', cancel, { once: true });
    this.pruneReplyEchoes();
    const echo: PendingReplyEcho = {
      channel: credentials.channel,
      username: credentials.username,
      text: input.text.trim(),
      expiresAt: Date.now() + REPLY_ECHO_WINDOW_MS,
    };
    this.pendingReplyEchoes.add(echo);
    while (this.pendingReplyEchoes.size > MAX_PENDING_REPLY_ECHOES)
      this.pendingReplyEchoes.delete(this.pendingReplyEchoes.values().next().value!);
    try {
      const result = (await this.requestJson(
        'https://api.twitch.tv/helix/chat/messages',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credentials.token}`,
            'Client-Id': identity.clientId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            broadcaster_id: broadcasterId,
            sender_id: identity.userId,
            message: input.text.trim(),
            reply_parent_message_id: input.replyToId,
          }),
        },
        'Twitch did not confirm this reply. It will not be retried.',
        abort.signal,
      )) as { data?: Array<{ message_id?: unknown; is_sent?: unknown }> } | null;
      if (this.wanted !== credentials || abort.signal.aborted)
        throw new Error('Twitch reply was cancelled.');
      const sent = result?.data?.[0];
      if (
        sent?.is_sent !== true ||
        typeof sent.message_id !== 'string' ||
        !sent.message_id ||
        sent.message_id.length > 128
      ) {
        if (sent?.is_sent === false) this.pendingReplyEchoes.delete(echo);
        throw new Error(
          'Twitch did not send this reply. Channel rules or moderation may have blocked it.',
        );
      }
      // The confirmed ID is precise enough to identify later echoes; stop
      // matching by text so a real broadcaster can repeat the same words.
      this.pendingReplyEchoes.delete(echo);
      this.seen.add(sent.message_id);
      if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
      return { messageId: sent.message_id };
    } catch (error) {
      // A request failure may have delivered. Keep its one-use text match for
      // a short window, except when Twitch explicitly rejected the send.
      if (
        error instanceof TwitchRequestError &&
        error.statusCode !== undefined &&
        error.statusCode >= 400 &&
        error.statusCode < 500 &&
        error.statusCode !== 408
      )
        this.pendingReplyEchoes.delete(echo);
      if (
        error instanceof TwitchRequestError &&
        error.statusCode === 401 &&
        this.wanted === credentials
      ) {
        this.disconnect();
        this.status(false, 'Twitch login expired or was revoked. Reconnect chat to continue.');
        throw new Error('Twitch login expired or was revoked. Reconnect chat to continue.');
      }
      if (error instanceof TwitchRequestError && error.statusCode === 403)
        throw new Error(
          'This Twitch account cannot send in that channel. Check channel restrictions.',
        );
      if (error instanceof TwitchRequestError && error.statusCode === 429)
        throw new Error('Twitch rate-limited this reply. It was not retried.');
      throw error;
    } finally {
      input.signal?.removeEventListener('abort', cancel);
      if (this.sending === abort) this.sending = null;
    }
  }

  private pruneReplyEchoes() {
    for (const echo of this.pendingReplyEchoes)
      if (echo.expiresAt <= Date.now()) this.pendingReplyEchoes.delete(echo);
  }

  private consumeReplyEcho(message: IrcMessage, credentials: TwitchCredentials): boolean {
    this.pruneReplyEchoes();
    const username = message.prefix.split('!')[0]?.toLowerCase();
    if (!credentials.username || username !== credentials.username) return false;
    for (const echo of this.pendingReplyEchoes) {
      if (
        echo.channel === credentials.channel &&
        echo.username === username &&
        echo.text === message.params[1]
      ) {
        this.pendingReplyEchoes.delete(echo);
        return true;
      }
    }
    return false;
  }

  onMessage(callback: (message: TwitchMessage) => void): () => void {
    this.messages.add(callback);
    return () => {
      this.messages.delete(callback);
    };
  }
  onStatus(callback: (connected: boolean, message: string) => void): () => void {
    this.statuses.add(callback);
    return () => {
      this.statuses.delete(callback);
    };
  }
  onDiagnostic(callback: (diagnostic: TwitchTransportDiagnostic) => void): () => void {
    this.diagnostics.add(callback);
    return () => {
      this.diagnostics.delete(callback);
    };
  }
  private status(connected: boolean, message: string): void {
    for (const callback of this.statuses) callback(connected, message);
  }

  async connect(input: TwitchCredentials): Promise<void> {
    const credentials = validateTwitchCredentials(input);
    this.disconnect();
    this.wanted = credentials;
    this.reconnectAttempts = 0;
    this.seen.clear();
    if (credentials.username) {
      try {
        this.status(false, 'Checking Twitch account permissions…');
        const identity = await this.validateIdentity(credentials);
        if (this.wanted !== credentials) throw new Error('Twitch connection was cancelled.');
        let broadcasterId: string | null = null;
        if (identity.canSend) {
          if (credentials.channel === identity.username) broadcasterId = identity.userId;
          else {
            const users = (await this.requestJson(
              `https://api.twitch.tv/helix/users?login=${encodeURIComponent(credentials.channel)}`,
              {
                headers: {
                  Authorization: `Bearer ${credentials.token}`,
                  'Client-Id': identity.clientId,
                },
              },
              'Twitch could not find that channel. Check its login name and reconnect.',
            )) as { data?: Array<{ id?: unknown; login?: unknown }> } | null;
            const channel = Array.isArray(users?.data)
              ? users.data.find((user) => user?.login === credentials.channel)
              : undefined;
            if (!channel || typeof channel.id !== 'string' || !/^\d{1,30}$/.test(channel.id)) {
              throw new Error(
                'Twitch could not find that channel. Check its login name and reconnect.',
              );
            }
            broadcasterId = channel.id;
          }
        }
        if (this.wanted !== credentials) throw new Error('Twitch connection was cancelled.');
        this.identity = identity;
        this.broadcasterId = broadcasterId;
        this.scheduleValidation(credentials);
      } catch (error) {
        if (this.wanted !== credentials) throw new Error('Twitch connection was cancelled.');
        this.disconnect();
        const message =
          error instanceof Error ? error.message : 'Twitch login could not be checked.';
        this.status(false, message);
        throw new Error(message);
      }
    }
    return this.connectAttempt(credentials, false);
  }

  private scheduleReconnect(credentials: TwitchCredentials): void {
    if (this.wanted !== credentials || this.reconnectTimer) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.status(
        false,
        'Twitch chat could not reconnect. Connect chat again when your network is ready.',
      );
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts++);
    this.status(false, `Twitch chat disconnected. Reconnecting in ${delay / 1000}s…`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wanted !== credentials) return;
      void this.connectAttempt(credentials, true).catch(() => {
        /* The attempt reports a bounded, sanitized status. */
      });
    }, delay);
  }

  private connectAttempt(credentials: TwitchCredentials, retrying: boolean): Promise<void> {
    const { channel } = credentials;
    // Keep public-chat receiving separate from the authenticated Helix writer.
    // Guest access is tested compatibility, not a documented OAuth entitlement.
    // Reader health is verified independently of the identity used for replies.
    const readerUsername = `justinfan${randomInt(10000, 100000000)}`;
    const socket = new WebSocket(TWITCH_IRC_URL, {
      maxPayload: MAX_BUFFER,
      handshakeTimeout: 12_000,
    });
    this.socket = socket;
    this.status(false, retrying ? 'Reconnecting to Twitch chat…' : 'Connecting to Twitch chat…');
    let buffer = '';
    let authenticated = false;
    let joined = false;
    let closedReason = 'Twitch chat disconnected. Reconnect when ready.';
    const diagnosticState: Omit<TwitchTransportDiagnostic, 'event'> = {
      receivedFrames: 0,
      parsedMessages: 0,
      acceptedMessages: 0,
      duplicateMessages: 0,
      echoMessages: 0,
      lastFrameAt: null,
      lastMessageAt: null,
      lastProbeAckAt: null,
    };
    const lastMessageDiagnosticAt: Partial<
      Record<'message_received' | 'message_filtered', number>
    > = {};
    const diagnostic = (event: TwitchTransportDiagnostic['event']) => {
      if (event === 'message_received' || event === 'message_filtered') {
        const now = Date.now();
        const previous = lastMessageDiagnosticAt[event];
        // Keep the first receipt immediate without writing one diagnostic per
        // chat message. Probe snapshots still include every cumulative count.
        if (
          previous !== undefined &&
          now >= previous &&
          now - previous < MESSAGE_DIAGNOSTIC_INTERVAL_MS
        )
          return;
        lastMessageDiagnosticAt[event] = now;
      }
      for (const callback of this.diagnostics) {
        try {
          callback({ event, ...diagnosticState });
        } catch {
          /* Diagnostics must never interrupt the chat connection. */
        }
      }
    };
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let probeTimer: ReturnType<typeof setTimeout> | null = null;
      let probeDeadline: ReturnType<typeof setTimeout> | null = null;
      let pendingProbe: string | null = null;
      const clearHeartbeat = () => {
        if (probeTimer) clearTimeout(probeTimer);
        if (probeDeadline) clearTimeout(probeDeadline);
        probeTimer = null;
        probeDeadline = null;
        pendingProbe = null;
        if (this.cancelHeartbeat === clearHeartbeat) this.cancelHeartbeat = null;
      };
      this.cancelHeartbeat = clearHeartbeat;
      const finish = (error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.socket === socket) this.cancelPending = null;
        if (error) reject(new Error(error));
        else resolve();
      };
      const fail = (message: string, recoverable = false) => {
        clearHeartbeat();
        closedReason = message;
        finish(message);
        if (this.socket === socket) {
          this.joined = false;
          this.sending?.abort();
          this.socket = null;
          if (recoverable && (joined || retrying)) {
            this.status(false, message);
            this.scheduleReconnect(credentials);
          } else {
            this.disconnect();
            this.status(false, message);
          }
        }
        socket.terminate();
      };
      const probe = () => {
        probeTimer = null;
        if (this.socket !== socket || !joined || socket.readyState !== WebSocket.OPEN) return;
        pendingProbe = `couchkin-health-${randomUUID()}`;
        probeDeadline = setTimeout(() => {
          if (this.socket !== socket || !pendingProbe) return;
          diagnostic('probe_timeout');
          fail('Twitch chat stopped responding. Reconnecting…', true);
        }, PROBE_TIMEOUT_MS);
        probeDeadline.unref?.();
        diagnostic('probe_sent');
        try {
          socket.send(`PING :${pendingProbe}\r\n`, (error) => {
            if (error && this.socket === socket) {
              diagnostic('socket_error');
              fail('Could not check Twitch chat. Reconnecting…', true);
            }
          });
        } catch {
          diagnostic('socket_error');
          fail('Could not check Twitch chat. Reconnecting…', true);
        }
      };
      const timer = setTimeout(
        () =>
          fail(
            'Twitch did not confirm joining that public channel. Check the channel name and reconnect chat.',
            retrying,
          ),
        CONNECT_TIMEOUT_MS,
      );
      this.cancelPending = () => finish('Twitch connection was cancelled.');
      socket.once('open', () => {
        if (this.socket !== socket) return;
        // SCHMOOPIIE is a non-secret guest placeholder. Real account credentials
        // remain in the validated API writer and never enter the IRC transport.
        socket.send('PASS SCHMOOPIIE\r\n');
        socket.send(`NICK ${readerUsername}\r\n`);
        socket.send('CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership\r\n');
      });
      socket.on('message', (raw) => {
        if (this.socket !== socket) return;
        diagnosticState.receivedFrames++;
        diagnosticState.lastFrameAt = Date.now();
        buffer += raw.toString();
        if (buffer.length > MAX_BUFFER) {
          fail('Twitch sent an oversized response. Reconnect to chat.');
          return;
        }
        let boundary: number;
        while ((boundary = buffer.indexOf('\r\n')) !== -1) {
          const line = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const message = parseIrcLine(line);
          if (!message) continue;
          if (message.command === 'PONG') {
            if (pendingProbe && message.params.at(-1) === pendingProbe) {
              if (probeDeadline) clearTimeout(probeDeadline);
              probeDeadline = null;
              pendingProbe = null;
              diagnosticState.lastProbeAckAt = Date.now();
              // A JOIN alone cannot prove that the reader remains responsive.
              this.reconnectAttempts = 0;
              diagnostic('probe_ack');
              probeTimer = setTimeout(probe, PROBE_INTERVAL_MS);
              probeTimer.unref?.();
            }
            continue;
          }
          if (message.command === 'PING') {
            if (socket.readyState === WebSocket.OPEN && message.params[0])
              socket.send(`PONG :${message.params[0]}\r\n`);
            continue;
          }
          if (message.command === 'NOTICE') {
            const notice = (message.params.at(-1) ?? '').toLowerCase();
            if (
              /authentication failed|improperly formatted auth|invalid nick|login unsuccessful/.test(
                notice,
              )
            ) {
              fail(
                'Twitch guest chat listening is unavailable. Reconnect chat or try again later.',
              );
              return;
            }
            if (message.tags['msg-id'] === 'msg_channel_suspended') {
              fail('That Twitch channel is unavailable.');
              return;
            }
          }
          if (message.command === 'RECONNECT') {
            fail('Twitch requested a reconnect.', true);
            return;
          }
          if (message.command === '001' && !authenticated) {
            authenticated = true;
            socket.send(`JOIN #${channel}\r\n`);
          }
          const ownJoin =
            message.command === 'JOIN' &&
            message.prefix.split('!')[0]?.toLowerCase() === readerUsername &&
            message.params[0]?.toLowerCase() === `#${channel}`;
          const roomReady =
            message.command === 'ROOMSTATE' && message.params[0]?.toLowerCase() === `#${channel}`;
          if (authenticated && !joined && (ownJoin || roomReady)) {
            joined = true;
            this.joined = true;
            this.status(true, this.connectedMessage(credentials));
            finish();
            diagnostic('joined');
            probe();
          }
          if (message.command !== 'PRIVMSG') continue;
          diagnosticState.parsedMessages++;
          const chat = ircChatMessage(message, channel);
          if (!joined || !chat) {
            diagnostic('message_filtered');
            continue;
          }
          if (this.seen.has(chat.id)) {
            diagnosticState.duplicateMessages++;
            diagnostic('message_filtered');
            continue;
          }
          this.seen.add(chat.id);
          if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
          // The streamer can use the same account as Couchkin. Suppress only a
          // known automated reply, including an echo arriving before Helix replies.
          if (this.consumeReplyEcho(message, credentials)) {
            diagnosticState.echoMessages++;
            diagnostic('message_filtered');
            continue;
          }
          diagnosticState.acceptedMessages++;
          diagnosticState.lastMessageAt = Date.now();
          diagnostic('message_received');
          for (const callback of this.messages) callback(chat);
        }
        if (buffer.length > MAX_LINE) fail('Twitch sent an invalid message. Reconnect to chat.');
      });
      socket.on('error', () => {
        if (this.socket !== socket) return;
        diagnostic('socket_error');
        fail('Could not connect to Twitch chat. Check your network and connection settings.', true);
      });
      socket.on('close', () => {
        clearHeartbeat();
        finish(closedReason);
        if (this.socket === socket) {
          diagnostic('socket_closed');
          this.joined = false;
          this.sending?.abort();
          this.socket = null;
          this.status(false, closedReason);
          if (joined || retrying) this.scheduleReconnect(credentials);
        }
      });
    });
  }

  disconnect(): void {
    this.cancelHeartbeat?.();
    this.cancelHeartbeat = null;
    this.pendingReplyEchoes.clear();
    this.wanted = null;
    this.joined = false;
    this.identity = null;
    this.broadcasterId = null;
    if (this.validationTimer) clearTimeout(this.validationTimer);
    this.validationTimer = null;
    for (const request of this.requests) request.abort();
    this.sending?.abort();
    this.sending = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.cancelPending?.();
    this.cancelPending = null;
    if (socket) {
      if (socket.readyState === WebSocket.OPEN) socket.close(1000);
      else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }
    this.status(false, 'Twitch chat is disconnected.');
  }
}
