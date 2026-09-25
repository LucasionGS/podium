import { randomUUID, createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { app, BrowserWindow, ipcMain, nativeImage, protocol, shell } from 'electron'
import {
  FILE_PROTOCOL,
  LIBRARY_IPC,
  type Clip,
  type ClipView,
  type DetectedGame,
  type Filmstrip,
  type GameSummary
} from '@shared/ipc'
import {
  gameFromPath,
  gameIdForName,
  groupGames,
  reconcile,
  trackLabels,
  VIDEO_EXTENSIONS,
  type FileEntry
} from '@core/library/library'
import { clipBaseName, DESKTOP_FOLDER, sanitizeFileName, withSuffix } from '@core/library/naming'
import { backgroundJobs, runFfmpeg } from './ffmpeg/jobs'
import { probe } from './ffmpeg/probe'
import { cacheRoot, libraryDir } from './paths'
import { writeFileAtomic } from './settings'

const TILE_HEIGHT = 72
const MAX_TILES = 60
const THUMB_WIDTH = 480

interface GameInfo {
  name: string
  iconPath: string | null
  heroPath: string | null
}

interface IndexFile {
  version: 1
  clips: Clip[]
  games: Record<string, GameInfo>
}

let index: IndexFile | null = null
let lastReconcile = 0
const indexPath = (): string => join(app.getPath('userData'), 'library.json')

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  )

async function loadIndex(): Promise<IndexFile> {
  if (index) return index
  try {
    const data = JSON.parse(await readFile(indexPath(), 'utf8')) as IndexFile
    index = { version: 1, clips: data.clips ?? [], games: data.games ?? {} }
  } catch {
    index = { version: 1, clips: [], games: {} }
  }
  return index
}

let saving: Promise<void> = Promise.resolve()
/** Serialised, so an older snapshot can never overwrite a newer one. */
function saveIndex(): Promise<void> {
  saving = saving
    .then(() => writeFileAtomic(indexPath(), JSON.stringify(index, null, 1)))
    .catch((e) => {
      console.error('[library] could not save the index', e)
    })
  return saving
}

// ---------------------------------------------------------------- URLs and the file protocol

const url = (kind: string, id: string, version?: string | number): string =>
  `${FILE_PROTOCOL}://${kind}/${encodeURIComponent(id)}${version === undefined ? '' : `?v=${version}`}`

export function toView(clip: Clip): ClipView {
  return { ...clip, url: url('clip', clip.id, clip.size), thumbnailUrl: url('thumb', clip.id, clip.size) }
}

export function registerFileProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: FILE_PROTOCOL,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
    }
  ])
}

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif'
}

