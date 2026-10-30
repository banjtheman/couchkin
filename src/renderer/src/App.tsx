import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  Armchair,
  Sparkles,
  Play,
  Pause,
  VolumeX,
  Plug,
  BookOpen,
  ChevronRight,
  CircleCheck,
  LoaderCircle,
  ArrowUpRight,
  Copy,
  ExternalLink,
  RefreshCw,
  Eye,
  MessageSquare,
  Send,
  Trash2,
  ArrowRight,
  Bot,
  Leaf,
  Star,
  Radio,
  WandSparkles,
  Check,
  X,
  Monitor,
  AlertCircle,
  Mic,
  MicOff,
  Square,
  ArrowLeft,
} from 'lucide-react';
import type {
  AppCommand,
  AppState,
  Character as CharacterDefinition,
  Connection,
  Theme,
} from '../../shared/types';
import { initialState } from '../../shared/defaults';
import { getPersonalityProfile } from '../../shared/personalities';
import Character, { palettes } from './Character';
import PersonalityPicker from './PersonalityPicker';
import CompanionQuickPicks from './CompanionQuickPicks';
import { useLocalMicrophone } from '../useLocalMicrophone';
import { useLiveMicrophone } from '../useLiveMicrophone';
import { useMicrophoneInputs } from '../useMicrophoneInputs';
import { PcmPlayer } from '../liveAudio';

