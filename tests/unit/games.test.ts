import { describe, expect, it } from 'vitest'
import { parseVdf, vdfString, vdfGet } from '@core/games/vdf'
import { prettifyClass, resolveGame, steamAppIdFromEnviron, type WindowInfo } from '@core/games/match'

describe('parseVdf', () => {
  it('parses an appmanifest', () => {
    const acf = `"AppState"
{
	"appid"		"730"
	"name"		"Counter-Strike 2"
	"installdir"		"Counter-Strike Global Offensive"
	"UserConfig"
	{
		"language"		"english"
	}
}`
    const data = parseVdf(acf)
    expect(vdfString(data, 'AppState', 'name')).toBe('Counter-Strike 2')
    expect(vdfString(data, 'appstate', 'APPID')).toBe('730')
    expect(vdfString(data, 'AppState', 'UserConfig', 'language')).toBe('english')
  })

  it('handles escapes, comments and libraryfolders', () => {
    const vdf = `// comment
"libraryfolders" { "0" { "path" "C:\\\\Games\\\\Steam" "apps" { "730" "123" } } "1" { "path" "/mnt/games" } }`
    const data = parseVdf(vdf)
    expect(vdfString(data, 'libraryfolders', '0', 'path')).toBe('C:\\Games\\Steam')
    expect(vdfString(data, 'libraryfolders', '1', 'path')).toBe('/mnt/games')
    expect(Object.keys(vdfGet(data, 'libraryfolders', '0', 'apps') as object)).toEqual(['730'])
  })
})

describe('steamAppIdFromEnviron', () => {
  const env = (vars: Record<string, string>): string =>
    Object.entries(vars)
      .map(([k, v]) => `${k}=${v}`)
      .join('\0')

  it('reads the app id Steam launches games with', () => {
    expect(steamAppIdFromEnviron(env({ HOME: '/home/x', SteamAppId: '730' }))).toBe(730)
    expect(steamAppIdFromEnviron(env({ STEAM_COMPAT_APP_ID: '1245620' }))).toBe(1245620)
  })

  it('ignores the Steam client and non-Steam shortcuts', () => {
    expect(steamAppIdFromEnviron(env({ SteamAppId: '0' }))).toBeNull()
    expect(steamAppIdFromEnviron(env({ SteamGameId: '15390525364736065536' }))).toBeNull()
    expect(steamAppIdFromEnviron(env({ PATH: '/usr/bin' }))).toBeNull()
  })
})

describe('resolveGame', () => {
  const win = (className: string, fullscreen = true, title = ''): WindowInfo => ({
    pid: 10,
    className,
    title,
    fullscreen
  })
  const base = { focused: null, focusedAppId: null, steam: [], rules: [], steamName: () => null }
  const names: Record<number, string> = { 730: 'Counter-Strike 2', 570: 'Dota 2' }
  const steamName = (id: number): string | null => names[id] ?? null

  it('prefers the focused Steam game over other running ones', () => {
    const game = resolveGame({
      ...base,
      steamName,
      focused: win('cs2'),
      focusedAppId: 730,
      steam: [
        { pid: 1, appId: 570 },
        { pid: 10, appId: 730 }
      ]
    })
    expect(game).toMatchObject({ id: 'steam:730', name: 'Counter-Strike 2', source: 'steam' })
  })

  it('tags a Steam game running in the background', () => {
    const game = resolveGame({ ...base, steamName, focused: win('firefox'), steam: [{ pid: 1, appId: 570 }] })
    expect(game?.name).toBe('Dota 2')
  })

  it('uses fullscreen windows that are not browsers or players', () => {
    expect(resolveGame({ ...base, focused: win('firefox') })).toBeNull()
    expect(resolveGame({ ...base, focused: win('mpv') })).toBeNull()
    expect(resolveGame({ ...base, focused: win('hollow_knight.x86_64', false) })).toBeNull()
    expect(resolveGame({ ...base, focused: win('hollow_knight.x86_64') })).toMatchObject({
      id: 'app:hollow_knight.x86_64',
      name: 'Hollow Knight'
    })
  })

  it('uses the title for generic classes like Java', () => {
    expect(resolveGame({ ...base, focused: win('java', true, 'Minecraft 1.21') })?.name).toBe(
      'Minecraft 1.21'
    )
  })

  it('applies user rules: rename (even windowed) and ignore', () => {
    const rules = [
      { match: 'RetroArch', name: 'Retro Games' },
      { match: 'blender', name: null }
    ]
    expect(resolveGame({ ...base, rules, focused: win('retroarch', false) })?.name).toBe('Retro Games')
    expect(resolveGame({ ...base, rules, focused: win('blender') })).toBeNull()
  })

  it('prettifies window classes', () => {
    expect(prettifyClass('org.prismlauncher.PrismLauncher')).toBe('PrismLauncher')
    expect(prettifyClass('celeste.bin')).toBe('Celeste')
    expect(prettifyClass('dead-cells')).toBe('Dead Cells')
  })
})
