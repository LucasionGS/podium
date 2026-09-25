import type { AudioSettings, BackendKind, CaptureCapabilities, CaptureSettings } from '@shared/ipc'

export interface StartConfig {
  capture: CaptureSettings
  audio: AudioSettings
  /** Resolved monitor id. */
  monitor: string
  /** Where saved replays are written before they are filed into the library. */
  stagingDir: string
}

/** A replay buffer engine: gpu-screen-recorder on Linux, FFmpeg on Windows (planned), a fake one for tests. */
export interface CaptureBackend {
  readonly kind: BackendKind
  probe(): Promise<CaptureCapabilities>
  /** Resolves once the buffer is filling; rejects with a readable reason when it can't start. */
  start(config: StartConfig): Promise<void>
  stop(): Promise<void>
  /** Saves the last `seconds` (or the whole buffer for null) and resolves with the file's path. */
  save(seconds: number | null): Promise<string>
  /** Called when the engine stops on its own (crash, device lost). */
  onExit(listener: (reason: string) => void): void
}

export const unavailable = (title: string, detail: string, install?: string[]): CaptureCapabilities => ({
  backend: null,
  problem: { title, detail, install },
  version: null,
  gpu: null,
  monitors: [],
  audioDevices: [],
  codecs: []
})
