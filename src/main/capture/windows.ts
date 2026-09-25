import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
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
  concatList,
  ENCODER_VENDORS,
  pickSegments,
  probeArgs,
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
  private readonly servers: Server[] = []
  private readonly sockets = new Map<CaptureTrack, Socket>()
  private readonly exitListeners = new Set<(reason: string) => void>()

  constructor() {
    ipcMain.on(WINCAP_IPC.pcm, (event, track: CaptureTrack, pcm: Uint8Array) => {
      if (event.sender !== this.audioWindow?.webContents) return
      const socket = this.sockets.get(track)
      // Before FFmpeg has connected (or after it stopped), audio has nowhere to go and is dropped.
      if (socket && !socket.destroyed) socket.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
    })
  }

  /** The hidden page that captures system audio and the mic (see renderer/src/capture). */
  private async agent(): Promise<BrowserWindow> {
    if (this.audioWindow && !this.audioWindow.isDestroyed()) return this.audioWindow
    const captureSession = session.fromPartition(PARTITION)
    // This page, and only this one, may use the microphone and system audio.
    captureSession.setPermissionRequestHandler((_wc, permission, callback) =>
      callback(permission === 'media' || permission === 'display-capture')
    )
    captureSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')
    captureSession.setDisplayMediaRequestHandler((_request, callback) => {
      void desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        // The video is discarded; `loopback` is what we want: everything the system plays.
        callback(sources[0] ? { video: sources[0], audio: 'loopback' } : {})
      })
    })
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
    const audioDevices = await this.call<AudioDevice[]>('window.captureAgent.listDevices()').catch(() => [
      { id: 'default_output', label: 'All system audio', kind: 'output' as const },
      { id: 'default_input', label: 'Default microphone', kind: 'input' as const }
    ])
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
      this.sockets.set(track, socket)
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

    // Audio first: FFmpeg would wait forever on a pipe nobody writes to, so only started tracks get one.
    const audio = await this.call<{ started: CaptureTrack[]; errors: string[] }>(
      `window.captureAgent.start(${JSON.stringify({ desktop: Boolean(config.audio.desktop), mic: config.audio.mic })})`
    ).catch((error: unknown) => ({ started: [] as CaptureTrack[], errors: [String(error)] }))
    for (const error of audio.errors) console.warn('[capture] audio:', error)
    const order: CaptureTrack[] = ['desktop', 'mic']
    const pipes: string[] = []
    for (const track of order.filter((t) => audio.started.includes(t)))
      pipes.push(await this.audioPipe(track))

    const args = buildWindowsArgs({
      capture: config.capture,
      audio: config.audio,
      outputIndex: Math.max(0, Number(config.monitor) || 0),
      vendor: this.vendor!,
      segmentDir: this.segmentDir,
      audioPipes: pipes
    })
    console.log('[ffmpeg] starting:', this.ffmpeg!.path, args.join(' '))
    const child = spawn(this.ffmpeg!.path, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    this.child = child
    this.stopping = false
    this.stderr = ''
    child.stderr?.on('data', (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-4000)))
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
        const reason = this.stderr.trim().split('\n').at(-1) || `FFmpeg exited with code ${code}`
        if (this.child === child) this.child = null
        void this.cleanupAudio()
        if (!settled) settle(new Error(reason))
        else if (!this.stopping) for (const listener of this.exitListeners) listener(reason)
      })
    })
  }

  private async cleanupAudio(): Promise<void> {
    for (const socket of this.sockets.values()) socket.destroy()
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
    const stamp = Date.now()
    const list = join(this.stagingDir, `concat-${stamp}.txt`)
    const output = join(this.stagingDir, `Replay_${stamp}.mp4`)
    await writeFile(list, concatList(picked.map((s) => s.path)))
    try {
      await exec(
        this.ffmpeg!.path,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          list,
          '-map',
          '0',
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          output
        ],
        { timeout: 60_000, windowsHide: true }
      )
    } finally {
      await rm(list, { force: true })
    }
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
