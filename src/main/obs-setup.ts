import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type OBSWebSocket from 'obs-websocket-js';
import type { OBSRequestTypes, OBSResponseTypes } from 'obs-websocket-js';

export const COUCHKIN_OVERLAY_INPUT = 'Couchkin Overlay';
const REQUEST_TIMEOUT_MS = 10_000;

export function parseLocalObsConfig(value: unknown): { address: string; password: string } {
  if (!value || typeof value !== 'object')
    throw new Error('OBS connection settings are invalid. Use the manual connection fields.');
  const config = value as Record<string, unknown>;
  if (config.server_enabled !== true)
    throw new Error(
      'Enable the WebSocket server in OBS → Tools → WebSocket Server Settings, then try again.',
    );
  const port = config.server_port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('OBS has an invalid WebSocket port. Use the manual connection fields.');
  const password = config.auth_required === false ? '' : config.server_password;
  if (
    typeof password !== 'string' ||
    password.length > 1024 ||
    (config.auth_required !== false && !password)
  )
    throw new Error('OBS authentication settings are unavailable. Use the manual password field.');
  return { address: `ws://127.0.0.1:${port}`, password };
}

/** Read only OBS's own fixed local settings file. Never return its password to the UI. */
export async function readLocalObsConnection(): Promise<{ address: string; password: string }> {
  if (process.platform !== 'darwin')
    throw new Error(
      'Automatic OBS connection is available on Mac. Use the manual connection fields.',
    );
  let value: unknown;
  try {
    const source = await readFile(
      join(
        homedir(),
        'Library',
        'Application Support',
        'obs-studio',
        'plugin_config',
        'obs-websocket',
        'config.json',
      ),
      'utf8',
    );
    if (source.length > 64 * 1024) throw new Error('oversized');
    value = JSON.parse(source);
  } catch {
    throw new Error(
      'Could not read OBS connection settings. Open OBS and enable its WebSocket server, or connect manually.',
    );
  }
  return parseLocalObsConfig(value);
}

export function validCouchkinOverlayUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.port === '43128' &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.searchParams.size === 2 &&
      url.searchParams.getAll('overlay').length === 1 &&
      url.searchParams.get('overlay') === '1' &&
      url.searchParams.getAll('token').length === 1 &&
      /^[a-f0-9]{48}$/.test(url.searchParams.get('token') || '')
    );
  } catch {
    return false;
  }
}

/** Add only Couchkin's own browser input to the current program scene. */
export async function installCouchkinOverlay(
  client: Pick<OBSWebSocket, 'call'>,
  overlayUrl: string,
  isCurrent: () => boolean = () => true,
): Promise<{ sceneName: string; inputName: string }> {
  if (!validCouchkinOverlayUrl(overlayUrl))
    throw new Error(
      'Couchkin’s local overlay URL is invalid. Restart Couchkin before adding the overlay.',
    );
  const call = async <K extends keyof OBSRequestTypes>(
    name: K,
    data?: OBSRequestTypes[K],
  ): Promise<OBSResponseTypes[K]> => {
    if (!isCurrent()) throw new Error('OBS connection changed. Try adding the overlay again.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        client.call(name, data),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), REQUEST_TIMEOUT_MS);
        }),
      ]);
      if (!isCurrent()) throw new Error('changed');
      return result;
    } catch {
      throw new Error(
        'Could not finish adding the Couchkin overlay. Check the OBS connection and retry.',
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const scene = await call('GetSceneList');
  const sceneName = scene.currentProgramSceneName;
  if (typeof sceneName !== 'string' || !sceneName.trim())
    throw new Error('Choose a program scene in OBS before adding Couchkin.');
  const inputName = COUCHKIN_OVERLAY_INPUT;
  const inputs = await call('GetInputList');
  const existing = inputs.inputs.find((input) => input.inputName === inputName);
  let sceneItemId: number;
  let createdInput = false;
  if (existing) {
    if (existing.inputKind !== 'browser_source')
      throw new Error(
        'An unrelated OBS source is already named “Couchkin Overlay”. Rename it before adding Couchkin.',
      );
    const settings = await call('GetInputSettings', { inputName });
    if (
      settings.inputKind !== 'browser_source' ||
      !validCouchkinOverlayUrl(settings.inputSettings.url)
    )
      throw new Error(
        'The existing “Couchkin Overlay” source is not a recognized Couchkin overlay. Rename it before adding this one.',
      );
    if (settings.inputSettings.url !== overlayUrl)
      await call('SetInputSettings', {
        inputName,
        inputSettings: { url: overlayUrl },
        overlay: true,
      });
    const items = await call('GetSceneItemList', { sceneName });
    // Repeated setup preserves the user's position, size, visibility, and audio choices.
    if (items.sceneItems.some((item) => item.sourceName === inputName))
      return { sceneName, inputName };
    const item = await call('CreateSceneItem', {
      sceneName,
      sourceName: inputName,
      sceneItemEnabled: true,
    });
    sceneItemId = item.sceneItemId;
  } else {
    const video = await call('GetVideoSettings');
    if (
      ![video.baseWidth, video.baseHeight].every(
        (value) => Number.isInteger(value) && value > 0 && value <= 16384,
      )
    )
      throw new Error(
        'OBS returned an invalid canvas size. Check Video settings before adding Couchkin.',
      );
    const created = await call('CreateInput', {
      sceneName,
      inputName,
      inputKind: 'browser_source',
      sceneItemEnabled: true,
      inputSettings: {
        url: overlayUrl,
        width: video.baseWidth,
        height: video.baseHeight,
        reroute_audio: true,
        shutdown: false,
        restart_when_active: false,
      },
    });
    sceneItemId = created.sceneItemId;
    createdInput = true;
  }
  await call('SetSceneItemTransform', {
    sceneName,
    sceneItemId,
    sceneItemTransform: {
      positionX: 0,
      positionY: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      alignment: 5,
      boundsType: 'OBS_BOUNDS_NONE',
      cropLeft: 0,
      cropRight: 0,
      cropTop: 0,
      cropBottom: 0,
    },
  });
  if (createdInput)
    await call('SetInputAudioMonitorType', { inputName, monitorType: 'OBS_MONITORING_TYPE_NONE' });
  return { sceneName, inputName };
}
