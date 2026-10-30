/* Hallmark · pre-emit critique: P4 H4 E4 S5 R5 V4
 * Component scope: personality picker · playful · existing cream / moss tokens.
 */
import { useId, type ButtonHTMLAttributes } from 'react';
import { AlertCircle, Check, LoaderCircle } from 'lucide-react';
import {
  getPersonalityProfile,
  personalityProfiles,
  personalityExampleScenario,
} from '../../shared/personalities';
import type { Character } from '../../shared/types';

type ChoiceState = 'idle' | 'loading' | 'error' | 'success';

export function PersonalityChoice({
  label,
  selected = false,
  state = 'idle',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  selected?: boolean;
  state?: ChoiceState;
}) {
  return (
    <button
      type="button"
      {...props}
      className={`personality-choice ${selected ? 'selected' : ''} ${className}`}
      aria-pressed={selected}
      aria-busy={state === 'loading' || undefined}
      aria-invalid={state === 'error' || undefined}
      data-state={state}
    >
      <span>{label}</span>
      {state === 'loading' && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
      {state === 'error' && <AlertCircle size={16} aria-hidden="true" />}
      {state === 'success' && <Check size={16} aria-hidden="true" />}
    </button>
  );
}

export default function PersonalityPicker({
  value,
  onChange,
  saving = false,
}: {
  value: Character['personality'];
  onChange: (value: Character['personality']) => void;
  saving?: boolean;
}) {
  const id = useId();
  const profile = getPersonalityProfile(value);

  return (
    <div className="attribute-section personality-section">
      <div className="field-label" id={`${id}-label`}>
        Personality
      </div>
      <div className="personality-picker-body">
        <div className="personality-options" role="group" aria-labelledby={`${id}-label`}>
          {personalityProfiles.map((option) => (
            <PersonalityChoice
              key={option.id}
              label={option.label}
              selected={value === option.id}
              state={saving && value === option.id ? 'loading' : 'idle'}
              disabled={saving}
              aria-describedby={value === option.id ? `${id}-description` : undefined}
              onClick={() => onChange(option.id)}
            />
          ))}
        </div>
        <div className="personality-preview" aria-live="polite" aria-atomic="true">
          <p className="personality-description" id={`${id}-description`}>
            {profile.description}
          </p>
          <div className="personality-example">
            <span className="personality-example-label">{profile.label} in action</span>
            <p className="personality-scenario">{personalityExampleScenario}</p>
            <blockquote>“{profile.example}”</blockquote>
            <p className="personality-example-note">Scripted example · Live replies will vary.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
