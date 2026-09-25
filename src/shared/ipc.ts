/** Everything the main process and the renderer agree on: channel names, data shapes and the preload API. */

export const FILE_PROTOCOL = 'podium-file'

// ---------------------------------------------------------------- FFmpeg

export interface FfmpegInfo {
  ffmpegPath: string
  ffprobePath: string
  version: string
  source: 'custom' | 'bundled' | 'system'
}

export interface MediaStreamInfo {
  index: number
  kind: 'video' | 'audio' | 'other'
  codec: string
  width?: number
  height?: number
  fps?: number
  rotation?: number
  pixelFormat?: string
  sampleRate?: number
  channels?: number
  /** Stream title tag; gsr names audio tracks after their source device. */
  title?: string
}

export interface MediaProbe {
  path: string
  size: number
  duration: number
  format: string
  streams: MediaStreamInfo[]
}

export type ExportQuality = 'high' | 'medium' | 'low'

export interface EncoderInfo {
  name: string
  label: string
  hardware: boolean
}

export interface ResolvedEncoder extends EncoderInfo {
  ffmpegPath: string
  /** Global options placed before the inputs (e.g. the VAAPI device). */
  globalArgs: string[]
  /** Appended to the filter chain (e.g. `format=nv12,hwupload`). */
  filterSuffix: string
  /** Codec options per quality level. */
  codecArgs: Record<ExportQuality, string[]>
  /** Software pixel format, or null when frames are uploaded to the GPU by the filter chain. */
  pixelFormat: string | null
}

// ---------------------------------------------------------------- Capture

export type VideoCodec = 'h264' | 'hevc' | 'av1'
export type BufferStorage = 'ram' | 'disk'
export type BackendKind = 'gsr' | 'fake'

export interface CaptureSettings {
  /** Monitor name (e.g. `DP-2`), or null for the monitor that has focus when the buffer starts. */
  monitor: string | null
  fps: number
  codec: VideoCodec
  /** Constant bitrate, so RAM use is predictable: bufferSeconds × bitrate / 8. */
  bitrateKbps: number
  bufferSeconds: number
  storage: BufferStorage
  cursor: boolean
}

export interface AudioSettings {
  /** Device id as the backend lists it (`default_output`, `device:…`), or null to not record it. */
  desktop: string | null
  mic: string | null
}

export interface Monitor {
  id: string
  width: number
  height: number
}

export interface AudioDevice {
  id: string
  label: string
  kind: 'output' | 'input'
}

export interface CaptureCapabilities {
  backend: BackendKind | null
  /** Why no backend can run (shown on the setup screen). Null when one is available. */
  problem: { title: string; detail: string; install?: string[] } | null
  version: string | null
  gpu: string | null
  monitors: Monitor[]
  audioDevices: AudioDevice[]
  codecs: VideoCodec[]
}

export type BufferState = 'off' | 'starting' | 'buffering' | 'paused' | 'error' | 'unavailable'

export interface CaptureStatus {
  state: BufferState
  /** When the buffer (re)started filling; buffered seconds = min(now - since, bufferSeconds). */
  since: number | null
  bufferSeconds: number
  monitor: Monitor | null
  fps: number
  codec: VideoCodec
  message: string | null
}

export type ClipAction = { kind: 'clip'; seconds: number } | { kind: 'bookmark' }

export interface Hotkey {
  id: string
  /** Electron accelerator, e.g. `Alt+F9`. Null when unbound. */
  accelerator: string | null
  action: ClipAction
}

// ---------------------------------------------------------------- Games

export interface GameRule {
  /** Matched case-insensitively against the window class (or the process name on Windows). */
  match: string
  /** Name to tag clips with; null ignores the window (it's never a game). */
  name: string | null
}

export interface DetectedGame {
  /** Stable id: `steam:<appid>` or `app:<window class>`. */
  id: string
  name: string
  source: 'steam' | 'window'
  /** Local artwork from Steam's library cache, when there is some. */
  iconPath: string | null
  heroPath: string | null
}

