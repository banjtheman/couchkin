import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sockets = vi.hoisted(() => ({
  instances: [] as Array<{
    readyState: number;
    answerProbes: boolean;
    sent: string[];
    emit: (event: string, ...args: unknown[]) => void;
    terminate: () => void;
  }>,
}));
vi.mock('ws', () => ({
  default: class {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    answerProbes = true;
    sent: string[] = [];
    handlers = new Map<string, Array<{ callback: (...args: any[]) => void; once: boolean }>>();
    constructor() {
      sockets.instances.push(this);
    }
    on(event: string, callback: (...args: any[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), { callback, once: false }]);
      return this;
    }
    once(event: string, callback: (...args: any[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), { callback, once: true }]);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      const callbacks = [...(this.handlers.get(event) ?? [])];
      this.handlers.set(
        event,
        callbacks.filter((item) => !item.once),
      );
      callbacks.forEach((item) => item.callback(...args));
    }
    send(message: string, callback?: (error?: Error) => void) {
      this.sent.push(message);
      if (this.answerProbes && message.startsWith('PING :couchkin-health-')) {
        const nonce = message.slice('PING :'.length).trim();
        queueMicrotask(() => {
          if (this.readyState === 1)
            this.emit('message', Buffer.from(`:tmi.twitch.tv PONG tmi.twitch.tv :${nonce}\r\n`));
        });
      }
      callback?.();
    }
    close() {
      this.readyState = 3;
      this.emit('close');
    }
    terminate() {
      this.readyState = 3;
      this.emit('close');
    }
  },
}));
import {
  TwitchBridge,
  decodeIrcTag,
  ircChatMessage,
  parseIrcLine,
  validateTwitchCredentials,
} from '../src/main/twitch';

