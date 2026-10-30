import { describe, expect, it, vi } from 'vitest';
import type OBSWebSocket from 'obs-websocket-js';
import {
  COUCHKIN_OVERLAY_INPUT,
  installCouchkinOverlay,
  parseLocalObsConfig,
  validCouchkinOverlayUrl,
} from '../src/main/obs-setup';

const overlayUrl = 'http://127.0.0.1:43128/?overlay=1&token=' + 'a'.repeat(48);
const oldOverlayUrl = overlayUrl.replace('a'.repeat(48), 'b'.repeat(48));
function fixture(options: { existingKind?: string; existingUrl?: string; inScene?: boolean } = {}) {
  const call = vi.fn(async (method: string) => {
    switch (method) {
      case 'GetSceneList':
        return { currentProgramSceneName: 'Game Scene' };
      case 'GetInputList':
        return {
          inputs: options.existingKind
            ? [{ inputName: COUCHKIN_OVERLAY_INPUT, inputKind: options.existingKind }]
            : [],
        };
      case 'GetInputSettings':
        return {
          inputKind: options.existingKind,
          inputSettings: {
            url: options.existingUrl,
            width: 960,
            height: 540,
            reroute_audio: false,
          },
        };
      case 'GetSceneItemList':
        return {
          sceneItems: options.inScene
            ? [{ sourceName: COUCHKIN_OVERLAY_INPUT, sceneItemId: 3, sceneItemEnabled: false }]
            : [],
        };
      case 'GetVideoSettings':
        return { baseWidth: 1920, baseHeight: 1080 };
      case 'CreateInput':
        return { sceneItemId: 9 };
      case 'CreateSceneItem':
        return { sceneItemId: 10 };
      default:
        return undefined;
    }
  });
  return { client: { call } as unknown as Pick<OBSWebSocket, 'call'>, call };
}
const mutations = (calls: ReturnType<typeof fixture>['call']['mock']['calls']) =>
  calls.filter(([method]) => !method.startsWith('Get'));

describe('local OBS settings', () => {
  it('uses a loopback address and the configured password without changing OBS auth', () => {
    expect(
      parseLocalObsConfig({
        server_enabled: true,
        server_port: 4455,
        auth_required: true,
        server_password: 'local-test-secret',
      }),
    ).toEqual({ address: 'ws://127.0.0.1:4455', password: 'local-test-secret' });
    expect(
      parseLocalObsConfig({ server_enabled: true, server_port: 4456, auth_required: false }),
    ).toEqual({ address: 'ws://127.0.0.1:4456', password: '' });
  });
  it('rejects disabled or broken config with errors that never disclose its values', () => {
    for (const config of [
      null,
      {},
      { server_enabled: false },
      { server_enabled: true, server_port: 0 },
      { server_enabled: true, server_port: '4455' },
      { server_enabled: true, server_port: 4455, server_password: { secret: 'never-show-this' } },
    ]) {
      expect(() => parseLocalObsConfig(config)).toThrow();
      try {
        parseLocalObsConfig(config);
      } catch (error) {
        expect(String(error)).not.toContain('never-show-this');
      }
    }
  });
});

