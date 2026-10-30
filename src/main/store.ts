import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { characterSchema, settingsSchema } from './validation';
import type { Character, Settings } from '../shared/types';
import { defaultSettings } from '../shared/defaults';
export interface PersistedState {
  character: Character;
  settings: Settings;
  memories: { id: string; text: string }[];
  avatarPath: string | null;
  pairingToken: string;
}
export class LocalStore {
  private pending: Promise<void> = Promise.resolve();
  constructor(readonly directory: string) {}
  async load(): Promise<Partial<PersistedState>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const raw = JSON.parse(await readFile(join(this.directory, 'settings.json'), 'utf8'));
      return {
        character: characterSchema.parse(raw.character),
        settings: settingsSchema.parse({ ...defaultSettings, ...raw.settings }),
        memories: Array.isArray(raw.memories)
          ? raw.memories
              .filter(
                (m: unknown) =>
                  !!m &&
                  typeof m === 'object' &&
                  'id' in m &&
                  'text' in m &&
                  typeof m.id === 'string' &&
                  typeof m.text === 'string',
              )
              .slice(-40)
          : [],
        avatarPath: typeof raw.avatarPath === 'string' ? raw.avatarPath : null,
        pairingToken:
          typeof raw.pairingToken === 'string' && /^[a-f0-9]{48}$/.test(raw.pairingToken)
            ? raw.pairingToken
            : randomBytes(24).toString('hex'),
      };
    } catch {
      return { pairingToken: randomBytes(24).toString('hex') };
    }
  }
  save(value: PersistedState): Promise<void> {
    const data = JSON.stringify(value, null, 2);
    this.pending = this.pending
      .catch(() => {})
      .then(async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const temp = join(this.directory, 'settings.json.tmp');
        await writeFile(temp, data, { mode: 0o600 });
        await rename(temp, join(this.directory, 'settings.json'));
      });
    return this.pending;
  }
}