const credentials = {
  channel: '#Couchkin',
  username: 'Streamer',
  token: 'oauth:abcdefghijklmnopqrstuvwxyz1234',
};
const identity = {
  client_id: 'testclient',
  user_id: '123',
  login: 'streamer',
  scopes: ['chat:read'],
  expires_in: 7200,
};
const fetchMock = vi.fn();
beforeEach(() => {
  sockets.instances.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => Response.json(identity));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function nextSocket() {
  await vi.waitFor(() => expect(sockets.instances.length).toBeGreaterThan(0));
  return sockets.instances.at(-1)!;
}

function readerNick(socket: (typeof sockets.instances)[number]) {
  return socket.sent
    .find((line) => line.startsWith('NICK '))!
    .slice(5)
    .trim();
}

function welcome(socket: (typeof sockets.instances)[number], channel = 'couchkin') {
  socket.readyState = 1;
  socket.emit('open');
  const nick = readerNick(socket);
  socket.emit(
    'message',
    Buffer.from(
      `:tmi.twitch.tv 001 ${nick} :Welcome, GLHF!\r\n:${nick}!${nick}@${nick}.tmi.twitch.tv JOIN #${channel}\r\n`,
    ),
  );
  return nick;
}

describe('Twitch IRC parsing and validation', () => {
  it('decodes IRCv3 tags and preserves trailing message text', () => {
    expect(decodeIrcTag('one\\stwo\\:three\\\\four\\r\\n')).toBe('one two;three\\four\r\n');
    expect(decodeIrcTag('name\\\\')).toBe('name\\');
    expect(decodeIrcTag('name\\')).toBe('name');
    expect(decodeIrcTag('name\\x')).toBe('namex');
    const parsed = parseIrcLine(
      '@id=abc;display-name=Cool\\sName :cool_name!cool_name@cool_name.tmi.twitch.tv PRIVMSG #couchkin :a message : with spaces',
    );
    expect(parsed?.tags['display-name']).toBe('Cool Name');
    expect(parsed?.params).toEqual(['#couchkin', 'a message : with spaces']);
    expect(ircChatMessage(parsed!, 'couchkin')).toEqual({
      id: 'abc',
      user: 'Cool Name',
      text: 'a message : with spaces',
    });
    expect(ircChatMessage(parsed!, 'different')).toBeNull();
  });

  it('recognizes PING and rejects malformed line injection', () => {
    expect(parseIrcLine('PING :tmi.twitch.tv')).toEqual({
      tags: {},
      prefix: '',
      command: 'PING',
      params: ['tmi.twitch.tv'],
    });
    for (const line of [
      '',
      '@id=foo',
      ':incomplete',
      'PING :host\r\nJOIN #evil',
      'X'.repeat(70000),
      '!invalid command',
    ])
      expect(parseIrcLine(line)).toBeNull();
    expect(
      parseIrcLine(`CMD ${Array.from({ length: 15 }, () => 'x').join(' ')}`)?.params,
    ).toHaveLength(15);
    expect(parseIrcLine(`CMD ${Array.from({ length: 16 }, () => 'x').join(' ')}`)).toBeNull();
    expect(
      parseIrcLine(`CMD ${Array.from({ length: 15 }, () => 'x').join(' ')} :extra`),
    ).toBeNull();
  });

  it('normalizes login and token without permitting IRC commands in them', () => {
    expect(validateTwitchCredentials(credentials)).toEqual({
      channel: 'couchkin',
      username: 'streamer',
      token: 'abcdefghijklmnopqrstuvwxyz1234',
    });
    expect(() =>
      validateTwitchCredentials({ ...credentials, channel: 'room\r\nJOIN #bad' }),
    ).toThrow();
    expect(() =>
      validateTwitchCredentials({ ...credentials, username: 'https://twitch.tv/person' }),
    ).toThrow();
    expect(() =>
      validateTwitchCredentials({ ...credentials, token: 'oauth:bad\r\nPRIVMSG #bad :hello' }),
    ).toThrow();
  });
});

describe('read-only Twitch connection', () => {
  it('registers the guest reader, handles fragmented input, joins, deduplicates and replies to PING only', async () => {
    const bridge = new TwitchBridge();
    const receive = vi.fn();
    bridge.onMessage(receive);
    const ready = bridge.connect(credentials);
    const socket = await nextSocket();
    socket.readyState = 1;
    socket.emit('open');
    expect(socket.sent[0]).toBe('PASS SCHMOOPIIE\r\n');
    const nick = readerNick(socket);
    expect(nick).toMatch(/^justinfan[0-9]+$/);
    expect(socket.sent.join('')).not.toContain('abcdefghijklmnopqrstuvwxyz1234');
    socket.emit('message', Buffer.from(`:tmi.twitch.tv 001 ${nick} :Welcome, GLHF!\r\nPING :tmi.`));
    socket.emit(
      'message',
      Buffer.from(`twitch.tv\r\n:${nick}!${nick}@${nick}.tmi.twitch.tv JOIN #couchkin\r\n`),
    );
    await ready;
    expect(socket.sent).toContain('JOIN #couchkin\r\n');
    expect(socket.sent).toContain('PONG :tmi.twitch.tv\r\n');
    const chat =
      '@id=hello;display-name=Friend :friend!friend@friend.tmi.twitch.tv PRIVMSG #couchkin :nice jump\r\n';
    socket.emit('message', Buffer.from(chat + chat));
    expect(receive).toHaveBeenCalledTimes(1);
    expect(receive).toHaveBeenCalledWith({ id: 'hello', user: 'Friend', text: 'nice jump' });
    expect(socket.sent.some((text) => text.startsWith('PRIVMSG'))).toBe(false);
    bridge.disconnect();
  });

  it('rejects failed guest registration without leaking server text or the token', async () => {
    const bridge = new TwitchBridge();
    const status = vi.fn();
    bridge.onStatus(status);
    const ready = bridge.connect(credentials);
    const failed = expect(ready).rejects.toThrow('Twitch guest chat listening is unavailable');
    const socket = await nextSocket();
    socket.readyState = 1;
    socket.emit('open');
    socket.emit(
      'message',
      Buffer.from(
        ':tmi.twitch.tv NOTICE * :Login authentication failed abcdefghijklmnopqrstuvwxyz1234\r\n',
      ),
    );
    await failed;
    expect(JSON.stringify(status.mock.calls)).not.toContain('abcdefghijklmnopqrstuvwxyz1234');
    expect(socket.readyState).toBe(3);
  });

  it('cancels pending connects and ignores old socket messages', async () => {
    const bridge = new TwitchBridge();
    const receive = vi.fn();
    bridge.onMessage(receive);
    const ready = bridge.connect(credentials);
    const rejected = expect(ready).rejects.toThrow('cancelled');
    const old = await nextSocket();
    bridge.disconnect();
    await rejected;
    old.emit(
      'message',
      Buffer.from('@id=late :friend!friend@friend.tmi.twitch.tv PRIVMSG #couchkin :late\r\n'),
    );
    expect(receive).not.toHaveBeenCalled();
  });
});

describe('guest Twitch listening and recovery', () => {
  const guest = { channel: 'couchkin', username: '', token: '' };

  it('allows explicit channel-only listening without silently discarding partial credentials', () => {
    expect(validateTwitchCredentials(guest)).toEqual(guest);
    expect(() => validateTwitchCredentials({ ...guest, username: 'streamer' })).toThrow();
    expect(() => validateTwitchCredentials({ ...guest, token: credentials.token })).toThrow();
  });

  it('uses an anonymous identity and receives chat without posting any messages', async () => {
    const bridge = new TwitchBridge();
    const receive = vi.fn(),
      status = vi.fn();
    bridge.onMessage(receive);
    bridge.onStatus(status);
    const ready = bridge.connect(guest);
    const socket = sockets.instances[0]!;
    expect(welcome(socket)).toMatch(/^justinfan[0-9]+$/);
    await ready;
    expect(socket.sent[0]).toBe('PASS SCHMOOPIIE\r\n');
    expect(status).toHaveBeenCalledWith(true, 'Listening to #couchkin as a guest (read-only).');
    socket.emit(
      'message',
      Buffer.from(
        '@id=guest-test;display-name=Viewer :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #couchkin :Pip, hello\r\n',
      ),
    );
    expect(receive).toHaveBeenCalledWith({ id: 'guest-test', user: 'Viewer', text: 'Pip, hello' });
    expect(socket.sent.some((line) => line.startsWith('PRIVMSG'))).toBe(false);
    bridge.disconnect();
  });

  it('rejoins after a server reconnect and deduplicates across that connection', async () => {
    vi.useFakeTimers();
    const bridge = new TwitchBridge();
    const receive = vi.fn();
    bridge.onMessage(receive);
    const ready = bridge.connect(guest),
      first = sockets.instances[0]!;
    welcome(first);
    await ready;
    const line =
      '@id=one;display-name=Viewer :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #couchkin :hello\r\n';
    first.emit('message', Buffer.from(line));
    first.emit('message', Buffer.from(':tmi.twitch.tv RECONNECT\r\n'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets.instances).toHaveLength(2);
    const second = sockets.instances[1]!;
    welcome(second);
    second.emit('message', Buffer.from(line));
    expect(receive).toHaveBeenCalledTimes(1);
    bridge.disconnect();
  });

  it('cancels a scheduled reconnect when the user disconnects', async () => {
    vi.useFakeTimers();
    const bridge = new TwitchBridge();
    const ready = bridge.connect(guest),
      first = sockets.instances[0]!;
    welcome(first);
    await ready;
    first.readyState = 3;
    first.emit('close');
    bridge.disconnect();
    await vi.advanceTimersByTimeAsync(60000);
    expect(sockets.instances).toHaveLength(1);
  });

  it('stops repeated transient reconnect attempts and asks for a manual retry', async () => {
    vi.useFakeTimers();
    const bridge = new TwitchBridge(),
      status = vi.fn();
    bridge.onStatus(status);
    const ready = bridge.connect(guest),
      first = sockets.instances[0]!;
    welcome(first);
    await ready;
    first.readyState = 3;
    first.emit('close');
    for (let attempt = 0; attempt < 5; attempt++) {
      await vi.advanceTimersByTimeAsync(1000 * 2 ** attempt);
      sockets.instances.at(-1)!.emit('error', new Error('untrusted server diagnostic'));
    }
    expect(sockets.instances).toHaveLength(6);
    expect(status).toHaveBeenLastCalledWith(
      false,
      'Twitch chat could not reconnect. Connect chat again when your network is ready.',
    );
    await vi.advanceTimersByTimeAsync(60000);
    expect(sockets.instances).toHaveLength(6);
    expect(JSON.stringify(status.mock.calls)).not.toContain('untrusted server diagnostic');
    bridge.disconnect();
  });
});

describe('authenticated Twitch replies', () => {
  function mockAccount(scopes = ['chat:read', 'user:write:chat']) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/validate')) return Response.json({ ...identity, scopes });
      if (url.includes('/users?'))
        return Response.json({ data: [{ id: '456', login: 'couchkin' }] });
      return Response.json({ data: [{ is_sent: true, message_id: 'sent-1' }] });
    });
  }
  async function connected(bridge: TwitchBridge) {
    const previousSockets = sockets.instances.length;
    const ready = bridge.connect(credentials);
    await vi.waitFor(() => expect(sockets.instances.length).toBeGreaterThan(previousSockets));
    const socket = sockets.instances.at(-1)!;
    welcome(socket);
    await ready;
    return socket;
  }

  it('keeps validated credentials out of the guest reader and uses them for one threaded API reply', async () => {
    mockAccount();
    const bridge = new TwitchBridge();
    const status = vi.fn();
    bridge.onStatus(status);
    expect(bridge.chatAccess).toEqual({ canSend: false, username: null });
    const socket = await connected(bridge);
    expect(bridge.chatAccess).toEqual({ canSend: true, username: 'streamer' });
    expect(socket.sent[0]).toBe('PASS SCHMOOPIIE\r\n');
    expect(readerNick(socket)).toMatch(/^justinfan[0-9]+$/);
    expect(socket.sent.join('')).not.toContain('abcdefghijklmnopqrstuvwxyz1234');
    expect(socket.sent).not.toContain('NICK streamer\r\n');
    expect(status).toHaveBeenLastCalledWith(
      true,
      'Listening to #couchkin as a guest; replies as streamer.',
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://id.twitch.tv/oauth2/validate');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://api.twitch.tv/helix/users?login=couchkin');
    await expect(
      bridge.sendReply({ text: 'Riff: That play was ambitious.', replyToId: 'viewer-1' }),
    ).resolves.toEqual({ messageId: 'sent-1' });
    const [url, options] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe('https://api.twitch.tv/helix/chat/messages');
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer abcdefghijklmnopqrstuvwxyz1234');
    expect(options.headers['Client-Id']).toBe('testclient');
    expect(JSON.parse(options.body)).toEqual({
      broadcaster_id: '456',
      sender_id: '123',
      message: 'Riff: That play was ambitious.',
      reply_parent_message_id: 'viewer-1',
    });
    expect(socket.sent.some((text) => text.startsWith('PRIVMSG'))).toBe(false);
    bridge.disconnect();
  });

  it('keeps guest and chat:read-only accounts unable to post', async () => {
    const bridge = new TwitchBridge();
    await expect(bridge.sendReply({ text: 'hello', replyToId: 'one' })).rejects.toThrow(
      'user:write:chat',
    );
    mockAccount(['chat:read']);
    await connected(bridge);
    expect(bridge.chatAccess).toEqual({ canSend: false, username: 'streamer' });
    await expect(bridge.sendReply({ text: 'hello', replyToId: 'one' })).rejects.toThrow(
      'user:write:chat',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    bridge.disconnect();
  });

  it.each([
    { ...identity, login: 'anotheruser' },
    { ...identity, user_id: null },
    { ...identity, client_id: '' },
    { ...identity, scopes: ['user:write:chat'] },
    { ...identity, expires_in: 0 },
  ])('rejects wrong identity, non-user tokens, missing read scope, and expiry', async (invalid) => {
    fetchMock.mockResolvedValue(Response.json(invalid));
    const bridge = new TwitchBridge();
    await expect(bridge.connect(credentials)).rejects.toThrow();
    expect(sockets.instances).toHaveLength(0);
    expect(bridge.chatAccess.canSend).toBe(false);
  });

  function incoming(
    socket: Awaited<ReturnType<typeof connected>>,
    id: string,
    user: string,
    text: string,
  ) {
    socket.emit(
      'message',
      Buffer.from(
        `@id=${id};display-name=${user} :${user}!${user}@host PRIVMSG #couchkin :${text}\r\n`,
      ),
    );
  }

  it('receives real broadcaster chat from the account also used for automated replies', async () => {
    mockAccount();
    const bridge = new TwitchBridge();
    const receive = vi.fn();
    bridge.onMessage(receive);
    const socket = await connected(bridge);
    incoming(socket, 'real-own', 'streamer', 'Riff, hello');
    incoming(socket, 'real-viewer', 'viewer', 'Riff, hello');
    expect(receive.mock.calls.map(([message]) => message.id)).toEqual(['real-own', 'real-viewer']);
    bridge.disconnect();
  });

  it('reconnects the guest reader while retaining the validated API writer', async () => {
    vi.useFakeTimers();
    mockAccount();
    const bridge = new TwitchBridge();
    const receive = vi.fn();
    bridge.onMessage(receive);
    const first = await connected(bridge);
    first.emit('message', Buffer.from(':tmi.twitch.tv RECONNECT\r\n'));
    expect(bridge.chatAccess).toEqual({ canSend: false, username: 'streamer' });
    await vi.advanceTimersByTimeAsync(1000);
    const second = sockets.instances.at(-1)!;
    expect(second).not.toBe(first);
    expect(bridge.chatAccess.canSend).toBe(false);
    expect(welcome(second)).toMatch(/^justinfan[0-9]+$/);
    expect(second.sent[0]).toBe('PASS SCHMOOPIIE\r\n');
    expect(second.sent.join('')).not.toContain('abcdefghijklmnopqrstuvwxyz1234');
    expect(bridge.chatAccess).toEqual({ canSend: true, username: 'streamer' });
    incoming(second, 'human-after-reconnect', 'streamer', 'Riff, still here?');
    expect(receive).toHaveBeenCalledWith({
      id: 'human-after-reconnect',
      user: 'streamer',
      text: 'Riff, still here?',
    });
    await bridge.sendReply({ text: 'Riff: Still here.', replyToId: 'human-after-reconnect' });
    expect(fetchMock.mock.calls.at(-1)?.[1].headers.Authorization).toBe(
      'Bearer abcdefghijklmnopqrstuvwxyz1234',
    );
    bridge.disconnect();
  });

  it('suppresses only the actual reply echo before its send response arrives', async () => {
    vi.useFakeTimers();
    mockAccount();
    const bridge = new TwitchBridge();
    const receive = vi.fn();
    const diagnostics = vi.fn();
    bridge.onMessage(receive);
    bridge.onDiagnostic(diagnostics);
    const socket = await connected(bridge);
    let finish!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const sending = bridge.sendReply({
      text: 'Riff: That play was ambitious.',
      replyToId: 'viewer-1',
    });
    incoming(socket, 'human-own', 'streamer', 'Riff, what is chat saying?');
    incoming(socket, 'other-same-text', 'viewer', 'Riff: That play was ambitious.');
    incoming(socket, 'echo', 'streamer', 'Riff: That play was ambitious.');
    incoming(socket, 'echo', 'streamer', 'Riff: That play was ambitious.');
    // Once the one matching echo is consumed, different message IDs remain real chat.
    incoming(socket, 'human-repeat', 'streamer', 'Riff: That play was ambitious.');
    finish(Response.json({ data: [{ is_sent: true, message_id: 'echo' }] }));
    await sending;
    expect(receive.mock.calls.map(([message]) => message.id)).toEqual([
      'human-own',
      'other-same-text',
      'human-repeat',
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(diagnostics.mock.calls.at(-1)?.[0]).toMatchObject({
      event: 'probe_ack',
      parsedMessages: 5,
      acceptedMessages: 3,
      duplicateMessages: 1,
      echoMessages: 1,
    });
    const serialized = JSON.stringify(diagnostics.mock.calls);
    for (const privateValue of [
      'abcdefghijklmnopqrstuvwxyz1234',
      'couchkin-health-',
      'human-own',
      'streamer',
      'couchkin',
      'Riff:',
    ])
      expect(serialized).not.toContain(privateValue);
    bridge.disconnect();
  });

  it('uses confirmed reply IDs without hiding later broadcaster text matches', async () => {
    mockAccount();
    const bridge = new TwitchBridge();
    const receive = vi.fn();
    bridge.onMessage(receive);
    const socket = await connected(bridge);
    await bridge.sendReply({ text: 'Riff: Hello.', replyToId: 'viewer-1' });
    incoming(socket, 'sent-1', 'streamer', 'Riff: Hello.');
    incoming(socket, 'human-repeat', 'streamer', 'Riff: Hello.');
    expect(receive.mock.calls.map(([message]) => message.id)).toEqual(['human-repeat']);
    bridge.disconnect();
  });

  it('bounds the time an uncertain send can suppress its own delayed echo', async () => {
    vi.useFakeTimers();
    mockAccount();
    const bridge = new TwitchBridge();
    const receive = vi.fn();
    bridge.onMessage(receive);
    const socket = await connected(bridge);
    fetchMock.mockRejectedValueOnce(new Error('network failure'));
    await expect(
      bridge.sendReply({ text: 'Riff: Uncertain delivery.', replyToId: 'viewer-1' }),
    ).rejects.toThrow('did not confirm');
    incoming(socket, 'late-echo', 'streamer', 'Riff: Uncertain delivery.');
    expect(receive).not.toHaveBeenCalled();
    fetchMock.mockRejectedValueOnce(new Error('network failure'));
    await expect(
      bridge.sendReply({ text: 'Riff: Another uncertain delivery.', replyToId: 'viewer-1' }),
    ).rejects.toThrow();
    vi.setSystemTime(Date.now() + 60_001);
    incoming(socket, 'human-later', 'streamer', 'Riff: Another uncertain delivery.');
    expect(receive.mock.calls.map(([message]) => message.id)).toEqual(['human-later']);
    bridge.disconnect();
  });

  it('does not retain text suppression for a reply Twitch explicitly rejected', async () => {
    mockAccount();
    const bridge = new TwitchBridge();
    const receive = vi.fn();
    bridge.onMessage(receive);
    const socket = await connected(bridge);
    fetchMock.mockResolvedValueOnce(Response.json({ data: [{ is_sent: false, message_id: '' }] }));
    await expect(
      bridge.sendReply({ text: 'Riff: Rejected.', replyToId: 'viewer-1' }),
    ).rejects.toThrow();
    incoming(socket, 'human-after-rejection', 'streamer', 'Riff: Rejected.');
    expect(receive.mock.calls.map(([message]) => message.id)).toEqual(['human-after-rejection']);
    bridge.disconnect();
  });

  it('clears uncertain echo suppression when explicitly reconnecting an account', async () => {
    mockAccount();
    const bridge = new TwitchBridge();
    const receive = vi.fn();
    bridge.onMessage(receive);
    await connected(bridge);
    fetchMock.mockRejectedValueOnce(new Error('network failure'));
    await expect(
      bridge.sendReply({ text: 'Riff: Earlier session.', replyToId: 'viewer-1' }),
    ).rejects.toThrow();
    bridge.disconnect();
    const socket = await connected(bridge);
    incoming(socket, 'new-session-human', 'streamer', 'Riff: Earlier session.');
    expect(receive.mock.calls.map(([message]) => message.id)).toEqual(['new-session-human']);
    bridge.disconnect();
  });

  it('caps uncertain reply matching instead of retaining unbounded prior text', async () => {
    mockAccount();
    const bridge = new TwitchBridge();
    const receive = vi.fn();
    bridge.onMessage(receive);
    const socket = await connected(bridge);
    for (let i = 0; i < 33; i++) {
      fetchMock.mockRejectedValueOnce(new Error('network failure'));
      await expect(
        bridge.sendReply({ text: `Riff: Reply ${i}.`, replyToId: 'viewer-1' }),
      ).rejects.toThrow();
    }
    incoming(socket, 'old-human', 'streamer', 'Riff: Reply 0.');
    incoming(socket, 'recent-echo', 'streamer', 'Riff: Reply 32.');
    expect(receive.mock.calls.map(([message]) => message.id)).toEqual(['old-human']);
    bridge.disconnect();
  });

  it.each(['hi\nthere', 'hi\rthere', 'hi\u0000there', 'x'.repeat(451), ''])(
    'rejects invalid outbound text before sending',
    async (text) => {
      mockAccount();
      const bridge = new TwitchBridge();
      await connected(bridge);
      await expect(bridge.sendReply({ text, replyToId: 'one' })).rejects.toThrow('one line');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      bridge.disconnect();
    },
  );

  it('reports a dropped message without claiming delivery or exposing server text', async () => {
    mockAccount();
    const bridge = new TwitchBridge();
    await connected(bridge);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        data: [{ is_sent: false, message_id: '', drop_reason: { message: credentials.token } }],
      }),
    );
    await expect(bridge.sendReply({ text: 'hello', replyToId: 'one' })).rejects.toThrow(
      'did not send',
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    bridge.disconnect();
  });

  it.each([403, 429, 500])(
    'never retries HTTP %s failures or exposes server text',
    async (status) => {
      mockAccount();
      const bridge = new TwitchBridge();
      await connected(bridge);
      fetchMock.mockResolvedValueOnce(Response.json({ message: credentials.token }, { status }));
      let message = '';
      await bridge.sendReply({ text: 'hello', replyToId: 'one' }).catch((error: Error) => {
        message = error.message;
      });
      expect(message).not.toContain(credentials.token);
      expect(message).toBeTruthy();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      bridge.disconnect();
    },
  );

  it('disconnects a revoked account on a 401 send response', async () => {
    mockAccount();
    const bridge = new TwitchBridge();
    const socket = await connected(bridge);
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 401 }));
    await expect(bridge.sendReply({ text: 'hello', replyToId: 'one' })).rejects.toThrow('revoked');
    expect(bridge.chatAccess).toEqual({ canSend: false, username: null });
    expect(socket.readyState).toBe(3);
  });

  it('aborts stale validation when disconnecting, without opening a late socket', async () => {
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const bridge = new TwitchBridge();
    const ready = bridge.connect(credentials);
    const rejected = expect(ready).rejects.toThrow('cancelled');
    bridge.disconnect();
    expect(fetchMock.mock.calls[0]?.[1].signal.aborted).toBe(true);
    resolve(Response.json(identity));
    await rejected;
    expect(sockets.instances).toHaveLength(0);
  });

  it('aborts pending sends and cannot report a late success after disconnect', async () => {
    mockAccount();
    const bridge = new TwitchBridge();
    await connected(bridge);
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const sending = bridge.sendReply({ text: 'hello', replyToId: 'one' });
    const rejected = expect(sending).rejects.toThrow('cancelled');
    await expect(bridge.sendReply({ text: 'again', replyToId: 'two' })).rejects.toThrow('already');
    bridge.disconnect();
    expect(fetchMock.mock.calls.at(-1)?.[1].signal.aborted).toBe(true);
    resolve(Response.json({ data: [{ is_sent: true, message_id: 'late' }] }));
    await rejected;
  });

  it('cancels sends through the caller signal', async () => {
    mockAccount();
    const bridge = new TwitchBridge();
    await connected(bridge);
    const controller = new AbortController();
    controller.abort();
    await expect(
      bridge.sendReply({ text: 'hello', replyToId: 'one', signal: controller.signal }),
    ).rejects.toThrow('cancelled');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    bridge.disconnect();
  });

  it('revalidates hourly and signs out if Twitch revokes the token', async () => {
    vi.useFakeTimers();
    mockAccount();
    const bridge = new TwitchBridge();
    const socket = await connected(bridge);
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 401 }));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(bridge.chatAccess).toEqual({ canSend: false, username: null });
    expect(socket.readyState).toBe(3);
  });
});

