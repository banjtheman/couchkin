import {
  app,
  BrowserWindow,
  ipcMain,
  clipboard,
  shell,
  session,
  systemPreferences,
} from 'electron';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller } from './controller';
import { OverlayServer } from './overlay';
import { commandSchema, safeExternalUrl } from './validation';
import { readApiConfig } from './api-config';
import type { AppCommand } from '../shared/types';
const here = fileURLToPath(new URL('.', import.meta.url));
let window: BrowserWindow | null = null,
  controller: Controller | null = null,
  overlay: OverlayServer | null = null,
  closing = false;
let microphonePermissionRequest: Promise<boolean> | null = null;
async function prepareMicrophone() {
  if (process.platform !== 'darwin') return { allowed: true, status: 'granted' };
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status !== 'not-determined') return { allowed: status === 'granted', status };
  window?.show();
  window?.focus();
  // A UI timeout cannot cancel an OS consent dialog. Reuse the outstanding request
  // when the user retries instead of opening several requests for the same prompt.
  microphonePermissionRequest ??= systemPreferences.askForMediaAccess('microphone').finally(() => {
    microphonePermissionRequest = null;
  });
  const allowed = await microphonePermissionRequest;
  return { allowed, status: systemPreferences.getMediaAccessStatus('microphone') };
}
// A dedicated profile makes local integration checks independent of your companion.
if (!app.isPackaged && process.env.COUCHKIN_DATA_DIR && isAbsolute(process.env.COUCHKIN_DATA_DIR))
  app.setPath('userData', process.env.COUCHKIN_DATA_DIR);
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (window) {
    window.show();
    window.focus();
  }
});
app
  .whenReady()
  .then(async () => {
    controller = new Controller(
      app.getPath('userData'),
      await readApiConfig(app.getAppPath(), app.getPath('userData')),
    );
    const token = await controller.initialize();
    overlay = new OverlayServer({
      token,
      port: 43128,
      rendererDir: join(here, '../renderer'),
      devUrl: process.env.ELECTRON_RENDERER_URL,
      onPlayed: (id) => controller?.played(id),
      onOwnerLost: () => controller?.ownerLost(),
      onOwnerReady: () => controller?.ownerReady(),
      onPlaybackFailed: () => controller?.playbackFailed(),
      onPcmActivity: (active) => controller?.livePlayback(active, 'overlay'),
    });
    const url = await overlay.start();
    controller.attachOverlay(overlay, url);
    session.defaultSession.setPermissionCheckHandler(
      (contents, permission, _origin, details) =>
        contents === window?.webContents &&
        details.isMainFrame &&
        permission === 'media' &&
        details.mediaType !== 'video' &&
        (process.platform !== 'darwin' ||
          systemPreferences.getMediaAccessStatus('microphone') === 'granted'),
    );
    session.defaultSession.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        if (
          contents !== window?.webContents ||
          !details.isMainFrame ||
          permission !== 'media' ||
          !('mediaTypes' in details) ||
          !details.mediaTypes?.length ||
          details.mediaTypes.some((type) => type !== 'audio')
        ) {
          callback(false);
          return;
        }
        // Reached only after the streamer's explicit microphone action in our main window.
        void prepareMicrophone().then(
          ({ allowed }) => callback(allowed),
          () => callback(false),
        );
      },
    );
    window = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 1000,
      minHeight: 720,
      title: 'Couchkin',
      backgroundColor: '#f4f1e9',
      show: false,
      webPreferences: {
        preload: join(here, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (url !== window?.webContents.getURL()) event.preventDefault();
    });
    controller.on('state', (state) => window?.webContents.send('couchkin:state', state));
    controller.on('audio', (event) => window?.webContents.send('couchkin:audio', event));
    const trusted = (event: Electron.IpcMainEvent) =>
      event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame;
    ipcMain.handle('couchkin:prepare-microphone', async (event) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error('Untrusted microphone request.');
      return prepareMicrophone();
    });
    ipcMain.on('couchkin:live-input', (event, delta) => {
      if (trusted(event)) controller?.appendLiveAudio(delta);
    });
    ipcMain.on('couchkin:live-playback', (event, active) => {
      if (trusted(event) && typeof active === 'boolean')
        controller?.livePlayback(active, 'desktop');
    });
    ipcMain.on('couchkin:live-microphone', (event, active) => {
      if (trusted(event) && typeof active === 'boolean') controller?.liveMicrophone(active);
    });
    ipcMain.handle('couchkin:command', async (event, raw) => {
      if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error('Untrusted sender.');
      const parsed = commandSchema.safeParse(raw);
      if (!parsed.success)
        return { ok: false, error: 'Invalid request.', state: controller!.state };
      const command = parsed.data as AppCommand;
      if (command.type === 'copy-overlay') {
        clipboard.writeText(controller!.state.overlayUrl);
        return { ok: true, state: controller!.state };
      }
      if (command.type === 'open-overlay') {
        await shell.openExternal(controller!.state.overlayUrl + '&preview=1');
        return { ok: true, state: controller!.state };
      }
      if (command.type === 'open-external') {
        if (!('url' in command) || !safeExternalUrl(command.url))
          return { ok: false, error: 'Only HTTPS links can be opened.', state: controller!.state };
        await shell.openExternal(command.url);
        return { ok: true, state: controller!.state };
      }
      return controller!.request(command);
    });
    if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else await window.loadFile(join(here, '../renderer/index.html'));
    window.show();
    void controller.checkCodex().catch(() => {});
  })
  .catch((error) => {
    console.error(
      'Couchkin could not start:',
      error instanceof Error ? error.message : 'unknown error',
    );
    app.quit();
  });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (closing) return;
  event.preventDefault();
  closing = true;
  void Promise.allSettled([controller?.dispose(), overlay?.close()]).finally(() => app.quit());
});
