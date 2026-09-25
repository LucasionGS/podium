import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import type { CaptureCapabilities } from '@shared/ipc'
import {
  buildGsrArgs,
  parseAudioDevices,
  parseInfo,
  parseMonitors,
  parseReplies,
  type GsrRequest
} from '@core/capture/gsr'
import { unavailable, type CaptureBackend, type StartConfig } from './Backend'

const exec = promisify(execFile)
const FLATPAK_ID = 'com.dec05eba.gpu_screen_recorder'
const SAVE_TIMEOUT_MS = 60_000

interface Command {
  file: string
  prefix: string[]
}

/** The native binary if it's on PATH, otherwise the Flathub build. */
async function findGsr(): Promise<{ command: Command; version: string } | null> {
  const candidates: Command[] = [
    { file: 'gpu-screen-recorder', prefix: [] },
    { file: 'flatpak', prefix: ['run', `--command=gpu-screen-recorder`, FLATPAK_ID] }
  ]
  for (const command of candidates) {
    try {
      const { stdout } = await exec(command.file, [...command.prefix, '--version'], { timeout: 10_000 })
      return { command, version: stdout.trim().split('\n')[0] ?? 'unknown' }
    } catch {
      // Try the next one.
    }
  }
  return null
}

/**
 * `setpriv --pdeathsig` makes the kernel stop gsr when Podium dies, even on a crash or kill -9,
 * so it never keeps capturing the screen on its own. It's part of util-linux, present on practically every distro.
 */
const hasSetpriv = existsSync('/usr/bin/setpriv') || existsSync('/bin/setpriv')

const socketPath = (): string =>
  join(process.env['XDG_RUNTIME_DIR'] ?? app.getPath('temp'), `podium-gsr-${process.getuid?.() ?? 0}.sock`)

/** One request over a fresh connection; gsr answers when the request is done (for saves: once the file is written). */
function request(path: string, req: Omit<GsrRequest, 'id'>, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9) + 1
    const socket = connect(path)
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('gpu-screen-recorder did not answer in time'))
    }, timeoutMs)
    const finish = (error: Error | null, data?: unknown): void => {
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(data)
    }
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify({ ...req, id })}\n`))
    socket.on('data', (chunk: string) => {
      const { replies, rest } = parseReplies(buffer + chunk)
      buffer = rest
      const reply = replies.find((r) => r.id === id)
      if (!reply) return
      if (reply.result === 'ok') finish(null, reply.data)
      else
        finish(
          new Error(typeof reply.data === 'string' ? reply.data : 'gpu-screen-recorder refused the request')
        )
    })
    socket.on('error', (error) => finish(error))
  })
}

/** Last line of defence for a normal exit that skipped `stop()` (e.g. `app.exit()`). */
const running = new Set<ChildProcess>()
process.on('exit', () => running.forEach((child) => child.kill('SIGINT')))

export class GsrBackend implements CaptureBackend {
  readonly kind = 'gsr' as const
  private child: ChildProcess | null = null
  private stopping = false
  private stderr = ''
  private readonly exitListeners = new Set<(reason: string) => void>()
  private gsr: { command: Command; version: string } | null = null

  async probe(): Promise<CaptureCapabilities> {
    if (process.platform !== 'linux') {
      return unavailable('Not supported yet', 'Recording on this platform is coming in a later version.')
    }
    this.gsr = await findGsr()
    if (!this.gsr) {
      return unavailable(
        'GPU Screen Recorder is not installed',
        'Podium uses GPU Screen Recorder to capture your screen with your graphics card’s video encoder. Install it, then check again.',
        ['yay -S gpu-screen-recorder', `flatpak install flathub ${FLATPAK_ID}`]
      )
    }
    const run = async (...args: string[]): Promise<string> => {
      const { file, prefix } = this.gsr!.command
      return (
        (await exec(file, [...prefix, ...args], { timeout: 15_000 }).catch((e: { stdout?: string }) => e))
          .stdout ?? ''
      )
    }
    const [infoText, audioText, monitorText] = await Promise.all([
      run('--info'),
      run('--list-audio-devices'),
      run('--list-monitors')
    ])
    const info = parseInfo(infoText)
    const monitors = info.monitors.length ? info.monitors : parseMonitors(monitorText)
    return {
      backend: 'gsr',
      problem: monitors.length
        ? null
        : {
            title: 'No monitors found',
            detail: 'GPU Screen Recorder did not report any monitor it can capture.'
          },
      version: this.gsr.version,
      gpu: info.gpuVendor,
      monitors,
      audioDevices: parseAudioDevices(audioText),
      codecs: info.codecs.length ? info.codecs : ['h264']
    }
  }

  async start(config: StartConfig): Promise<void> {
    if (this.child) await this.stop()
    this.gsr ??= await findGsr()
    if (!this.gsr) throw new Error('GPU Screen Recorder is not installed')
    await mkdir(config.stagingDir, { recursive: true })
    const ipcPath = socketPath()
    // A gsr left behind by a crashed Podium would hold the monitor and the socket.
    await request(ipcPath, { name: 'stop' }, 2000).catch(() => {})
    await rm(ipcPath, { force: true })

    const args = buildGsrArgs({ ...config, outputDir: config.stagingDir, ipcPath })
    const { file, prefix } = this.gsr.command
    const command = hasSetpriv
      ? ['setpriv', '--pdeathsig', 'SIGINT', '--', file, ...prefix, ...args]
      : [file, ...prefix, ...args]
    console.log('[gsr] starting:', command.join(' '))
    const child = spawn(command[0]!, command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    running.add(child)
    child.once('exit', () => running.delete(child))
    this.stopping = false
    this.stderr = ''
    child.stderr?.on('data', (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-4000)))
    child.stdout?.resume()

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      // gsr has no "ready" message; if it's still running after a moment, capture and encoding started fine.
      const timer = setTimeout(() => settle(), 2500)
      child.once('error', (error) => settle(error))
      child.once('exit', (code, signal) => {
        const reason = this.describeExit(code, signal)
        if (this.child === child) this.child = null
        if (!settled) settle(new Error(reason))
        else if (!this.stopping) for (const listener of this.exitListeners) listener(reason)
      })
    })
  }

  private describeExit(code: number | null, signal: NodeJS.Signals | null): string {
    const lines = this.stderr
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !/^(info|warning):/i.test(l))
    const last = lines.filter((l) => /error/i.test(l)).at(-1) ?? lines.at(-1)
    return last ?? `gpu-screen-recorder exited (${signal ?? `code ${code}`})`
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.stopping = true
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 5000)
      child.once('exit', () => {
        clearTimeout(kill)
        resolve()
      })
      // In replay mode SIGINT stops without saving anything.
      child.kill('SIGINT')
    })
    this.child = null
  }

  async save(seconds: number | null): Promise<string> {
    if (!this.child) throw new Error('The replay buffer is not running')
    const data = seconds ? { seconds: Math.max(1, Math.round(seconds)) } : null
    const path = await request(socketPath(), { name: 'save-replay', data }, SAVE_TIMEOUT_MS)
    if (typeof path !== 'string' || !path) throw new Error('gpu-screen-recorder did not report a file')
    return path
  }

  onExit(listener: (reason: string) => void): void {
    this.exitListeners.add(listener)
  }
}
