import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeDiagnostics } from '../src/main/runtime-diagnostics';

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'couchkin-diagnostics-'));
  directories.push(directory);
  return {
    directory,
    log: new RuntimeDiagnostics(directory),
    file: join(directory, 'runtime', 'live-diagnostics.json'),
  };
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { force: true, recursive: true })));
});

describe('private runtime diagnostics', () => {
  it('persists Twitch receipt and health metadata without chat content or connection secrets', async () => {
    const { log, file } = await fixture();
    const secret = 'private-chat-or-token';
    log.record('twitch', {
      event: 'probe_ack',
      receivedFrames: 12,
      parsedMessages: 3,
      acceptedMessages: 2,
      duplicateMessages: 1,
      echoMessages: 0,
      lastFrameAt: 1_800_000_000_000,
      lastMessageAt: 1_799_999_999_000,
      lastProbeAckAt: 1_800_000_000_000,
      message: secret,
      channel: secret,
      token: secret,
      error: secret,
    });
    log.record('twitch', { event: secret, acceptedMessages: 5 });
    log.record('twitch', {
      event: 'probe_timeout',
      receivedFrames: -1,
      parsedMessages: Number.POSITIVE_INFINITY,
      acceptedMessages: secret,
      lastFrameAt: secret,
      lastMessageAt: null,
      lastProbeAckAt: null,
    });
    await log.flush();
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain(secret);
    const entries = JSON.parse(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0].data).toEqual({
      event: 'probe_ack',
      receivedFrames: 12,
      parsedMessages: 3,
      acceptedMessages: 2,
      duplicateMessages: 1,
      echoMessages: 0,
      lastFrameAt: 1_800_000_000_000,
      lastMessageAt: 1_799_999_999_000,
      lastProbeAckAt: 1_800_000_000_000,
    });
    expect(entries[1].data).toEqual({
      event: 'probe_timeout',
      lastMessageAt: null,
      lastProbeAckAt: null,
    });
  });

  it('retains useful failure metadata but strips content, credentials and unrecognized fields', async () => {
    const { log, file } = await fixture();
    const secret = 'secret-key-and-private-screen-content';
    log.record('transport', {
      kind: 'api_error',
      sessionElapsedMs: 1100,
      lastReceivedAgeMs: 0,
      bufferedBytes: 32,
      pendingToolCount: 1,
      pendingContextCount: 0,
      outgoingEventType: 'session.thinking.append',
      apiErrorCode: 'invalid_request_error',
      apiErrorType: 'invalid_request_error',
      apiErrorParam: secret,
      message: secret,
      clientEventId: secret,
      audio: secret,
    });
    log.record('observation', {
      trigger: 'speech',
      outcome: 'failed',
      phase: 'interpretation',
      durationMs: 200,
      code: 'observation_http_error',
      httpStatus: 429,
      transportCode: secret,
      image: secret,
      summary: secret,
      source: secret,
    });
    await log.flush();
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain(secret);
    const entries = JSON.parse(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0].data).toMatchObject({
      outgoingEventType: 'session.thinking.append',
      apiErrorParam: 'unknown',
    });
    expect(entries[1].data).toEqual({
      trigger: 'speech',
      outcome: 'failed',
      phase: 'interpretation',
      durationMs: 200,
      code: 'observation_http_error',
      httpStatus: 429,
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('bounds and re-sanitizes persisted history, and ignores malformed events', async () => {
    const { log, file, directory } = await fixture();
    await mkdir(join(directory, 'runtime'));
    const secret = 'private-old-content';
    await writeFile(
      file,
      JSON.stringify(
        Array.from({ length: 600 }, () => ({
          at: '2026-10-30T18:00:00.000Z',
          kind: 'observation',
          data: { trigger: 'periodic', outcome: 'submitted', durationMs: 42, summary: secret },
        })),
      ),
    );
    log.record('observation', { trigger: secret, outcome: 'failed' });
    log.record('observation', { trigger: 'speech', outcome: 'stale', durationMs: 6100 });
    await log.flush();
    const raw = await readFile(file, 'utf8');
    const entries = JSON.parse(raw);
    expect(entries).toHaveLength(500);
    expect(raw).not.toContain(secret);
    expect(entries.at(-1).data).toEqual({ trigger: 'speech', outcome: 'stale', durationMs: 6100 });
  });

  it('does not break the conversation when storage is unavailable', async () => {
    const { directory } = await fixture();
    await writeFile(join(directory, 'runtime'), 'occupied');
    const log = new RuntimeDiagnostics(directory);
    log.record('observation', { trigger: 'speech', outcome: 'failed', durationMs: 100 });
    await expect(log.flush()).resolves.toBeUndefined();
  });

  it('bounds a write backlog and preserves the newest evidence during an event burst', async () => {
    const { log, file } = await fixture();
    for (let i = 0; i < 1000; i++)
      log.record('observation', { trigger: 'speech', outcome: 'failed', durationMs: i });
    expect((log as any).pending).toHaveLength(128);
    await log.flush();
    const entries = JSON.parse(await readFile(file, 'utf8'));
    expect(entries).toHaveLength(128);
    expect(entries[0].data.durationMs).toBe(872);
    expect(entries.at(-1).data.durationMs).toBe(999);
  });
});
