import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../src/main/store';
import { defaultCharacter, defaultSettings } from '../src/shared/defaults';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('memory preference compatibility', () => {
  it('loads older settings without losing memories, voice choice, artwork or overlay pairing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'couchkin-store-test-'));
    directories.push(directory);
    const { rememberMoments: _newPreference, ...oldSettings } = defaultSettings;
    const old = {
      character: { ...defaultCharacter, name: 'Riff', personality: 'trash-talker' },
      settings: { ...oldSettings, liveVoice: 'cedar' },
      memories: [{ id: 'old-moment', text: 'We call the overkill move meteor budgeting.' }],
      avatarPath: '/fixture/characters/riff.png',
      pairingToken: 'b'.repeat(48),
    };
    await writeFile(join(directory, 'settings.json'), JSON.stringify(old));
    const store = new LocalStore(directory);
    expect(await store.load()).toEqual({
      ...old,
      settings: { ...old.settings, rememberMoments: true },
    });
  });
});
