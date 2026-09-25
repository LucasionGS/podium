import { execFile, execFileSync } from 'node:child_process'
import { constants, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, Socket } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ClipAction, Hotkey } from '@shared/ipc'
import {
  acceleratorToHyprland,
  actionFromCommand,
  actionToCommand,
  hyprlandModmask,
  luaKey,
  luaString
} from '@core/hotkeys'
import type { HyprMonitor } from '@core/capture/monitors'

const exec = promisify(execFile)

export const isHyprland = (): boolean =>
  process.platform === 'linux' && Boolean(process.env['HYPRLAND_INSTANCE_SIGNATURE'])

const runtimeDir = (): string => process.env['XDG_RUNTIME_DIR'] ?? '/tmp'
const fifoPath = (): string => join(runtimeDir(), `podium-${process.getuid?.() ?? 0}.cmd`)
/** What we bound, per Hyprland instance, so binds left by a crashed Podium can be removed on the next start. */
const boundFile = (): string => join(runtimeDir(), `podium-${process.getuid?.() ?? 0}.binds.json`)

/** The compositor's outputs, with position, rotation, model and focus; empty outside Hyprland. */
export async function hyprlandMonitors(): Promise<HyprMonitor[]> {
  if (!isHyprland()) return []
  try {
    return JSON.parse(await hyprctl('monitors', '-j')) as HyprMonitor[]
  } catch {
    return []
  }
}

async function hyprctl(...args: string[]): Promise<string> {
  return (await exec('hyprctl', args, { timeout: 3000 })).stdout.trim()
}

interface HyprBind {
  modmask: number
  key: string
  submap: string
}

interface Bound {
  id: string
  mods: string
  key: string
}

/**
 * Hotkeys on Hyprland: while Podium runs it adds binds to the compositor (`hyprctl eval` on the Lua
 * config, `hyprctl keyword` on the classic one). A bind writes one line to a FIFO Podium reads, which
 * is instant: no process start, no focus change, works over fullscreen games.
 */
export class HyprlandBinds {
  private bound: Bound[] = []
  private pipe: Socket | null = null
  private events: Socket | null = null
  private lua: boolean | null = null
  private wanted: Hotkey[] = []
  private reapply: NodeJS.Timeout | null = null

  constructor(private readonly fire: (action: ClipAction) => void) {}

