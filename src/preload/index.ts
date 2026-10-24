import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import {
  CAPTURE_IPC,
  EXPORT_IPC,
  GAMES_IPC,
  HOTKEYS_IPC,
  IPC,
  LIBRARY_IPC,
  SETTINGS_IPC,
  UPDATE_IPC,
  UPLOAD_IPC,
  type PodiumApi
} from '@shared/ipc'

/** Subscribes to a main → renderer channel; returns the unsubscribe function. */
function listen<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, value: T): void => cb(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: PodiumApi = {
  platform: process.platform,
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    copyText: (text) => ipcRenderer.send(IPC.copyText, text),
    openExternal: (url) => ipcRenderer.send(IPC.openExternal, url),
    onPlayCue: (cb) => listen(IPC.playCue, cb),
    onNavigate: (cb) => listen(IPC.navigate, cb)
  },
  settings: {
    get: () => ipcRenderer.invoke(SETTINGS_IPC.get),
    update: (patch) => ipcRenderer.invoke(SETTINGS_IPC.update, patch)
  },
  dialog: {
    chooseFolder: () => ipcRenderer.invoke(IPC.dialogChooseFolder),
    saveFile: (name, extensions) => ipcRenderer.invoke(IPC.dialogSaveFile, name, extensions)
  },
  capture: {
    capabilities: (refresh) => ipcRenderer.invoke(CAPTURE_IPC.capabilities, refresh),
    status: () => ipcRenderer.invoke(CAPTURE_IPC.status),
    start: () => ipcRenderer.invoke(CAPTURE_IPC.start),
    stop: () => ipcRenderer.invoke(CAPTURE_IPC.stop),
    restart: () => ipcRenderer.invoke(CAPTURE_IPC.restart),
    save: (action) => ipcRenderer.invoke(CAPTURE_IPC.save, action),
    preview: (monitor) => ipcRenderer.invoke(CAPTURE_IPC.preview, monitor),
    onStatus: (cb) => listen(CAPTURE_IPC.statusChanged, cb)
  },
  library: {
    list: () => ipcRenderer.invoke(LIBRARY_IPC.list),
    games: () => ipcRenderer.invoke(LIBRARY_IPC.games),
    rename: (id, title) => ipcRenderer.invoke(LIBRARY_IPC.rename, id, title),
    setFlags: (id, flags) => ipcRenderer.invoke(LIBRARY_IPC.setFlags, id, flags),
    remove: (ids) => ipcRenderer.invoke(LIBRARY_IPC.remove, ids),
    reveal: (id) => ipcRenderer.send(LIBRARY_IPC.reveal, id),
    startDrag: (id) => ipcRenderer.send(LIBRARY_IPC.startDrag, id),
    filmstrip: (id) => ipcRenderer.invoke(LIBRARY_IPC.filmstrip, id),
    audioTracks: (id) => ipcRenderer.invoke(LIBRARY_IPC.audioTracks, id),
    onChanged: (cb) => listen(LIBRARY_IPC.changed, cb),
    onSaved: (cb) => listen(LIBRARY_IPC.saved, cb)
  },
  exports: {
    start: (request) => ipcRenderer.invoke(EXPORT_IPC.start, request),
    cancel: (id) => ipcRenderer.send(EXPORT_IPC.cancel, id),
    list: () => ipcRenderer.invoke(EXPORT_IPC.list),
    onUpdate: (cb) => listen(EXPORT_IPC.update, cb)
  },
  games: {
    current: () => ipcRenderer.invoke(GAMES_IPC.current),
    onChanged: (cb) => listen(GAMES_IPC.changed, cb)
  },
  hotkeys: {
    status: () => ipcRenderer.invoke(HOTKEYS_IPC.status),
    suspend: (suspended) => ipcRenderer.send(HOTKEYS_IPC.suspend, suspended)
  },
  uploads: {
    start: (clipId, targetId) => ipcRenderer.invoke(UPLOAD_IPC.start, clipId, targetId),
    cancel: (id) => ipcRenderer.send(UPLOAD_IPC.cancel, id),
    list: () => ipcRenderer.invoke(UPLOAD_IPC.list),
    onUpdate: (cb) => listen(UPLOAD_IPC.update, cb),
    test: (target, token) => ipcRenderer.invoke(UPLOAD_IPC.test, target, token),
    setToken: (targetId, token) => ipcRenderer.invoke(UPLOAD_IPC.setToken, targetId, token),
    tokens: () => ipcRenderer.invoke(UPLOAD_IPC.tokens)
  },
  updates: {
    status: () => ipcRenderer.invoke(UPDATE_IPC.status),
    check: () => ipcRenderer.invoke(UPDATE_IPC.check),
    install: () => ipcRenderer.invoke(UPDATE_IPC.install),
    restart: () => ipcRenderer.send(UPDATE_IPC.restart),
    onChanged: (cb) => listen(UPDATE_IPC.changed, cb)
  },
  pathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('podium', api)
