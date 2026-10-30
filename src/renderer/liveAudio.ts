/** Raw mono PCM16LE used by GPT-Live. This module never stores audio on disk. */
export const LIVE_SAMPLE_RATE = 24_000;
const MAX_CHUNK_BYTES = LIVE_SAMPLE_RATE * 2 * 4;

export function pcm16Base64ToFloat32(base64: string): Float32Array {
  if (!base64 || base64.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4)
    throw new Error('Live audio chunk has an invalid size.');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('Invalid live audio.');
  const binary = atob(base64);
  if (binary.length % 2 || !binary.length) throw new Error('Incomplete live audio sample.');
  const result = new Float32Array(binary.length / 2);
  for (let i = 0; i < result.length; i++) {
    const unsigned = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
    result[i] = (unsigned >= 32768 ? unsigned - 65536 : unsigned) / 32768;
  }
  return result;
}

export function pcmBytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export interface PcmPlayerOptions {
  onActivity?: (active: boolean) => void;
  onProgress?: (playedMs: number) => void;
  onError?: (message: string) => void;
  maxQueueSeconds?: number;
}

type ScheduledChunk = {
  source: AudioBufferSourceNode;
  start: number;
  end: number;
  // Short windows allow continuous silent output to leave the character at rest.
  audible: { start: number; end: number }[];
};

/** Schedules ordered chunks against the audio clock, including gaps and interruptions. */
export class PcmPlayer {
  private context: AudioContext | null = null;
  private chunks: ScheduledChunk[] = [];
  private tail = 0;
  private completedMs = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;
  private audibleUntil = 0;
  private generation = 0;
  private disposed = false;
  private pendingSeconds = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly maxQueueSeconds: number;

  constructor(private readonly options: PcmPlayerOptions = {}) {
    this.maxQueueSeconds = Math.min(30, Math.max(1, options.maxQueueSeconds ?? 8));
  }

  get playedMilliseconds(): number {
    if (!this.context) return this.completedMs;
    const now = this.context.currentTime;
    return (
      this.completedMs +
      this.chunks.reduce(
        (total, chunk) => total + Math.max(0, Math.min(now, chunk.end) - chunk.start) * 1000,
        0,
      )
    );
  }

  async push(base64: string): Promise<void> {
    if (this.disposed) return;
    let samples: Float32Array;
    try {
      samples = pcm16Base64ToFloat32(base64);
    } catch {
      this.options.onError?.('Pip received an invalid audio chunk. Reconnect live voice.');
      return;
    }
    const seconds = samples.length / LIVE_SAMPLE_RATE;
    const contextQueue = this.context ? Math.max(0, this.tail - this.context.currentTime) : 0;
    if (contextQueue + this.pendingSeconds + seconds > this.maxQueueSeconds) {
      this.stop();
      this.options.onError?.('Live voice playback fell behind. Reconnect to catch up.');
      return;
    }
    const generation = this.generation;
    this.pendingSeconds += seconds;
    const schedule = async () => {
      if (generation !== this.generation || this.disposed) return;
      const context = (this.context ??= new AudioContext({ latencyHint: 'interactive' }));
      if (context.state === 'suspended') await context.resume();
      if (generation !== this.generation || this.disposed) return;
      if (context.state !== 'running') throw new Error('Audio output unavailable');
      this.pendingSeconds = Math.max(0, this.pendingSeconds - seconds);
      const now = context.currentTime;
      const start = Math.max(this.tail, now + (this.tail > now ? 0 : 0.035));
      const end = start + seconds;
      const buffer = context.createBuffer(1, samples.length, LIVE_SAMPLE_RATE);
      buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const audible: ScheduledChunk['audible'] = [];
      for (let offset = 0; offset < samples.length; offset += 480) {
        const limit = Math.min(samples.length, offset + 480);
        let energy = 0;
        for (let index = offset; index < limit; index++) energy += samples[index] ** 2;
        if (Math.sqrt(energy / (limit - offset)) > 0.003)
          audible.push({
            start: start + offset / LIVE_SAMPLE_RATE,
            end: start + limit / LIVE_SAMPLE_RATE,
          });
      }
      this.chunks.push({ source, start, end, audible });
      this.tail = end;
      source.onended = () => {
        source.disconnect();
        if (generation === this.generation) this.tick();
      };
      source.start(start);
      this.timer ??= setInterval(() => this.tick(), 25);
      this.tick();
    };
    this.chain = this.chain.then(schedule).catch(() => {
      if (generation !== this.generation || this.disposed) return;
      this.stop();
      this.options.onError?.('Live voice could not play. Check your audio output and reconnect.');
    });
    await this.chain;
  }

  private tick() {
    if (!this.context) return;
    const now = this.context.currentTime;
    for (const chunk of this.chunks)
      for (const window of chunk.audible)
        if (window.start <= now) this.audibleUntil = Math.max(this.audibleUntil, window.end + 0.12);
    while (this.chunks.length && this.chunks[0].end <= now) {
      const finished = this.chunks.shift()!;
      this.completedMs += (finished.end - finished.start) * 1000;
    }
    const speaking = this.context.state === 'running' && now < this.audibleUntil;
    this.setActive(speaking);
    this.options.onProgress?.(this.playedMilliseconds);
    if (!this.chunks.length && !this.active && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private setActive(active: boolean) {
    if (active === this.active) return;
    this.active = active;
    this.options.onActivity?.(active);
  }

  stop() {
    this.generation++;
    for (const { source } of this.chunks) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* Already ended. */
      }
      source.disconnect();
    }
    this.chunks = [];
    this.pendingSeconds = 0;
    this.tail = 0;
    this.audibleUntil = 0;
    this.completedMs = 0;
    // New playback must not wait on an obsolete suspended resume promise.
    this.chain = Promise.resolve();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.setActive(false);
  }

  async dispose() {
    this.disposed = true;
    this.stop();
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') await context.close().catch(() => {});
  }
}
