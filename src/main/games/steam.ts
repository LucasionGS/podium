import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parseRegValue } from '@core/capture/windows'
import { parseVdf, vdfGet, vdfString } from '@core/games/vdf'

const exec = promisify(execFile)

/** A value under Steam's registry key (Windows), e.g. `SteamPath` or `RunningAppID`. */
export async function steamRegistry(name: string): Promise<string | number | null> {
  if (process.platform !== 'win32') return null
  try {
    const { stdout } = await exec('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', name], {
      timeout: 3000,
      windowsHide: true
    })
    return parseRegValue(stdout, name)
  } catch {
    return null
  }
}

/** Where Steam keeps its data on each platform (native and Flatpak installs on Linux). */
async function steamRoots(): Promise<string[]> {
  const home = homedir()
  const registered = await steamRegistry('SteamPath')
  const candidates =
    process.platform === 'win32'
      ? [
          ...(typeof registered === 'string' ? [registered] : []),
          join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Steam')
        ]
      : process.platform === 'darwin'
        ? [join(home, 'Library/Application Support/Steam')]
        : [
            join(home, '.local/share/Steam'),
            join(home, '.steam/steam'),
            join(home, '.var/app/com.valvesoftware.Steam/.local/share/Steam')
          ]
  return [...new Set(candidates)].filter((dir) => existsSync(join(dir, 'steamapps')))
}

export interface SteamApp {
  name: string
  iconPath: string | null
  heroPath: string | null
}

let names: Map<number, string> | null = null
let loadedAt = 0

async function loadNames(): Promise<Map<number, string>> {
  const found = new Map<number, string>()
  for (const root of await steamRoots()) {
    const libraries = new Set([join(root, 'steamapps')])
    try {
      const folders = parseVdf(await readFile(join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8'))
      const entries = vdfGet(folders, 'libraryfolders')
      if (entries && typeof entries !== 'string') {
        for (const entry of Object.values(entries)) {
          const path = vdfString(entry, 'path')
          if (path) libraries.add(join(path, 'steamapps'))
        }
      }
    } catch {
      // No libraryfolders.vdf: only the default library.
    }
    for (const dir of libraries) {
      const files = await readdir(dir).catch(() => [] as string[])
      await Promise.all(
        files
          .filter((f) => /^appmanifest_\d+\.acf$/.test(f))
          .map(async (f) => {
            const manifest = parseVdf(await readFile(join(dir, f), 'utf8').catch(() => ''))
            const id = Number(vdfString(manifest, 'AppState', 'appid'))
            const name = vdfString(manifest, 'AppState', 'name')
            if (id && name) found.set(id, name)
          })
      )
    }
  }
  return found
}

/** Installed Steam games by app id. Re-read at most once a minute, so newly installed games show up. */
export async function steamNames(): Promise<Map<number, string>> {
  if (!names || Date.now() - loadedAt > 60_000) {
    names = await loadNames()
    loadedAt = Date.now()
  }
  return names
}

/** Artwork from Steam's library cache: the small icon (a hash-named jpg) and the wide hero banner. */
async function art(appId: number): Promise<Pick<SteamApp, 'iconPath' | 'heroPath'>> {
  for (const root of await steamRoots()) {
    const dir = join(root, 'appcache', 'librarycache', String(appId))
    const files = await readdir(dir).catch(() => null)
    if (files) {
      const icon = files.find((f) => /^[0-9a-f]{40}\.jpg$/.test(f))
      const hero = files.find((f) => f === 'library_hero.jpg') ?? files.find((f) => f === 'header.jpg')
      return { iconPath: icon ? join(dir, icon) : null, heroPath: hero ? join(dir, hero) : null }
    }
    // Older Steam clients kept everything in one flat folder.
    const flat = join(root, 'appcache', 'librarycache')
    const icon = join(flat, `${appId}_icon.jpg`)
    const hero = join(flat, `${appId}_library_hero.jpg`)
    if (existsSync(icon) || existsSync(hero)) {
      return { iconPath: existsSync(icon) ? icon : null, heroPath: existsSync(hero) ? hero : null }
    }
  }
  return { iconPath: null, heroPath: null }
}

export async function steamApp(appId: number): Promise<SteamApp | null> {
  let name = (await steamNames()).get(appId)
  if (!name) {
    // Installed just now: skip the cache once.
    loadedAt = 0
    name = (await steamNames()).get(appId)
  }
  return name ? { name, ...(await art(appId)) } : null
}
