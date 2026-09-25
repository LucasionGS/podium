const pad = (n: number): string => String(n).padStart(2, '0')

/** Characters Windows, macOS or Linux reject in file names, plus control characters. */
const UNSAFE = /[<>:"/\\|?*\u0000-\u001f]/g

export function sanitizeFileName(name: string, fallback = 'Clip'): string {
  const clean = name
    .replace(UNSAFE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|[. ]+$/g, '')
    .slice(0, 100)
    .trim()
  // Windows reserves these names regardless of extension.
  if (!clean || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean)) return fallback
  return clean
}

export const DESKTOP_FOLDER = 'Desktop'

/** `Counter-Strike 2 2026-09-25 21-04-11`: sorts by date within a game folder, safe on every OS. */
export function clipBaseName(gameName: string | null, date: Date): string {
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  return `${sanitizeFileName(gameName ?? DESKTOP_FOLDER)} ${stamp}`
}

/** `name.mp4` → `name (2).mp4` for n = 2. */
export function withSuffix(fileName: string, n: number): string {
  if (n <= 1) return fileName
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? `${fileName.slice(0, dot)} (${n})${fileName.slice(dot)}` : `${fileName} (${n})`
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

/** A length people say out loud: `30 s`, `2 min`, `1 min 30 s`. */
export function formatLength(seconds: number): string {
  const s = Math.round(seconds)
  if (s < 60) return `${s} s`
  return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}
