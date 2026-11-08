import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createInterface } from 'node:readline'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { app, BrowserWindow, desktopCapturer, ipcMain, screen, session, type NativeImage } from 'electron'
import {
  WINCAP_IPC,
  type AudioDevice,
  type CaptureCapabilities,
  type CaptureTrack,
  type Monitor,
  type VideoCodec
} from '@shared/ipc'
import {
  buildWindowsArgs,
  CHANNELS,
  ENCODER_VENDORS,
  FrameWatch,
  FROZEN_MS,
  helperCaptureArgs,
  parseOutputDevices,
  pickSegments,
  probeArgs,
  runsAhead,
  saveArgs,
  SEGMENT_SECONDS,
  silenceDue,
  takeFrames,
  type AudioClock,
  type EncoderVendor,
  type Segment
} from '@core/capture/windows'
import { resolveFfmpeg, systemFfmpeg } from '../ffmpeg/paths'
import { loadRendererPage } from '../windows'
import { unavailable, type CaptureBackend, type StartConfig } from './Backend'

const exec = promisify(execFile)
const PARTITION = 'podium-capture'
const VENDOR_LABELS: Record<EncoderVendor, string> = {
  nvenc: 'NVIDIA NVENC',
  amf: 'AMD AMF',
  qsv: 'Intel Quick Sync',
  software: 'CPU (x264)'
}

const pidFile = (): string => join(app.getPath('userData'), 'capture.pid')
/** Bytes per frame of interleaved float32 PCM. */
const FRAME_BYTES = CHANNELS * 4
/** How often stalled audio tracks are topped up with silence. */
const PACE_MS = 100
/** The longest wait before restarting a desktop audio helper that keeps exiting. */
const HELPER_MAX_BACKOFF_MS = 30_000
/** How long a stopped helper gets to exit on its own before it is killed. */
const HELPER_STOP_MS = 1500

/** `podium-audio.exe` records desktop audio (WASAPI loopback); built from native/podium-audio. */
const helperPath = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, 'podium-audio.exe')
    : join(app.getAppPath(), 'resources', 'win', 'podium-audio.exe')

/** FFmpeg builds that can grab the desktop (ddagrab needs FFmpeg 6+ with D3D11). */
async function findFfmpeg(): Promise<{ path: string; version: string } | null> {
  const candidates = new Set<string>()
  await resolveFfmpeg().then(
    (f) => candidates.add(f.ffmpegPath),
    () => {}
  )
  const system = await systemFfmpeg()
  if (system) candidates.add(system)
  for (const path of candidates) {
    try {
      const { stdout } = await exec(path, ['-hide_banner', '-filters'], {
        timeout: 10_000,
        maxBuffer: 8 << 20
      })
      if (!/\sddagrab\s/.test(stdout)) continue
      const version =
        (await exec(path, ['-version'], { timeout: 10_000 })).stdout.match(/version (\S+)/)?.[1] ?? 'unknown'
      return { path, version }
    } catch {
      // Try the next build.
    }
  }
  return null
}

/** Monitors in DXGI output order, which is what ddagrab's `output_idx` counts. */
function monitors(): Monitor[] {
  return screen.getAllDisplays().map((d, i) => ({
    id: String(i),
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor),
    label: d.label || `Display ${i + 1}`,
    bounds: d.bounds
  }))
}

/** An FFmpeg left behind by a crashed Podium keeps grabbing the screen; Windows doesn't stop children with their parent. */
async function killStale(): Promise<void> {
  const pid = Number(await readFile(pidFile(), 'utf8').catch(() => ''))
  if (!pid) return
  const { stdout } = await exec('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).catch(() => ({
    stdout: ''
  }))
  if (/ffmpeg/i.test(stdout)) await exec('taskkill', ['/PID', String(pid), '/F']).catch(() => {})
  await rm(pidFile(), { force: true })
}

/** Runs FFmpeg with `files` streamed into its stdin one after another. */
async function remux(ffmpeg: string, args: string[], files: string[]): Promise<void> {
  const child = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)))
  child.stdin.on('error', () => {})
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code))
  })
  const timer = setTimeout(() => child.kill(), 60_000)
  try {
    // A write error means FFmpeg quit early; its exit code and stderr say why.
    const fed = (async () => {
      for (const file of files) await pipeline(createReadStream(file), child.stdin, { end: false })
      child.stdin.end()
    })().catch(() => child.stdin.destroy())
    const [code] = await Promise.all([exited, fed])
    if (code !== 0) throw new Error(stderr.trim().split('\n').at(-1) || `FFmpeg exited with code ${code}`)
  } finally {
    clearTimeout(timer)
  }
}

