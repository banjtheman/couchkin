import { describe, it, expect } from 'vitest';
import { commandSchema, safeExternalUrl } from '../src/main/validation';
import { defaultCharacter } from '../src/shared/defaults';
describe('desktop commands', () => {
  it('does not reset the voice when unrelated settings change', () => {
    expect(commandSchema.parse({ type: 'save-settings', settings: { gameTitle: 'Demo' } })).toEqual(
      { type: 'save-settings', settings: { gameTitle: 'Demo' } },
    );
  });
  it('rejects arbitrary commands and oversized untrusted input', () => {
    expect(commandSchema.safeParse({ type: 'exec', command: 'touch file' }).success).toBe(false);
    expect(commandSchema.safeParse({ type: 'send-message', text: 'x'.repeat(2001) }).success).toBe(
      false,
    );
  });
  it('constrains attributes, source cadence and voices', () => {
    expect(
      commandSchema.safeParse({
        type: 'save-character',
        character: { ...defaultCharacter, backseating: 200 },
      }).success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({ type: 'save-settings', settings: { observationInterval: 1 } })
        .success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({ type: 'save-settings', settings: { voice: '$(bad)' } }).success,
    ).toBe(false);
  });
  it('only opens regular HTTPS reference links', () => {
    expect(safeExternalUrl('https://example.com/help')).toBe(true);
    expect(safeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(safeExternalUrl('https://name:secret@example.com')).toBe(false);
    expect(safeExternalUrl('javascript:alert(1)')).toBe(false);
  });
  it('accepts bounded manual memories and independent automatic-memory preferences', () => {
    expect(
      commandSchema.parse({ type: 'add-memory', text: '  Our lucky card is a shiv.  ' }),
    ).toEqual({
      type: 'add-memory',
      text: 'Our lucky card is a shiv.',
    });
    expect(commandSchema.safeParse({ type: 'add-memory', text: ' ' }).success).toBe(false);
    expect(commandSchema.safeParse({ type: 'add-memory', text: 'x'.repeat(301) }).success).toBe(
      false,
    );
    expect(
      commandSchema.parse({ type: 'save-settings', settings: { rememberMoments: false } }),
    ).toEqual({
      type: 'save-settings',
      settings: { rememberMoments: false },
    });
    expect(
      commandSchema.safeParse({ type: 'save-settings', settings: { rememberMoments: 'yes' } })
        .success,
    ).toBe(false);
  });
});