export interface GameSummary {
  id: string
  name: string
  clipCount: number
  iconUrl: string | null
  heroUrl: string | null
}

// ---------------------------------------------------------------- Library

export interface Clip {
  id: string
  path: string
  title: string
  gameId: string | null
  gameName: string | null
  createdAt: number
  duration: number
  width: number
  height: number
  fps: number
  size: number
  /** Audio track labels in stream order (e.g. Desktop, Microphone). */
  audioTracks: string[]
  /** Saved from the whole buffer with the bookmark hotkey; still needs trimming. */
  bookmark: boolean
  favorite: boolean
}

/** A clip as the renderer sees it: urls the page can load. */
export interface ClipView extends Clip {
  url: string
  thumbnailUrl: string | null
}

export interface Filmstrip {
  url: string
  count: number
  interval: number
  tileWidth: number
  tileHeight: number
}

// ---------------------------------------------------------------- Export

export type ExportPreset = 'discord' | 'high' | 'tracks' | 'gif'

export interface ExportRequest {
  clipId: string
  preset: ExportPreset
  /** Seconds within the clip. */
  range: { start: number; end: number }
  /** Linear gain per audio track, in stream order. */
  volumes: number[]
  /** 'library' adds a new clip next to the original, 'replace' overwrites it, a path exports to a file. */
  destination: 'library' | 'replace' | { path: string }
}

export interface ExportJobState {
  id: string
  clipId: string
  name: string
  preset: ExportPreset
  outputPath: string | null
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  /** 0..1 */
  progress: number
  message: string | null
}

// ---------------------------------------------------------------- Settings

export interface AppSettings {
  ffmpegDir: string | null
  /** Where clips are saved; null means `<Videos>/Podium`. */
  libraryDir: string | null
  capture: CaptureSettings
  audio: AudioSettings
  hotkeys: Hotkey[]
  gameRules: GameRule[]
  notifications: { sound: boolean; soundVolume: number; system: boolean }
  startup: { autostart: boolean; startHidden: boolean }
  /** Closing the window keeps Podium (and the buffer) running in the tray. */
  closeToTray: boolean
  /** Start buffering as soon as Podium starts. */
  bufferOnLaunch: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  ffmpegDir: null,
  libraryDir: null,
  capture: {
    monitor: null,
    fps: 60,
    codec: 'h264',
    bitrateKbps: 40_000,
    bufferSeconds: 120,
    storage: 'ram',
    cursor: true
  },
  audio: { desktop: 'default_output', mic: 'default_input' },
  hotkeys: [
    { id: 'clip-30', accelerator: 'Alt+F9', action: { kind: 'clip', seconds: 30 } },
    { id: 'clip-120', accelerator: 'Alt+F10', action: { kind: 'clip', seconds: 120 } },
    { id: 'bookmark', accelerator: 'Alt+F8', action: { kind: 'bookmark' } }
  ],
  gameRules: [],
  notifications: { sound: true, soundVolume: 0.6, system: true },
  startup: { autostart: false, startHidden: true },
  closeToTray: true,
  bufferOnLaunch: true
}

// ---------------------------------------------------------------- Channels

export const IPC = {
  ffmpegInfo: 'ffmpeg:info',
  dialogChooseFolder: 'dialog:choose-folder',
  dialogSaveFile: 'dialog:save-file',
  copyText: 'app:copy-text',
  openExternal: 'app:open-external',
  /** Main → renderer: play the "clip saved" sound. */
  playCue: 'app:play-cue',
  /** Main → renderer: navigate (e.g. a notification was clicked). */
  navigate: 'app:navigate',
  appInfo: 'app:info'
} as const

export const SETTINGS_IPC = { get: 'settings:get', update: 'settings:update' } as const

export const CAPTURE_IPC = {
  capabilities: 'capture:capabilities',
  status: 'capture:status',
  start: 'capture:start',
  stop: 'capture:stop',
  restart: 'capture:restart',
  save: 'capture:save',
  /** Main → renderer. */
  statusChanged: 'capture:status-changed'
} as const

