/* Hallmark · pre-emit critique: P5 H4 E4 S5 R4 V4
 * Component scope: companion quick picks · playful · existing cream / moss tokens.
 */
import { ArrowRight, Check, CircleCheck, SlidersHorizontal } from 'lucide-react';
import { companionQuickPicks, getPersonalityProfile } from '../../shared/personalities';
import type { Character as CharacterDefinition } from '../../shared/types';
import Character from './Character';

export default function CompanionQuickPicks({
  character,
  avatarUrl,
  unsaved,
  busy,
  sessionActive,
  onSelect,
  onCustomize,
  onRestore,
  onUse,
}: {
  character: CharacterDefinition;
  avatarUrl: string | null;
  unsaved: boolean;
  busy: boolean;
  sessionActive: boolean;
  onSelect: (character: CharacterDefinition) => void;
  onCustomize: () => void;
  onRestore: () => void;
  onUse: () => void;
}) {
  const selectedPick = companionQuickPicks.find(({ character: preset }) =>
    (Object.keys(preset) as (keyof CharacterDefinition)[]).every(
      (key) => character[key] === preset[key],
    ),
  );
  const personality = getPersonalityProfile(character.personality);
  return (
    <section className="quick-picks" aria-labelledby="quick-picks-heading">
      <div className="quick-picks-heading">
        <h2 id="quick-picks-heading">A few friends to get you started</h2>
        <p>Pick a personality. Their look, name, and vibe are ready to go.</p>
      </div>
      <div className="quick-pick-grid" role="group" aria-label="Ready-to-go companions">
        {companionQuickPicks.map((pick) => (
          <button
            type="button"
            key={pick.id}
            className={`quick-pick ${selectedPick?.id === pick.id ? 'selected' : ''}`}
            aria-pressed={selectedPick?.id === pick.id}
            disabled={busy}
            onClick={() => onSelect({ ...pick.character })}
          >
            <span className="quick-pick-art" aria-hidden="true">
              <Character character={pick.character} small />
            </span>
            <span className="quick-pick-copy">
              <strong>{pick.label}</strong>
              <span className="quick-pick-personality">
                {getPersonalityProfile(pick.character.personality).label}
              </span>
              <span className="quick-pick-description">{pick.description}</span>
            </span>
            <span className="quick-pick-check" aria-hidden="true">
              {selectedPick?.id === pick.id && <Check size={16} />}
            </span>
          </button>
        ))}
      </div>
      <div className="quick-pick-current panel">
        <div className="quick-current-art" aria-hidden="true">
          {avatarUrl ? <img src={avatarUrl} alt="" /> : <Character character={character} small />}
        </div>
        <div className="quick-current-copy">
          <span className="eyebrow">{unsaved ? 'YOUR PICK' : 'YOUR COMPANION'}</span>
          <h2>
            {character.name || 'Your buddy'} <span>· {personality.label}</span>
          </h2>
          <p>{personality.description}</p>
          <p className="quick-pick-status" role="status">
            {unsaved ? (
              sessionActive ? (
                'Using this pick pauses the current session. Resume when you’re ready.'
              ) : (
                'Save your pick, then start a session when you’re ready.'
              )
            ) : (
              <>
                <CircleCheck size={16} /> Saved and ready for the couch.
              </>
            )}
          </p>
        </div>
        <div className="quick-current-actions">
          <button className="button primary" disabled={busy} onClick={onUse}>
            <ArrowRight size={17} />
            {unsaved
              ? selectedPick
                ? `Use ${selectedPick.label}`
                : 'Use this companion'
              : 'Go to the couch'}
          </button>
          <button className="button secondary" onClick={onCustomize}>
            <SlidersHorizontal size={17} /> Customize
          </button>
          {unsaved && (
            <div className="quick-draft-actions">
              <button className="text-button" disabled={busy} onClick={onRestore}>
                Keep saved companion
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
