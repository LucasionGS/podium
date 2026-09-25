import { BrowserWindow } from 'electron'
import {
  CAPTURE_IPC,
  type AppSettings,
  type CaptureCapabilities,
  type CaptureStatus,
  type ClipAction,
  type ClipView,
  type Monitor
} from '@shared/ipc'
import { clampBuffer } from '@core/capture/gsr'
import { withHyprlandLayout } from '@core/capture/monitors'
import { addClip, toView } from '../library'
import type { GameDetector } from '../games/detect'
import { hyprlandMonitors } from '../hyprland'
import { stagingDir } from '../paths'
import { getSettings } from '../settings'
import type { CaptureBackend } from './Backend'
import { FakeBackend } from './fake'
import { GsrBackend } from './gsr'
import { WindowsBackend } from './windows'

/** Restart delays after the engine dies on its own; after the last one we give up and show the error. */
const RESTART_DELAYS_MS = [1000, 3000, 10_000]

export class CaptureManager {
  private readonly backend: CaptureBackend
  private capabilities: CaptureCapabilities | null = null
  private status: CaptureStatus
  private restarts = 0
  private restartTimer: NodeJS.Timeout | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private readonly savedListeners = new Set<(clip: ClipView, action: ClipAction) => void>()
  private readonly statusListeners = new Set<(status: CaptureStatus) => void>()

  constructor(private readonly games: GameDetector) {
    // gpu-screen-recorder on Linux, FFmpeg (ddagrab) on Windows.
    this.backend =
      process.env['PODIUM_BACKEND'] === 'fake'
        ? new FakeBackend()
        : process.platform === 'win32'
          ? new WindowsBackend()
          : new GsrBackend()
    this.status = {
      state: 'off',
      since: null,
      bufferSeconds: 0,
      monitor: null,
      fps: 0,
      codec: 'h264',
      message: null
    }
    this.backend.onExit((reason) => this.handleCrash(reason))
  }

  async getCapabilities(refresh = false): Promise<CaptureCapabilities> {
    if (!this.capabilities || refresh) {
      const [caps, hypr] = await Promise.all([this.backend.probe(), hyprlandMonitors()])
      this.capabilities = { ...caps, monitors: withHyprlandLayout(caps.monitors, hypr) }
    }
    return this.capabilities
  }

  /** A JPEG data URL of what the monitor shows now, small enough for the picker. */
  async preview(monitor: string): Promise<string | null> {
    const caps = await this.getCapabilities()
    if (!caps.monitors.some((m) => m.id === monitor)) return null
    const image = await this.backend.preview(monitor, await stagingDir()).catch((error) => {
      console.warn('[capture] preview failed:', errorText(error))
      return null
    })
    if (!image || image.isEmpty()) return null
    const { width, height } = image.getSize()
    const small =
      width >= height
        ? image.resize({ width: Math.min(width, 480) })
        : image.resize({ height: Math.min(height, 480) })
    return `data:image/jpeg;base64,${small.toJPEG(75).toString('base64')}`
  }

  getStatus(): CaptureStatus {
    return this.status
  }

  onSaved(listener: (clip: ClipView, action: ClipAction) => void): void {
    this.savedListeners.add(listener)
  }

  onStatus(listener: (status: CaptureStatus) => void): void {
    this.statusListeners.add(listener)
  }

  private setStatus(patch: Partial<CaptureStatus>): void {
    this.status = { ...this.status, ...patch }
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send(CAPTURE_IPC.statusChanged, this.status)
    for (const listener of this.statusListeners) listener(this.status)
  }

  /** Operations run one at a time, so a save can't race a restart. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => {})
    return run
  }

  start(): Promise<void> {
    return this.serial(() => this.startNow())
  }

  private async startNow(): Promise<void> {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const caps = await this.getCapabilities()
    if (!caps.backend || caps.problem) {
      this.setStatus({
        state: 'unavailable',
        since: null,
        message: caps.problem?.title ?? 'No capture engine'
      })
      return
    }
    const settings = await getSettings()
    const known = (id: string | null): Monitor | undefined => caps.monitors.find((m) => m.id === id)
    // The chosen monitor if it's connected, else the focused one, else the first.
    const monitor: Monitor | null =
      known(settings.capture.monitor) ??
      known((await hyprlandMonitors()).find((m) => m.focused)?.name ?? null) ??
      caps.monitors[0] ??
      null
    if (!monitor) {
      this.setStatus({ state: 'error', message: 'No monitor to record' })
      return
    }
    this.setStatus({
      state: 'starting',
      since: null,
      message: null,
      monitor,
      fps: settings.capture.fps,
      codec: settings.capture.codec,
      bufferSeconds: clampBuffer(settings.capture.bufferSeconds)
    })
    try {
      await this.backend.start({
        capture: settings.capture,
        audio: settings.audio,
        monitor: monitor.id,
        stagingDir: await stagingDir()
      })
      this.setStatus({ state: 'buffering', since: Date.now() })
    } catch (error) {
      this.setStatus({ state: 'error', since: null, message: errorText(error) })
    }
  }

  stop(): Promise<void> {
    return this.serial(async () => {
      if (this.restartTimer) clearTimeout(this.restartTimer)
      this.restartTimer = null
      await this.backend.stop()
      this.setStatus({ state: 'off', since: null, message: null })
    })
  }

  /** Quitting: stop the engine right away, even if a start or save is still in progress. */
  async shutdown(): Promise<void> {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    await this.backend.stop()
  }

  restart(): Promise<void> {
    return this.serial(async () => {
      await this.backend.stop()
      this.restarts = 0
      await this.startNow()
    })
  }

  private handleCrash(reason: string): void {
    console.warn('[capture] engine stopped:', reason)
    const delay = RESTART_DELAYS_MS[this.restarts]
    if (delay === undefined) {
      this.setStatus({ state: 'error', since: null, message: reason })
      return
    }
    this.restarts++
    this.setStatus({ state: 'starting', since: null, message: `Restarting: ${reason}` })
    this.restartTimer = setTimeout(() => {
      void this.start().then(() => {
        // A buffer that stays up for a minute has recovered; later crashes get the full retry budget again.
        setTimeout(() => {
          if (this.status.state === 'buffering') this.restarts = 0
        }, 60_000)
      })
    }, delay)
  }

  /** Saves a clip from the buffer and files it in the library. Resolves with null when nothing is buffering. */
  save(action: ClipAction): Promise<ClipView | null> {
    return this.serial(async () => {
      if (this.status.state !== 'buffering') return null
      const seconds = action.kind === 'clip' ? Math.min(action.seconds, this.status.bufferSeconds) : null
      const [path, game] = await Promise.all([
        this.backend.save(seconds),
        this.games.detect().catch(() => null)
      ])
      const clip = toView(await addClip(path, { game, bookmark: action.kind === 'bookmark' }))
      for (const listener of this.savedListeners) listener(clip, action)
      return clip
    })
  }

  /** Restart the buffer when a setting it was started with changes. */
  async applySettings(next: AppSettings, previous: AppSettings): Promise<void> {
    const changed =
      JSON.stringify(next.capture) !== JSON.stringify(previous.capture) ||
      JSON.stringify(next.audio) !== JSON.stringify(previous.audio) ||
      next.libraryDir !== previous.libraryDir
    if (changed && ['buffering', 'starting', 'error'].includes(this.status.state)) await this.restart()
  }
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
