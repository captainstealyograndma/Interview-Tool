import { contextBridge, ipcRenderer } from 'electron';
import type { Api } from '../shared/ipc';

const api: Api = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setKeys: (keys) => ipcRenderer.invoke('keys:set', keys),

  getProfile: () => ipcRenderer.invoke('profile:get'),
  createProfile: (name) => ipcRenderer.invoke('profile:create', name),
  renameProfile: (name) => ipcRenderer.invoke('profile:rename', name),
  deleteProfile: () => ipcRenderer.invoke('profile:delete'),
  selectProfile: (id) => ipcRenderer.invoke('profile:select', id),
  chooseSheet: () => ipcRenderer.invoke('sheet:choose'),
  reloadSheet: () => ipcRenderer.invoke('sheet:reload'),
  chooseMaterial: (kind) => ipcRenderer.invoke('material:choose', kind),
  clearMaterial: (kind) => ipcRenderer.invoke('material:clear', kind),
  saveTemplate: () => ipcRenderer.invoke('template:save'),

  openReview: () => ipcRenderer.invoke('review:open'),
  getReview: () => ipcRenderer.invoke('review:get'),
  setPairing: (finder, blocks) => ipcRenderer.invoke('review:setPairing', finder, blocks),
  approve: () => ipcRenderer.invoke('review:approve'),

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
