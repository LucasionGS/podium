import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type BufferStorage,
  type ClipAction,
  type GameRule,
  type Hotkey,
  type UploadSettings,
  type UploadTarget,
  type VideoCodec
} from '@shared/ipc'
import { normalizeServerUrl } from './upload/protocol'

type Raw = Record<string, unknown>

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
const str = (v: unknown, fallback: string | null): string | null =>
  typeof v === 'string' && v.trim() ? v : v === null ? null : fallback
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  options.includes(v as T) ? (v as T) : fallback

function action(v: unknown): ClipAction | null {
  if (!isObject(v)) return null
  if (v['kind'] === 'bookmark') return { kind: 'bookmark' }
  if (v['kind'] === 'clip') return { kind: 'clip', seconds: num(v['seconds'], 30, 1, 1800) }
  return null
}

function hotkeys(v: unknown): Hotkey[] {
  if (!Array.isArray(v)) return DEFAULT_SETTINGS.hotkeys
  const valid = v.flatMap((h): Hotkey[] => {
    const a = isObject(h) ? action(h['action']) : null
    if (!isObject(h) || typeof h['id'] !== 'string' || !a) return []
    return [{ id: h['id'], accelerator: str(h['accelerator'], null), action: a }]
  })
  return valid.length ? valid : DEFAULT_SETTINGS.hotkeys
}

function gameRules(v: unknown): GameRule[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((r): GameRule[] =>
    isObject(r) && typeof r['match'] === 'string' ? [{ match: r['match'], name: str(r['name'], null) }] : []
  )
}

function uploadTargets(v: unknown): UploadTarget[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  return v.flatMap((t): UploadTarget[] => {
    if (!isObject(t) || typeof t['id'] !== 'string' || !t['id'] || seen.has(t['id'])) return []
    if (t['protocol'] !== 'podium' || typeof t['url'] !== 'string') return []
    let url: string
    try {
      url = normalizeServerUrl(t['url'])
    } catch {
      return []
    }
    seen.add(t['id'])
    const name = typeof t['name'] === 'string' && t['name'].trim() ? t['name'].trim() : new URL(url).host
    return [{ id: t['id'], name, protocol: 'podium', url }]
  })
}

function upload(v: unknown): UploadSettings {
  const d = DEFAULT_SETTINGS.upload
  const u = isObject(v) ? v : {}
  const targets = uploadTargets(u['targets'])
  const defaultTarget = str(u['defaultTarget'], null)
  return {
    targets,
    defaultTarget: targets.some((t) => t.id === defaultTarget) ? defaultTarget : null,
    // Without somewhere to upload to there's nothing to do automatically.
    auto: targets.length > 0 && bool(u['auto'], d.auto),
    copyLink: bool(u['copyLink'], d.copyLink)
  }
}

/**
 * Settings as stored on disk may come from an older version, another build, or a hand edit.
 * Every field is checked on its own; anything missing or malformed falls back to its default.
 */
export function normalizeSettings(raw: unknown): AppSettings {
  const d = DEFAULT_SETTINGS
  const s = isObject(raw) ? raw : {}
  const capture = isObject(s['capture']) ? s['capture'] : {}
  const audio = isObject(s['audio']) ? s['audio'] : {}
  const notifications = isObject(s['notifications']) ? s['notifications'] : {}
  const startup = isObject(s['startup']) ? s['startup'] : {}
  return {
    ffmpegDir: str(s['ffmpegDir'], d.ffmpegDir),
    libraryDir: str(s['libraryDir'], d.libraryDir),
    capture: {
      monitor: str(capture['monitor'], d.capture.monitor),
      fps: num(capture['fps'], d.capture.fps, 10, 500),
      codec: oneOf<VideoCodec>(capture['codec'], ['h264', 'hevc', 'av1'], d.capture.codec),
      bitrateKbps: num(capture['bitrateKbps'], d.capture.bitrateKbps, 1000, 500_000),
      bufferSeconds: num(capture['bufferSeconds'], d.capture.bufferSeconds, 5, 1800),
      storage: oneOf<BufferStorage>(capture['storage'], ['ram', 'disk'], d.capture.storage),
      cursor: bool(capture['cursor'], d.capture.cursor)
    },
    audio: {
      desktop: 'desktop' in audio ? str(audio['desktop'], d.audio.desktop) : d.audio.desktop,
      mic: 'mic' in audio ? str(audio['mic'], d.audio.mic) : d.audio.mic
    },
    hotkeys: hotkeys(s['hotkeys']),
    gameRules: gameRules(s['gameRules']),
    notifications: {
      sound: bool(notifications['sound'], d.notifications.sound),
      soundVolume: num(notifications['soundVolume'], d.notifications.soundVolume, 0, 1),
      system: bool(notifications['system'], d.notifications.system)
    },
    startup: {
      autostart: bool(startup['autostart'], d.startup.autostart),
      startHidden: bool(startup['startHidden'], d.startup.startHidden)
    },
    closeToTray: bool(s['closeToTray'], d.closeToTray),
    bufferOnLaunch: bool(s['bufferOnLaunch'], d.bufferOnLaunch),
    upload: upload(s['upload']),
    updates: { check: bool(isObject(s['updates']) ? s['updates']['check'] : undefined, d.updates.check) }
  }
}
