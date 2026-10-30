import { useId, type CSSProperties } from 'react';
import './companion-motion.css';
import type { Character as CharacterDefinition, Expression } from '../../shared/types';

export const palettes = {
  moss: {
    main: 'var(--character-moss-main)',
    dark: 'var(--character-moss-dark)',
    accent: 'var(--character-moss-accent)',
    light: 'var(--character-moss-light)',
  },
  ember: {
    main: 'var(--character-ember-main)',
    dark: 'var(--character-ember-dark)',
    accent: 'var(--character-ember-accent)',
    light: 'var(--character-ember-light)',
  },
  berry: {
    main: 'var(--character-berry-main)',
    dark: 'var(--character-berry-dark)',
    accent: 'var(--character-berry-accent)',
    light: 'var(--character-berry-light)',
  },
  ocean: {
    main: 'var(--character-ocean-main)',
    dark: 'var(--character-ocean-dark)',
    accent: 'var(--character-ocean-accent)',
    light: 'var(--character-ocean-light)',
  },
};

export default function Character({
  character,
  expression = 'idle',
  speaking = false,
  small = false,
}: {
  character: CharacterDefinition;
  expression?: Expression;
  speaking?: boolean;
  small?: boolean;
}) {
  const id = useId().replaceAll(':', '');
  const p = palettes[character.palette];
  const tall = character.shape === 'tall';
  const robot = character.theme === 'robot';
  const forest = character.theme === 'forest';
  const rx = character.shape === 'bean' ? 88 : tall ? 62 : 80;
  const faceTop = tall ? 99 : 113;
  const happy = expression === 'happy' || (expression === 'idle' && character.eyes === 'bright');
  const sleepy = expression === 'idle' && character.eyes === 'sleepy';
  const thinking = expression === 'thinking';
  const idleDelay = -(Array.from(id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 70) / 10;
  const surprised = expression === 'surprised';
  const skeptical = expression === 'skeptical';
  return (
    <svg
      viewBox="0 0 320 330"
      role="img"
      aria-label={`${character.name}, ${expression} ${robot ? 'pocket robot' : forest ? 'forest familiar' : 'star sprite'}`}
      className={`character-art couchkin-character ${small ? 'small' : ''} expression-${expression} ${speaking ? 'is-speaking' : ''}`}
      style={{ '--ck-idle-delay': `${idleDelay}s` } as CSSProperties}
      data-expression={expression}
      data-speaking={speaking}
    >
      <defs>
        <linearGradient id={`${id}body`} x1="0" y1="0" x2=".8" y2="1">
          <stop stopColor="var(--character-shell-light)" />
          <stop offset=".55" stopColor="var(--character-shell-mid)" />
          <stop offset="1" stopColor="var(--character-shell-shade)" />
        </linearGradient>
        <linearGradient id={`${id}green`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor={p.main} />
          <stop offset="1" stopColor={p.dark} />
        </linearGradient>
        <linearGradient id={`${id}face`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="var(--character-face-light)" />
          <stop offset="1" stopColor="var(--character-face-dark)" />
        </linearGradient>
        <radialGradient id={`${id}shine`}>
          <stop stopColor="var(--character-shine)" stopOpacity=".8" />
          <stop offset="1" stopColor="var(--character-shine)" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}shadow`} x="-25%" y="-25%" width="150%" height="170%">
          <feDropShadow
            dx="0"
            dy="7"
            stdDeviation="5"
            floodColor="var(--character-shadow)"
            floodOpacity=".14"
          />
        </filter>
      </defs>
      {!small && (
        <ellipse
          cx="160"
          cy="302"
          rx="77"
          ry="12"
          fill="var(--character-ground)"
          opacity=".12"
          className="character-shadow"
        />
      )}
      <g className="character-body" filter={`url(#${id}shadow)`}>
        <g className="character-pose">
          {!robot && !forest && (
            <g className="orbit-stars" fill={p.accent}>
              <path d="m62 97 5 10 11 2-8 8 2 11-10-5-10 5 2-11-8-8 11-2z" />
              <path d="m257 70 4 8 9 1-6 6 1 9-8-4-7 4 1-9-6-6 8-1z" />
              <circle cx="262" cy="151" r="5" />
            </g>
          )}
          {forest && (
            <g fill={`url(#${id}green)`}>
              <path d="M151 99C89 97 72 67 68 33c43 2 78 12 83 66Z" />
              <path d="M162 100c-5-45 22-70 50-77 10 34-4 60-50 77Z" />
              <path
                d="m143 94-50-40m73 33 33-45"
                stroke={p.light}
                strokeWidth="3"
                opacity=".5"
                fill="none"
              />
            </g>
          )}
          {robot && (
            <g>
              <ellipse cx={160 - rx - 6} cy="187" rx="18" ry="37" fill={`url(#${id}green)`} />
              <ellipse cx={160 + rx + 6} cy="187" rx="18" ry="37" fill={`url(#${id}green)`} />
              <ellipse cx={160 - rx - 11} cy="187" rx="7" ry="20" fill={p.dark} />
              <ellipse cx={160 + rx + 11} cy="187" rx="7" ry="20" fill={p.dark} />
            </g>
          )}
          <g className="character-feet">
            <ellipse
              cx="124"
              cy="282"
              rx="28"
              ry="17"
              fill={p.accent}
              transform="rotate(-9 124 282)"
            />
            <ellipse
              cx="196"
              cy="282"
              rx="28"
              ry="17"
              fill={p.accent}
              transform="rotate(9 196 282)"
            />
            <path
              d="M106 279h32m44 0h32"
              stroke="var(--character-shoe-highlight)"
              strokeWidth="3"
              strokeLinecap="round"
              opacity=".5"
            />
          </g>
          {robot ? (
            <rect
              x={160 - rx}
              y={tall ? 75 : 93}
              width={rx * 2}
              height={tall ? 202 : 181}
              rx={character.shape === 'bean' ? 75 : 55}
              fill={`url(#${id}body)`}
              stroke="var(--character-shell-outline)"
              strokeWidth="2"
            />
          ) : (
            <ellipse
              cx="160"
              cy="185"
              rx={rx + 5}
              ry={tall ? 104 : 91}
              fill={`url(#${id}body)`}
              stroke="var(--character-organic-outline)"
              strokeWidth="2"
            />
          )}
          <ellipse cx="124" cy="125" rx="61" ry="38" fill={`url(#${id}shine)`} />
          {forest && (
            <path
              d="M84 226c22 8 19 35 32 30 17-6 16 29 30 22 19-9 22-1 34 0 17 1 21-30 31-21 11 10 19-23 25-31-56 14-97 11-152 0Z"
              fill={`url(#${id}green)`}
            />
          )}
          {robot && (
            <rect
              x={160 - rx + 17}
              y={faceTop}
              width={rx * 2 - 34}
              height="111"
              rx="37"
              fill={`url(#${id}face)`}
              stroke="var(--character-face-outline)"
              strokeWidth="4"
            />
          )}
          {robot && (
            <path
              d={`M${160 - rx + 34} ${faceTop + 11}q30-10 53-3`}
              stroke="var(--character-face-reflection)"
              strokeWidth="3"
              opacity=".5"
              fill="none"
              strokeLinecap="round"
            />
          )}
          <g className="character-face">
            <g
              fill={robot ? 'var(--character-eyes-lit)' : 'var(--character-eyes-ink)'}
              className="character-eyes"
            >
              <g className="character-lids">
                {happy ? (
                  <>
                    <path
                      d="M111 168q14-25 26 0M181 168q14-25 26 0"
                      fill="none"
                      stroke={robot ? 'var(--character-eyes-lit)' : 'var(--character-eyes-ink)'}
                      strokeWidth="9"
                      strokeLinecap="round"
                    />
                  </>
                ) : sleepy ? (
                  <>
                    <path
                      d="M111 165q13 15 27 0M181 165q13 15 27 0"
                      fill="none"
                      stroke={robot ? 'var(--character-eyes-lit)' : 'var(--character-eyes-ink)'}
                      strokeWidth="8"
                      strokeLinecap="round"
                    />
                  </>
                ) : (
                  <>
                    <ellipse
                      cx="126"
                      cy={surprised ? 162 : 166}
                      rx={surprised ? 12 : 11}
                      ry={surprised ? 25 : thinking ? 17 : 20}
                      transform={skeptical ? 'rotate(-12 126 166)' : undefined}
                    />
                    <ellipse
                      cx="194"
                      cy={surprised ? 162 : 166}
                      rx={surprised ? 12 : 11}
                      ry={surprised ? 25 : thinking ? 17 : 20}
                    />
                    {!robot && (
                      <>
                        <ellipse
                          cx="130"
                          cy="159"
                          rx="3"
                          ry="5"
                          fill="var(--character-eye-highlight)"
                        />
                        <ellipse
                          cx="198"
                          cy="159"
                          rx="3"
                          ry="5"
                          fill="var(--character-eye-highlight)"
                        />
                      </>
                    )}
                    {skeptical && (
                      <path
                        d="m111 147 28 5"
                        stroke={robot ? 'var(--character-eyelid)' : 'var(--character-shell-mid)'}
                        strokeWidth="11"
                      />
                    )}
                  </>
                )}
              </g>
            </g>
            {(thinking || skeptical || surprised) && (
              <g
                className="character-brows"
                fill="none"
                stroke={robot ? 'var(--character-eyes-lit)' : 'var(--character-eyes-ink)'}
                strokeWidth="4"
                strokeLinecap="round"
              >
                <path
                  d={
                    surprised
                      ? 'M115 131q12-9 23 0'
                      : thinking
                        ? 'M112 141q13-7 24-2'
                        : 'M111 144l28 5'
                  }
                />
                <path
                  d={
                    surprised
                      ? 'M183 131q12-9 23 0'
                      : thinking
                        ? 'M183 135q12-6 23 1'
                        : 'M183 136q12-9 24-2'
                  }
                />
              </g>
            )}
            {!robot && (
              <g fill={p.accent} opacity=".32">
                <ellipse cx="103" cy="185" rx="13" ry="7" />
                <ellipse cx="217" cy="185" rx="13" ry="7" />
              </g>
            )}
            {speaking || happy || surprised ? (
              <g className="character-mouth">
                <path
                  d={
                    surprised
                      ? 'M151 198a9 12 0 1 0 18 0 9 12 0 1 0-18 0'
                      : 'M145 193q15 7 30 0c-1 23-29 23-30 0Z'
                  }
                  fill={robot ? 'var(--character-mouth-lit)' : 'var(--character-mouth-ink)'}
                />
                {!surprised && (
                  <path d="M151 206q9-7 18 0-9 10-18 0" fill="var(--character-tongue)" />
                )}
              </g>
            ) : (
              <path
                d={
                  skeptical
                    ? 'M150 201q10-4 20 1'
                    : thinking
                      ? 'M153 202q7-3 14 0'
                      : 'M148 196q12 12 24 0'
                }
                fill="none"
                stroke={robot ? 'var(--character-smile-lit)' : 'var(--character-smile-ink)'}
                strokeWidth="4"
                strokeLinecap="round"
              />
            )}
          </g>
          <g className="character-arms" fill={p.accent}>
            <path
              className="character-arm-left"
              d="M82 211c-7-17-20-16-21-3-13-7-23 3-16 16 7 13 18 22 30 17 11-4 12-15 7-30Z"
            />
            <path
              className="character-arm-right"
              d="M238 211c7-17 20-16 21-3 13-7 23 3 16 16-7 13-18 22-30 17-11-4-12-15-7-30Z"
            />
          </g>
          {character.accessory === 'antenna' && (
            <g className="character-antenna">
              <path
                d={`M156 ${tall ? 78 : 95}q-7-38 21-42`}
                stroke={p.accent}
                strokeWidth="9"
                fill="none"
                strokeLinecap="round"
              />
              <circle cx="183" cy="51" r="15" fill={p.accent} />
              <circle cx="179" cy="47" r="5" fill="var(--character-antenna-glint)" opacity=".5" />
            </g>
          )}
          {character.accessory === 'helmet' && (
            <g transform={`rotate(-9 160 ${tall ? 80 : 93})`}>
              <path
                d={`M109 ${tall ? 80 : 93}c-4-57 103-59 103 0Z`}
                fill="var(--character-helmet)"
                stroke="var(--character-helmet-outline)"
                strokeWidth="2"
              />
              <path
                d={`M103 ${tall ? 81 : 94}h116`}
                stroke="var(--character-helmet-rim)"
                strokeWidth="12"
                strokeLinecap="round"
              />
              <path d={`M147 ${tall ? 70 : 83}v-20q13-8 25 0v20`} fill={p.main} />
            </g>
          )}
          {character.accessory === 'scarf' && (
            <g fill={p.accent}>
              <path d="M90 238q69 31 141-3l-3 22q-65 22-137-2Z" />
              <path d="m195 253 29 9-19 39-17-10Z" />
              <path
                d="m98 244q62 24 123 2"
                stroke="var(--character-scarf-stitch)"
                strokeWidth="3"
                fill="none"
              />
            </g>
          )}
          {robot && (
            <g fill="var(--character-freckles)" opacity=".6">
              <circle cx="113" cy="247" r="2" />
              <circle cx="120" cy="253" r="1.5" />
              <circle cx="210" cy="235" r="2" />
              <circle cx="201" cy="251" r="1.5" />
            </g>
          )}
        </g>
      </g>
    </svg>
  );
}
