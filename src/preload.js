/*
 * Dictofon — безопасный мост между окном и главным процессом.
 * Доступен только узкий API, Node.js в окне отключён.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dictofon', {
  isElectron: true,
  demoMode: false,
  platform: process.platform,

  app: {
    info: () => ipcRenderer.invoke('app:info'),
    close: () => ipcRenderer.invoke('app:close-now')
  },

  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    close: () => ipcRenderer.send('win:close'),
    onMaximizeChange: (callback) => {
      ipcRenderer.on('win:maximized', (event, value) => callback(!!value));
    },
    onCloseRequested: (callback) => {
      ipcRenderer.on('app:close-requested', () => callback());
    }
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    chooseFolder: () => ipcRenderer.invoke('settings:choose-folder')
  },

  rec: {
    begin: (payload) => ipcRenderer.invoke('rec:begin', payload),
    chunk: (payload) => ipcRenderer.invoke('rec:chunk', payload),
    end: (payload) => ipcRenderer.invoke('rec:end', payload),
    save: (payload) => ipcRenderer.invoke('rec:save', payload),
    discard: (payload) => ipcRenderer.invoke('rec:discard', payload)
  },

  recordings: {
    list: () => ipcRenderer.invoke('recordings:list'),
    read: (id) => ipcRenderer.invoke('recordings:read', id),
    reveal: (id) => ipcRenderer.invoke('recordings:reveal', id),
    remove: (id) => ipcRenderer.invoke('recordings:remove', id),
    openFolder: () => ipcRenderer.invoke('recordings:open-folder')
  },

  dialog: {
    unsavedClose: () => ipcRenderer.invoke('dialog:unsaved'),
    confirmDelete: (entry) => ipcRenderer.invoke('dialog:confirm-delete', entry)
  }
});