/** Serves a file with HTTP Range support, which <video> needs to seek. */
async function serveFile(request: Request, path: string): Promise<Response> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return new Response('Not found', { status: 404 })
  const type = CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '')
  // The player routes audio through Web Audio, which needs CORS to read another origin's samples.
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*'
  }
  if (!range || (!range[1] && !range[2])) {
    const body = Readable.toWeb(createReadStream(path)) as ReadableStream
    return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(info.size) } })
  }
  let start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]))
  let end = range[1] && range[2] ? Number(range[2]) : info.size - 1
  end = Math.min(end, info.size - 1)
  start = Math.min(start, end)
  if (start >= info.size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } })
  }
  const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream
  return new Response(body, {
    status: 206,
    headers: {
      ...headers,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${info.size}`
    }
  })
}

/**
 * `podium-file://clip/<id>`, `thumb/<id>`, `game-icon/<id>`, `game-hero/<id>` and `cache/<path>`.
 * Only indexed clips, their games' art and our own cache can be read, never arbitrary paths.
 */
function registerFileProtocol(): void {
  protocol.handle(FILE_PROTOCOL, async (request) => {
    const { host, pathname } = new URL(request.url)
    const id = decodeURIComponent(pathname.slice(1))
    try {
      if (host === 'cache') {
        const path = resolve(cacheRoot(), id)
        if (!path.startsWith(cacheRoot() + sep)) return new Response('Forbidden', { status: 403 })
        return await serveFile(request, path)
      }
      const data = await loadIndex()
      if (host === 'game-icon' || host === 'game-hero') {
        const game = data.games[id]
        const path = host === 'game-icon' ? game?.iconPath : game?.heroPath
        return path ? await serveFile(request, path) : new Response('Not found', { status: 404 })
      }
      const clip = data.clips.find((c) => c.id === id)
      if (!clip) return new Response('Not found', { status: 404 })
      if (host === 'clip') return await serveFile(request, clip.path)
      if (host === 'thumb') {
        const thumb = await once(thumbJobs, clip.path, () => buildThumbnail(clip))
        return thumb ? await serveFile(request, thumb) : new Response('Not found', { status: 404 })
      }
    } catch (error) {
      console.warn('[protocol]', request.url, error)
      return new Response('Error', { status: 500 })
    }
    return new Response('Not found', { status: 404 })
  })
}

// ---------------------------------------------------------------- Derived files (thumbnails, filmstrips, tracks)

/** Cache entries are keyed by path + size + mtime, so replaced or edited clips are regenerated automatically. */
async function cacheDirFor(path: string): Promise<string> {
  const info = await stat(path)
  const key = createHash('sha1').update(`${path}:${info.size}:${info.mtimeMs}`).digest('hex').slice(0, 20)
  const dir = join(cacheRoot(), key)
  await mkdir(dir, { recursive: true })
  return dir
}

/** De-duplicates concurrent requests for the same file and forgets failures so they can be retried. */
function once<T>(
  jobs: Map<string, Promise<T | null>>,
  key: string,
  build: () => Promise<T | null>
): Promise<T | null> {
  let job = jobs.get(key)
  if (!job) {
    job = build().catch((error) => {
      console.warn(`[library] ${basename(key)}:`, error)
      jobs.delete(key)
      return null
    })
    jobs.set(key, job)
    // Keyed by path, but the file behind it can change (trims replace clips in place).
    void job.then(() => setTimeout(() => jobs.delete(key), 30_000))
  }
  return job
}

const thumbJobs = new Map<string, Promise<string | null>>()
const filmstripJobs = new Map<string, Promise<Filmstrip | null>>()
const trackJobs = new Map<string, Promise<string[] | null>>()

/** A frame from late in the clip: replays end right after the moment worth saving. */
async function buildThumbnail(clip: Clip): Promise<string | null> {
  const output = join(await cacheDirFor(clip.path), 'thumb.jpg')
  if (await exists(output)) return output
  const at = Math.max(0, clip.duration * 0.7)
  await backgroundJobs.run(() =>
    runFfmpeg({
      args: [
        '-y',
        '-ss',
        at.toFixed(2),
        '-i',
        clip.path,
        '-frames:v',
        '1',
        '-vf',
        `scale=${THUMB_WIDTH}:-2`,
        '-q:v',
        '4',
        output
      ]
    })
  )
  return output
}

async function buildFilmstrip(clip: Clip): Promise<Filmstrip | null> {
  if (!clip.width || !clip.height || clip.duration <= 0) return null
  const dir = await cacheDirFor(clip.path)
  const sprite = join(dir, 'filmstrip.jpg')
  const meta = join(dir, 'filmstrip.json')
  const cacheUrl = (): string => url('cache', relative(cacheRoot(), sprite))
  if ((await exists(sprite)) && (await exists(meta))) {
    return { ...(JSON.parse(await readFile(meta, 'utf8')) as Omit<Filmstrip, 'url'>), url: cacheUrl() }
  }
  const tileWidth = Math.max(2, Math.round((TILE_HEIGHT * clip.width) / clip.height / 2) * 2)
  const count = Math.max(1, Math.min(MAX_TILES, Math.ceil(clip.duration)))
  const interval = clip.duration / count
  await backgroundJobs.run(() =>
    runFfmpeg({
      args: [
        '-y',
        '-i',
        clip.path,
        '-an',
        '-vf',
        `fps=1/${interval.toFixed(4)},scale=${tileWidth}:${TILE_HEIGHT},tile=${count}x1`,
        '-frames:v',
        '1',
        '-q:v',
        '5',
        sprite
      ]
    })
  )
  const data = { count, interval, tileWidth, tileHeight: TILE_HEIGHT }
  await writeFileAtomic(meta, JSON.stringify(data))
  return { ...data, url: cacheUrl() }
}

/** Each audio track as its own file (stream copy, so it's instant) for per-track volume in the player. */
async function buildAudioTracks(clip: Clip): Promise<string[] | null> {
  if (!clip.audioTracks.length) return []
  const dir = await cacheDirFor(clip.path)
  const files = clip.audioTracks.map((_, i) => join(dir, `track-${i}.m4a`))
  if (!(await Promise.all(files.map(exists))).every(Boolean)) {
    const args = ['-y', '-i', clip.path]
    files.forEach((file, i) => args.push('-map', `0:a:${i}`, '-c', 'copy', '-vn', file))
    await runFfmpeg({ args })
  }
  return files.map((file) => url('cache', relative(cacheRoot(), file)))
}

// ---------------------------------------------------------------- Library operations

async function scanFolder(root: string): Promise<FileEntry[]> {
  const found: FileEntry[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      // `.podium` holds the replay buffer and in-progress files.
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory() && depth < 3) await walk(full, depth + 1)
      else if (entry.isFile() && VIDEO_EXTENSIONS.includes(extname(entry.name).toLowerCase())) {
        const info = await stat(full).catch(() => null)
        if (info) found.push({ path: full, size: info.size, mtimeMs: info.mtimeMs })
      }
    }
  }
  await walk(root, 0)
  return found
}

async function describe(
  path: string,
  meta: {
    title?: string
    gameId: string | null
    gameName: string | null
    bookmark: boolean
    createdAt?: number
  }
): Promise<Clip> {
  const info = await probe(path)
  const video = info.streams.find((s) => s.kind === 'video')
  const audio = info.streams.filter((s) => s.kind === 'audio')
  const file = await stat(path)
  return {
    id: randomUUID(),
    path,
    title: meta.title ?? basename(path, extname(path)),
    gameId: meta.gameId,
    gameName: meta.gameName,
    createdAt: meta.createdAt ?? (file.birthtimeMs || file.mtimeMs),
    duration: info.duration,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: Math.round(video?.fps ?? 0),
    size: info.size,
    audioTracks: trackLabels(audio.map((a) => a.title)),
    bookmark: meta.bookmark,
    favorite: false
  }
}

/** Syncs the index with the folder: drops clips deleted outside Podium, adopts files added outside it. */
export async function reconcileLibrary(force = false): Promise<void> {
  if (!force && Date.now() - lastReconcile < 10_000) return
  lastReconcile = Date.now()
  const data = await loadIndex()
  const root = await libraryDir()
  await mkdir(root, { recursive: true })
  const { kept, removed, added } = reconcile(data.clips, await scanFolder(root))
  if (!removed.length && !added.length && kept.every((c, i) => c === data.clips[i])) return
  const adopted: Clip[] = []
  for (const file of added) {
    const gameName = gameFromPath(root, file.path, sep)
    const known = gameName ? Object.entries(data.games).find(([, g]) => g.name === gameName)?.[0] : null
    try {
      adopted.push(
        await describe(file.path, {
          gameId: gameName ? (known ?? gameIdForName(gameName)) : null,
          gameName,
          bookmark: false
        })
      )
    } catch (error) {
      console.warn('[library] skipping unreadable file', file.path, error)
    }
  }
  data.clips = [...kept, ...adopted]
  await saveIndex()
  broadcastChanged()
}

async function uniquePath(dir: string, fileName: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = join(dir, withSuffix(fileName, n))
    if (!(await exists(candidate))) return candidate
  }
}

