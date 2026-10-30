import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export class LocalSpeech {
  private child: ChildProcess | null = null;
  private epoch = 0;
  constructor(readonly directory: string) {}
  cancel() {
    this.epoch++;
    this.child?.kill('SIGTERM');
    this.child = null;
  }
  async synthesize(text: string, voice = 'Samantha'): Promise<string | null> {
    this.cancel();
    const epoch = this.epoch;
    if (process.platform !== 'darwin') return null;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${randomUUID()}.wav`);
    try {
      await new Promise<void>((resolve, reject) => {
        // Text goes through stdin: never interpolate model output into a shell command.
        const child = spawn(
          '/usr/bin/say',
          [
            '-v',
            voice,
            '-r',
            '185',
            '-o',
            path,
            '--file-format=WAVE',
            '--data-format=LEI16@24000',
            '-f',
            '-',
          ],
          { stdio: ['pipe', 'ignore', 'ignore'] },
        );
        this.child = child;
        const timeout = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error('Local speech took too long.'));
        }, 15000);
        child.on('error', () => {
          clearTimeout(timeout);
          reject(new Error('Local speech is unavailable.'));
        });
        child.on('close', (code) => {
          clearTimeout(timeout);
          if (this.child === child) this.child = null;
          code === 0 ? resolve() : reject(new Error('Speech stopped.'));
        });
        child.stdin?.end(text.slice(0, 1600));
      });
      if (epoch === this.epoch) return path;
      await unlink(path).catch(() => {});
      return null;
    } catch (error) {
      await unlink(path).catch(() => {});
      throw error;
    }
  }
}