  /** Opens the command pipe and follows config reloads, which drop runtime binds. */
  start(): void {
    try {
      const saved = JSON.parse(readFileSync(boundFile(), 'utf8')) as { instance: string; bound: Bound[] }
      if (saved.instance === process.env['HYPRLAND_INSTANCE_SIGNATURE']) this.bound = saved.bound
    } catch {
      // Nothing left over.
    }
    const path = fifoPath()
    rmSync(path, { force: true })
    execFileSync('mkfifo', ['-m', '600', path])
    // Read-write and non-blocking: opening never waits for a writer, and there is never an EOF.
    const fd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK)
    this.pipe = new Socket({ fd, readable: true, writable: false })
    this.pipe.setEncoding('utf8')
    let pending = ''
    this.pipe.on('data', (chunk: string) => {
      const lines = (pending + chunk).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const action = actionFromCommand(line)
        if (action) this.fire(action)
      }
    })
    this.followEvents()
  }

  private followEvents(): void {
    const signature = process.env['HYPRLAND_INSTANCE_SIGNATURE']!
    const socket = connect(join(runtimeDir(), 'hypr', signature, '.socket2.sock'))
    this.events = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      if (!chunk.includes('configreloaded>>')) return
      if (this.reapply) clearTimeout(this.reapply)
      // The reload has already dropped our binds; add them again once it has settled.
      this.reapply = setTimeout(() => {
        this.bound = []
        void this.apply(this.wanted)
      }, 300)
    })
    socket.on('error', (error) => console.warn('[hyprland] event socket:', error.message))
  }

  private async isLua(): Promise<boolean> {
    if (this.lua === null) {
      this.lua = await hyprctl('eval', 'return 1').then(
        (out) => !/unknown request/i.test(out),
        () => false
      )
    }
    return this.lua
  }

  private command(action: ClipAction): string {
    // `timeout` so a press can never leave a shell hanging if Podium died without cleaning up.
    return `timeout 1 sh -c 'echo ${actionToCommand(action)} > ${fifoPath()}'`
  }

  private async unbindAll(): Promise<void> {
    const lua = await this.isLua()
    for (const b of this.bound) {
      await (
        lua
          ? hyprctl('eval', `hl.unbind(${luaString(luaKey(b))})`)
          : hyprctl('keyword', 'unbind', `${b.mods}, ${b.key}`)
      ).catch(() => {})
    }
    this.bound = []
    this.saveBound()
  }

  private saveBound(): void {
    const data = { instance: process.env['HYPRLAND_INSTANCE_SIGNATURE'], bound: this.bound }
    writeFileSync(boundFile(), JSON.stringify(data))
  }

  /** Binds the hotkeys; returns the ones that couldn't be bound, with the reason. */
  async apply(hotkeys: Hotkey[]): Promise<Array<{ id: string; reason: string }>> {
    this.wanted = hotkeys
    await this.unbindAll()
    const lua = await this.isLua()
    const existing: HyprBind[] = await hyprctl('binds', '-j').then(
      (out) => JSON.parse(out) as HyprBind[],
      () => []
    )
    const failed: Array<{ id: string; reason: string }> = []
    for (const hotkey of hotkeys) {
      if (!hotkey.accelerator) continue
      const bind = acceleratorToHyprland(hotkey.accelerator)
      if (!bind) {
        failed.push({ id: hotkey.id, reason: 'Hyprland can’t bind this key combination' })
        continue
      }
      const mask = hyprlandModmask(bind.mods)
      const taken = existing.some(
        (b) => !b.submap && b.modmask === mask && b.key.toLowerCase() === bind.key.toLowerCase()
      )
      if (taken) {
        failed.push({
          id: hotkey.id,
          reason: `${hotkey.accelerator} is already bound in your Hyprland config`
        })
        continue
      }
      const command = this.command(hotkey.action)
      // Mouse buttons also reach the app under the cursor (Mouse4 stays "back" in a browser); keys don't.
      const passThrough = bind.key.startsWith('mouse:')
      const options = passThrough ? ', { non_consuming = true }' : ''
      try {
        const out = lua
          ? await hyprctl(
              'eval',
              `hl.bind(${luaString(luaKey(bind))}, hl.dsp.exec_cmd(${luaString(command)})${options})`
            )
          : await hyprctl(
              'keyword',
              passThrough ? 'bindn' : 'bind',
              `${bind.mods}, ${bind.key}, exec, ${command}`
            )
        if (out !== 'ok') throw new Error(out)
        this.bound.push({ id: hotkey.id, ...bind })
        this.saveBound()
      } catch (error) {
        failed.push({ id: hotkey.id, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return failed
  }

  /** On quit: remove our binds and the pipe. Synchronous, because quitting doesn't wait for promises. */
  stop(): void {
    if (this.reapply) clearTimeout(this.reapply)
    this.events?.destroy()
    this.pipe?.destroy()
    for (const b of this.bound) {
      try {
        if (this.lua)
          execFileSync('hyprctl', ['eval', `hl.unbind(${luaString(luaKey(b))})`], { timeout: 2000 })
        else execFileSync('hyprctl', ['keyword', 'unbind', `${b.mods}, ${b.key}`], { timeout: 2000 })
      } catch {
        // Hyprland may already be gone (logging out).
      }
    }
    this.bound = []
    rmSync(fifoPath(), { force: true })
    rmSync(boundFile(), { force: true })
  }
}
