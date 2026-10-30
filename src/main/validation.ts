import { z } from 'zod';
import { personalityIds } from '../shared/personalities';
export const characterSchema = z.object({
  name: z.string().trim().min(1).max(30),
  theme: z.enum(['forest', 'robot', 'star']),
  shape: z.enum(['round', 'tall', 'bean']),
  palette: z.enum(['moss', 'ember', 'berry', 'ocean']),
  eyes: z.enum(['curious', 'sleepy', 'bright']),
  accessory: z.enum(['none', 'antenna', 'scarf', 'helmet']),
  personality: z.enum(personalityIds),
  talkativeness: z.number().min(0).max(100),
  backseating: z.number().min(0).max(100),
  noSpoilers: z.boolean(),
});
export const settingsSchema = z.object({
  gameTitle: z.string().max(120),
  obsAddress: z.string().max(200),
  obsSource: z.string().max(200),
  autoObserve: z.boolean(),
  observationInterval: z.number().int().min(10).max(120),
  voiceEnabled: z.boolean(),
  voice: z.enum(['Samantha', 'Daniel', 'Tessa', 'Karen', 'Alex', 'Fred']),
  voiceProvider: z.enum(['live', 'local']),
  liveVoice: z.enum(['marin', 'cedar', 'gleam', 'meridian', 'willow']),
  twitchChannel: z.string().max(40),
  twitchClientId: z
    .string()
    .trim()
    .max(100)
    .regex(/^[A-Za-z0-9]*$/),
  twitchChatReplies: z.boolean(),
  twitchReplyCooldown: z.number().int().min(30).max(300),
  rememberMoments: z.boolean(),
});
const empty = (type: string) => z.object({ type: z.literal(type) });
export const commandSchema = z.union([
  ...[
    'state',
    'check-codex',
    'connect-live',
    'disconnect-live',
    'disconnect-obs',
    'connect-local-obs',
    'install-obs-overlay',
    'refresh-sources',
    'start-session',
    'pause-session',
    'quiet',
    'observe',
    'audition',
    'generate-character',
    'reset-avatar',
    'clear-memories',
    'disconnect-twitch',
    'cancel-twitch-auth',
    'open-overlay',
    'copy-overlay',
  ].map(empty),
  z.object({ type: z.literal('save-character'), character: characterSchema }),
  z.object({ type: z.literal('save-settings'), settings: settingsSchema.partial() }),
  z.object({
    type: z.literal('connect-obs'),
    address: z.string().max(200),
    password: z.string().max(1024),
  }),
  z.object({ type: z.literal('send-message'), text: z.string().trim().min(1).max(2000) }),
  z.object({ type: z.literal('delete-memory'), id: z.string().max(100) }),
  z.object({ type: z.literal('add-memory'), text: z.string().trim().min(1).max(300) }),
  z.object({ type: z.literal('speech-ended'), id: z.string().max(100) }),
  z.object({
    type: z.literal('connect-twitch'),
    channel: z.string().max(40),
    username: z.string().max(40),
    token: z.string().max(512),
  }),
  z.object({ type: z.literal('open-external'), url: z.string().url().max(2048) }),
  z.object({
    type: z.literal('connect-twitch-account'),
    channel: z
      .string()
      .trim()
      .regex(/^#?[A-Za-z0-9_]{1,25}$/),
    clientId: z
      .string()
      .trim()
      .min(10)
      .max(100)
      .regex(/^[A-Za-z0-9]+$/),
  }),
]);
export function safeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}