describe('Twitch reply connection lifecycle', () => {
  it('uses the validated broadcaster identity without looking up the same account', async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ ...identity, scopes: ['chat:read', 'user:write:chat'] }),
    );
    const bridge = new TwitchBridge();
    const ready = bridge.connect({ ...credentials, channel: 'streamer' });
    const socket = await nextSocket();
    expect(bridge.chatAccess.canSend).toBe(false);
    welcome(socket, 'streamer');
    await ready;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bridge.chatAccess.canSend).toBe(true);
    fetchMock.mockResolvedValueOnce(
      Response.json({ data: [{ is_sent: true, message_id: 'sent' }] }),
    );
    await bridge.sendReply({ text: 'hello', replyToId: 'viewer' });
    expect(JSON.parse(fetchMock.mock.calls.at(-1)?.[1].body)).toMatchObject({
      sender_id: '123',
      broadcaster_id: '123',
    });
    bridge.disconnect();
  });

  it('cancels an in-flight send when the receiving connection is lost', async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ ...identity, scopes: ['chat:read', 'user:write:chat'] }),
    );
    const bridge = new TwitchBridge();
    const ready = bridge.connect({ ...credentials, channel: 'streamer' });
    const socket = await nextSocket();
    welcome(socket, 'streamer');
    await ready;
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const sending = bridge.sendReply({ text: 'hello', replyToId: 'viewer' });
    const rejected = expect(sending).rejects.toThrow('cancelled');
    socket.readyState = 3;
    socket.emit('close');
    expect(bridge.chatAccess.canSend).toBe(false);
    expect(fetchMock.mock.calls.at(-1)?.[1].signal.aborted).toBe(true);
    resolve(Response.json({ data: [{ is_sent: true, message_id: 'late' }] }));
    await rejected;
    bridge.disconnect();
  });
});

