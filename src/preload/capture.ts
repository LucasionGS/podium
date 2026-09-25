import { contextBridge, ipcRenderer } from 'electron'
import { WINCAP_IPC, type CaptureTrack } from '@shared/ipc'

/** Bridge for the hidden audio-capture window (Windows): PCM chunks go straight to main. */
contextBridge.exposeInMainWorld('podiumCapture', {
  sendPcm: (track: CaptureTrack, pcm: Float32Array): void =>
    ipcRenderer.send(WINCAP_IPC.pcm, track, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
})