type Page = 'companion' | 'session' | 'memories' | 'connections';
const themes: { id: Theme; name: string; description: string; icon: typeof Bot }[] = [
  {
    id: 'forest',
    name: 'Forest familiar',
    description: 'A little wild. A lot of heart.',
    icon: Leaf,
  },
  { id: 'robot', name: 'Pocket bot', description: 'Small circuits. Big opinions.', icon: Bot },
  { id: 'star', name: 'Star sprite', description: 'Along for the cosmic chaos.', icon: Star },
];
const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function Label({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="field-label">
      <span>{children}</span>
      {aside}
    </div>
  );
}
function Status({ connection, short = false }: { connection: Connection; short?: boolean }) {
  return (
    <span className={`connection-status ${connection.state}`} title={connection.message}>
      <span className="status-dot" />
      {short ? titleCase(connection.state) : connection.message}
    </span>
  );
}
function Panel({
  title,
  subtitle,
  children,
  className = '',
  action,
  id,
}: {
  title?: ReactNode;
  subtitle?: string;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className={`panel ${className}`}>
      {title && (
        <div className="panel-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

function useCouchkin() {
  const [state, setState] = useState<AppState>(() =>
    structuredClone({
      ...initialState,
      capabilities: { ...initialState.capabilities, desktop: !!window.couchkin },
    }),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState('');
  useEffect(() => {
    const api = window.couchkin;
    if (!api) return;
    let alive = true;
    const unsubscribe = api.subscribe((s) => {
      if (alive) setState(s);
    });
    void api
      .request({ type: 'state' })
      .then((r) => {
        if (alive) setState(r.state);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Could not connect to Couchkin.');
      });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  const request = useCallback(async (command: AppCommand) => {
    setError(null);
    setPending(command.type);
    try {
      if (!window.couchkin) {
        if (command.type === 'save-character')
          setState((s) => ({ ...s, character: command.character }));
        else if (command.type === 'save-settings')
          setState((s) => ({ ...s, settings: { ...s.settings, ...command.settings } }));
        else if (command.type !== 'state')
          throw new Error(
            'Open the Couchkin desktop app to use this connection. This browser is a design preview.',
          );
        return true;
      }
      const result = await window.couchkin.request(command);
      setState(result.state);
      if (!result.ok) {
        setError(result.error || 'That did not work. Please try again.');
        return false;
      }
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      return false;
    } finally {
      setPending('');
    }
  }, []);
  return { state, request, pending, error, setError };
}

export default function App() {
  const overlay = new URLSearchParams(window.location.search).get('overlay') === '1';
  return overlay ? <Overlay /> : <Desktop />;
}

function Desktop() {
  const { state, request, pending, error, setError } = useCouchkin();
  useDesktopAudio(setError);
  const usesLive = state.settings.voiceProvider === 'live';
  const conversationConnection = usesLive ? state.live : state.codex;
  const [page, setPage] = useState<Page>('companion');
  const [customizing, setCustomizing] = useState(false);
  const focusMicrophone = useRef(false);
  useEffect(() => {
    if (page === 'session' && focusMicrophone.current) {
      document.getElementById('live-microphone-settings')?.scrollIntoView({ block: 'center' });
      document.getElementById('live-microphone-input')?.focus({ preventScroll: true });
    } else window.scrollTo({ top: 0 });
    focusMicrophone.current = false;
  }, [page]);
  const [character, setCharacter] = useState(state.character);
  const [previewExpression, setPreviewExpression] = useState<AppState['expression']>('idle');
  const charKey = JSON.stringify(state.character);
  useEffect(() => {
    setCharacter(state.character);
  }, [charKey]);
  const update = (patch: Partial<CharacterDefinition>) => setCharacter((c) => ({ ...c, ...patch }));
  const unsaved = JSON.stringify(character) !== JSON.stringify(state.character);
  const artworkMatches = ['theme', 'shape', 'palette', 'eyes', 'accessory'].every(
    (key) =>
      character[key as keyof CharacterDefinition] ===
      state.character[key as keyof CharacterDefinition],
  );
  const previewAvatar = artworkMatches ? state.avatarUrl : null;
  const navItems: { page: Page; label: string; icon: typeof Armchair }[] = [
    { page: 'companion', label: 'Your companion', icon: Armchair },
    { page: 'session', label: 'On the couch', icon: Radio },
    { page: 'memories', label: 'Shared memories', icon: BookOpen },
    { page: 'connections', label: 'Connections', icon: Plug },
  ];
  const save = () => request({ type: 'save-character', character });
  const generate = async () => {
    if (await save()) await request({ type: 'generate-character' });
  };
  const start = async () => {
    if (unsaved && !(await save())) return;
    if (await request({ type: 'start-session' })) setPage('session');
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage('companion');
          }}
          className="brand"
          aria-label="Couchkin home"
        >
          <span className="brand-mark">
            <Armchair size={25} strokeWidth={1.8} />
          </span>
          <span>
            couchkin<span className="brand-period">.</span>
          </span>
        </a>
        <div className="sidebar-caption">A friend for the run</div>
        <nav aria-label="Main navigation">
          {navItems.map(({ page: p, label, icon: Icon }) => (
            <button
              key={p}
              className={`nav-item ${p === page ? 'active' : ''}`}
              onClick={() => setPage(p)}
              aria-label={label}
              aria-current={p === page ? 'page' : undefined}
            >
              <Icon size={19} />
              <span>{label}</span>
              {p === 'memories' && state.memories.length > 0 && (
                <small>{state.memories.length}</small>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="little-companion">
            <Character character={state.character} small expression={state.expression} />
            <div>
              <strong>{state.character.name || 'Your buddy'}</strong>
              <span>
                {state.session.status === 'live' ? 'Here for the adventure' : 'Saving you a seat'}
              </span>
            </div>
          </div>
          <button className="sidebar-connection" onClick={() => setPage('connections')}>
            <span
              className={`status-dot ${conversationConnection.state === 'connected' ? 'green' : ''}`}
            />
            <span>
              {usesLive
                ? state.live.state === 'connected'
                  ? 'Live voice, connected'
                  : 'Set up live voice'
                : state.codex.state === 'connected'
                  ? 'Your Codex, connected'
                  : 'Connect your Codex'}
            </span>
            <ChevronRight size={14} />
          </button>
          <p className="sidebar-footnote">
            Made for the moments
            <br />
            between the wins.
          </p>
          <span className="version">EARLY BUILD · 0.1</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            Your space <ChevronRight size={13} />
            <strong>{navItems.find((n) => n.page === page)?.label}</strong>
          </div>
          <div className="topbar-actions">
            <span className={`session-indicator ${state.session.status === 'live' ? 'live' : ''}`}>
              <span className="status-dot" />
              {state.session.status === 'live'
                ? 'Companion active'
                : state.session.status === 'paused'
                  ? 'Taking a breather'
                  : 'Ready to hang out'}
            </span>
            {state.session.status === 'live' ? (
              <button
                className="button compact secondary"
                onClick={() => void request({ type: 'pause-session' })}
              >
                <Pause size={15} />
                Pause session
              </button>
            ) : (
              <button
                className="button compact primary"
                disabled={!!pending || state.generating}
                onClick={() => void start()}
              >
                <Play size={15} />
                {state.session.status === 'paused' ? 'Resume session' : 'Start session'}
              </button>
            )}
          </div>
        </header>
        <main className="main-content">
          {!window.couchkin && (
            <div className="preview-banner">
              <Monitor size={15} />
              <strong>Browser preview</strong>
              <span>Appearance controls work here. Live connections run in the desktop app.</span>
            </div>
          )}
          {error && (
            <div className="notice error" role="alert">
              <AlertCircle size={18} />
              <span>{error}</span>
              <button onClick={() => setError(null)} aria-label="Dismiss error">
                <X size={16} />
              </button>
            </div>
          )}
          {state.notice && !error && !(page === 'session' && usesLive) && (
            <div className="notice">
              <Sparkles size={17} />
              <span>{state.notice}</span>
            </div>
          )}
          {page === 'companion' && (
            <>
              <div className="page-heading companion-heading">
                <div>
                  <h1>
                    {customizing ? (
                      <>
                        Your companion, <em>your way.</em>
                      </>
                    ) : (
                      <>
                        Find <em>your kind of company.</em>
                      </>
                    )}
                  </h1>
                  <p>
                    {customizing
                      ? 'Fine-tune their look, banter, and voice.'
                      : 'A friend for the run. A heckler for your questionable decisions.'}
                  </p>
                </div>
                {customizing && (
                  <button className="button secondary" onClick={() => setCustomizing(false)}>
                    <ArrowLeft size={17} /> Quick picks
                  </button>
                )}
              </div>
              {!customizing && (
                <CompanionQuickPicks
                  character={character}
                  avatarUrl={previewAvatar}
                  unsaved={unsaved}
                  busy={!!pending || state.generating}
                  sessionActive={state.session.status === 'live'}
                  onSelect={setCharacter}
                  onCustomize={() => setCustomizing(true)}
                  onRestore={() => setCharacter(state.character)}
                  onUse={async () => {
                    if (unsaved && !(await save())) return;
                    setPage('session');
                  }}
                />
              )}
              {customizing && (
                <div className="creator-layout">
                  <Panel
                    title={<>Choose a world</>}
                    subtitle="Their home, their look, their little details."
                    className="theme-panel"
                  >
                    <div className="theme-list">
                      {themes.map((t) => (
                        <button
                          key={t.id}
                          className={`theme-card ${character.theme === t.id ? 'selected' : ''}`}
                          onClick={() => update({ theme: t.id })}
                          aria-pressed={character.theme === t.id}
                        >
                          <div className="theme-avatar">
                            <Character
                              character={{
                                ...character,
                                theme: t.id,
                                accessory:
                                  t.id === 'forest'
                                    ? 'scarf'
                                    : t.id === 'robot'
                                      ? 'antenna'
                                      : 'none',
                              }}
                              small
                            />
                          </div>
                          <span>
                            <strong>{t.name}</strong>
                            <small>{t.description}</small>
                          </span>
                          <span className="selection-check">
                            {character.theme === t.id && <Check size={12} />}
                          </span>
                        </button>
                      ))}
                    </div>
                    <div className="attribute-section">
                      <Label>Shape</Label>
                      <div className="segmented">
                        {(['round', 'tall', 'bean'] as const).map((v) => (
                          <button
                            key={v}
                            className={character.shape === v ? 'selected' : ''}
                            onClick={() => update({ shape: v })}
                            aria-pressed={character.shape === v}
                          >
                            {titleCase(v)}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="attribute-section">
                      <Label>Palette</Label>
                      <div className="palette-options">
                        {(Object.keys(palettes) as CharacterDefinition['palette'][]).map((v) => (
                          <button
                            key={v}
                            className={`palette-option ${character.palette === v ? 'selected' : ''}`}
                            onClick={() => update({ palette: v })}
                            aria-label={`${v} palette`}
                            aria-pressed={character.palette === v}
                          >
                            <span style={{ background: palettes[v].main }}>
                              <i style={{ background: palettes[v].accent }} />
                              {character.palette === v && <Check size={13} />}
                            </span>
                            <small>{titleCase(v)}</small>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="attribute-section">
                      <Label>Eyes</Label>
                      <div className="segmented">
                        {(['curious', 'sleepy', 'bright'] as const).map((v) => (
                          <button
                            key={v}
                            className={character.eyes === v ? 'selected' : ''}
                            onClick={() => update({ eyes: v })}
                            aria-pressed={character.eyes === v}
                          >
                            {titleCase(v)}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="attribute-section">
                      <Label>A finishing touch</Label>
                      <div className="accessories">
                        {(['none', 'antenna', 'scarf', 'helmet'] as const).map((v) => (
                          <button
                            key={v}
                            className={character.accessory === v ? 'selected' : ''}
                            onClick={() => update({ accessory: v })}
                            aria-pressed={character.accessory === v}
                          >
                            {v === 'helmet' ? 'Tiny helmet' : titleCase(v)}
                          </button>
                        ))}
                      </div>
                    </div>
                  </Panel>
                  <section className="character-stage panel">
                    <div className="stage-header">
                      <span className="eyebrow">MEET YOUR COUCHKIN</span>
                      <span className="tiny-tag">
                        {previewAvatar ? 'Generated artwork' : 'Live preview'}
                      </span>
                    </div>
                    <div className="character-display">
                      <div className="stage-orbit orbit-one" />
                      <div className="stage-orbit orbit-two" />
                      <Sparkles className="stage-spark one" size={24} />
                      <span className="stage-spark two">✳</span>
                      {previewAvatar ? (
                        <img
                          className={`generated-character ${state.speaking ? 'speaking' : ''}`}
                          src={previewAvatar}
                          alt={`Generated artwork of ${state.character.name}`}
                        />
                      ) : (
                        <Character
                          character={character}
                          expression={state.speaking ? state.expression : previewExpression}
                          speaking={state.speaking}
                        />
                      )}
                      <div className="stage-floor" />
                    </div>
                    <div className="stage-introduction">
                      <span className="hello-label">HEY, I'M</span>
                      <h2>
                        {character.name || 'your buddy'}
                        <span>!</span>
                      </h2>
                      <p>{getPersonalityProfile(character.personality).tagline}</p>
                    </div>
                    <div className="expression-picker" aria-label="Preview an expression">
                      {(['idle', 'happy', 'skeptical'] as const).map((v) => (
                        <button
                          key={v}
                          aria-pressed={previewExpression === v}
                          className={previewExpression === v ? 'selected' : ''}
                          onClick={() => setPreviewExpression(v)}
                        >
                          {v === 'idle' ? 'Watching' : v === 'happy' ? 'Hyped' : 'Skeptical'}
                        </button>
                      ))}
                    </div>
                    <div className="stage-actions">
                      <button
                        className="button primary full"
                        onClick={() => void generate()}
                        disabled={
                          state.generating || !!pending || !state.capabilities.characterGeneration
                        }
                      >
                        {state.generating ? (
                          <LoaderCircle size={17} className="spin" />
                        ) : (
                          <WandSparkles size={17} />
                        )}{' '}
                        {state.generating ? 'Making your buddy…' : 'Generate with Codex'}
                      </button>
                      <p className="generation-note">
                        {state.avatarUrl
                          ? 'Your generated character is saved on this Mac.'
                          : state.capabilities.characterGeneration
                            ? 'Turn these choices into original character artwork.'
                            : 'Your live preview is ready to use. Artwork generation is not available in this connection yet.'}
                      </p>
                      {state.avatarUrl && (
                        <button
                          className="text-button"
                          onClick={() => void request({ type: 'reset-avatar' })}
                        >
                          Return to customizable preview
                        </button>
                      )}
                    </div>
                  </section>
                  <Panel
                    title={<>Give them a vibe</>}
                    subtitle="The kind of friend you want beside you."
                    className="personality-panel"
                  >
                    <label className="input-label">
                      Their name
                      <input
                        value={character.name}
                        onChange={(e) => update({ name: e.target.value })}
                        maxLength={32}
                        placeholder="Name your buddy"
                      />
                    </label>
                    <PersonalityPicker
                      value={character.personality}
                      onChange={(value) => update({ personality: value })}
                      saving={pending === 'save-character'}
                    />
                    <RangeControl
                      label="Talkativeness"
                      value={character.talkativeness}
                      onChange={(value) => update({ talkativeness: value })}
                      low="Enjoys the quiet"
                      high="Here to chat"
                    />
                    <RangeControl
                      label="Backseat energy"
                      value={character.backseating}
                      onChange={(value) => update({ backseating: value })}
                      low="Gentle nudge"
                      high="Big opinions"
                    />
                    <label className="switch-row">
                      <span>
                        <strong>Keep the surprises</strong>
                        <small>No story spoilers, please.</small>
                      </span>
                      <input
                        type="checkbox"
                        role="switch"
                        checked={character.noSpoilers}
                        onChange={(e) => update({ noSpoilers: e.target.checked })}
                      />
                    </label>
                    <div className="voice-settings">
                      <Label>
                        Speaking voice{' '}
                        <span className="local-tag">{usesLive ? 'OPENAI' : 'ON YOUR MAC'}</span>
                      </Label>
                      <select
                        aria-label="Voice provider"
                        className="voice-provider-select"
                        value={state.settings.voiceProvider}
                        onChange={(e) =>
                          void request({
                            type: 'save-settings',
                            settings: { voiceProvider: e.target.value as 'live' | 'local' },
                          })
                        }
                      >
                        <option value="live">OpenAI live voice</option>
                        <option value="local">Mac voice + Codex</option>
                      </select>
                      <div className="voice-choice">
                        <select
                          aria-label="Speaking voice"
                          value={usesLive ? state.settings.liveVoice : state.settings.voice}
                          onChange={(e) =>
                            void request({
                              type: 'save-settings',
                              settings: usesLive
                                ? { liveVoice: e.target.value }
                                : { voice: e.target.value },
                            })
                          }
                        >
                          {usesLive ? (
                            ['marin', 'cedar', 'gleam', 'meridian', 'willow'].map((voice) => (
                              <option key={voice} value={voice}>
                                {titleCase(voice)}
                              </option>
                            ))
                          ) : (
                            <>
                              <option value="Samantha">Samantha · warm</option>
                              <option value="Alex">Alex · easygoing</option>
                              <option value="Daniel">Daniel · thoughtful</option>
                            </>
                          )}
                        </select>
                        <button
                          className="icon-button"
                          aria-label="Audition voice"
                          disabled={!!pending}
                          onClick={async () => {
                            if (await save()) await request({ type: 'audition' });
                          }}
                        >
                          <Play size={15} />
                        </button>
                      </div>
                      {usesLive && (
                        <p className="voice-provider-note">
                          Natural voice with GPT-Live. Uses your OpenAI API balance. Changing voices
                          pauses the session; resume to use the new voice.
                        </p>
                      )}
                      <label className="small-toggle">
                        <input
                          type="checkbox"
                          checked={state.settings.voiceEnabled}
                          onChange={(e) =>
                            void request({
                              type: 'save-settings',
                              settings: { voiceEnabled: e.target.checked },
                            })
                          }
                        />
                        Speak replies aloud
                      </label>
                    </div>
                    <button
                      className={`button full ${unsaved ? 'primary' : 'secondary'}`}
                      disabled={!unsaved || !!pending}
                      onClick={() => void save()}
                    >
                      {unsaved ? <Check size={16} /> : <CircleCheck size={16} />}{' '}
                      {unsaved ? 'Save companion' : 'All yours. All saved.'}
                    </button>
                    <p className="small-print">
                      Your companion stays on this Mac.
                      <br />
                      Their personality travels into each session.
                    </p>
                  </Panel>
                </div>
              )}
              <div className="creator-footer">
                <span>
                  <span className="status-dot green" /> Built for hanging out, even with an empty
                  chat.
                </span>
                <button className="text-button" onClick={() => setPage('connections')}>
                  Set up your game <ArrowRight size={15} />
                </button>
              </div>
            </>
          )}
          {page === 'session' && (
            <Session
              state={state}
              request={request}
              pending={pending}
              goConnections={() => setPage('connections')}
            />
          )}
          {page === 'memories' && <Memories state={state} request={request} pending={pending} />}
          {page === 'connections' && (
            <Connections
              state={state}
              request={request}
              pending={pending}
              goMicrophone={() => {
                focusMicrophone.current = true;
                setPage('session');
              }}
            />
          )}
        </main>
      </div>
      {state.speaking && (
        <button className="quiet-fab" onClick={() => void request({ type: 'quiet' })}>
          <VolumeX size={17} />
          Quiet, buddy <kbd>Esc</kbd>
        </button>
      )}
      <EscapeQuiet onQuiet={() => void request({ type: 'quiet' })} />
    </div>
  );
}

type Request = (command: AppCommand) => Promise<boolean>;
function RangeControl({
  label,
  value,
  onChange,
  low,
  high,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  low: string;
  high: string;
}) {
  return (
    <div className="range-control">
      <Label aside={<span className="range-value">{value}%</span>}>{label}</Label>
      <input
        aria-label={label}
        type="range"
        min="0"
        max="100"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ '--range-progress': `${value}%` } as CSSProperties}
      />
      <div className="range-extremes">
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </div>
  );
}
function EscapeQuiet({ onQuiet }: { onQuiet: () => void }) {
  const callback = useRef(onQuiet);
  callback.current = onQuiet;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') callback.current();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  return null;
}

function useDesktopAudio(onError: (message: string) => void) {
  useEffect(() => {
    const api = window.couchkin;
    if (!api) return;
    let audio: HTMLAudioElement | null = null;
    const pcm = new PcmPlayer({
      onActivity: (active) => api.livePlayback(active),
      onError: (message) => {
        onError(message);
        void api.request({ type: 'disconnect-live' }).catch(() => {});
      },
    });
    const stopLegacy = () => {
      if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        audio = null;
      }
    };
    const unsubscribe = api.subscribeAudio((event) => {
      if (event.type === 'quiet') {
        stopLegacy();
        pcm.stop();
        return;
      }
      if (event.type === 'pcm') {
        stopLegacy();
        void pcm.push(event.delta);
        return;
      }
      stopLegacy();
      pcm.stop();
      const next = new Audio(event.url);
      audio = next;
      const finish = () => {
        if (audio !== next) return;
        audio = null;
        void api.request({ type: 'speech-ended', id: event.id });
      };
      next.onended = finish;
      next.onerror = () => {
        onError('Your buddy’s voice could not play. The reply is still in the conversation.');
        finish();
      };
      void next.play().catch(() => {
        if (audio === next) {
          onError('Audio playback was blocked. Try the voice preview, then send another message.');
          finish();
        }
      });
    });
    return () => {
      unsubscribe();
      stopLegacy();
      void pcm.dispose();
    };
  }, [onError]);
}

function LiveMicrophone({ state }: { state: AppState }) {
  const [requested, setRequested] = useState(false);
  const inputs = useMicrophoneInputs();
  const canListen =
    state.capabilities.desktop &&
    state.settings.voiceProvider === 'live' &&
    state.session.status === 'live' &&
    state.live.state === 'connected';
  const mic = useLiveMicrophone({
    enabled: requested && canListen,
    deviceId: inputs.selectedId || undefined,
    onChunk: (chunk) => window.couchkin?.appendLiveAudio(chunk),
  });
  const refreshInputs = inputs.refresh;
  useEffect(() => {
    if (mic.status === 'listening') void refreshInputs();
  }, [mic.status, refreshInputs]);
  useEffect(() => {
    if (!canListen) setRequested(false);
  }, [canListen]);
  useEffect(() => {
    window.couchkin?.liveMicrophone(mic.status === 'listening');
    return () => window.couchkin?.liveMicrophone(false);
  }, [mic.status]);
  const listening = mic.status === 'listening';
  return (
    <div
      id="live-microphone-settings"
      className={`microphone-controls live-microphone ${listening ? 'recording' : ''}`}
    >
      <div className="microphone-input-row">
        <label className="input-label" htmlFor="live-microphone-input">
          Microphone
          <select
            id="live-microphone-input"
            aria-describedby="microphone-input-help"
            value={inputs.selectedId}
            onChange={(event) => inputs.select(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') event.stopPropagation();
            }}
          >
            <option value="">System default</option>
            {inputs.selectedMissing && (
              <option value={inputs.selectedId}>
                {inputs.selectedLabel || 'Saved microphone'} — not listed
              </option>
            )}
            {inputs.inputs.map((input, index) => (
              <option key={input.deviceId} value={input.deviceId}>
                {input.label || `Microphone ${index + 1}`}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button compact secondary"
          disabled={inputs.loading}
          onClick={() => void inputs.refresh()}
        >
          <RefreshCw size={15} className={inputs.loading ? 'spin' : undefined} />
          {inputs.loading ? 'Refreshing…' : 'Refresh inputs'}
        </button>
      </div>
      <p id="microphone-input-help" className="microphone-input-help">
        {inputs.selectedMissing && inputs.enumerated
          ? 'Your saved microphone isn’t listed. Reconnect it or allow microphone access, then refresh. Couchkin will not switch to another input automatically.'
          : inputs.inputs.length === 0 || inputs.inputs.some((input) => !input.label)
            ? 'If inputs are missing or unnamed, allow microphone access in Connections, then refresh. Refreshing does not turn your mic on.'
            : 'Choose the mic Couchkin should hear. This is separate from the microphone selected in OBS.'}{' '}
        {!inputs.savedLocally && 'This choice could not be saved on this Mac.'}
      </p>
      {inputs.error && (
        <p className="microphone-input-error" role="status">
          {inputs.error}
        </p>
      )}
      <div className="microphone-row">
        <button
          className="button compact secondary"
          disabled={!canListen}
          onClick={() => setRequested(mic.status === 'error' ? false : !requested)}
        >
          {mic.status === 'requesting' ? (
            <LoaderCircle size={15} className="spin" />
          ) : listening ? (
            <MicOff size={15} />
          ) : (
            <Mic size={15} />
          )}
          {mic.status === 'requesting'
            ? 'Cancel microphone setup'
            : mic.status === 'error'
              ? 'Reset microphone setup'
              : requested
                ? 'Turn mic off'
                : 'Enable live mic'}
        </button>
        {listening && (
          <span className="recording-label">
            <span className="status-dot" />
            Listening live
          </span>
        )}
      </div>
      {listening && (
        <div className="microphone-active-input">
          <p>
            <strong>Using: {mic.deviceLabel || 'Audio input (name unavailable)'}</strong>
          </p>
          <meter
            className="mic-level"
            min={0}
            max={1}
            value={mic.level}
            aria-label="Microphone level"
          />
          <p>Say a few words and watch the level move to check this input.</p>
        </div>
      )}
      {mic.error ? (
        <div className="microphone-error" role="alert">
          <strong>Microphone unavailable</strong>
          <p>{mic.error}</p>
          {canListen && (
            <p>
              Your live session is still connected. You can keep typing, or reset microphone setup
              and enable it again.
            </p>
          )}
        </div>
      ) : (
        <p aria-live="polite">
          {mic.status === 'requesting'
            ? 'Waiting for microphone access. You can cancel setup at any time.'
            : listening
              ? `Your mic audio goes to OpenAI while this is on. Use headphones so ${state.character.name} does not hear their own voice.`
              : state.session.status !== 'live'
                ? `Start a session, then turn on your mic to talk naturally with ${state.character.name}.`
                : state.live.state !== 'connected'
                  ? 'Connect live voice before enabling the microphone.'
                  : 'Mic is off. Enable it to send live audio to OpenAI. Pause or leave this page to stop listening.'}
        </p>
      )}
    </div>
  );
}

function Microphone({ request, desktop }: { request: Request; desktop: boolean }) {
  const mic = useLocalMicrophone(
    (text) => {
      void request({ type: 'send-message', text });
    },
    () => {
      void request({ type: 'quiet' });
    },
  );
  const busy = mic.status === 'loading' || mic.status === 'transcribing';
  const enabled = mic.status !== 'off' && mic.status !== 'error';
  const label =
    mic.status === 'loading'
      ? 'Preparing local speech…'
      : mic.status === 'transcribing'
        ? 'Turning speech into words…'
        : mic.status === 'recording'
          ? 'Send recording'
          : enabled
            ? 'Start talking'
            : 'Enable local mic';
  return (
    <div className={`microphone-controls ${mic.status === 'recording' ? 'recording' : ''}`}>
      <div className="microphone-row">
        <button
          className="button compact secondary"
          disabled={!desktop || busy}
          onClick={() => {
            if (!enabled) void mic.enable();
            else if (mic.status === 'recording') void mic.stop();
            else void mic.start();
          }}
        >
          {busy ? (
            <LoaderCircle size={14} className="spin" />
          ) : mic.status === 'recording' ? (
            <Square size={13} />
          ) : (
            <Mic size={14} />
          )}{' '}
          {label}
        </button>
        {enabled && !busy && (
          <button
            className="icon-button small"
            onClick={mic.disable}
            aria-label="Disable local microphone"
          >
            <MicOff size={14} />
          </button>
        )}
        {mic.status === 'recording' && (
          <span className="recording-label">
            <span className="status-dot" />
            Listening · up to 30 sec
          </span>
        )}
      </div>
      <p aria-live="polite">
        {mic.error ||
          (!enabled
            ? 'First use downloads a local Whisper model. Audio stays on this Mac; text goes to Codex.'
            : mic.status === 'recording'
              ? 'Click “Send recording” when you finish.'
              : mic.status === 'loading'
                ? 'Downloading the speech model. You can keep typing.'
                : 'Push to talk. Your mic is off between recordings.')}
      </p>
    </div>
  );
}

function Session({
  state,
  request,
  pending,
  goConnections,
}: {
  state: AppState;
  request: Request;
  pending: string;
  goConnections: () => void;
}) {
  const [text, setText] = useState('');
  const [gameTitle, setGameTitle] = useState(state.settings.gameTitle);
  const editingGameTitle = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  const gameReady = state.obs.state === 'connected' && !!state.settings.obsSource;
  const usesLive = state.settings.voiceProvider === 'live';
  const liveActive = state.session.status === 'live' && state.live.state === 'connected';
  const liveConnecting = state.live.state === 'connecting';
  const liveProblem = state.live.state === 'error';
  useEffect(() => {
    if (!editingGameTitle.current) setGameTitle(state.settings.gameTitle);
  }, [state.settings.gameTitle]);
  useEffect(() => {
    end.current?.scrollTo({ top: end.current.scrollHeight, behavior: 'smooth' });
  }, [state.messages.length]);
  const saveGameTitle = () => {
    editingGameTitle.current = false;
    const next = gameTitle.trim();
    setGameTitle(next);
    if (next !== state.settings.gameTitle)
      void request({ type: 'save-settings', settings: { gameTitle: next } });
  };
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const message = text.trim();
    setText('');
    if (!(await request({ type: 'send-message', text: message }))) setText(message);
  };
  return (
    <>
      <div className="page-heading compact-heading">
        <div>
          <h1>
            On the couch <em>with {state.character.name}.</em>
          </h1>
          <p>Same game. Shared moments. One very opinionated friend.</p>
        </div>
        <button className="button secondary" onClick={() => void request({ type: 'quiet' })}>
          <VolumeX size={16} />
          Quiet for a moment
        </button>
      </div>
      {usesLive && (
        <section
          className={`live-session-status ${liveProblem ? 'error' : liveActive ? 'active' : ''}`}
          aria-label="Live session status"
        >
          <div className="live-session-status-copy" role="status" aria-live="polite">
            <strong>
              {liveConnecting ? (
                <LoaderCircle size={17} className="spin" />
              ) : liveProblem ? (
                <AlertCircle size={17} />
              ) : liveActive ? (
                <Radio size={17} />
              ) : (
                <Pause size={17} />
              )}
              {liveConnecting
                ? 'Connecting live voice'
                : liveProblem
                  ? 'Live voice needs attention'
                  : liveActive
                    ? 'Live session is active'
                    : state.session.status === 'paused'
                      ? 'Session paused'
                      : state.session.status === 'live'
                        ? 'Live voice is disconnected'
                        : 'Ready to start a live session'}
            </strong>
            <p>{state.live.message}</p>
            {state.notice && state.notice.trim() !== state.live.message.trim() && (
              <p>{state.notice}</p>
            )}
            {!liveActive && !liveConnecting && (
              <p className="live-session-next-step">
                {state.capabilities.liveVoice
                  ? 'Start or resume when you’re ready. Then enable your mic to talk.'
                  : 'Set up your OpenAI API key in Connections to use live voice.'}
              </p>
            )}
          </div>
          {!liveActive && !liveConnecting && (
            <button
              className="button compact secondary"
              disabled={!!pending}
              onClick={
                state.capabilities.liveVoice
                  ? () => void request({ type: 'start-session' })
                  : goConnections
              }
            >
              {state.capabilities.liveVoice ? <Play size={15} /> : <Plug size={15} />}
              {state.capabilities.liveVoice
                ? state.session.status === 'paused'
                  ? 'Resume session'
                  : liveProblem
                    ? 'Try live voice again'
                    : 'Start session'
                : 'Open Connections'}
            </button>
          )}
        </section>
      )}
      <div className="session-layout">
        <div className="session-main">
          <Panel
            title="Watching with you"
            action={<Status connection={state.obs} short />}
            className="game-panel"
          >
            <div className="game-toolbar">
              <label>
                Playing
                <input
                  aria-label="Current game"
                  aria-describedby="game-title-hint"
                  placeholder="What are we playing?"
                  value={gameTitle}
                  onFocus={() => {
                    editingGameTitle.current = true;
                  }}
                  onChange={(e) => setGameTitle(e.target.value)}
                  onBlur={saveGameTitle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      e.currentTarget.blur();
                    }
                  }}
                />
                <span id="game-title-hint" className="game-title-hint">
                  Enter or leave this field to save.{' '}
                  {usesLive && 'Changing games pauses live voice.'}
                </span>
              </label>
              <button
                className="button compact secondary"
                disabled={!gameReady || state.session.observing || state.session.thinking}
                onClick={() => void request({ type: 'observe' })}
              >
                {state.session.observing ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Eye size={15} />
                )}
                Look at the game
              </button>
            </div>
            <div className={`game-preview ${state.frameUrl ? 'has-frame' : ''}`}>
              {state.frameUrl ? (
                <img src={state.frameUrl} alt="Latest screenshot of the selected OBS game source" />
              ) : (
                <div className="game-placeholder">
                  <Monitor size={34} strokeWidth={1.2} />
                  <h3>{gameReady ? 'Ready for a first look.' : 'A shared view starts here.'}</h3>
                  <p>
                    {gameReady
                      ? `${state.settings.obsSource} is selected. Take a look together when you’re ready.`
                      : state.obs.state === 'connected'
                        ? 'OBS is connected. Choose the game input you want your buddy to see.'
                        : 'Connect an OBS game source so your buddy can follow the action with you.'}
                  </p>
                  <button
                    className="text-button"
                    disabled={gameReady && (state.session.observing || state.session.thinking)}
                    onClick={gameReady ? () => void request({ type: 'observe' }) : goConnections}
                  >
                    {gameReady
                      ? 'Look at the game'
                      : state.obs.state === 'connected'
                        ? 'Choose game source'
                        : 'Connect OBS'}{' '}
                    <ArrowRight size={15} />
                  </button>
                </div>
              )}
              <div className="game-buddy">
                {state.avatarUrl ? (
                  <img src={state.avatarUrl} alt={state.character.name} />
                ) : (
                  <Character
                    character={state.character}
                    expression={state.expression}
                    speaking={state.speaking}
                  />
                )}
              </div>
              {state.frameUrl && (
                <span className="frame-label">LATEST OBS FRAME · {state.settings.obsSource}</span>
              )}
            </div>
            <div className="observation-controls">
              <label className="small-toggle">
                <input
                  type="checkbox"
                  checked={state.settings.autoObserve}
                  onChange={(e) =>
                    void request({
                      type: 'save-settings',
                      settings: { autoObserve: e.target.checked },
                    })
                  }
                />
                Keep an eye on the game
              </label>
              <label className="interval-select">
                Every{' '}
                <select
                  aria-label="Observation interval"
                  value={state.settings.observationInterval}
                  onChange={(e) =>
                    void request({
                      type: 'save-settings',
                      settings: { observationInterval: Number(e.target.value) },
                    })
                  }
                >
                  <option value={10}>10 sec</option>
                  <option value={20}>20 sec</option>
                  <option value={30}>30 sec</option>
                  <option value={60}>60 sec</option>
                </select>
              </label>
            </div>
            <p className="capture-note">
              {usesLive
                ? `${state.character.name} uses selected game frames, chat, and your conversation for context. Frames go to OpenAI; this is not continuous video.`
                : 'Codex checks selected frames, not continuous video. Replies take a moment and observations use your plan’s allowance.'}
            </p>
          </Panel>
          <Panel
            title="The moments so far"
            action={<span className="count-badge">{state.moments.length}</span>}
            className="moments-panel"
          >
            {state.moments.length ? (
              <div className="moment-list">
                {state.moments
                  .slice(-5)
                  .reverse()
                  .map((m) => (
                    <div className="moment-row" key={m.id}>
                      <span className={`moment-icon ${m.kind}`}>
                        {m.kind === 'memory' ? (
                          <BookOpen size={15} />
                        ) : m.kind === 'research' ? (
                          <Sparkles size={15} />
                        ) : (
                          <Eye size={15} />
                        )}
                      </span>
                      <div>
                        <p>{m.text}</p>
                        <span>
                          {time(m.at)} · {titleCase(m.kind)}
                        </span>
                      </div>
                    </div>
                  ))}
              </div>
            ) : (
              <div className="small-empty">
                <Sparkles size={22} />
                <p>
                  Every good run starts with a blank page.
                  <br />
                  Your buddy’s observations will show up here.
                </p>
              </div>
            )}
          </Panel>
        </div>
        <Panel
          title={
            <>
              <MessageSquare size={18} /> Couch conversation
            </>
          }
          action={<span className="local-tag">{usesLive ? 'GPT-LIVE' : 'CODEX'}</span>}
          className="conversation-panel"
        >
          <div className="conversation-scroll" ref={end}>
            {state.messages.length === 0 ? (
              <div className="conversation-welcome">
                <Character character={state.character} small expression="happy" />
                <h3>“So, what’s the plan?”</h3>
                <p>
                  Tell {state.character.name} what you’re playing, ask about a mechanic, or just say
                  hello.
                </p>
                <button
                  className="conversation-suggestion"
                  disabled={!!pending || state.session.thinking}
                  onClick={() =>
                    void request({
                      type: 'send-message',
                      text: 'Hey! Ready to hang out while I play?',
                    })
                  }
                >
                  Hey, ready to hang out? <ArrowUpRight size={14} />
                </button>
              </div>
            ) : (
              state.messages.map((m) => (
                <div key={m.id} className={`message ${m.role}`}>
                  <span className="message-author">
                    {m.role === 'companion'
                      ? state.character.name
                      : m.role === 'chat'
                        ? 'Twitch chat'
                        : 'You'}
                    <time>{time(m.at)}</time>
                  </span>
                  <p>{m.text}</p>
                  {m.sources?.length ? (
                    <div className="message-sources">
                      {m.sources.map((s, i) => (
                        <button
                          key={`${s.url}-${i}`}
                          onClick={() => void request({ type: 'open-external', url: s.url })}
                        >
                          <ExternalLink size={11} />
                          {s.title || 'Source'}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))
            )}
            {state.session.thinking && (
              <div className="thinking">
                <span />
                <span />
                <span />
                {state.character.name} is thinking…
              </div>
            )}
          </div>
          <form className="message-composer" onSubmit={send}>
            <textarea
              aria-label="Message your companion"
              value={text}
              placeholder={`Say something to ${state.character.name}…`}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(e);
                }
              }}
              maxLength={2000}
              rows={2}
            />
            <div>
              <span>Enter to send · Shift + Enter for a new line</span>
              <button
                className="send-button"
                type="submit"
                aria-label="Send message"
                disabled={!text.trim() || state.session.thinking || pending === 'send-message'}
              >
                <Send size={16} />
              </button>
            </div>
          </form>
          {usesLive ? (
            <LiveMicrophone state={state} />
          ) : (
            <Microphone request={request} desktop={state.capabilities.desktop} />
          )}
          <p className="conversation-footer">
            {usesLive
              ? 'OpenAI live voice · API usage billed separately'
              : 'Local speech · Codex conversation'}
          </p>
        </Panel>
      </div>
    </>
  );
}

function Memories({
  state,
  request,
  pending,
}: {
  state: AppState;
  request: Request;
  pending: string;
}) {
  const [confirm, setConfirm] = useState(false);
  const [draft, setDraft] = useState('');
  const [noteSaved, setNoteSaved] = useState(false);
  const remembering = state.settings.rememberMoments;
  const memoryStatus = state.memoryStatus;
  const saveNote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.trim() || pending) return;
    setNoteSaved(false);
    if (await request({ type: 'add-memory', text: draft.trim() })) {
      setDraft('');
      setNoteSaved(true);
    }
  };
  return (
    <>
      <div className="page-heading compact-heading">
        <div>
          <span className="eyebrow">THE LORE YOU MAKE TOGETHER</span>
          <h1>
            A few <em>shared memories.</em>
          </h1>
          <p>The little things that make the next conversation feel familiar.</p>
        </div>
        {state.memories.length > 0 && (
          <button
            className="button secondary danger-text"
            disabled={!!pending}
            onClick={() => setConfirm(true)}
          >
            <Trash2 size={15} />
            Clear memories
          </button>
        )}
      </div>
      <Panel className="memory-controls">
        <div className="memory-preferences">
          <label className="switch-row memory-remember-toggle">
            <span>
              <strong>Remember shared moments</strong>
              <small>Keep a few useful notes from your conversations.</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={remembering}
              disabled={!!pending}
              onChange={(event) =>
                void request({
                  type: 'save-settings',
                  settings: { rememberMoments: event.target.checked },
                })
              }
            />
          </label>
          <p className="memory-explanation">
            {remembering
              ? state.settings.voiceProvider === 'live'
                ? 'Your companion reviews your conversations while you talk and after you pause, keeping game preferences and confirmed inside jokes.'
                : 'Your companion can keep game preferences and confirmed inside jokes from your conversations.'
              : 'Automatic memory is off. Existing notes are still available to your companion. You can add or forget a note below.'}
          </p>
          <p className="memory-explanation">
            Short notes saved on this Mac, not a full transcript.
          </p>
          <div
            className={`memory-save-status ${remembering ? memoryStatus.state : 'idle'}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {remembering && memoryStatus.state === 'saving' ? (
              <LoaderCircle size={18} className="spin" aria-hidden="true" />
            ) : remembering && memoryStatus.state === 'error' ? (
              <AlertCircle size={18} aria-hidden="true" />
            ) : (
              <BookOpen size={18} aria-hidden="true" />
            )}
            <span>
              {!remembering
                ? 'Automatic memory paused.'
                : memoryStatus.message || 'Ready to remember the moments that matter.'}
              {memoryStatus.lastSavedAt && memoryStatus.state === 'idle' && (
                <small>Last saved at {time(memoryStatus.lastSavedAt)}.</small>
              )}
            </span>
          </div>
        </div>
        <form className="memory-add-form" onSubmit={(event) => void saveNote(event)}>
          <label className="input-label" htmlFor="new-memory">
            Add a memory
          </label>
          <p id="new-memory-help">Something you want your companion to know next time.</p>
          <textarea
            id="new-memory"
            aria-describedby="new-memory-help new-memory-count"
            value={draft}
            maxLength={300}
            rows={3}
            placeholder="I like to discover builds myself. Only offer tips when I ask."
            disabled={pending === 'add-memory'}
            onChange={(event) => {
              setDraft(event.target.value);
              setNoteSaved(false);
            }}
          />
          <div className="memory-add-actions">
            <span id="new-memory-count">{draft.length}/300</span>
            <button
              className="button secondary"
              type="submit"
              disabled={!draft.trim() || !!pending}
            >
              {pending === 'add-memory' ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <Check size={17} />
              )}
              {pending === 'add-memory' ? 'Saving…' : 'Save memory'}
            </button>
          </div>
          <p className="memory-add-result" role="status" aria-live="polite">
            {noteSaved ? 'Memory saved. You can find it below.' : 'You choose what stays.'}
          </p>
        </form>
      </Panel>
      {confirm && (
        <div className="notice confirmation" role="alert">
          <span>Forget all shared memories? This cannot be undone.</span>
          <button
            className="button compact secondary"
            disabled={!!pending}
            onClick={() => setConfirm(false)}
          >
            Keep them
          </button>
          <button
            className="button compact danger"
            disabled={!!pending}
            onClick={async () => {
              if (await request({ type: 'clear-memories' })) setConfirm(false);
            }}
          >
            Forget all
          </button>
        </div>
      )}
      {state.memories.length ? (
        <div className="memory-grid">
          {state.memories.map((m, i) => (
            <article className="memory-card" key={m.id}>
              <span className="memory-number">MOMENT {String(i + 1).padStart(2, '0')}</span>
              <BookOpen size={24} strokeWidth={1.4} />
              <p>{m.text}</p>
              <button
                className="text-button danger-text"
                disabled={!!pending}
                onClick={() => void request({ type: 'delete-memory', id: m.id })}
              >
                <Trash2 size={13} />
                Forget this one
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="memory-empty">
          <div className="empty-illustration">
            <Character character={state.character} expression="thinking" />
            <BookOpen size={43} strokeWidth={1.2} />
          </div>
          <h2>{remembering ? 'The inside jokes are still ahead.' : 'A fresh page, for now.'}</h2>
          <p>
            {remembering
              ? 'Useful notes will appear here as you talk.'
              : 'Turn on shared moments, or add your own note above.'}
            <br />
            Review them whenever you like. Forget anything that does not fit.
          </p>
        </div>
      )}
      <div className="memory-note">
        <span className="status-dot green" />
        Your memories stay on this Mac. Relevant moments are shared with{' '}
        {state.settings.voiceProvider === 'live' ? 'OpenAI' : 'Codex'} when you talk.
      </div>
    </>
  );
}

function Connections({
  state,
  request,
  pending,
  goMicrophone,
}: {
  state: AppState;
  request: Request;
  pending: string;
  goMicrophone: () => void;
}) {
  const usesLive = state.settings.voiceProvider === 'live';
  const [address, setAddress] = useState(state.settings.obsAddress);
  const [password, setPassword] = useState('');
  const [channel, setChannel] = useState(state.settings.twitchChannel);
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [twitchClientId, setTwitchClientId] = useState(state.settings.twitchClientId);
  const [showTwitchSetup, setShowTwitchSetup] = useState(!state.settings.twitchClientId);
  const [permissionCheck, setPermissionCheck] = useState({ checking: false, message: '' });
  const permissionAttempt = useRef(0);
  const permissionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      permissionAttempt.current++;
      if (permissionTimer.current) clearTimeout(permissionTimer.current);
    },
    [],
  );
  const checkMicrophonePermission = async () => {
    const api = window.couchkin;
    if (!api || permissionCheck.checking) return;
    const attempt = ++permissionAttempt.current;
    setPermissionCheck({
      checking: true,
      message: 'Respond to the macOS microphone prompt if it appears.',
    });
    const timer = setTimeout(() => {
      if (permissionAttempt.current !== attempt) return;
      permissionAttempt.current++;
      setPermissionCheck({
        checking: false,
        message:
          'Still waiting for macOS. Allow microphone access in the system prompt, then check again. No audio capture has started.',
      });
    }, 20_000);
    permissionTimer.current = timer;
    try {
      const result = await api.prepareMicrophone();
      if (permissionAttempt.current !== attempt) return;
      const message = result.allowed
        ? 'Microphone permission is ready. Audio stays off until you enable the live mic.'
        : result.status === 'denied'
          ? 'macOS blocked microphone access. Enable Couchkin in System Settings → Privacy & Security → Microphone, then check again.'
          : result.status === 'restricted'
            ? 'Microphone access is restricted on this Mac. Check the device restrictions before trying again.'
            : 'Microphone permission is not decided yet. Respond to the macOS prompt, then check again.';
      setPermissionCheck({ checking: false, message });
    } catch {
      if (permissionAttempt.current === attempt)
        setPermissionCheck({
          checking: false,
          message:
            'Could not check microphone permission. Check the macOS privacy settings, then try again.',
        });
    } finally {
      clearTimeout(timer);
      if (permissionTimer.current === timer) permissionTimer.current = null;
    }
  };
  const connectObs = async (e: FormEvent) => {
    e.preventDefault();
    if (await request({ type: 'connect-obs', address, password })) setPassword('');
  };
  const connectTwitch = async (e: FormEvent) => {
    e.preventDefault();
    if (
      await request({
        type: 'connect-twitch',
        channel,
        username,
        token,
      })
    )
      setToken('');
  };
  return (
    <>
      <div className="page-heading compact-heading">
        <div>
          <h1>
            Set up <em>your stream.</em>
          </h1>
          <p>Your companion’s voice, your game, and your chat. Connected from this Mac.</p>
        </div>
      </div>
      <ol className="setup-progress" aria-label="Stream setup">
        {[
          {
            id: usesLive ? 'setup-live' : 'setup-codex',
            label: usesLive ? 'Live voice' : 'Codex',
            detail: usesLive
              ? state.live.state === 'connected'
                ? 'Connected'
                : 'Connect OpenAI'
              : state.codex.state === 'connected'
                ? 'Connected'
                : 'Connect your login',
            complete: (usesLive ? state.live : state.codex).state === 'connected',
          },
          {
            id: 'setup-obs',
            label: 'Game',
            detail:
              state.obs.state === 'connected' && state.settings.obsSource
                ? 'Source selected'
                : 'Choose an OBS input',
            complete: state.obs.state === 'connected' && !!state.settings.obsSource,
          },
          {
            id: 'setup-overlay',
            label: 'Overlay',
            detail: state.overlay.state === 'connected' ? 'Overlay connected' : 'Add to OBS',
            complete: state.overlay.state === 'connected',
          },
          {
            id: 'setup-twitch',
            label: 'Chat',
            detail: state.twitch.state === 'connected' ? 'Listening' : 'Optional',
            complete: state.twitch.state === 'connected',
          },
        ].map((step, index) => (
          <li key={step.id} data-complete={step.complete}>
            <button
              onClick={() =>
                document
                  .getElementById(step.id)
                  ?.scrollIntoView({ block: 'start', behavior: 'auto' })
              }
            >
              <span className="setup-number">
                {step.complete ? <Check size={16} /> : index + 1}
              </span>
              {step.label}
            </button>
            <span className="setup-detail">{step.detail}</span>
          </li>
        ))}
      </ol>
      <div className="connections-grid">
        <Panel
          title={
            <>
              <span className="connection-logo">
                <Mic size={20} />
              </span>
              OpenAI live voice
            </>
          }
          subtitle="A voice that can hang out with you."
          action={<Status connection={state.live} short />}
          id="setup-live"
          className="live-voice-panel"
        >
          <p className="connection-description">
            GPT-Live speaks naturally and uses your game, Twitch chat, and shared memories for
            context. It can check the game and look up current information when needed.
          </p>
          <p className="connection-detail">
            {state.capabilities.liveVoice
              ? 'OpenAI API key is configured on this Mac. The key stays in the desktop app.'
              : 'Add OPENAI_API_KEY to your local .env file, then restart Couchkin. Keep that file out of Git.'}
          </p>
          <label className="input-label">
            Conversation mode
            <select
              aria-label="Conversation mode"
              value={state.settings.voiceProvider}
              onChange={(e) =>
                void request({
                  type: 'save-settings',
                  settings: { voiceProvider: e.target.value as 'live' | 'local' },
                })
              }
            >
              <option value="live">OpenAI live voice</option>
              <option value="local">Mac voice + Codex</option>
            </select>
          </label>
          <div className="button-row">
            <button
              className="button primary"
              disabled={
                !state.capabilities.liveVoice ||
                !usesLive ||
                pending === 'connect-live' ||
                state.live.state === 'connecting'
              }
              onClick={() => void request({ type: 'connect-live' })}
            >
              {state.live.state === 'connecting' ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Plug size={16} />
              )}
              {state.live.state === 'connected' ? 'Reconnect live voice' : 'Connect live voice'}
            </button>
            {state.live.state === 'connected' && (
              <button
                className="button secondary"
                onClick={() => void request({ type: 'disconnect-live' })}
              >
                Disconnect
              </button>
            )}
          </div>
          <button
            className="button secondary"
            disabled={!state.capabilities.desktop || permissionCheck.checking}
            onClick={() => void checkMicrophonePermission()}
          >
            {permissionCheck.checking ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Mic size={16} />
            )}
            {permissionCheck.checking ? 'Waiting for macOS…' : 'Check microphone permission'}
          </button>
          <p className="connection-detail" aria-live="polite">
            {permissionCheck.message ||
              'Check Mac microphone permission before connecting. This does not start audio capture or a paid voice session.'}
          </p>
          {usesLive && (
            <div className="microphone-settings-link">
              <p className="connection-detail">
                Choose Couchkin’s input on On the couch. Selecting a microphone in OBS does not
                change the microphone Couchkin uses. You can choose it before starting a session.
              </p>
              <p className="connection-detail">
                Leaving On the couch turns your live mic off. When you return, use Enable live mic
                to start listening again.
              </p>
              <button className="text-button" onClick={goMicrophone}>
                Choose microphone <ArrowRight size={15} />
              </button>
            </div>
          )}
          <p className="connection-detail live-billing-note">
            Live voice and its reasoning tools use your OpenAI API balance, separately from your
            ChatGPT subscription. Only enable the mic when you are ready; selected game frames and
            chat also go to OpenAI.
          </p>
          {(state.liveUsage.voiceSeconds > 0 || state.liveUsage.backendTokens > 0) && (
            <p className="live-usage">
              Voice usage: {Math.ceil(state.liveUsage.voiceSeconds)} sec · Reasoning:{' '}
              {state.liveUsage.backendTokens.toLocaleString()} tokens
              {state.liveUsage.final ? ' · Finalized' : ' · Updating'}
            </p>
          )}
          {state.overlay.state === 'connected' && (
            <p className="connection-detail">
              Your companion’s voice goes to OBS. Use Monitor and Output on the Couchkin source to
              hear it in headphones.
            </p>
          )}
        </Panel>
        <Panel
          title={
            <>
              <span className="connection-logo codex-logo">⌘</span>Your Codex
            </>
          }
          subtitle={
            usesLive
              ? 'For original artwork and the Mac voice mode.'
              : 'Use the ChatGPT login you already have.'
          }
          action={<Status connection={state.codex} short />}
          className="codex-panel"
          id="setup-codex"
        >
          <p className="connection-description">
            {usesLive
              ? 'Your Codex login powers original character artwork. You can also switch to Mac voice + Codex for the earlier conversation mode.'
              : 'Couchkin uses your local Codex CLI for conversation, screen understanding, and research.'}{' '}
            Your existing plan’s usage limits apply to Codex.
          </p>
          <div className="setup-command">
            <code>codex login</code>
            <span>Run once in Terminal</span>
          </div>
          <p className="connection-detail">
            No API key is required for this connection. Couchkin never copies your login credentials
            into the project.
          </p>
          <button
            className="button primary"
            disabled={pending === 'check-codex'}
            onClick={() => void request({ type: 'check-codex' })}
          >
            {pending === 'check-codex' ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <RefreshCw size={16} />
            )}
            Check connection
          </button>
        </Panel>
        <Panel
          title={
            <>
              <span className="connection-logo obs-logo">
                <Monitor size={20} />
              </span>
              OBS Studio
            </>
          }
          subtitle="Let your buddy see the same game."
          id="setup-obs"
          action={<Status connection={state.obs} short />}
        >
          <p className="connection-description">
            Open OBS and enable its WebSocket server. Couchkin can use the connection settings
            already saved on this Mac.
          </p>
          <div className="button-row">
            <button
              className="button primary"
              disabled={pending === 'connect-local-obs'}
              onClick={() => void request({ type: 'connect-local-obs' })}
            >
              {pending === 'connect-local-obs' ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Plug size={16} />
              )}
              Connect local OBS
            </button>
            {state.obs.state === 'connected' && (
              <button
                className="button secondary"
                onClick={() => void request({ type: 'disconnect-obs' })}
              >
                Disconnect
              </button>
            )}
          </div>
          <details className="advanced-connection">
            <summary>Enter connection details manually</summary>
            <form onSubmit={connectObs}>
              <div className="two-fields">
                <label className="input-label">
                  WebSocket address
                  <input
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="ws://127.0.0.1:4455"
                    spellCheck={false}
                  />
                </label>
                <label className="input-label">
                  Password
                  <input
                    type="password"
                    autoComplete="off"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Your OBS password"
                  />
                </label>
              </div>
              <p className="connection-detail">
                In OBS: Tools → WebSocket Server Settings. Enable the server and enter its
                connection details.
              </p>
              <div className="button-row">
                <button
                  className="button primary"
                  disabled={pending === 'connect-obs'}
                  type="submit"
                >
                  {pending === 'connect-obs' ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <Plug size={16} />
                  )}
                  Connect OBS
                </button>
                {state.obs.state === 'connected' && (
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => void request({ type: 'disconnect-obs' })}
                  >
                    Disconnect
                  </button>
                )}
              </div>
            </form>
          </details>
          {state.obs.state === 'connected' && (
            <div className="connected-source">
              <Label
                aside={
                  <button
                    className="icon-button small"
                    aria-label="Refresh OBS sources"
                    onClick={() => void request({ type: 'refresh-sources' })}
                  >
                    <RefreshCw size={14} />
                  </button>
                }
              >
                Game source
              </Label>
              <select
                aria-label="OBS game source"
                value={state.settings.obsSource}
                onChange={(e) =>
                  void request({ type: 'save-settings', settings: { obsSource: e.target.value } })
                }
              >
                <option value="">Choose the game input…</option>
                {state.sources.map((source) => (
                  <option key={source} value={source}>
                    {source}
                  </option>
                ))}
              </select>
              <p className="connection-detail">
                Choose your game or capture-card input, before your overlay is added.
              </p>
            </div>
          )}
        </Panel>
        <Panel
          title={
            <>
              <span className="connection-logo overlay-logo">
                <Sparkles size={20} />
              </span>
              Your stream overlay
            </>
          }
          subtitle="A small character. A proper place on stream."
          id="setup-overlay"
          action={<Status connection={state.overlay} short />}
        >
          <div className="overlay-miniature">
            <div className="miniature-lines">
              <span />
              <span />
              <span />
            </div>
            <div className="miniature-buddy">
              <Character character={state.character} small expression="happy" />
            </div>
            <div className="miniature-speech">“We can make that. Probably.”</div>
            <span className="miniature-label">TRANSPARENT OVERLAY</span>
          </div>
          <p className="connection-detail">
            Add Couchkin to the current OBS scene as a Browser Source at your canvas size. Keep it
            active across scenes. Preview opens a silent visual check; OBS carries the voice.
          </p>
          <button
            className="button primary overlay-install"
            disabled={state.obs.state !== 'connected' || pending === 'install-obs-overlay'}
            onClick={() => void request({ type: 'install-obs-overlay' })}
          >
            {pending === 'install-obs-overlay' ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Sparkles size={16} />
            )}
            Add to OBS
          </button>
          <p className="connection-detail">
            Or copy the URL below into an OBS Browser Source yourself. For headphones, enable
            “Control audio via OBS” and use Monitor and Output.
          </p>
          <div className="overlay-link">
            <input
              aria-label="OBS overlay URL"
              readOnly
              value={state.overlayUrl}
              placeholder="Available in the desktop app"
            />
            <button
              className="icon-button"
              aria-label="Copy overlay URL"
              disabled={!state.overlayUrl}
              onClick={() => void request({ type: 'copy-overlay' })}
            >
              <Copy size={15} />
            </button>
          </div>
          <button
            className="button secondary"
            disabled={!state.overlayUrl}
            onClick={() => void request({ type: 'open-overlay' })}
          >
            <ExternalLink size={15} />
            Preview overlay
          </button>
        </Panel>
        <Panel
          title={
            <>
              <span className="connection-logo twitch-logo">
                <MessageSquare size={19} />
              </span>
              Twitch chat
            </>
          }
          subtitle="Make room for the rest of the couch."
          id="setup-twitch"
          action={<span className="tiny-tag">OPTIONAL</span>}
        >
          <Status connection={state.twitch} />
          <label className="input-label">
            Channel
            <input
              value={channel}
              disabled={state.twitchAuth.state === 'pending'}
              onChange={(e) => setChannel(e.target.value)}
              placeholder="your_channel"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <p className="connection-detail">
            Viewers can address {state.character.name} or “Couchkin” to join the conversation. Guest
            listening needs only a channel name.
          </p>
          <div className="button-row">
            <button
              type="button"
              className="button secondary"
              disabled={
                !channel.trim() ||
                pending === 'connect-twitch' ||
                state.twitchAuth.state === 'pending'
              }
              onClick={async () => {
                if (await request({ type: 'connect-twitch', channel, username: '', token: '' }))
                  setToken('');
              }}
            >
              {pending === 'connect-twitch' ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Plug size={16} />
              )}
              Listen to chat
            </button>
            {state.twitch.state === 'connected' && (
              <button
                type="button"
                className="text-button"
                onClick={() => void request({ type: 'disconnect-twitch' })}
              >
                Disconnect
              </button>
            )}
          </div>
          <div className="twitch-reply-controls">
            <label className="switch-row twitch-reply-toggle">
              <span>
                <strong>Reply in Twitch chat</strong>
                <small>A little banter, with room for everyone else.</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={state.settings.twitchChatReplies}
                disabled={pending === 'save-settings'}
                onChange={(e) =>
                  void request({
                    type: 'save-settings',
                    settings: { twitchChatReplies: e.target.checked },
                  })
                }
              />
            </label>
            <label className="input-label twitch-cooldown">
              Time between replies
              <select
                value={state.settings.twitchReplyCooldown}
                disabled={pending === 'save-settings'}
                onChange={(e) =>
                  void request({
                    type: 'save-settings',
                    settings: { twitchReplyCooldown: Number(e.target.value) },
                  })
                }
              >
                {[...new Set([30, 45, 60, 90, 120, 300, state.settings.twitchReplyCooldown])]
                  .sort((a, b) => a - b)
                  .map((seconds) => (
                    <option key={seconds} value={seconds}>
                      {seconds < 60
                        ? `${seconds} seconds`
                        : seconds === 60
                          ? '1 minute'
                          : `${seconds / 60} minutes`}
                    </option>
                  ))}
              </select>
            </label>
            <p className="connection-detail">
              At most one reply every {state.settings.twitchReplyCooldown} seconds, only when
              addressed. Replies stop when your Couchkin session is paused.
            </p>
            <p className="connection-detail">
              Text replies use your OpenAI API balance and start with “{state.character.name}:”.
              Choose the Twitch account you want viewers to see.
            </p>
            {state.twitchChat.canSend && state.twitchChat.username ? (
              <p className="twitch-sender">
                <CircleCheck size={16} />
                <span>
                  {state.character.name} replies from <strong>@{state.twitchChat.username}</strong>.
                </span>
              </p>
            ) : (
              <p className="connection-detail twitch-signin-hint">
                Sign in to let {state.character.name} post. Guest chat stays read-only.
              </p>
            )}
            <p
              className={`twitch-reply-status ${state.twitchChat.state}`}
              role="status"
              aria-live="polite"
            >
              {state.twitchChat.state === 'generating' && (
                <LoaderCircle size={16} className="spin" />
              )}
              {state.twitchChat.state === 'sent' && <CircleCheck size={16} />}
              <span>{state.twitchChat.message}</span>
            </p>
          </div>
          <details
            className="advanced-connection twitch-account-setup"
            open={showTwitchSetup}
            onToggle={(event) => setShowTwitchSetup(event.currentTarget.open)}
          >
            <summary>Twitch sign-in setup</summary>
            <p className="connection-detail">
              Couchkin’s public app ID is ready to use. If you run your own build, you can replace
              it with your registered Public app’s Client ID. No client secret is needed.
            </p>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                void request({ type: 'open-external', url: 'https://dev.twitch.tv/console/apps' })
              }
            >
              Twitch developer console <ExternalLink size={14} />
            </button>
            <label className="input-label">
              Twitch Client ID
              <input
                value={twitchClientId}
                onChange={(e) => setTwitchClientId(e.target.value)}
                autoCapitalize="none"
                spellCheck={false}
                placeholder="Your registered app’s public Client ID"
                disabled={state.twitchAuth.state === 'pending'}
              />
            </label>
          </details>
          {state.twitchAuth.state === 'pending' ? (
            <div className="twitch-device-signin" aria-live="polite">
              <p>Finish signing in on Twitch. Enter this code if asked:</p>
              <output aria-label="Twitch sign-in code">{state.twitchAuth.userCode}</output>
              <p className="connection-detail">{state.twitchAuth.message}</p>
              <div className="button-row">
                <button
                  type="button"
                  className="button primary"
                  disabled={!state.twitchAuth.verificationUri}
                  onClick={() =>
                    void request({ type: 'open-external', url: state.twitchAuth.verificationUri })
                  }
                >
                  Open Twitch <ExternalLink size={16} />
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void request({ type: 'cancel-twitch-auth' })}
                >
                  Cancel sign-in
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="button primary twitch-signin-button"
                disabled={
                  !channel.trim() || !twitchClientId.trim() || pending === 'connect-twitch-account'
                }
                onClick={() =>
                  void request({
                    type: 'connect-twitch-account',
                    channel,
                    clientId: twitchClientId.trim(),
                  })
                }
              >
                {pending === 'connect-twitch-account' ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <MessageSquare size={16} />
                )}
                {state.twitchChat.canSend ? 'Switch Twitch account' : 'Sign in to reply'}
              </button>
              {state.twitchAuth.state === 'error' && (
                <p className="twitch-reply-status error" role="alert">
                  {state.twitchAuth.message}
                </p>
              )}
            </>
          )}
          <details className="advanced-connection">
            <summary>Already have a chat token?</summary>
            <p className="connection-detail">
              Use a token with chat:read and user:write:chat access. A chat:read-only token can
              listen. Credentials stay in memory for this connection.
            </p>
            <form onSubmit={connectTwitch}>
              <label className="input-label">
                Twitch username
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="your_username"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>
              <label className="input-label">
                Chat access token
                <input
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Paste a chat token for this session"
                />
              </label>
              <button
                type="submit"
                className="button secondary"
                disabled={
                  !channel.trim() ||
                  !username.trim() ||
                  !token.trim() ||
                  pending === 'connect-twitch' ||
                  state.twitchAuth.state === 'pending'
                }
              >
                {pending === 'connect-twitch' && <LoaderCircle className="spin" size={16} />}
                Connect account
              </button>
            </form>
          </details>
        </Panel>
      </div>
      <div className="connections-note">
        <CircleCheck size={17} />
        <span>
          Your OpenAI key never appears in the app UI. Keep your local .env private; companion
          settings stay on this Mac.
        </span>
      </div>
    </>
  );
}

function Overlay() {
  const [state, setState] = useState<AppState>(structuredClone(initialState));
  const [connected, setConnected] = useState(false);
  const [caption, setCaption] = useState('');
  useEffect(() => {
    document.body.classList.add('overlay-body');
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const preview = params.get('preview') === '1';
    const defaultEvents = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/events`;
    let address: URL;
    try {
      address = new URL(params.get('eventsUrl') || defaultEvents);
    } catch {
      return;
    }
    if (!['ws:', 'wss:'].includes(address.protocol)) return;
    address.searchParams.set('token', token);
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let disposed = false;
    let audio: HTMLAudioElement | null = null;
    let latestCaptionId = '';
    let latestCaptionText = '';
    const pcm = new PcmPlayer({
      onActivity: (active) => {
        if (!preview && !disposed && socket?.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ type: 'pcm-activity', active }));
      },
      onError: () => {
        if (!preview && !disposed && socket?.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ type: 'playback-failed' }));
      },
    });
    const stopLegacy = () => {
      if (audio) {
        audio.pause();
        audio.src = '';
        audio = null;
      }
    };
    const quiet = () => {
      stopLegacy();
      pcm.stop();
    };
    const connect = () => {
      socket = new WebSocket(address);
      socket.onopen = () => {
        setConnected(true);
        if (!preview) {
          socket?.send(JSON.stringify({ type: 'ready' }));
          heartbeat = setInterval(() => {
            if (socket?.readyState === WebSocket.OPEN)
              socket.send(JSON.stringify({ type: 'heartbeat' }));
          }, 5000);
        }
      };
      socket.onmessage = (e) => {
        try {
          const event = JSON.parse(String(e.data));
          if (event.type === 'state' || event.character) {
            const next = event.type === 'state' ? event.state : event;
            setState(next);
            const latest = next.messages
              ?.filter((m: { role: string }) => m.role === 'companion')
              .at(-1);
            if (latest && (latest.id !== latestCaptionId || latest.text !== latestCaptionText)) {
              latestCaptionId = latest.id;
              latestCaptionText = latest.text;
              setCaption(latest.text);
            }
          } else if (event.type === 'pcm' && !preview && typeof event.delta === 'string') {
            stopLegacy();
            void pcm.push(event.delta);
          } else if (event.type === 'speech' && !preview && typeof event.url === 'string') {
            quiet();
            audio = new Audio(event.url);
            const id = event.id;
            audio.onended = () => {
              if (socket?.readyState === WebSocket.OPEN)
                socket.send(JSON.stringify({ type: 'played', id }));
            };
            void audio.play().catch(() => {
              if (socket?.readyState === WebSocket.OPEN)
                socket.send(JSON.stringify({ type: 'playback-failed', id }));
            });
          } else if (event.type === 'quiet') {
            quiet();
            if (event.clearCaption !== false) setCaption('');
          }
        } catch {
          /* Ignore malformed frames; a disconnected overlay must not affect the desktop app. */
        }
      };
      socket.onclose = () => {
        quiet();
        setConnected(false);
        if (heartbeat) clearInterval(heartbeat);
        if (!disposed) retry = setTimeout(connect, 2000);
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      if (heartbeat) clearInterval(heartbeat);
      quiet();
      void pcm.dispose();
      socket?.close();
      document.body.classList.remove('overlay-body');
    };
  }, []);
  useEffect(() => {
    if (!caption) return;
    const timeout = setTimeout(() => setCaption(''), 15000);
    return () => clearTimeout(timeout);
  }, [caption]);
  return (
    <div className={`stream-overlay ${state.speaking ? 'speaking' : ''}`}>
      {caption && (
        <div className="overlay-caption">
          <span>{state.character.name}</span>
          <p>{caption}</p>
        </div>
      )}
      <div className="overlay-character">
        {state.avatarUrl ? (
          <img src={state.avatarUrl} alt={state.character.name} />
        ) : (
          <Character
            character={state.character}
            expression={state.expression}
            speaking={state.speaking}
          />
        )}
      </div>
      {!connected && (
        <span className="overlay-disconnected">Couchkin · waiting for your buddy</span>
      )}
    </div>
  );
}