describe('Couchkin overlay installation', () => {
  it('accepts only the application pairing URL, not previews or unrelated browser URLs', () => {
    expect(validCouchkinOverlayUrl(overlayUrl)).toBe(true);
    for (const value of [
      overlayUrl + '&preview=1',
      overlayUrl + '&overlay=1',
      overlayUrl.replace('127.0.0.1', 'localhost'),
      overlayUrl.replace('43128', '80'),
      overlayUrl.replace('http:', 'https:'),
      overlayUrl.replace('a'.repeat(48), 'short'),
      overlayUrl + '#fragment',
      'https://example.com',
    ])
      expect(validCouchkinOverlayUrl(value)).toBe(false);
  });
  it('creates a full-canvas browser source with no scene switch, stream action, or desktop monitoring', async () => {
    const { client, call } = fixture();
    expect(await installCouchkinOverlay(client, overlayUrl)).toEqual({
      sceneName: 'Game Scene',
      inputName: COUCHKIN_OVERLAY_INPUT,
    });
    expect(call).toHaveBeenCalledWith('CreateInput', {
      sceneName: 'Game Scene',
      inputName: COUCHKIN_OVERLAY_INPUT,
      inputKind: 'browser_source',
      sceneItemEnabled: true,
      inputSettings: {
        url: overlayUrl,
        width: 1920,
        height: 1080,
        reroute_audio: true,
        shutdown: false,
        restart_when_active: false,
      },
    });
    expect(call).toHaveBeenCalledWith('SetInputAudioMonitorType', {
      inputName: COUCHKIN_OVERLAY_INPUT,
      monitorType: 'OBS_MONITORING_TYPE_NONE',
    });
    expect(mutations(call.mock.calls).map(([method]) => method)).toEqual([
      'CreateInput',
      'SetSceneItemTransform',
      'SetInputAudioMonitorType',
    ]);
  });
  it('is idempotent and preserves the existing scene item position, visibility and audio choices', async () => {
    const { client, call } = fixture({
      existingKind: 'browser_source',
      existingUrl: overlayUrl,
      inScene: true,
    });
    await installCouchkinOverlay(client, overlayUrl);
    expect(mutations(call.mock.calls)).toEqual([]);
  });
  it('updates only a recognized stale pairing URL and keeps the remaining input settings', async () => {
    const { client, call } = fixture({
      existingKind: 'browser_source',
      existingUrl: oldOverlayUrl,
      inScene: true,
    });
    await installCouchkinOverlay(client, overlayUrl);
    expect(mutations(call.mock.calls)).toEqual([
      [
        'SetInputSettings',
        { inputName: COUCHKIN_OVERLAY_INPUT, inputSettings: { url: overlayUrl }, overlay: true },
      ],
    ]);
  });
  it('adds the existing input to another scene without changing its audio configuration', async () => {
    const { client, call } = fixture({ existingKind: 'browser_source', existingUrl: overlayUrl });
    await installCouchkinOverlay(client, overlayUrl);
    expect(call).toHaveBeenCalledWith('CreateSceneItem', {
      sceneName: 'Game Scene',
      sourceName: COUCHKIN_OVERLAY_INPUT,
      sceneItemEnabled: true,
    });
    expect(mutations(call.mock.calls).map(([method]) => method)).toEqual([
      'CreateSceneItem',
      'SetSceneItemTransform',
    ]);
  });
  it('refuses name collisions before any mutation', async () => {
    for (const options of [
      { existingKind: 'image_source' },
      { existingKind: 'browser_source', existingUrl: 'https://example.com/overlay' },
    ]) {
      const { client, call } = fixture(options);
      await expect(installCouchkinOverlay(client, overlayUrl)).rejects.toThrow(/Rename/);
      expect(mutations(call.mock.calls)).toEqual([]);
    }
  });
  it('stops if the OBS connection changes between requests', async () => {
    const { client, call } = fixture();
    let current = true;
    call.mockImplementationOnce(async () => {
      current = false;
      return { currentProgramSceneName: 'Game Scene' };
    });
    await expect(installCouchkinOverlay(client, overlayUrl, () => current)).rejects.toThrow(
      'Could not finish',
    );
    expect(call).toHaveBeenCalledTimes(1);
    expect(mutations(call.mock.calls)).toEqual([]);
  });
  it('never exposes an OBS error that could contain a pairing URL or password', async () => {
    const { client, call } = fixture();
    call.mockRejectedValueOnce(new Error(overlayUrl + ' local-test-secret'));
    try {
      await installCouchkinOverlay(client, overlayUrl);
    } catch (error) {
      expect(String(error)).not.toContain(overlayUrl);
      expect(String(error)).not.toContain('local-test-secret');
    }
  });
});
