import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwitchDeviceAuth } from '../src/main/twitch-auth';

const clientId = 'couchkinPublicClient123456789';
const token = 'twitchFixtureAccessToken123456789';
const device = {
  device_code: 'privateDeviceFixtureCode123456',
  user_code: 'ABCDEFGH',
  verification_uri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH',
  expires_in: 30,
  interval: 5,
};
const validation = {
  client_id: clientId,
  login: 'riff_bot',
  user_id: '123456',
  scopes: ['chat:read', 'user:write:chat'],
  expires_in: 14400,
};
const fetchMock = vi.fn<typeof fetch>();
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const instances: TwitchDeviceAuth[] = [];
function auth() {
  const instance = new TwitchDeviceAuth();
  instances.push(instance);
  return instance;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-30T20:00:00Z'));
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  instances.splice(0).forEach((instance) => instance.dispose());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Twitch device authorization', () => {
  it('uses public device OAuth, waits the interval, and validates identity/scopes before handing off a token', async () => {
    fetchMock
      .mockResolvedValueOnce(response(device))
      .mockResolvedValueOnce(response({ access_token: token, refresh_token: 'unused' }))
      .mockResolvedValueOnce(response(validation));
    const bridge = auth(),
      authorized = vi.fn(),
      statuses = vi.fn();
    bridge.on('authorized', authorized).on('status', statuses);
    const result = await bridge.begin(` ${clientId} `);
    expect(result).toEqual({
      userCode: device.user_code,
      verificationUri: device.verification_uri,
      expiresAt: Date.now() + 30_000,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://id.twitch.tv/oauth2/device');
    expect(fetchMock.mock.calls[0]?.[1]?.body?.toString()).toBe(
      `client_id=${clientId}&scopes=chat%3Aread+user%3Awrite%3Achat`,
    );
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock.mock.calls[1]?.[1]?.body?.toString()).toContain(
      'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code',
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://id.twitch.tv/oauth2/validate');
    expect(authorized).toHaveBeenCalledWith({ username: 'riff_bot', token });
    expect(JSON.stringify(statuses.mock.calls)).not.toContain(token);
    expect(JSON.stringify(statuses.mock.calls)).not.toContain(device.device_code);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('client_secret');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('respects pending and increasing slow-down intervals without polling in parallel', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ ...device, expires_in: 120 }))
      .mockResolvedValueOnce(response({ message: 'authorization_pending' }, 400))
      .mockResolvedValueOnce(response({ error: 'slow_down' }, 400))
      .mockResolvedValueOnce(response({ message: 'authorization_pending' }, 400));
    await auth().begin(clientId);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('stops at the expiry deadline instead of making another request', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ ...device, expires_in: 7 }))
      .mockResolvedValueOnce(response({ message: 'authorization_pending' }, 400));
    const bridge = auth(),
      statuses = vi.fn();
    bridge.on('status', statuses);
    await bridge.begin(clientId);
    await vi.advanceTimersByTimeAsync(7000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(statuses).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'error', message: expect.stringContaining('expired') }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancels an in-flight token response and never validates or emits it after cancellation', async () => {
    let resolveToken!: (value: Response) => void;
    fetchMock.mockResolvedValueOnce(response(device)).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveToken = resolve;
        }),
    );
    const bridge = auth(),
      authorized = vi.fn();
    bridge.on('authorized', authorized);
    await bridge.begin(clientId);
    await vi.advanceTimersByTimeAsync(5000);
    const signal = fetchMock.mock.calls[1]?.[1]?.signal;
    bridge.cancel();
    expect(signal?.aborted).toBe(true);
    resolveToken(response({ access_token: token }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(authorized).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('replacing a pending begin ignores the stale device response', async () => {
    let oldResponse!: (value: Response) => void;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            oldResponse = resolve;
          }),
      )
      .mockResolvedValueOnce(response(device));
    const bridge = auth();
    const old = bridge.begin(clientId);
    const rejected = expect(old).rejects.toThrow('cancelled');
    await bridge.begin(clientId);
    oldResponse(response({ ...device, user_code: 'OLDOLDCODE' }));
    await rejected;
    expect(vi.getTimerCount()).toBe(1);
  });

  it('does not emit credentials when a status handler cancels the completed flow', async () => {
    fetchMock
      .mockResolvedValueOnce(response(device))
      .mockResolvedValueOnce(response({ access_token: token }))
      .mockResolvedValueOnce(response(validation));
    const bridge = auth(),
      authorized = vi.fn();
    bridge.on('authorized', authorized).on('status', (status) => {
      if (status.state === 'authorized') bridge.cancel();
    });
    await bridge.begin(clientId);
    await vi.advanceTimersByTimeAsync(5000);
    expect(authorized).not.toHaveBeenCalled();
  });

  it('bounds a stalled start request and sanitizes network diagnostics', async () => {
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error(`private diagnostic ${token}`)),
            { once: true },
          );
        }),
    );
    const bridge = auth(),
      statuses = vi.fn();
    bridge.on('status', statuses);
    const start = bridge.begin(clientId);
    const failed = expect(start).rejects.toThrow('Could not start Twitch sign-in');
    await vi.advanceTimersByTimeAsync(12_000);
    await failed;
    expect(JSON.stringify(statuses.mock.calls)).not.toContain(token);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { ...validation, client_id: 'anotherClient' },
    { ...validation, scopes: ['chat:read'] },
    { ...validation, login: null },
    { ...validation, user_id: null },
    { ...validation, expires_in: 0 },
  ])('rejects mismatched or insufficient token grants', async (invalid) => {
    fetchMock
      .mockResolvedValueOnce(response(device))
      .mockResolvedValueOnce(response({ access_token: token }))
      .mockResolvedValueOnce(response(invalid));
    const bridge = auth(),
      authorized = vi.fn(),
      statuses = vi.fn();
    bridge.on('authorized', authorized).on('status', statuses);
    await bridge.begin(clientId);
    await vi.advanceTimersByTimeAsync(5000);
    expect(authorized).not.toHaveBeenCalled();
    expect(statuses).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'error' }));
    expect(JSON.stringify(statuses.mock.calls)).not.toContain(token);
  });

  it.each([
    'https://evil.example/activate',
    'https://www.twitch.tv.evil.example/activate',
    'https://example.com@www.twitch.tv/activate',
    'http://www.twitch.tv/activate',
    'https://www.twitch.tv/other',
    'https://www.twitch.tv/activate?device-code=DIFFERENT',
  ])('does not present an untrusted activation URL: %s', async (verification_uri) => {
    fetchMock.mockResolvedValueOnce(response({ ...device, verification_uri }));
    await expect(auth().begin(clientId)).rejects.toThrow('Could not start Twitch sign-in');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects malformed input and oversized responses without exposing response bodies', async () => {
    const bridge = auth(),
      statuses = vi.fn();
    bridge.on('status', statuses);
    await expect(bridge.begin('bad\ninput')).rejects.toThrow('public Client ID');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(response({ secret: token.repeat(1000) }));
    await expect(bridge.begin(clientId)).rejects.toThrow('Could not start Twitch sign-in');
    expect(JSON.stringify(statuses.mock.calls)).not.toContain(token);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops on a declined grant and does not repeat attempts', async () => {
    fetchMock
      .mockResolvedValueOnce(response(device))
      .mockResolvedValueOnce(response({ error: 'access_denied' }, 400));
    const bridge = auth(),
      statuses = vi.fn();
    bridge.on('status', statuses);
    await bridge.begin(clientId);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(statuses).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: expect.stringContaining('declined') }),
    );
  });
});