export class WindowsBackend implements CaptureBackend {
  readonly kind = 'ffmpeg' as const
  private ffmpeg: { path: string; version: string } | null = null
  private vendor: EncoderVendor | null = null
  private child: ChildProcess | null = null
  private stopping = false
  private stderr = ''
  private segmentDir: string | null = null
  private stagingDir: string | null = null
  private audioWindow: BrowserWindow | null = null
  private helper: ChildProcess | null = null
  private helperTimer: NodeJS.Timeout | null = null
  private readonly servers: Server[] = []
  private readonly sockets = new Map<CaptureTrack, { socket: Socket; clock: AudioClock }>()
  private pacer: NodeJS.Timeout | null = null
  private watchdog: NodeJS.Timeout | null = null
  private restartReason: string | null = null
  private readonly exitListeners = new Set<(reason: string) => void>()

  constructor() {
    ipcMain.on(WINCAP_IPC.pcm, (event, track: CaptureTrack, pcm: Uint8Array) => {
      if (event.sender === this.audioWindow?.webContents) this.feed(track, pcm)
    })
  }

  /** Writes whole frames of PCM to a track's pipe, unless they would run ahead of the clock. */
  private feed(track: CaptureTrack, pcm: Uint8Array): void {
    const pipe = this.sockets.get(track)
    // Before FFmpeg has connected (or after it stopped), audio has nowhere to go and is dropped.
    if (!pipe || pipe.socket.destroyed) return
    const frames = pcm.byteLength / FRAME_BYTES
    if (runsAhead(pipe.clock, performance.now(), frames)) return
    pipe.socket.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
    pipe.clock.frames += frames
  }

  /**
   * Runs the desktop audio helper, restarting it if it exits while recording. While it is down the
   * track carries on as silence (the pacer fills it), so the recording itself never stops for audio.
   */
  private startHelper(desktop: string, failures = 0): void {
    const startedAt = performance.now()
    const child = spawn(helperPath(), helperCaptureArgs(desktop), {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.helper = child
    let carry: Uint8Array = new Uint8Array()
    child.stdout.on('data', (chunk: Buffer) => {
      // A stopped helper's last buffered output must not reach the next recording's track.
      if (this.helper !== child) return
      const [whole, rest] = takeFrames(carry, chunk, FRAME_BYTES)
      carry = rest
      if (whole.length) this.feed('desktop', whole)
    })
    // Its log lines start with `[podium-audio]`.
    createInterface({ input: child.stderr }).on('line', (line) => line.trim() && console.log(line.trim()))
    child.stdin.on('error', () => {})
    child.once('error', (error) => console.warn('[capture] desktop audio helper:', error.message))
    child.once('close', (code) => {
      if (this.helper !== child) return
      this.helper = null
      // One that ran for a while is restarted at once; one that keeps failing is retried less and less often.
      const failed = performance.now() - startedAt < HELPER_MAX_BACKOFF_MS ? failures + 1 : 0
      const delay = Math.min(HELPER_MAX_BACKOFF_MS, failed ? 1000 * 2 ** (failed - 1) : 0)
      console.warn(`[capture] desktop audio helper exited (${code}); restarting in ${delay / 1000} s`)
      this.helperTimer = setTimeout(() => this.startHelper(desktop, failed), delay)
    })
  }

  private stopHelper(): void {
    if (this.helperTimer) clearTimeout(this.helperTimer)
    this.helperTimer = null
    const child = this.helper
    this.helper = null
    if (!child) return
    // Closing stdin is its signal to exit (it releases the audio device cleanly); the kill is for one that is stuck.
    child.stdin?.end()
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }, HELPER_STOP_MS)
  }

  /** Fills audio stalls with silence, so FFmpeg's sample-counted audio keeps time with ddagrab's clock. */
  private pace(): void {
    const now = performance.now()
    for (const { socket, clock } of this.sockets.values()) {
      const frames = silenceDue(clock, now)
      if (!frames || socket.destroyed) continue
      socket.write(Buffer.alloc(frames * FRAME_BYTES))
      clock.frames += frames
    }
  }

