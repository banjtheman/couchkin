import { describe, it, expect } from 'vitest';
import { tokenMatches, overlayState, OverlayServer } from '../src/main/overlay';
import { initialState } from '../src/shared/defaults';
import { WebSocket } from 'ws';
describe('overlay boundary', () => {
  it('rejects malformed tokens without throwing', () => {
    expect(tokenMatches('a'.repeat(48), 'a'.repeat(48))).toBe(true);
    expect(tokenMatches('é'.repeat(48), 'a'.repeat(48))).toBe(false);
    expect(tokenMatches(null, 'a'.repeat(48))).toBe(false);
    expect(tokenMatches('b'.repeat(48), 'a'.repeat(48))).toBe(false);
  });
  it('does not broadcast user messages, game frames, memories or connections', () => {
    const privateState = {
      ...structuredClone(initialState),
      frameUrl: 'private-image',
      memories: [{ id: '1', text: 'private memory' }],
      messages: [
        { id: 'a', role: 'user' as const, text: 'private question', at: 0 },
        { id: 'b', role: 'companion' as const, text: 'A public reply', at: 1 },
      ],
      overlayUrl: 'secret-pairing-url',
    };
    const publicState = overlayState(privateState);
    expect(publicState.frameUrl).toBeNull();
    expect(publicState.memories).toEqual([]);
    expect(publicState.overlayUrl).toBe('');
    expect(publicState.messages.map((x) => x.text)).toEqual(['A public reply']);
  });
  it('uses one audio owner and refuses silent fallback after losing it', async () => {
    const server = new OverlayServer({
      token: 'a'.repeat(48),
      rendererDir: '/not-used',
      onPlayed: () => {},
      onOwnerLost: () => {},
    });
    await server.start();
    const socket = new WebSocket(
      server.origin.replace('http:', 'ws:') + '/events?token=' + 'a'.repeat(48),
    );
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        socket.send(JSON.stringify({ type: 'ready' }));
        resolve();
      });
      socket.once('error', reject);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(server.play({ type: 'speech', url: 'test', id: '1' })).toBe('overlay');
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.close();
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(server.play({ type: 'speech', url: 'test', id: '2' })).toBe('unavailable');
    server.resetAudioRouting();
    expect(server.play({ type: 'speech', url: 'test', id: '3' })).toBe('desktop');
    await server.close();
  });
});
