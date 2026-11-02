import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sanitizeLiveTransportDiagnostic } from './live-diagnostics';

const triggers = ['manual', 'periodic', 'speech'];
const outcomes = ['submitted', 'unchanged', 'stale', 'superseded', 'failed'];
const phases = ['capture', 'interpretation', 'context'];
const codes = [
  'observation_capture_failed',
  'observation_failed',
  'observation_network_error',
  'observation_http_error',
  'observation_invalid_response',
  'observation_timeout',
  'observation_body_error',
];
const transportCodes = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
];
const twitchEvents = [
  'joined',
  'probe_sent',
  'probe_ack',
  'probe_timeout',
  'message_received',
  'message_filtered',
  'socket_closed',
  'socket_error',
];
const number = (value: unknown, maximum: number): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum
    ? Math.round(value)
    : undefined;
const member = (value: unknown, allowed: string[]): string | undefined =>
  typeof value === 'string' && allowed.includes(value) ? value : undefined;

function observation(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  const trigger = member(data.trigger, triggers),
    outcome = member(data.outcome, outcomes);
  if (!trigger || !outcome) return null;
  return {
    trigger,
    outcome,
    capturedAt: number(data.capturedAt, 10_000_000_000_000),
    durationMs: number(data.durationMs, 86_400_000),
    phase: member(data.phase, phases),
    code: member(data.code, codes),
    httpStatus:
      typeof data.httpStatus === 'number' &&
      Number.isInteger(data.httpStatus) &&
      data.httpStatus >= 100 &&
      data.httpStatus <= 599
        ? data.httpStatus
        : undefined,
    transportCode: member(data.transportCode, transportCodes),
  };
}

function twitch(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  const event = member(data.event, twitchEvents);
  if (!event) return null;
  const result: Record<string, string | number | null | undefined> = { event };
  for (const field of [
    'receivedFrames',
    'parsedMessages',
    'acceptedMessages',
    'duplicateMessages',
    'echoMessages',
  ])
    result[field] = number(data[field], Number.MAX_SAFE_INTEGER);
  for (const field of ['lastFrameAt', 'lastMessageAt', 'lastProbeAckAt'])
    result[field] = data[field] == null ? null : number(data[field], 10_000_000_000_000);
  return result;
}

function safeEntry(kind: unknown, value: unknown, at: string) {
  const data =
    kind === 'transport'
      ? sanitizeLiveTransportDiagnostic(value)
      : kind === 'observation'
        ? observation(value)
        : kind === 'twitch'
          ? twitch(value)
          : null;
  return data ? { at, kind, data } : null;
}

/** Private, bounded metadata; no content, device labels, URLs or arbitrary error strings. */
export class RuntimeDiagnostics {
  private writes = Promise.resolve();
  private pending: NonNullable<ReturnType<typeof safeEntry>>[] = [];
  private draining = false;
  constructor(private readonly directory: string) {}

  record(kind: 'transport' | 'observation' | 'twitch', value: unknown): void {
    const entry = safeEntry(kind, value, new Date().toISOString());
    if (!entry) return;
    // Prefer recent evidence when a fault storm outpaces disk. Never retain
    // unbounded promise closures or hold up audio on diagnostic writes.
    this.pending.push(entry);
    if (this.pending.length > 128) this.pending.shift();
    if (this.draining) return;
    this.draining = true;
    this.writes = Promise.resolve().then(async () => {
      try {
        while (this.pending.length) await this.writeBatch(this.pending.splice(0));
      } finally {
        this.draining = false;
      }
    });
  }

  private async writeBatch(entries: NonNullable<ReturnType<typeof safeEntry>>[]) {
    try {
      const directory = join(this.directory, 'runtime');
      const file = join(directory, 'live-diagnostics.json');
      let previous: NonNullable<ReturnType<typeof safeEntry>>[] = [];
      try {
        const raw = await readFile(file, 'utf8');
        if (raw.length <= 512 * 1024) {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed))
            previous = parsed.slice(-(500 - entries.length)).flatMap((old) => {
              if (!old || typeof old !== 'object' || typeof old.at !== 'string') return [];
              const date = Date.parse(old.at);
              if (!Number.isFinite(date)) return [];
              const clean = safeEntry(old.kind, old.data, new Date(date).toISOString());
              return clean ? [clean] : [];
            });
        }
      } catch {
        /* Missing diagnostics must not affect a conversation. */
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.tmp`;
      await writeFile(temporary, JSON.stringify([...previous, ...entries]), { mode: 0o600 });
      await rename(temporary, file);
    } catch {
      /* Diagnostics never break the live audio path. */
    }
  }

  flush(): Promise<void> {
    return this.writes;
  }
}