  /** The hidden page that captures system audio and the mic (see renderer/src/capture). */
  private async agent(): Promise<BrowserWindow> {
    if (this.audioWindow && !this.audioWindow.isDestroyed()) return this.audioWindow
    const captureSession = session.fromPartition(PARTITION)
    // This page, and only this one, may use the microphone.
    captureSession.setPermissionRequestHandler((_wc, permission, callback) =>
      callback(permission === 'media')
    )
    captureSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/capture.js'),
        partition: PARTITION,
        contextIsolation: true,
        sandbox: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required'
      }
    })
    this.audioWindow = win
    // Keep the page's warnings (a microphone that fails to open) in the main log.
    win.webContents.on('console-message', ({ level, message }) => {
      if (level === 'warning' || level === 'error') console.warn(message)
      else if (message.startsWith('[capture]')) console.log(message)
    })
    await new Promise<void>((resolve) => {
      win.webContents.once('did-finish-load', () => resolve())
      loadRendererPage(win, 'capture')
    })
    return win
  }

  private async call<T>(expression: string): Promise<T> {
    const win = await this.agent()
    return (await win.webContents.executeJavaScript(expression, true)) as T
  }

  async probe(): Promise<CaptureCapabilities> {
    if (process.platform !== 'win32') {
      return unavailable('Not supported yet', 'Recording on this platform is coming in a later version.')
    }
    this.ffmpeg = await findFfmpeg()
    if (!this.ffmpeg) {
      return unavailable(
        'FFmpeg with desktop capture is missing',
        'Podium records with FFmpeg’s Desktop Duplication grabber (ddagrab), which needs FFmpeg 6 or newer. Install a full build, then check again (or point Podium at it in the settings file’s ffmpegDir).',
        ['winget install Gyan.FFmpeg']
      )
    }
    // Listing an encoder proves nothing (driver, GPU vendor): each one encodes a few real frames.
    const works = async (vendor: EncoderVendor, codec: VideoCodec): Promise<boolean> =>
      exec(this.ffmpeg!.path, probeArgs(vendor, codec, 0), { timeout: 20_000 }).then(
        () => true,
        () => false
      )
    this.vendor = null
    for (const vendor of ENCODER_VENDORS) {
      if (await works(vendor, 'h264')) {
        this.vendor = vendor
        break
      }
    }
    if (!this.vendor) {
      return unavailable(
        'Desktop capture failed',
        'FFmpeg could not capture the desktop with any encoder. Make sure your graphics driver is up to date.'
      )
    }
    const codecs: VideoCodec[] = ['h264']
    if (this.vendor !== 'software') {
      for (const codec of ['hevc', 'av1'] as VideoCodec[])
        if (await works(this.vendor, codec)) codecs.push(codec)
    }
    const outputs = await exec(helperPath(), ['list'], { timeout: 10_000 }).then(
      ({ stdout }) => parseOutputDevices(stdout),
      (error: Error) => {
        console.warn('[capture] could not list output devices:', error.message)
        return parseOutputDevices('')
      }
    )
    const inputs = await this.call<AudioDevice[]>('window.captureAgent.listDevices()').catch(() => [
      { id: 'default_input', label: 'Default microphone', kind: 'input' as const }
    ])
    const audioDevices = [...outputs, ...inputs]
    return {
      backend: 'ffmpeg',
      problem: null,
      version: `FFmpeg ${this.ffmpeg.version}`,
      gpu: VENDOR_LABELS[this.vendor],
      monitors: monitors(),
      audioDevices,
      codecs,
      ramBuffer: false
    }
  }

  /** A named pipe FFmpeg reads one audio track from. */
  private async audioPipe(track: CaptureTrack): Promise<string> {
    const path = `\\\\.\\pipe\\podium-${track}-${process.pid}`
    const server = createServer((socket) => {
      this.sockets.set(track, { socket, clock: { startMs: performance.now(), frames: 0 } })
      socket.on('error', () => this.sockets.delete(track))
      socket.on('close', () => this.sockets.delete(track))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => resolve())
    })
    this.servers.push(server)
    return path
  }

  async start(config: StartConfig): Promise<void> {
    if (this.child) await this.stop()
    if (!this.ffmpeg || !this.vendor) {
      const caps = await this.probe()
      if (caps.problem) throw new Error(caps.problem.title)
    }
    await killStale()
    this.stagingDir = config.stagingDir
    this.segmentDir = join(config.stagingDir, 'ring')
    await rm(this.segmentDir, { recursive: true, force: true })
    await mkdir(this.segmentDir, { recursive: true })

    // Anything that fails from here on must not leave the helper, the pacer or a pipe behind: the
    // next start would find the pipe name taken.
    try {
      // Audio first: FFmpeg would wait forever on a pipe nobody writes to, so only started tracks get one.
      // The desktop track always has one: while its helper is down, the pacer keeps it going as silence.
      const pipes: string[] = []
      if (config.audio.desktop) {
        pipes.push(await this.audioPipe('desktop'))
        this.startHelper(config.audio.desktop)
      }
      const mic = await this.call<{ started: CaptureTrack[]; errors: string[] }>(
        `window.captureAgent.start(${JSON.stringify({ mic: config.audio.mic })})`
      ).catch((error: unknown) => ({ started: [] as CaptureTrack[], errors: [String(error)] }))
      for (const error of mic.errors) console.warn('[capture] audio:', error)
      if (mic.started.includes('mic')) pipes.push(await this.audioPipe('mic'))
      if (pipes.length) this.pacer = setInterval(() => this.pace(), PACE_MS)

      const args = buildWindowsArgs({
        capture: config.capture,
        audio: config.audio,
        outputIndex: Math.max(0, Number(config.monitor) || 0),
        vendor: this.vendor!,
        segmentDir: this.segmentDir,
        audioPipes: pipes
      })
      console.log('[ffmpeg] starting:', this.ffmpeg!.path, args.join(' '))
      const child = spawn(this.ffmpeg!.path, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      this.child = child
      this.stopping = false
      this.restartReason = null
      this.stderr = ''
      child.stderr?.on('data', (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-4000)))
      const frames = new FrameWatch(performance.now())
      child.stdout?.on('data', (d: Buffer) => frames.feed(d.toString(), performance.now()))
      if (child.pid) await writeFile(pidFile(), String(child.pid)).catch(() => {})

      await new Promise<void>((resolve, reject) => {
        let settled = false
        const settle = (error?: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error) reject(error)
          else resolve()
        }
        const timer = setTimeout(() => settle(), 3000)
        child.once('error', (error) => settle(error))
        child.once('exit', (code) => {
          const reason =
            this.restartReason ?? (this.stderr.trim().split('\n').at(-1) || `FFmpeg exited with code ${code}`)
          if (this.child === child) this.child = null
          void this.cleanupAudio()
          if (!settled) settle(new Error(reason))
          else if (!this.stopping) for (const listener of this.exitListeners) listener(reason)
        })
      })
      this.startWatchdog(frames)
    } catch (error) {
      if (this.child && this.child.exitCode === null) this.child.kill()
      this.child = null
      await this.cleanupAudio()
      throw error
    }
  }

  /** Restarts the recording when the video stops coming or Podium was frozen (sleep). */
  private startWatchdog(frames: FrameWatch): void {
    let last = { wall: Date.now(), mono: performance.now() }
    this.watchdog = setInterval(() => {
      const now = { wall: Date.now(), mono: performance.now() }
      const gap = Math.max(now.wall - last.wall, now.mono - last.mono)
      last = now
      if (gap > FROZEN_MS) {
        this.restartFor(`Podium was paused for ${Math.round(gap / 1000)} s (sleep?); restarting the buffer`)
      } else if (frames.stalled(now.mono)) {
        this.restartFor('The screen capture stopped (lock screen, UAC prompt or display change?); restarting')
      }
    }, 250)
  }

  /** Ends FFmpeg so the manager starts a fresh recording (it restarts engines that exit on their own). */
  private restartFor(reason: string): void {
    if (!this.child || this.stopping) return
    console.warn('[capture]', reason)
    this.restartReason = reason
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
    this.child.kill()
  }

  private async cleanupAudio(): Promise<void> {
    if (this.pacer) clearInterval(this.pacer)
    this.pacer = null
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
    this.stopHelper()
    for (const { socket } of this.sockets.values()) socket.destroy()
    this.sockets.clear()
    for (const server of this.servers.splice(0)) server.close()
    if (this.audioWindow && !this.audioWindow.isDestroyed()) {
      await this.audioWindow.webContents.executeJavaScript('window.captureAgent.stop()').catch(() => {})
    }
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.stopping = true
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill(), 5000)
      child.once('exit', () => {
        clearTimeout(kill)
        resolve()
      })
      // `q` stops FFmpeg cleanly (the last segment is finished properly).
      child.stdin?.write('q')
      child.stdin?.end()
    })
    this.child = null
    await this.cleanupAudio()
    await rm(pidFile(), { force: true })
  }

  async save(seconds: number | null): Promise<string> {
    if (!this.child || !this.segmentDir || !this.stagingDir)
      throw new Error('The replay buffer is not running')
    const dir = this.segmentDir
    const segments: Segment[] = []
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.ts')) continue
      const info = await stat(join(dir, name)).catch(() => null)
      if (info) segments.push({ path: join(dir, name), size: info.size, mtimeMs: info.mtimeMs })
    }
    const picked = pickSegments(segments, seconds)
    if (!picked.length) throw new Error('Nothing has been recorded yet')
    const output = join(this.stagingDir, `Replay_${Date.now()}.mp4`)
    await remux(
      this.ffmpeg!.path,
      saveArgs(output, (picked.length + 1) * SEGMENT_SECONDS),
      picked.map((s) => s.path)
    )
    return output
  }

  async preview(monitor: string): Promise<NativeImage | null> {
    const display = screen.getAllDisplays()[Number(monitor)]
    if (!display) return null
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 480, height: 480 }
    })
    return sources.find((s) => s.display_id === String(display.id))?.thumbnail ?? null
  }

  onExit(listener: (reason: string) => void): void {
    this.exitListeners.add(listener)
  }
}
