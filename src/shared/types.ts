export type Theme = 'forest' | 'robot' | 'star';
export type Expression = 'idle' | 'happy' | 'thinking' | 'surprised' | 'skeptical';
export interface Character {
  name: string;
  theme: Theme;
  shape: 'round' | 'tall' | 'bean';
  palette: 'moss' | 'ember' | 'berry' | 'ocean';
  eyes: 'curious' | 'sleepy' | 'bright';
  accessory: 'none' | 'antenna' | 'scarf' | 'helmet';
  personality: PersonalityId;
  talkativeness: number;
  backseating: number;
  noSpoilers: boolean;
}
export interface Settings {
  gameTitle: string;
  obsAddress: string;
  obsSource: string;
  autoObserve: boolean;
  observationInterval: number;
  voiceEnabled: boolean;
  voice: string;
  voiceProvider: 'live' | 'local';
  liveVoice: string;
  twitchChannel: string;
  twitchClientId: string;
  twitchChatReplies: boolean;
  twitchReplyCooldown: number;
  rememberMoments: boolean;
}
export interface Connection {
  state: 'disconnected' | 'connecting' | 'connected' | 'error';
  message: string;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'companion' | 'chat';
  text: string;
  at: number;
  sources?: { title: string; url: string }[];
}
export interface Moment {
  id: string;
  kind: 'observation' | 'system' | 'memory' | 'research';
  text: string;
  at: number;
}
export interface AppState {
  character: Character;
  settings: Settings;
  codex: Connection;
  obs: Connection;
  twitch: Connection;
  twitchChat: {
    canSend: boolean;
    username: string | null;
    state: 'idle' | 'generating' | 'sent' | 'error';
    message: string;
    lastSentAt: number | null;
  };
  twitchAuth: {
    state: 'idle' | 'pending' | 'error';
    userCode: string;
    verificationUri: string;
    expiresAt: number | null;
    message: string;
  };
  overlay: Connection;
  live: Connection;
  liveUsage: { voiceSeconds: number; backendTokens: number; final: boolean };
  sources: string[];
  session: {
    status: 'idle' | 'live' | 'paused';
    startedAt: number | null;
    thinking: boolean;
    observing: boolean;
  };
  expression: Expression;
  speaking: boolean;
  messages: ChatMessage[];
  moments: Moment[];
  memories: { id: string; text: string }[];
  memoryStatus: {
    state: 'idle' | 'saving' | 'error';
    message: string;
    lastSavedAt: number | null;
  };
  avatarUrl: string | null;
  overlayUrl: string;
  frameUrl: string | null;
  notice: string | null;
  generating: boolean;
  capabilities: {
    desktop: boolean;
    characterGeneration: boolean;
    localSpeech: boolean;
    liveVoice: boolean;
  };
}
export type AppCommand =
  | { type: 'state' }
  | { type: 'check-codex' }
  | { type: 'connect-live' }
  | { type: 'disconnect-live' }
  | { type: 'save-character'; character: Character }
  | { type: 'save-settings'; settings: Partial<Settings> }
  | { type: 'connect-obs'; address: string; password: string }
  | { type: 'disconnect-obs' }
  | { type: 'connect-local-obs' }
  | { type: 'install-obs-overlay' }
  | { type: 'refresh-sources' }
  | { type: 'start-session' }
  | { type: 'pause-session' }
  | { type: 'quiet' }
  | { type: 'send-message'; text: string }
  | { type: 'observe' }
  | { type: 'audition' }
  | { type: 'generate-character' }
  | { type: 'reset-avatar' }
  | { type: 'delete-memory'; id: string }
  | { type: 'add-memory'; text: string }
  | { type: 'clear-memories' }
  | { type: 'connect-twitch'; channel: string; username: string; token: string }
  | { type: 'connect-twitch-account'; channel: string; clientId: string }
  | { type: 'cancel-twitch-auth' }
  | { type: 'disconnect-twitch' }
  | { type: 'open-overlay' }
  | { type: 'copy-overlay' }
  | { type: 'open-external'; url: string }
  | { type: 'speech-ended'; id: string };
export interface CommandResult {
  ok: boolean;
  state: AppState;
  error?: string;
}
export interface CouchkinAPI {
  request(command: AppCommand): Promise<CommandResult>;
  subscribe(callback: (state: AppState) => void): () => void;
  subscribeAudio(callback: (event: AudioEvent) => void): () => void;
  appendLiveAudio(delta: string): void;
  livePlayback(active: boolean): void;
  liveMicrophone(active: boolean): void;
  prepareMicrophone(): Promise<{ allowed: boolean; status: string }>;
}
export type AudioEvent =
  | { type: 'speech'; url: string; id: string }
  | { type: 'quiet'; clearCaption?: boolean }
  | { type: 'pcm'; delta: string; sampleRate: 24000 };
declare global {
  interface Window {
    couchkin?: CouchkinAPI;
  }
}
import type { PersonalityId } from './personalities';
