import type { Clip } from '@shared/ipc'
import { DESKTOP_FOLDER } from './naming'

export const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.mov']

export interface FileEntry {
  path: string
  size: number
  mtimeMs: number
}

/**
 * Brings the index in line with what is on disk: clips whose file is gone are dropped, files nobody
 * indexed (copied in by hand, or saved while Podium's index was lost) are returned for adoption.
 */
export function reconcile(
  clips: Clip[],
  files: FileEntry[]
): { kept: Clip[]; removed: Clip[]; added: FileEntry[] } {
  const onDisk = new Map(files.map((f) => [f.path, f]))
  const kept: Clip[] = []
  const removed: Clip[] = []
  for (const clip of clips) {
    const file = onDisk.get(clip.path)
    if (file) kept.push(file.size === clip.size ? clip : { ...clip, size: file.size })
    else removed.push(clip)
  }
  const known = new Set(clips.map((c) => c.path))
  return { kept, removed, added: files.filter((f) => !known.has(f.path)) }
}

/**
 * Clips live in `<root>/<Game>/…`; for adopted files the folder is the best guess at the game.
 * Files directly in the root, or in the Desktop folder, have no game.
 */
export function gameFromPath(root: string, path: string, sep = '/'): string | null {
  const normalRoot = root.endsWith(sep) ? root : root + sep
  if (!path.startsWith(normalRoot)) return null
  const parts = path.slice(normalRoot.length).split(sep)
  if (parts.length < 2) return null
  const folder = parts[0]!
  return folder === DESKTOP_FOLDER ? null : folder
}

export const gameIdForName = (name: string): string => `name:${name.trim().toLowerCase()}`

export type ClipSort = 'newest' | 'oldest' | 'longest' | 'largest' | 'name'

export interface ClipFilter {
  /** A game id, `desktop` for clips without a game, or null for everything. */
  gameId: string | null
  query: string
  favorites: boolean
  bookmarks: boolean
}

export function filterClips<T extends Clip>(clips: T[], filter: ClipFilter): T[] {
  const words = filter.query.toLowerCase().split(/\s+/).filter(Boolean)
  return clips.filter((clip) => {
    if (filter.gameId === 'desktop' ? clip.gameId !== null : filter.gameId && clip.gameId !== filter.gameId)
      return false
    if (filter.favorites && !clip.favorite) return false
    if (filter.bookmarks && !clip.bookmark) return false
    const haystack = `${clip.title} ${clip.gameName ?? ''}`.toLowerCase()
    return words.every((w) => haystack.includes(w))
  })
}

export function sortClips<T extends Clip>(clips: T[], sort: ClipSort): T[] {
  const sorted = [...clips]
  const by: Record<ClipSort, (a: T, b: T) => number> = {
    newest: (a, b) => b.createdAt - a.createdAt,
    oldest: (a, b) => a.createdAt - b.createdAt,
    longest: (a, b) => b.duration - a.duration,
    largest: (a, b) => b.size - a.size,
    name: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true })
  }
  return sorted.sort(by[sort])
}

export interface GameGroup {
  id: string
  name: string
  clipCount: number
  /** Most recent clip, used to order the sidebar. */
  lastClipAt: number
}

/** Games in the sidebar, most recently clipped first. */
export function groupGames(clips: Clip[]): GameGroup[] {
  const groups = new Map<string, GameGroup>()
  for (const clip of clips) {
    if (!clip.gameId) continue
    const group = groups.get(clip.gameId)
    if (group) {
      group.clipCount++
      group.lastClipAt = Math.max(group.lastClipAt, clip.createdAt)
    } else {
      groups.set(clip.gameId, {
        id: clip.gameId,
        name: clip.gameName ?? clip.gameId,
        clipCount: 1,
        lastClipAt: clip.createdAt
      })
    }
  }
  return [...groups.values()].sort((a, b) => b.lastClipAt - a.lastClipAt)
}

/** gsr names audio tracks after the device; show something a person would call them. */
export function trackLabels(titles: Array<string | undefined>): string[] {
  return titles.map((title, i) => {
    const t = (title ?? '').toLowerCase()
    if (/mic|input|headset mic|webcam/.test(t) && !/monitor/.test(t)) return 'Microphone'
    if (/output|monitor|speaker|desktop/.test(t)) return 'Desktop'
    if (titles.length === 2) return i === 0 ? 'Desktop' : 'Microphone'
    return titles.length === 1 ? 'Audio' : `Track ${i + 1}`
  })
}
