import { describe, expect, it } from 'vitest'
import type { Clip } from '@shared/ipc'
import {
  filterClips,
  gameFromPath,
  groupGames,
  reconcile,
  sortClips,
  trackLabels,
  type ClipFilter
} from '@core/library/library'
import {
  clipBaseName,
  formatBytes,
  formatDuration,
  formatLength,
  sanitizeFileName,
  withSuffix
} from '@core/library/naming'

const clip = (over: Partial<Clip>): Clip => ({
  id: 'x',
  path: '/lib/x.mp4',
  title: 'x',
  gameId: null,
  gameName: null,
  createdAt: 0,
  duration: 30,
  width: 1920,
  height: 1080,
  fps: 60,
  size: 100,
  audioTracks: [],
  bookmark: false,
  favorite: false,
  ...over
})

describe('naming', () => {
  it('sanitizes names for every OS', () => {
    expect(sanitizeFileName('Half-Life: Alyx / VR?')).toBe('Half-Life Alyx VR')
    expect(sanitizeFileName('  ...  ')).toBe('Clip')
    expect(sanitizeFileName('CON')).toBe('Clip')
    expect(sanitizeFileName('trailing dot.')).toBe('trailing dot')
  })

  it('names clips by game and local time', () => {
    const date = new Date(2026, 8, 25, 21, 4, 9)
    expect(clipBaseName('Counter-Strike 2', date)).toBe('Counter-Strike 2 2026-09-25 21-04-09')
    expect(clipBaseName(null, date)).toBe('Desktop 2026-09-25 21-04-09')
  })

  it('adds a counter before the extension', () => {
    expect(withSuffix('a.mp4', 1)).toBe('a.mp4')
    expect(withSuffix('a.mp4', 3)).toBe('a (3).mp4')
  })

  it('formats durations and sizes', () => {
    expect(formatDuration(5)).toBe('0:05')
    expect(formatDuration(125.4)).toBe('2:05')
    expect(formatDuration(3725)).toBe('1:02:05')
    expect(formatLength(30)).toBe('30 s')
    expect(formatLength(120)).toBe('2 min')
    expect(formatLength(90)).toBe('1 min 30 s')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(9.5 * 1024 * 1024)).toBe('9.5 MB')
  })
})

describe('library', () => {
  it('reconciles the index with the disk', () => {
    const a = clip({ id: 'a', path: '/lib/a.mp4' })
    const b = clip({ id: 'b', path: '/lib/b.mp4' })
    const result = reconcile(
      [a, b],
      [
        { path: '/lib/a.mp4', size: 200, mtimeMs: 1 },
        { path: '/lib/new.mp4', size: 5, mtimeMs: 2 }
      ]
    )
    expect(result.kept).toEqual([{ ...a, size: 200 }])
    expect(result.removed).toEqual([b])
    expect(result.added.map((f) => f.path)).toEqual(['/lib/new.mp4'])
  })

  it('guesses the game from the folder', () => {
    expect(gameFromPath('/lib', '/lib/Dota 2/clip.mp4')).toBe('Dota 2')
    expect(gameFromPath('/lib/', '/lib/Desktop/clip.mp4')).toBeNull()
    expect(gameFromPath('/lib', '/lib/clip.mp4')).toBeNull()
    expect(gameFromPath('/lib', '/elsewhere/Dota 2/clip.mp4')).toBeNull()
  })

  it('filters by game, desktop, flags and search words', () => {
    const clips = [
      clip({
        id: '1',
        title: 'Ace clutch',
        gameId: 'steam:730',
        gameName: 'Counter-Strike 2',
        favorite: true
      }),
      clip({ id: '2', title: 'Funny bug', gameId: null }),
      clip({ id: '3', title: 'Rampage', gameId: 'steam:570', gameName: 'Dota 2', bookmark: true })
    ]
    const none: ClipFilter = { gameId: null, query: '', favorites: false, bookmarks: false }
    const ids = (f: Partial<typeof none>): string[] => filterClips(clips, { ...none, ...f }).map((c) => c.id)
    expect(ids({})).toEqual(['1', '2', '3'])
    expect(ids({ gameId: 'steam:730' })).toEqual(['1'])
    expect(ids({ gameId: 'desktop' })).toEqual(['2'])
    expect(ids({ favorites: true })).toEqual(['1'])
    expect(ids({ bookmarks: true })).toEqual(['3'])
    expect(ids({ query: 'counter ace' })).toEqual(['1'])
    expect(ids({ query: 'dota' })).toEqual(['3'])
  })

  it('sorts without mutating', () => {
    const clips = [clip({ id: 'a', createdAt: 1, size: 9 }), clip({ id: 'b', createdAt: 2, size: 1 })]
    expect(sortClips(clips, 'newest').map((c) => c.id)).toEqual(['b', 'a'])
    expect(sortClips(clips, 'largest').map((c) => c.id)).toEqual(['a', 'b'])
    expect(clips[0]!.id).toBe('a')
  })

  it('groups games by most recent clip', () => {
    const groups = groupGames([
      clip({ gameId: 'g1', gameName: 'One', createdAt: 5 }),
      clip({ gameId: 'g2', gameName: 'Two', createdAt: 9 }),
      clip({ gameId: 'g1', gameName: 'One', createdAt: 1 }),
      clip({ gameId: null })
    ])
    expect(groups.map((g) => [g.name, g.clipCount])).toEqual([
      ['Two', 1],
      ['One', 2]
    ])
  })

  it('labels audio tracks', () => {
    expect(trackLabels(['default_output', 'default_input'])).toEqual(['Desktop', 'Microphone'])
    expect(trackLabels([undefined, undefined])).toEqual(['Desktop', 'Microphone'])
    expect(trackLabels([undefined])).toEqual(['Audio'])
  })
})
