import { EventEmitter } from 'node:events';

const OAUTH_BASE = 'https://id.twitch.tv/oauth2';
const SCOPES = 'chat:read user:write:chat';
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 16 * 1024;

export interface DeviceAuthorization {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}
export interface TwitchAuthorizationStatus {
  state: 'pending' | 'authorized' | 'cancelled' | 'error';
  message: string;
}

function canceled(): Error {
  return Object.assign(new Error('Twitch sign-in was cancelled.'), { name: 'AbortError' });
}

/** Only Twitch's device activation page may be presented to the user. */
function activationUri(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error();
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'www.twitch.tv' ||
    url.port ||
    url.username ||
    url.password ||
    !['/activate', '/activate/'].includes(url.pathname) ||
    url.hash
  )
    throw new Error();
  // Reconstruct the known URL rather than forwarding unexpected query parameters.
  const code = url.searchParams.get('device-code');
  if (code !== null && !/^[A-Za-z0-9-]{4,64}$/.test(code)) throw new Error();
  const safe = new URL('https://www.twitch.tv/activate');
  safe.searchParams.set('public', 'true');
  if (code) safe.searchParams.set('device-code', code);
  return safe.href;
}

async function requestJson(
  endpoint: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${OAUTH_BASE}/${endpoint}`, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([signal, timeout.signal]),
    });
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error();
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.byteLength;
        if (length > MAX_RESPONSE_BYTES) throw new Error();
        chunks.push(result.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return { ok: response.ok, status: response.status, body: body as Record<string, unknown> };
  } finally {
    clearTimeout(timer);
  }
}

function post(body: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  };
}

/** Main-process-only OAuth. A successful token is handed off once and never persisted here. */
export class TwitchDeviceAuth extends EventEmitter {
  private epoch = 0;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private status(state: TwitchAuthorizationStatus['state'], message: string): void {
    this.emit('status', { state, message } satisfies TwitchAuthorizationStatus);
  }

  async begin(rawClientId: string): Promise<DeviceAuthorization> {
    const clientId = rawClientId.trim();
    if (!/^[A-Za-z0-9]{10,128}$/.test(clientId))
      throw new Error('Enter the public Client ID from your registered Twitch application.');
    this.stop();
    const epoch = this.epoch;
    const abort = new AbortController();
    this.abort = abort;
    this.status('pending', 'Preparing Twitch sign-in…');
    try {
      const response = await requestJson(
        'device',
        post({ client_id: clientId, scopes: SCOPES }),
        abort.signal,
      );
      if (epoch !== this.epoch || abort.signal.aborted) throw canceled();
      const { device_code, expires_in, interval, user_code, verification_uri } = response.body;
      if (
        !response.ok ||
        typeof device_code !== 'string' ||
        !/^[A-Za-z0-9_-]{10,512}$/.test(device_code) ||
        typeof user_code !== 'string' ||
        !/^[A-Za-z0-9-]{4,64}$/.test(user_code) ||
        typeof expires_in !== 'number' ||
        !Number.isInteger(expires_in) ||
        expires_in <= 0 ||
        expires_in > 3600 ||
        typeof interval !== 'number' ||
        !Number.isInteger(interval) ||
        interval < 1 ||
        interval > 120
      )
        throw new Error();
      const authorization = {
        userCode: user_code,
        verificationUri: activationUri(verification_uri),
        expiresAt: Date.now() + expires_in * 1000,
      };
      // A returned activation URL must not point at a different code.
      const linkedCode = new URL(authorization.verificationUri).searchParams.get('device-code');
      if (linkedCode && linkedCode !== user_code) throw new Error();
      this.status('pending', 'Finish signing in on Twitch, then return to Couchkin.');
      if (epoch !== this.epoch || abort.signal.aborted) throw canceled();
      this.schedulePoll(
        clientId,
        device_code,
        authorization.expiresAt,
        interval * 1000,
        epoch,
        abort,
      );
      return authorization;
    } catch (error) {
      if (epoch !== this.epoch || abort.signal.aborted) throw canceled();
      this.stop();
      const message =
        'Could not start Twitch sign-in. Check your public Client ID and connection, then try again.';
      this.status('error', message);
      throw new Error(message);
    }
  }

  private schedulePoll(
    clientId: string,
    deviceCode: string,
    expiresAt: number,
    intervalMs: number,
    epoch: number,
    abort: AbortController,
  ): void {
    if (epoch !== this.epoch || abort.signal.aborted) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.poll(clientId, deviceCode, expiresAt, intervalMs, epoch, abort);
      },
      Math.min(intervalMs, Math.max(0, expiresAt - Date.now())),
    );
  }

  private async poll(
    clientId: string,
    deviceCode: string,
    expiresAt: number,
    intervalMs: number,
    epoch: number,
    abort: AbortController,
  ): Promise<void> {
    const current = () => epoch === this.epoch && !abort.signal.aborted;
    if (!current()) return;
    if (Date.now() >= expiresAt) {
      this.stop();
      this.status('error', 'Twitch sign-in expired. Start sign-in again for a fresh code.');
      return;
    }
    try {
      const response = await requestJson(
        'token',
        post({
          client_id: clientId,
          scopes: SCOPES,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
        abort.signal,
      );
      if (!current()) return;
      const errorCode = response.body.error ?? response.body.message;
      if (!response.ok && (errorCode === 'authorization_pending' || errorCode === 'slow_down')) {
        this.schedulePoll(
          clientId,
          deviceCode,
          expiresAt,
          errorCode === 'slow_down' ? Math.min(intervalMs + 5000, 120_000) : intervalMs,
          epoch,
          abort,
        );
        return;
      }
      if (!response.ok) {
        this.stop();
        this.status(
          'error',
          errorCode === 'access_denied' || errorCode === 'authorization_declined'
            ? 'Twitch sign-in was declined. You can sign in again whenever you are ready.'
            : errorCode === 'expired_token' || errorCode === 'invalid device code'
              ? 'Twitch sign-in expired. Start sign-in again for a fresh code.'
              : 'Twitch sign-in could not finish. Start sign-in again.',
        );
        return;
      }
      const token = response.body.access_token;
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,512}$/.test(token)) throw new Error();
      const validated = await requestJson(
        'validate',
        { headers: { Authorization: `OAuth ${token}` } },
        abort.signal,
      );
      if (!current()) return;
      const { login, user_id, client_id, scopes, expires_in } = validated.body;
      if (
        !validated.ok ||
        client_id !== clientId ||
        typeof login !== 'string' ||
        !/^[a-z0-9_]{1,25}$/.test(login) ||
        typeof user_id !== 'string' ||
        !/^\d+$/.test(user_id) ||
        !Array.isArray(scopes) ||
        !['chat:read', 'user:write:chat'].every((scope) => scopes.includes(scope)) ||
        typeof expires_in !== 'number' ||
        !Number.isFinite(expires_in) ||
        expires_in <= 0
      ) {
        this.stop();
        this.status(
          'error',
          'Twitch did not grant chat reading and posting access. Sign in again and approve both permissions.',
        );
        return;
      }
      this.stop();
      const completedEpoch = this.epoch;
      this.status('authorized', `Signed in as ${login}. Connecting chat…`);
      if (this.epoch === completedEpoch) this.emit('authorized', { username: login, token });
    } catch {
      if (!current()) return;
      this.stop();
      this.status('error', 'Twitch sign-in lost its connection. Start sign-in again.');
    }
  }

  private stop(): void {
    this.epoch++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
    this.abort = null;
  }

  cancel(): void {
    const active = this.abort !== null;
    this.stop();
    if (active) this.status('cancelled', 'Twitch sign-in was cancelled.');
  }

  dispose(): void {
    this.cancel();
    this.removeAllListeners();
  }
}
