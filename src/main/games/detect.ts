import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { DetectedGame, GameRule } from '@shared/ipc'
import { resolveGame, steamAppIdFromEnviron, type SteamProcess, type WindowInfo } from '@core/games/match'
import { steamApp, steamNames, steamRegistry } from './steam'

const exec = promisify(execFile)
const POLL_MS = 4000

/**
 * Processes Steam started a game in. Linux: from /proc/<pid>/environ (readable for our own processes).
 * Windows: Steam records the running game in the registry.
 */
async function steamProcesses(): Promise<SteamProcess[]> {
  if (process.platform === 'win32') {
    const appId = await steamRegistry('RunningAppID')
    return typeof appId === 'number' && appId > 0 ? [{ pid: 0, appId }] : []
  }
  if (process.platform !== 'linux') return []
  const found: SteamProcess[] = []
  const pids = (await readdir('/proc').catch(() => [] as string[])).filter((p) => /^\d+$/.test(p))
  await Promise.all(
    pids.map(async (pid) => {
      const environ = await readFile(`/proc/${pid}/environ`, 'latin1').catch(() => null)
      const appId = environ ? steamAppIdFromEnviron(environ) : null
      if (appId) found.push({ pid: Number(pid), appId })
    })
  )
  return found.sort((a, b) => a.pid - b.pid)
}

/** The focused window, where the desktop lets us ask (Hyprland for now). */
async function focusedWindow(): Promise<WindowInfo | null> {
  if (!process.env['HYPRLAND_INSTANCE_SIGNATURE']) return null
  try {
    const { stdout } = await exec('hyprctl', ['activewindow', '-j'], { timeout: 2000 })
    const w = JSON.parse(stdout) as {
      pid?: number
      class?: string
      initialClass?: string
      title?: string
      fullscreen?: number | boolean
    }
    if (!w.pid) return null
    return {
      pid: w.pid,
      className: w.class || w.initialClass || '',
      title: w.title ?? '',
      fullscreen: Boolean(w.fullscreen)
    }
  } catch {
    return null
  }
}

/** Steam's own launcher processes (reaper, pressure-vessel) also carry the app id; any match in the window's process counts. */
async function appIdOf(pid: number, steam: SteamProcess[]): Promise<number | null> {
  const direct = steam.find((p) => p.pid === pid)
  if (direct) return direct.appId
  const environ = await readFile(`/proc/${pid}/environ`, 'latin1').catch(() => null)
  return environ ? steamAppIdFromEnviron(environ) : null
}

export class GameDetector {
  private current: DetectedGame | null = null
  private timer: NodeJS.Timeout | null = null
  private readonly listeners = new Set<(game: DetectedGame | null) => void>()

  constructor(private readonly rules: () => GameRule[]) {}

  start(): void {
    if (this.timer) return
    const tick = (): void => void this.detect().catch((e) => console.warn('[games]', e))
    tick()
    this.timer = setInterval(tick, POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  get game(): DetectedGame | null {
    return this.current
  }

  onChange(listener: (game: DetectedGame | null) => void): void {
    this.listeners.add(listener)
  }

  /** Looks right now (used when saving a clip, so a game started a second ago is still tagged). */
  async detect(): Promise<DetectedGame | null> {
    const [steam, focused] = await Promise.all([steamProcesses(), focusedWindow()])
    const focusedAppId = focused ? await appIdOf(focused.pid, steam) : null
    const names = steam.length || focusedAppId ? await steamNames() : new Map<number, string>()
    const match = resolveGame({
      focused,
      focusedAppId,
      steam,
      rules: this.rules(),
      steamName: (id) => names.get(id) ?? null
    })
    let game: DetectedGame | null = null
    if (match) {
      const art = match.appId ? await steamApp(match.appId) : null
      game = {
        id: match.id,
        name: art?.name ?? match.name,
        source: match.source,
        iconPath: art?.iconPath ?? null,
        heroPath: art?.heroPath ?? null
      }
    }
    if (game?.id !== this.current?.id) {
      this.current = game
      for (const listener of this.listeners) listener(game)
    }
    return game
  }
}
