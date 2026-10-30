import OBSWebSocket from 'obs-websocket-js';
import {
  COUCHKIN_OVERLAY_INPUT,
  readLocalObsConnection,
  installCouchkinOverlay,
} from './obs-setup';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

/** OBS is local infrastructure; never send its password to an arbitrary URL. */
export function normalizeObsAddress(address: string): string {
  if (typeof address !== 'string' || address.length > 512)
    throw new Error('Enter a local OBS WebSocket address.');
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    throw new Error('Use an OBS address such as ws://127.0.0.1:4455.');
  }
  if (
    !['ws:', 'wss:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase())
  ) {
    throw new Error('This build connects to OBS on this computer only. Use ws://127.0.0.1:4455.');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== '/')
  ) {
    throw new Error(
      'Put the OBS password in its separate field; the address must contain only a local host and port.',
    );
  }
  if (!url.port) url.port = '4455';
  return `${url.protocol}//${url.host}`;
}

export function validateScreenshot(data: unknown): string {
  if (typeof data !== 'string' || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64) {
    throw new Error('OBS returned a screenshot that is too large or invalid.');
  }
  const match = /^data:image\/(?:jpeg|jpg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  const encoded = match?.[1];
  if (!encoded || encoded.length % 4 !== 0)
    throw new Error('OBS did not return a valid JPEG screenshot.');
  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.length < 4 ||
    bytes.length > MAX_IMAGE_BYTES ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8
  ) {
    throw new Error('OBS did not return a valid JPEG screenshot.');
  }
  // OBS echoes imageFormat verbatim, including the nonstandard image/jpg alias.
  return data.replace(/^data:image\/jpg;/, 'data:image/jpeg;');
}

function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), REQUEST_TIMEOUT_MS);
    operation.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export class ObsBridge {
  private client: OBSWebSocket | null = null;
  private connected = false;
  private revision = 0;
  private overlaySetup: Promise<{ sceneName: string; inputName: string }> | null = null;
  private readonly listeners = new Set<(connected: boolean, message: string) => void>();

  onStatus(callback: (connected: boolean, message: string) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private status(connected: boolean, message: string): void {
    this.connected = connected;
    for (const listener of this.listeners) listener(connected, message);
  }

  async connect(address: string, password: string): Promise<void> {
    const normalized = normalizeObsAddress(address);
    if (typeof password !== 'string' || password.length > 1024)
      throw new Error('The OBS password is invalid.');
    await this.disconnect();
    const revision = ++this.revision;
    const client = new OBSWebSocket();
    this.client = client;
    client.on('ConnectionClosed', () => {
      if (this.client === client)
        this.status(false, 'OBS disconnected. Reconnect to keep watching.');
    });
    // Do not display raw library errors: some WebSocket errors include connection details.
    client.on('ConnectionError', () => {
      if (this.client === client)
        this.status(false, 'OBS connection failed. Check that its WebSocket server is enabled.');
    });
    try {
      await withTimeout(
        client.connect(normalized, password || undefined, { rpcVersion: 1, eventSubscriptions: 0 }),
        'OBS did not respond. Check its WebSocket settings.',
      );
      if (revision !== this.revision || this.client !== client) {
        await client.disconnect();
        throw new Error('OBS connection was cancelled.');
      }
      this.status(true, 'OBS connected. Choose the game input you want Couchkin to see.');
    } catch (error) {
      if (this.client === client) {
        this.client = null;
        const code = (error as { code?: number })?.code;
        this.status(
          false,
          code === 4008
            ? 'OBS rejected the password. Check Tools → WebSocket Server Settings.'
            : 'Could not connect to OBS. Check the local address, password, and WebSocket server.',
        );
      }
      await client.disconnect().catch(() => undefined);
      const authFailed = (error as { code?: number })?.code === 4008;
      throw new Error(
        authFailed
          ? 'OBS rejected the password.'
          : 'Could not connect to OBS. Check its WebSocket server, address, and password.',
      );
    }
  }

  async connectLocal(): Promise<string> {
    const { address, password } = await readLocalObsConnection();
    await this.connect(address, password);
    return address;
  }

  async installOverlay(overlayUrl: string): Promise<{ sceneName: string; inputName: string }> {
    if (this.overlaySetup) return this.overlaySetup;
    const client = this.active(),
      revision = this.revision;
    const setup = installCouchkinOverlay(
      client,
      overlayUrl,
      () => revision === this.revision && client === this.client,
    );
    this.overlaySetup = setup;
    try {
      return await setup;
    } finally {
      if (this.overlaySetup === setup) this.overlaySetup = null;
    }
  }

  async disconnect(): Promise<void> {
    ++this.revision;
    const old = this.client;
    this.client = null;
    this.status(false, 'OBS is disconnected.');
    if (old) await old.disconnect().catch(() => undefined);
  }

  private active(): OBSWebSocket {
    if (!this.connected || !this.client) throw new Error('Connect to OBS first.');
    return this.client;
  }

  async listSources(): Promise<string[]> {
    const client = this.active();
    const revision = this.revision;
    try {
      const result = await withTimeout(
        client.call('GetInputList'),
        'OBS took too long to list its inputs.',
      );
      if (revision !== this.revision) throw new Error('OBS connection changed.');
      return [
        ...new Set(
          result.inputs.flatMap((input) =>
            typeof input.inputName === 'string' &&
            input.inputName.trim() &&
            input.inputName !== COUCHKIN_OVERLAY_INPUT
              ? [input.inputName]
              : [],
          ),
        ),
      ].sort((a, b) => a.localeCompare(b));
    } catch {
      throw new Error('Could not read OBS inputs. Reconnect and try again.');
    }
  }

  async capture(source: string): Promise<{ dataUrl: string; capturedAt: number }> {
    const client = this.active();
    if (
      typeof source !== 'string' ||
      !source.trim() ||
      source === COUCHKIN_OVERLAY_INPUT ||
      source.length > 512 ||
      /[\r\n\0]/.test(source)
    ) {
      throw new Error('Choose a valid OBS game input first.');
    }
    const revision = this.revision;
    // OBS does not return a frame timestamp. Use request time conservatively so
    // a delayed response cannot make an old screenshot look freshly captured.
    const capturedAt = Date.now();
    try {
      const result = await withTimeout(
        client.call('GetSourceScreenshot', {
          sourceName: source,
          imageFormat: 'jpeg',
          imageWidth: 1280,
          imageCompressionQuality: 80,
        }),
        'OBS took too long to capture the selected input.',
      );
      if (revision !== this.revision || client !== this.client)
        throw new Error('OBS connection changed.');
      return { dataUrl: validateScreenshot(result.imageData), capturedAt };
    } catch {
      throw new Error(
        'Could not capture that OBS input. Check that the game or capture-card source exists and has video.',
      );
    }
  }
}
