// Hallmark state reference. Not imported by the application or bundled for production.
import { useState } from 'react';
import type { Character } from '../../shared/types';
import PersonalityPicker, { PersonalityChoice } from './PersonalityPicker';

export default function PersonalityPickerPreview() {
  const [value, setValue] = useState<Character['personality']>('trash-talker');
  return (
    <main className="personality-state-preview">
      <h1>Personality choices</h1>
      <PersonalityPicker value={value} onChange={setValue} />
      <h2>Interaction states</h2>
      <dl>
        <dt>Default</dt>
        <dd>
          <PersonalityChoice label="Trash talker" />
        </dd>
        <dt>Hover</dt>
        <dd>
          <PersonalityChoice label="Trash talker" className="is-hover" />
        </dd>
        <dt>Focus</dt>
        <dd>
          <PersonalityChoice label="Trash talker" className="is-focus" />
        </dd>
        <dt>Active</dt>
        <dd>
          <PersonalityChoice label="Trash talker" className="is-active" />
        </dd>
        <dt>Disabled</dt>
        <dd>
          <PersonalityChoice label="Trash talker" disabled />
        </dd>
        <dt>Loading</dt>
        <dd>
          <PersonalityChoice label="Trash talker" selected state="loading" disabled />
        </dd>
        <dt>Error</dt>
        <dd>
          <PersonalityChoice label="Try again" state="error" />
        </dd>
        <dt>Success</dt>
        <dd>
          <PersonalityChoice label="Trash talker" selected state="success" />
        </dd>
      </dl>
    </main>
  );
}
