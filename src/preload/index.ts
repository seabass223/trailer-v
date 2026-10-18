import { contextBridge, ipcRenderer } from 'electron'
import type { TrailerApi } from '../shared/ipc'

const api: TrailerApi = {
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (input) => ipcRenderer.invoke('projects:create', input),
    read: (id) => ipcRenderer.invoke('projects:read', id),
    save: (project) => ipcRenderer.invoke('projects:save', project),
    rename: (id, name) => ipcRenderer.invoke('projects:rename', id, name),
    duplicate: (id) => ipcRenderer.invoke('projects:duplicate', id),
    remove: (id) => ipcRenderer.invoke('projects:remove', id),
    savePoster: (id, jpeg) => ipcRenderer.invoke('projects:savePoster', id, jpeg),
  },
  library: {
    scan: (folder) => ipcRenderer.invoke('library:scan', folder),
    onChanged: (cb) => {
      const listener = (_e: unknown, folder: string, files: Parameters<typeof cb>[1]) => cb(folder, files)
      ipcRenderer.on('library:changed', listener)
      return () => ipcRenderer.removeListener('library:changed', listener)
    },
    readText: (path) => ipcRenderer.invoke('library:readText', path),
  },
  dialog: {
    pickFolder: (defaultPath) => ipcRenderer.invoke('dialog:pickFolder', defaultPath),
    saveVideo: (defaultName) => ipcRenderer.invoke('dialog:saveVideo', defaultName),
  },
  fonts: { list: () => ipcRenderer.invoke('fonts:list') },
  encoder: { caps: () => ipcRenderer.invoke('encoder:caps') },
  exporter: {
    start: (project, job) => ipcRenderer.invoke('export:start', project, job),
    cancel: () => ipcRenderer.send('export:cancel'),
    onEvent: (cb) => {
      const listener = (_e: unknown, ev: Parameters<typeof cb>[0]) => cb(ev)
      ipcRenderer.on('export:event', listener)
      return () => ipcRenderer.removeListener('export:event', listener)
    },
  },
  shell: { showItem: (path) => ipcRenderer.invoke('shell:showItem', path) },
  generate: {
    openView: (folder) => ipcRenderer.invoke('generate:openView', folder),
    closeView: (viewId) => ipcRenderer.send('generate:closeView', viewId),
    callTool: (viewId, name, args) => ipcRenderer.invoke('generate:callTool', viewId, name, args),
    readResource: (uri) => ipcRenderer.invoke('generate:readResource', uri),
    adopt: (viewId, handle) => ipcRenderer.send('generate:adopt', viewId, handle),
    deliverNow: (jobId) => ipcRenderer.send('generate:deliverNow', jobId),
    cancel: (jobId) => ipcRenderer.invoke('generate:cancel', jobId),
    openLink: (url) => ipcRenderer.invoke('generate:openLink', url),
    onEvent: (cb) => {
      const listener = (_e: unknown, ev: Parameters<typeof cb>[0]) => cb(ev)
      ipcRenderer.on('generate:event', listener)
      return () => ipcRenderer.removeListener('generate:event', listener)
    },
  },
  mediaUrl: (path) => `media://local/${encodeURIComponent(path)}`,
}

contextBridge.exposeInMainWorld('api', api)
