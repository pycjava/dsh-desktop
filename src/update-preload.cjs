// @ts-check
/**
 * Preload for the update dialog (src/update.html). A minimal bridge — no
 * title-bar injection — exposing the dialog state plus the actions the two
 * update flows need: on Windows the buttons drive electron-updater (download/
 * retry, restart to install), on macOS they open the browser download page.
 * Uses the same ready-pull pattern as preload.cjs's dshBoot bridge so the
 * initial state is never lost to a page-load race.
 */
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshUpdate', {
  /** Report the dialog's listener attached so the main process can push the current state. */
  ready: () => ipcRenderer.send('update:ready'),
  /** Subscribe to dialog-state pushes ({mode, phase, currentVersion, version, url, progress, error}). */
  onState: (listener) => ipcRenderer.on('update:state', (_event, state) => { listener(state) }),
  /** Start (or retry) the update download — Windows auto flow only. */
  download: () => ipcRenderer.send('update:download'),
  /** Restart the app into the downloaded update — Windows auto flow only. */
  install: () => ipcRenderer.send('update:install'),
  /** Close the dialog; at prompt stage this also records the version as ignored. */
  dismiss: () => ipcRenderer.send('update:dismiss'),
  /** Ask the main process to open the download page in the OS browser. */
  openDownload: () => ipcRenderer.send('update:open-download'),
})
