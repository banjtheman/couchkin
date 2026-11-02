import { describe, expect, it } from 'vitest';
import { RecentTwitchChat } from '../src/main/chat-context';

const message = (id = 'real-message') => ({ id, user: 'viewer', text: 'That boss had one HP!' });

describe('authoritative recent Twitch chat', () => {
  it('distinguishes unavailable chat from a connection that has received no messages', () => {
    const chat = new RecentTwitchChat();
    chat.selectChannel('#Some_Channel');
    chat.receive(message(), 1);
    expect(chat.snapshot(2)).toMatchObject({
      channel: 'some_channel',
      connected: false,
      status: 'disconnected',
      messages: [],
      joinedAt: null,
    });
    chat.connection(true, 10);
    expect(chat.snapshot(20)).toMatchObject({
      connected: true,
      status: 'waiting',
      joinedAt: 10,
      messages: [],
    });
  });

  it('keeps exact received messages with timestamps and expires old evidence', () => {
    const chat = new RecentTwitchChat();
    chat.selectChannel('channel');
    chat.connection(true, 1);
    chat.receive(message(), 10);
    expect(chat.snapshot(20)).toMatchObject({
      status: 'messages',
      messages: [{ ...message(), receivedAt: 10 }],
    });
    const copy = chat.snapshot(20);
    copy.messages[0]!.text = 'Invented replacement';
    expect(chat.snapshot(30).messages[0]!.text).toBe(message().text);
    expect(chat.snapshot(300011)).toMatchObject({
      status: 'quiet',
      messages: [],
      lastReceivedAt: 10,
    });
  });

  it('bounds the buffer and clears evidence on disconnect or a different channel', () => {
    const chat = new RecentTwitchChat();
    chat.selectChannel('first');
    chat.connection(true, 1);
    for (let i = 0; i < 40; i++) chat.receive(message(String(i)), 10 + i);
    expect(chat.receipt()).toEqual({
      receivedCount: 40,
      lastReceivedAt: 49,
      lastMessage: { user: 'viewer', text: 'That boss had one HP!' },
    });
    expect(chat.snapshot(60).messages.map((m) => m.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => String(i + 20)),
    );
    chat.connection(false, 70);
    expect(chat.receipt()).toEqual({ receivedCount: 0, lastReceivedAt: null, lastMessage: null });
    expect(chat.snapshot(80).messages).toEqual([]);
    chat.connection(true, 90);
    expect(chat.snapshot(100).status).toBe('waiting');
    chat.receive(message('new'), 110);
    chat.selectChannel('second');
    chat.connection(true, 120);
    expect(chat.snapshot(130)).toMatchObject({
      channel: 'second',
      status: 'waiting',
      messages: [],
    });
  });
});