/** rename(), or copy + delete when the source is on another disk. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await copyFile(from, to)
    await unlink(from)
  }
}

/** Files a freshly saved replay under `<library>/<Game>/<Game> <date>.mp4` and indexes it. */
export async function addClip(
  source: string,
  meta: { game: DetectedGame | null; bookmark: boolean; title?: string; move?: boolean }
): Promise<Clip> {
  const data = await loadIndex()
  const root = await libraryDir()
  const folder = join(root, sanitizeFileName(meta.game?.name ?? DESKTOP_FOLDER, DESKTOP_FOLDER))
  await mkdir(folder, { recursive: true })
  const now = new Date()
  const base = meta.title ? sanitizeFileName(meta.title) : clipBaseName(meta.game?.name ?? null, now)
  const target = await uniquePath(folder, `${base}${extname(source) || '.mp4'}`)
  if (meta.move === false) await copyFile(source, target)
  else await moveFile(source, target)
  if (meta.game) {
    data.games[meta.game.id] = {
      name: meta.game.name,
      iconPath: meta.game.iconPath ?? data.games[meta.game.id]?.iconPath ?? null,
      heroPath: meta.game.heroPath ?? data.games[meta.game.id]?.heroPath ?? null
    }
  }
  const clip = await describe(target, {
    title: basename(target, extname(target)),
    gameId: meta.game?.id ?? null,
    gameName: meta.game?.name ?? null,
    bookmark: meta.bookmark,
    createdAt: now.getTime()
  })
  data.clips.push(clip)
  await saveIndex()
  broadcastChanged()
  return clip
}

