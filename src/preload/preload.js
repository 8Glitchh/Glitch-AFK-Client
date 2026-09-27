'use strict'
/**
 * The only bridge between the UI and the main process. The renderer gets a
 * fixed list of functions — no raw ipcRenderer, no Node APIs.
 */
const { contextBridge, ipcRenderer } = require('electron')

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('api', {
  bootstrap: () => call('app:bootstrap'),
  saveProfile: p => call('profiles:save', p),
  deleteProfile: id => call('profiles:delete', id),
  saveSettings: s => call('settings:save', s),
  setSecret: (profileId, secret, persist) => call('secret:set', profileId, secret, persist),
  deleteSecret: profileId => call('secret:delete', profileId),
  connect: profileId => call('bot:connect', profileId),
  disconnect: () => call('bot:disconnect'),
  reconnect: () => call('bot:reconnect'),
  sendChat: text => call('bot:chat', text),
  startAfk: cfg => call('afk:start', cfg),
  stopAfk: () => call('afk:stop'),
  clearChat: () => call('chat:clear'),
  copyChat: () => call('chat:copy'),
  exportChat: () => call('chat:export'),
  clearLogs: () => call('logs:clear'),
  exportLogs: () => call('logs:export'),
  openDataDir: () => call('app:openDataDir'),
  onPush: fn => {
    const listener = (_e, batch) => fn(batch)
    ipcRenderer.on('push', listener)
    return () => ipcRenderer.removeListener('push', listener)
  }
})
