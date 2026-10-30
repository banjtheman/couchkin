import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

/** Credentials are read only by Electron main, never copied to settings or the renderer. */
export async function readApiConfig(appPath: string, userData: string) {
  if (process.env.OPENAI_API_KEY?.trim()) return { apiKey: process.env.OPENAI_API_KEY.trim() };
  const candidates = new Set<string>([join(userData, '.env')]);
  for (const start of [process.cwd(), appPath]) {
    let directory = resolve(start);
    for (let level = 0; level < 8; level++) {
      try {
        const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (pkg.name === 'couchkin') candidates.add(join(directory, '.env'));
      } catch {
        /* Not a Couchkin project directory. */
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  for (const path of candidates) {
    try {
      const contents = await readFile(path, 'utf8');
      if (contents.length > 64 * 1024) continue;
      const key = parseEnv(contents).OPENAI_API_KEY?.trim();
      if (key && key.length < 1024) return { apiKey: key };
    } catch {
      /* An absent environment file is normal. */
    }
  }
  return { apiKey: undefined };
}