/** After a clip's file was replaced in place (trim): refresh its duration, size and tracks. */
export async function refreshClip(id: string): Promise<void> {
  const data = await loadIndex()
  const clip = data.clips.find((c) => c.id === id)
  if (!clip) return
  for (const jobs of [thumbJobs, filmstripJobs, trackJobs]) jobs.delete(clip.path)
  const fresh = await describe(clip.path, clip)
  Object.assign(clip, {
    ...fresh,
    id: clip.id,
    title: clip.title,
    createdAt: clip.createdAt,
    favorite: clip.favorite,
    bookmark: false
  })
  await saveIndex()
  broadcastChanged()
}

export async function getClip(id: string): Promise<Clip | null> {
  return (await loadIndex()).clips.find((c) => c.id === id) ?? null
}

export async function listClips(): Promise<ClipView[]> {
  await reconcileLibrary()
  return (await loadIndex()).clips.map(toView)
}

async function listGames(): Promise<GameSummary[]> {
  const data = await loadIndex()
  return groupGames(data.clips).map((g) => {
    const info = data.games[g.id]
    return {
      id: g.id,
      name: info?.name ?? g.name,
      clipCount: g.clipCount,
      iconUrl: info?.iconPath ? url('game-icon', g.id) : null,
      heroUrl: info?.heroPath ? url('game-hero', g.id) : null
    }
  })
}

async function renameClip(id: string, title: string): Promise<void> {
  const data = await loadIndex()
  const clip = data.clips.find((c) => c.id === id)
  const name = sanitizeFileName(title, '')
  if (!clip || !name || name === clip.title) return
  // The file is renamed too, so the folder stays as readable as the library.
  const target = await uniquePath(dirname(clip.path), `${name}${extname(clip.path)}`)
  await rename(clip.path, target)
  clip.path = target
  clip.title = basename(target, extname(target))
  await saveIndex()
  broadcastChanged()
}

async function removeClips(ids: string[]): Promise<void> {
  const data = await loadIndex()
  for (const clip of data.clips.filter((c) => ids.includes(c.id))) {
    // The system trash, so a mistaken delete can be undone from the file manager.
    await shell.trashItem(clip.path).catch(() => rm(clip.path, { force: true }))
  }
  data.clips = data.clips.filter((c) => !ids.includes(c.id))
  await saveIndex()
  broadcastChanged()
}

function broadcastChanged(): void {
  const clips = index?.clips.map(toView) ?? []
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(LIBRARY_IPC.changed, clips)
}

export function registerLibraryIpc(): void {
  registerFileProtocol()
  ipcMain.handle(LIBRARY_IPC.list, () => listClips())
  ipcMain.handle(LIBRARY_IPC.games, () => listGames())
  ipcMain.handle(LIBRARY_IPC.rename, (_e, id: string, title: string) => renameClip(id, title))
  ipcMain.handle(
    LIBRARY_IPC.setFlags,
    async (_e, id: string, flags: Partial<Pick<Clip, 'favorite' | 'bookmark'>>) => {
      const clip = await getClip(id)
      if (!clip) return
      if (flags.favorite !== undefined) clip.favorite = flags.favorite
      if (flags.bookmark !== undefined) clip.bookmark = flags.bookmark
      await saveIndex()
      broadcastChanged()
    }
  )
  ipcMain.handle(LIBRARY_IPC.remove, (_e, ids: string[]) => removeClips(ids))
  ipcMain.on(LIBRARY_IPC.reveal, async (_e, id: string) => {
    const clip = await getClip(id)
    if (clip) shell.showItemInFolder(clip.path)
  })
  ipcMain.on(LIBRARY_IPC.startDrag, async (event, id: string) => {
    const clip = await getClip(id)
    if (!clip) return
    const thumb = await once(thumbJobs, clip.path, () => buildThumbnail(clip))
    const icon = thumb ? nativeImage.createFromPath(thumb).resize({ width: 160 }) : nativeImage.createEmpty()
    event.sender.startDrag({ file: clip.path, icon })
  })
  ipcMain.handle(LIBRARY_IPC.filmstrip, async (_e, id: string) => {
    const clip = await getClip(id)
    return clip ? once(filmstripJobs, clip.path, () => buildFilmstrip(clip)) : null
  })
  ipcMain.handle(LIBRARY_IPC.audioTracks, async (_e, id: string) => {
    const clip = await getClip(id)
    return clip ? ((await once(trackJobs, clip.path, () => buildAudioTracks(clip))) ?? []) : []
  })
}

/** Thumbnail path for notifications (generated if needed). */
export async function thumbnailFor(clip: Clip): Promise<string | null> {
  return once(thumbJobs, clip.path, () => buildThumbnail(clip))
}