describe('Twitch reader heartbeat', () => {
  const guest = { channel: 'couchkin', username: '', token: '' };

  beforeEach(() => vi.useFakeTimers());

  it('bounds busy-chat diagnostics while preserving immediate first receipt and full probe counts', async () => {
    const bridge = new TwitchBridge();
    const diagnostics = vi.fn();
    const receive = vi.fn();
    bridge.onDiagnostic(diagnostics);
    bridge.onMessage(receive);
    const ready = bridge.connect(guest);
    const socket = sockets.instances[0]!;
    welcome(socket);
    await ready;
    const sendBurst = (offset: number, size: number) => {
      for (let index = offset; index < offset + size; index++) {
        const line = `@id=message-${index} :viewer!viewer@host PRIVMSG #couchkin :hello\r\n`;
        socket.emit('message', Buffer.from(line + line));
      }
    };
    const events = (event: string) =>
      diagnostics.mock.calls.filter(([diagnostic]) => diagnostic.event === event);
    sendBurst(0, 1000);
    expect(receive).toHaveBeenCalledTimes(1000);
    expect(events('message_received')).toHaveLength(1);
    expect(events('message_received')[0]?.[0].acceptedMessages).toBe(1);
    expect(events('message_filtered')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_999);
    sendBurst(1000, 100);
    expect(events('message_received')).toHaveLength(1);
    expect(events('message_filtered')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    sendBurst(1100, 100);
    expect(events('message_received')).toHaveLength(2);
    expect(events('message_filtered')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(diagnostics.mock.calls.at(-1)?.[0]).toMatchObject({
      event: 'probe_ack',
      parsedMessages: 2400,
      acceptedMessages: 1200,
      duplicateMessages: 1200,
      echoMessages: 0,
    });
    bridge.disconnect();
  });

  it('keeps a silent channel healthy for more than six minutes through exact probe acknowledgments', async () => {
    const bridge = new TwitchBridge();
    const diagnostics = vi.fn();
    const receive = vi.fn();
    bridge.onDiagnostic(diagnostics);
    bridge.onMessage(receive);
    const ready = bridge.connect(guest);
    const socket = sockets.instances[0]!;
    welcome(socket);
    await ready;
    await vi.advanceTimersByTimeAsync(6 * 60_000 + 1000);
    expect(sockets.instances).toHaveLength(1);
    expect(socket.readyState).toBe(1);
    const probes = socket.sent.filter((line) => line.startsWith('PING :couchkin-health-'));
    expect(probes.length).toBeGreaterThanOrEqual(13);
    expect(new Set(probes).size).toBe(probes.length);
    expect(diagnostics.mock.calls.filter(([event]) => event.event === 'probe_ack')).toHaveLength(
      probes.length,
    );
    expect(diagnostics.mock.calls.at(-1)?.[0]).toMatchObject({
      event: 'probe_ack',
      parsedMessages: 0,
      acceptedMessages: 0,
      lastMessageAt: null,
      lastProbeAckAt: expect.any(Number),
    });
    expect(receive).not.toHaveBeenCalled();
    expect(socket.sent.some((line) => line.startsWith('PRIVMSG'))).toBe(false);
    bridge.disconnect();
  });

  it('does not mistake unrelated traffic or a wrong pong for acknowledgment, then reconnects', async () => {
    const bridge = new TwitchBridge();
    const diagnostics = vi.fn();
    bridge.onDiagnostic(diagnostics);
    const ready = bridge.connect(guest);
    const first = sockets.instances[0]!;
    first.answerProbes = false;
    welcome(first);
    await ready;
    first.emit('message', Buffer.from(':tmi.twitch.tv PONG tmi.twitch.tv :wrong-nonce\r\n'));
    first.emit('message', Buffer.from('PING :tmi.twitch.tv\r\n'));
    first.emit('pong', Buffer.from('unrelated-websocket-pong'));
    expect(first.sent).toContain('PONG :tmi.twitch.tv\r\n');
    await vi.advanceTimersByTimeAsync(14_999);
    expect(first.readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.readyState).toBe(3);
    expect(diagnostics.mock.calls.at(-1)?.[0]).toMatchObject({
      event: 'probe_timeout',
      lastProbeAckAt: null,
      acceptedMessages: 0,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets.instances).toHaveLength(2);
    const second = sockets.instances[1]!;
    welcome(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnostics.mock.calls.at(-1)?.[0].event).toBe('probe_ack');
    bridge.disconnect();
  });

  it('ignores late acknowledgments and closes from a replaced socket', async () => {
    const bridge = new TwitchBridge();
    const diagnostics = vi.fn();
    bridge.onDiagnostic(diagnostics);
    const firstReady = bridge.connect(guest);
    const first = sockets.instances[0]!;
    first.answerProbes = false;
    welcome(first);
    await firstReady;
    const oldNonce = first.sent
      .find((line) => line.startsWith('PING :'))!
      .slice(6)
      .trim();
    const secondReady = bridge.connect(guest);
    const second = sockets.instances[1]!;
    second.answerProbes = false;
    welcome(second);
    await secondReady;
    const beforeStaleEvents = diagnostics.mock.calls.length;
    first.emit('message', Buffer.from(`:tmi.twitch.tv PONG tmi.twitch.tv :${oldNonce}\r\n`));
    first.emit('error', new Error('late error from replaced reader'));
    first.emit('close');
    expect(diagnostics).toHaveBeenCalledTimes(beforeStaleEvents);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(second.readyState).toBe(3);
    expect(diagnostics.mock.calls.at(-1)?.[0].event).toBe('probe_timeout');
    bridge.disconnect();
  });

  it.each([false, true])(
    'clears pending heartbeat timers on disconnect (acknowledged=%s)',
    async (answerProbes) => {
      const bridge = new TwitchBridge();
      const ready = bridge.connect(guest);
      const socket = sockets.instances[0]!;
      socket.answerProbes = answerProbes;
      welcome(socket);
      await ready;
      await vi.advanceTimersByTimeAsync(0);
      bridge.disconnect();
      const sentCount = socket.sent.length;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(socket.sent).toHaveLength(sentCount);
      expect(sockets.instances).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('bounds retries when each new reader joins but never answers a probe', async () => {
    const bridge = new TwitchBridge();
    const status = vi.fn();
    bridge.onStatus(status);
    const ready = bridge.connect(guest);
    const first = sockets.instances[0]!;
    first.answerProbes = false;
    welcome(first);
    await ready;
    for (let attempt = 0; attempt < 5; attempt++) {
      await vi.advanceTimersByTimeAsync(15_000 + 1000 * 2 ** attempt);
      expect(sockets.instances).toHaveLength(attempt + 2);
      const retry = sockets.instances.at(-1)!;
      retry.answerProbes = false;
      welcome(retry);
    }
    await vi.advanceTimersByTimeAsync(15_000);
    expect(status).toHaveBeenLastCalledWith(
      false,
      'Twitch chat could not reconnect. Connect chat again when your network is ready.',
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets.instances).toHaveLength(6);
    bridge.disconnect();
  });

  it('keeps listener failures from breaking the chat transport and supports removing diagnostics', async () => {
    const bridge = new TwitchBridge();
    const diagnostics = vi.fn();
    const remove = bridge.onDiagnostic(diagnostics);
    bridge.onDiagnostic(() => {
      throw new Error('observer failure');
    });
    const ready = bridge.connect(guest);
    const socket = sockets.instances[0]!;
    welcome(socket);
    await ready;
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnostics.mock.calls.at(-1)?.[0].event).toBe('probe_ack');
    remove();
    const diagnosticCount = diagnostics.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(diagnostics).toHaveBeenCalledTimes(diagnosticCount);
    expect(socket.readyState).toBe(1);
    bridge.disconnect();
  });
});
