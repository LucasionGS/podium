import type { GameRule } from '@shared/ipc'

export interface WindowInfo {
  pid: number
  className: string
  title: string
  fullscreen: boolean
}

export interface SteamProcess {
  pid: number
  appId: number
}

export interface GameMatch {
  id: string
  name: string
  source: 'steam' | 'window'
  appId: number | null
}

/**
 * Steam starts every game (native or Proton) with its app id in the environment. The Steam client,
 * its web helper and runtime tools either lack these variables or carry app id 0.
 */
export function steamAppIdFromEnviron(environ: string): number | null {
  const vars = new Map<string, string>()
  for (const entry of environ.split('\0')) {
    const eq = entry.indexOf('=')
    if (eq > 0) vars.set(entry.slice(0, eq), entry.slice(eq + 1))
  }
  for (const key of ['SteamAppId', 'STEAM_COMPAT_APP_ID', 'SteamGameId']) {
    const id = Number(vars.get(key))
    // Non-Steam shortcuts get 64-bit "game ids"; those aren't store apps with a name to look up.
    if (Number.isInteger(id) && id > 0 && id < 2 ** 32) return id
  }
  return null
}

/** Fullscreen windows that are almost never games: browsers, video players, chat, terminals. */
const NOT_GAMES = [
  'firefox',
  'librewolf',
  'zen',
  'chromium',
  'google-chrome',
  'brave-browser',
  'vivaldi',
  'microsoft-edge',
  'mpv',
  'vlc',
  'celluloid',
  'haruna',
  'totem',
  'io.github.celluloid_player',
  'obs',
  'com.obsproject.studio',
  'discord',
  'vesktop',
  'code',
  'kitty',
  'alacritty',
  'foot',
  'wezterm',
  'podium',
  'edion',
  'steam',
  'steamwebhelper'
]

const normalise = (s: string): string => s.trim().toLowerCase()

export function findRule(rules: GameRule[], className: string): GameRule | undefined {
  const cls = normalise(className)
  return rules.find((r) => normalise(r.match) === cls)
}

/** `org.prismlauncher.PrismLauncher` → `PrismLauncher`, `hollow_knight.x86_64` → `Hollow Knight`. */
export function prettifyClass(className: string): string {
  let name = className.replace(/\.(x86_64|x86|exe|bin|sh|AppImage)$/i, '')
  if (/^[a-z]+(\.[a-z0-9_-]+){2,}$/i.test(name)) name = name.split('.').pop()!
  name = name.replace(/[_-]+/g, ' ').trim()
  return name.replace(/\b[a-z]/g, (c) => c.toUpperCase()) || className
}

/** Generic window classes that say nothing about the game (Java, Wine…); the title is better there. */
const GENERIC_CLASSES = /^(java|wine|explorer\.exe|steam_proton|gamescope|sdl_app|unity|godot|love)$/i

/**
 * Which game a clip saved right now belongs to. In order:
 * 1. a user rule naming the focused window, 2. the focused window's Steam app,
 * 3. any running Steam game, 4. a fullscreen window that isn't a browser, player, chat…
 */
export function resolveGame(input: {
  focused: WindowInfo | null
  focusedAppId: number | null
  steam: SteamProcess[]
  rules: GameRule[]
  steamName: (appId: number) => string | null
}): GameMatch | null {
  const { focused, focusedAppId, steam, rules, steamName } = input
  const rule = focused ? findRule(rules, focused.className) : undefined
  if (focused && rule?.name) return windowGame(focused.className, rule.name)

  const fromSteam = (appId: number): GameMatch => ({
    id: `steam:${appId}`,
    name: steamName(appId) ?? `Steam app ${appId}`,
    source: 'steam',
    appId
  })
  if (focusedAppId) return fromSteam(focusedAppId)
  const running = steam[0]
  if (running) return fromSteam(running.appId)

  if (!focused || rule || !focused.fullscreen) return null
  const cls = normalise(focused.className)
  if (!cls || NOT_GAMES.some((n) => cls === n || cls.endsWith(`.${n}`))) return null
  const name =
    GENERIC_CLASSES.test(cls) && focused.title.trim()
      ? focused.title.trim()
      : prettifyClass(focused.className)
  return windowGame(focused.className, name)
}

const windowGame = (className: string, name: string): GameMatch => ({
  id: `app:${normalise(className)}`,
  name,
  source: 'window',
  appId: null
})
