import { contextBridge, ipcRenderer } from 'electron';
import type { AppCommand, AppState, CouchkinAPI } from '../shared/types';
const api: CouchkinAPI = {
  request: (command: AppCommand) => ipcRenderer.invoke('couchkin:command', command),
  subscribe: (callback: (state: AppState) => void) => {
    const listener = (_event: unknown, state: AppState) => callback(state);
    ipcRenderer.on('couchkin:state', listener);
    return () => ipcRenderer.removeListener('couchkin:state', listener);
  },
  subscribeAudio: (callback) => {
    const listener = (_event: unknown, event: Parameters<typeof callback>[0]) => callback(event);
    ipcRenderer.on('couchkin:audio', listener);
    return () => ipcRenderer.removeListener('couchkin:audio', listener);
  },
  appendLiveAudio: (delta) => ipcRenderer.send('couchkin:live-input', delta),
  livePlayback: (active) => ipcRenderer.send('couchkin:live-playback', active),
  liveMicrophone: (active) => ipcRenderer.send('couchkin:live-microphone', active),
  prepareMicrophone: () => ipcRenderer.invoke('couchkin:prepare-microphone'),
};
contextBridge.exposeInMainWorld('couchkin', api);
