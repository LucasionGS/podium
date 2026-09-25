export { formatBytes, formatDuration, formatLength } from '@core/library/naming'

const DAY = 86_400_000

const startOfDay = (t: number): number => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Section heading for a clip date: Today, Yesterday, This week, or the month. */
export function dateGroup(time: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(time)) / DAY)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return 'This week'
  const date = new Date(time)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(undefined, { month: 'long', ...(sameYear ? {} : { year: 'numeric' }) })
}

export function formatRelative(time: number, now = Date.now()): string {
  const seconds = Math.round((now - time) / 1000)
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const date = new Date(time)
  return (
    date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) +
    ` ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
  )
}

/** `1:05.3` with tenths, for trim points. */
export function formatPrecise(seconds: number): string {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`
}

export const codecLabel = (codec: string): string =>
  ({ h264: 'H.264', hevc: 'HEVC', av1: 'AV1' })[codec] ?? codec.toUpperCase()
