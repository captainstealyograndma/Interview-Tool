import { contextBridge, ipcRenderer } from 'electron';
import type { Api } from '../shared/ipc';

const api: Api = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setKeys: (keys) => ipcRenderer.invoke('keys:set', keys),
  openSheet: () => ipcRenderer.invoke('sheet:open'),
  reloadSheet: () => ipcRenderer.invoke('sheet:reload'),
  getSummary: () => ipcRenderer.invoke('sheet:summary'),
  openReview: () => ipcRenderer.invoke('review:open'),
  getReview: () => ipcRenderer.invoke('review:get'),
  setPairing: (finder, blocks) => ipcRenderer.invoke('review:setPairing', finder, blocks),
  approve: () => ipcRenderer.invoke('review:approve'),
  generatePhrasings: () => ipcRenderer.invoke('phrasings:generate'),
  startSession: () => ipcRenderer.invoke('session:start'),
  stopSession: () => ipcRenderer.invoke('session:stop'),
  simulate: (text) => ipcRenderer.invoke('session:simulate', text),
  sendAudio: (pcm) => ipcRenderer.send('audio:chunk', pcm),
  audioLevel: (rms) => ipcRenderer.send('audio:level', rms),
  audioError: (message) => ipcRenderer.send('audio:error', message),
  bannerScrolled: () => ipcRenderer.send('banner:scrolled'),
  showRunnerUp: () => ipcRenderer.send('banner:runnerUp'),
  showPiece: (id) => ipcRenderer.send('banner:showPiece', id),
  closeBanner: () => ipcRenderer.send('banner:close'),
  on: (channel, cb) => {
    const listener = (_e: Electron.IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld('api', api);