export const LIBRARY_IPC = {
  list: 'library:list',
  games: 'library:games',
  rename: 'library:rename',
  setFlags: 'library:set-flags',
  remove: 'library:remove',
  reveal: 'library:reveal',
  startDrag: 'library:start-drag',
  filmstrip: 'library:filmstrip',
  audioTracks: 'library:audio-tracks',
  /** Main → renderer, with the full updated list. */
  changed: 'library:changed',
  /** Main → renderer: a clip was just saved by a hotkey or the tray. */
  saved: 'library:saved'
} as const

export const EXPORT_IPC = {
  start: 'export:start',
  cancel: 'export:cancel',
  list: 'export:list',
  update: 'export:update'
} as const

export const GAMES_IPC = {
  current: 'games:current',
  changed: 'games:changed'
} as const

export const HOTKEYS_IPC = {
  /** Where the hotkeys are registered and whether it worked. */
  status: 'hotkeys:status',
  /** Temporarily unregister global hotkeys while the user records a new binding. */
  suspend: 'hotkeys:suspend'
} as const

export interface HotkeyStatus {
  /** `hyprland`: binds added to the compositor at runtime; `portal`: the desktop's GlobalShortcuts portal; `global`: X11/Windows. */
  mechanism: 'hyprland' | 'portal' | 'global'
  /** Hotkeys that could not be registered, and why. */
  failed: Array<{ id: string; reason: string }>
  /** Shell command that saves a clip, for binding in any desktop environment. */
  cliCommand: string
}

export interface AppInfo {
  version: string
  platform: string
  sessionType: string | null
  desktop: string | null
  userData: string
  libraryDir: string
}

// ---------------------------------------------------------------- Preload API

export interface PodiumApi {
  platform: string
  app: {
    info(): Promise<AppInfo>
    copyText(text: string): void
    openExternal(url: string): void
    onPlayCue(cb: () => void): () => void
    onNavigate(cb: (route: string) => void): () => void
  }
  settings: {
    get(): Promise<AppSettings>
    update(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  dialog: {
    chooseFolder(): Promise<string | null>
    saveFile(defaultName: string, extensions: string[]): Promise<string | null>
  }
  capture: {
    capabilities(refresh?: boolean): Promise<CaptureCapabilities>
    status(): Promise<CaptureStatus>
    start(): Promise<void>
    stop(): Promise<void>
    restart(): Promise<void>
    save(action: ClipAction): Promise<ClipView | null>
    onStatus(cb: (status: CaptureStatus) => void): () => void
  }
  library: {
    list(): Promise<ClipView[]>
    games(): Promise<GameSummary[]>
    rename(id: string, title: string): Promise<void>
    setFlags(id: string, flags: Partial<Pick<Clip, 'favorite' | 'bookmark'>>): Promise<void>
    remove(ids: string[]): Promise<void>
    reveal(id: string): void
    /** Native drag of the clip file, so it can be dropped into Discord, a browser or a file manager. */
    startDrag(id: string): void
    filmstrip(id: string): Promise<Filmstrip | null>
    /** One playable audio file per track (extracted and cached), for per-track volume in the player. */
    audioTracks(id: string): Promise<string[]>
    onChanged(cb: (clips: ClipView[]) => void): () => void
    onSaved(cb: (clip: ClipView) => void): () => void
  }
  exports: {
    start(request: ExportRequest): Promise<string>
    cancel(id: string): void
    list(): Promise<ExportJobState[]>
    onUpdate(cb: (jobs: ExportJobState[]) => void): () => void
  }
  games: {
    current(): Promise<DetectedGame | null>
    onChanged(cb: (game: DetectedGame | null) => void): () => void
  }
  hotkeys: {
    status(): Promise<HotkeyStatus>
    suspend(suspended: boolean): void
  }
  pathForFile(file: File): string
}
