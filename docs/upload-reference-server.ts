/**
 * A complete Podium-compatible upload server (see upload-protocol.md), with no dependencies.
 *
 *   PODIUM_UPLOAD_TOKEN=secret node docs/upload-reference-server.ts     (Node 22.18+)
 *   PODIUM_UPLOAD_TOKEN=secret deno run -A docs/upload-reference-server.ts
 *
 * Environment: PORT (8787), PODIUM_UPLOAD_DIR (./uploads), PODIUM_UPLOAD_TOKEN (none: no auth),
 * PODIUM_UPLOAD_NAME, PODIUM_UPLOAD_CHUNK_SIZE (8 MiB), PODIUM_UPLOAD_MAX_SIZE (4 GiB).
 * Uploaded clips are served at /c/<id>. Sessions live in memory, so a restart forgets unfinished uploads.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export interface UploadServerOptions {
  /** Where finished clips (and partial uploads, in `.partial/`) are stored. */
  dir: string
  /** The access token clients must send; null runs without authentication. */
  token: string | null
  name?: string
  chunkSize?: number
  maxFileSize?: number
  /** Test hook: what to do with the n-th chunk request (0-based) the server receives. */
  fault?: (chunk: number) => 'none' | 'fail-before-write' | 'fail-after-write'
}

interface Session {
  id: string
  token: string | null
  size: number
  sha256: string
  contentType: string
  clip: Record<string, unknown>
  offset: number
  expiresAt: number
  /** Set once completed, so a repeated complete returns the same answer. */
  result: { clip: StoredClip } | null
}

export interface StoredClip {
  id: string
  url: string
  sha256: string
  size: number
  contentType: string
  title: string | null
  game: unknown
  uploadedAt: string
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000
const ID = /^[A-Za-z0-9._-]{1,128}$/
const EXTENSIONS: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/x-matroska': '.mkv',
  'video/webm': '.webm',
  'video/quicktime': '.mov'
}

// Plain fields rather than parameter properties: Node's type stripping only removes erasable syntax.
class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly extra: Record<string, unknown>
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end()
    return
  }
  const json = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(json)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = []
  let length = 0
  for await (const part of req as AsyncIterable<Buffer>) {
    length += part.length
    if (length > 64 * 1024) throw new HttpError(413, 'invalid_request', 'The request body is too large.')
    parts.push(part)
  }
  const text = Buffer.concat(parts).toString('utf8').trim()
  if (!text) return {}
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value === 'object' && value !== null && !Array.isArray(value))
      return value as Record<string, unknown>
  } catch {
    // Falls through to the error below.
  }
  throw new HttpError(400, 'invalid_request', 'The request body must be a JSON object.')
}

export function createUploadServer(options: UploadServerOptions): Server {
  const chunkSize = options.chunkSize ?? 8 * 1024 * 1024
  const maxFileSize = options.maxFileSize ?? 4 * 1024 * 1024 * 1024
  const sessions = new Map<string, Session>()
  const partialDir = join(options.dir, '.partial')
  const partialPath = (id: string): string => join(partialDir, id)
  let chunkRequests = 0

  const tokenOf = (req: IncomingMessage): string | null => {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
    return match ? match[1]!.trim() : null
  }
  const authorize = (req: IncomingMessage): void => {
    if (options.token !== null && tokenOf(req) !== options.token)
      throw new HttpError(401, 'unauthorized', 'The access token is missing or wrong.')
  }
  const sessionFor = (req: IncomingMessage, id: string): Session => {
    const session = sessions.get(id)
    if (!session || session.expiresAt < Date.now() || session.token !== tokenOf(req))
      throw new HttpError(404, 'not_found', 'This upload does not exist or has expired.')
    return session
  }
  const clipUrl = (req: IncomingMessage, id: string): string => `http://${req.headers.host}/c/${id}`

  // A finished file the server already has, by checksum; lets a re-upload finish instantly.
  async function findBySha(sha256: string): Promise<StoredClip | null> {
    try {
      const index = JSON.parse(await readFile(join(options.dir, 'index.json'), 'utf8')) as StoredClip[]
      return index.find((c) => c.sha256 === sha256) ?? null
    } catch {
      return null
    }
  }
  async function remember(clip: StoredClip): Promise<void> {
    const file = join(options.dir, 'index.json')
    const index = await readFile(file, 'utf8')
      .then((t) => JSON.parse(t) as StoredClip[])
      .catch(() => [])
    await writeFile(file, JSON.stringify([...index, clip], null, 2))
  }

  async function startUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req)
    const { size, sha256, contentType } = body
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1)
      throw new HttpError(400, 'invalid_request', '`size` must be a positive whole number of bytes.')
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))
      throw new HttpError(400, 'invalid_request', '`sha256` must be 64 lowercase hex characters.')
    if (typeof contentType !== 'string' || !EXTENSIONS[contentType])
      throw new HttpError(415, 'unsupported_type', `This server doesn't take ${String(contentType)} files.`)
    if (size > maxFileSize)
      throw new HttpError(413, 'too_large', `Clips can be at most ${maxFileSize} bytes on this server.`)
    const existing = await findBySha(sha256)
    if (existing) return send(res, 200, { clip: { id: existing.id, url: existing.url } })

    const session: Session = {
      id: randomUUID(),
      token: tokenOf(req),
      size,
      sha256,
      contentType,
      clip: typeof body['clip'] === 'object' && body['clip'] ? (body['clip'] as Record<string, unknown>) : {},
      offset: 0,
      expiresAt: Date.now() + SESSION_TTL_MS,
      result: null
    }
    await mkdir(partialDir, { recursive: true })
    await writeFile(partialPath(session.id), '')
    sessions.set(session.id, session)
    send(res, 201, {
      id: session.id,
      chunkSize,
      offset: 0,
      expiresAt: new Date(session.expiresAt).toISOString()
    })
  }

  async function receiveChunk(req: IncomingMessage, res: ServerResponse, session: Session): Promise<void> {
    const fault = options.fault?.(chunkRequests++) ?? 'none'
    // Example: bytes 0-8388607/187465321
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(req.headers['content-range'] ?? '')
    if (!range) throw new HttpError(400, 'invalid_request', 'Send a `Content-Range: bytes a-b/size` header.')
    const first = Number(range[1])
    const last = Number(range[2])
    if (Number(range[3]) !== session.size || last < first || last >= session.size)
      throw new HttpError(400, 'invalid_request', 'The Content-Range does not fit this upload.')
    if (last - first + 1 > chunkSize)
      throw new HttpError(400, 'invalid_request', `Chunks can be at most ${chunkSize} bytes.`)
    if (first !== session.offset) {
      throw new HttpError(409, 'offset_mismatch', `Expected the chunk at byte ${session.offset}.`, {
        offset: session.offset
      })
    }
    if (fault === 'fail-before-write') {
      req.resume()
      throw new HttpError(503, 'server_error', 'Injected failure before the write.')
    }

    const expected = last - first + 1
    const file = await open(partialPath(session.id), 'a')
    let received = 0
    try {
      for await (const part of req as AsyncIterable<Buffer>) {
        received += part.length
        if (received > expected) break
        await file.write(part)
      }
      await file.sync()
    } finally {
      await file.close()
    }
    if (received !== expected) {
      // A broken or oversized chunk: drop what arrived, the client resumes from the old offset.
      await truncate(partialPath(session.id), session.offset)
      throw new HttpError(400, 'invalid_request', `Expected ${expected} bytes, got ${received}.`)
    }
    session.offset += expected
    if (fault === 'fail-after-write')
      throw new HttpError(500, 'server_error', 'Injected failure after the write.')
    send(res, 200, { offset: session.offset })
  }

  async function complete(req: IncomingMessage, res: ServerResponse, session: Session): Promise<void> {
    if (session.result)
      return send(res, 201, { clip: { id: session.result.clip.id, url: session.result.clip.url } })
    if (session.offset !== session.size) {
      throw new HttpError(409, 'incomplete', `Only ${session.offset} of ${session.size} bytes arrived.`, {
        offset: session.offset
      })
    }
    const partial = partialPath(session.id)
    const hash = createHash('sha256')
    for await (const part of createReadStream(partial)) hash.update(part as Buffer)
    if (hash.digest('hex') !== session.sha256) {
      sessions.delete(session.id)
      await rm(partial, { force: true })
      throw new HttpError(422, 'checksum_mismatch', 'The uploaded bytes do not match the checksum.')
    }
    const id = randomUUID().replaceAll('-', '').slice(0, 12)
    await rename(partial, join(options.dir, id + EXTENSIONS[session.contentType]))
    const clip: StoredClip = {
      id,
      url: clipUrl(req, id),
      sha256: session.sha256,
      size: session.size,
      contentType: session.contentType,
      title: typeof session.clip['title'] === 'string' ? session.clip['title'] : null,
      game: session.clip['game'] ?? null,
      uploadedAt: new Date().toISOString()
    }
    await remember(clip)
    session.result = { clip }
    send(res, 201, { clip: { id: clip.id, url: clip.url } })
  }

  async function serveClip(res: ServerResponse, id: string): Promise<void> {
    const index = await readFile(join(options.dir, 'index.json'), 'utf8')
      .then((t) => JSON.parse(t) as StoredClip[])
      .catch(() => [])
    const clip = index.find((c) => c.id === id)
    if (!clip) throw new HttpError(404, 'not_found', 'No clip with this id.')
    const path = join(options.dir, id + EXTENSIONS[clip.contentType])
    const info = await stat(path)
    res.writeHead(200, { 'Content-Type': clip.contentType, 'Content-Length': info.size })
    createReadStream(path).pipe(res)
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost')
    const parts = pathname.split('/').filter(Boolean)
    const method = req.method ?? 'GET'

    if (method === 'GET' && parts[0] === 'c' && parts.length === 2) return serveClip(res, parts[1]!)
    if (method === 'GET' && pathname === '/server') {
      authorize(req)
      return send(res, 200, {
        protocol: 'podium-upload',
        versions: [1],
        name: options.name ?? 'Podium reference server',
        account: options.token === null ? null : { name: 'owner' },
        maxFileSize,
        accept: Object.keys(EXTENSIONS)
      })
    }
    if (parts[0] === 'uploads') {
      authorize(req)
      if (parts.length === 1 && method === 'POST') return startUpload(req, res)
      const id = parts[1]
      if (!id || !ID.test(id)) throw new HttpError(404, 'not_found', 'Unknown endpoint.')
      if (parts.length === 2 && method === 'DELETE') {
        if (sessions.get(id)?.token === tokenOf(req)) sessions.delete(id)
        await rm(partialPath(id), { force: true })
        return send(res, 204)
      }
      const session = sessionFor(req, id)
      if (parts.length === 2 && method === 'PUT') return receiveChunk(req, res, session)
      if (parts.length === 2 && method === 'GET')
        return send(res, 200, { id: session.id, offset: session.offset, size: session.size })
      if (parts.length === 3 && parts[2] === 'complete' && method === 'POST')
        return complete(req, res, session)
    }
    throw new HttpError(404, 'not_found', 'Unknown endpoint.')
  }

  // Forget sessions nobody finished.
  const sweep = setInterval(() => {
    for (const session of sessions.values()) {
      if (session.expiresAt > Date.now()) continue
      sessions.delete(session.id)
      void rm(partialPath(session.id), { force: true })
    }
  }, 60_000)
  sweep.unref()

  const server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (res.headersSent) return res.destroy()
      if (error instanceof HttpError) {
        if (error.status === 401) res.setHeader('WWW-Authenticate', 'Bearer')
        return send(res, error.status, {
          error: { code: error.code, message: error.message },
          ...error.extra
        })
      }
      console.error(error)
      send(res, 500, { error: { code: 'server_error', message: 'Something went wrong on the server.' } })
    })
  })
  server.on('close', () => clearInterval(sweep))
  return server
}

const runDirectly =
  (import.meta as { main?: boolean }).main ??
  (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)

if (runDirectly) {
  const env = process.env
  const port = Number(env['PORT'] ?? 8787)
  const dir = env['PODIUM_UPLOAD_DIR'] ?? join(process.cwd(), 'uploads')
  await mkdir(dir, { recursive: true })
  createUploadServer({
    dir,
    token: env['PODIUM_UPLOAD_TOKEN'] || null,
    name: env['PODIUM_UPLOAD_NAME'],
    chunkSize: env['PODIUM_UPLOAD_CHUNK_SIZE'] ? Number(env['PODIUM_UPLOAD_CHUNK_SIZE']) : undefined,
    maxFileSize: env['PODIUM_UPLOAD_MAX_SIZE'] ? Number(env['PODIUM_UPLOAD_MAX_SIZE']) : undefined
  }).listen(port, () => {
    console.log(`Podium upload server on http://localhost:${port}, storing clips in ${dir}`)
    if (!env['PODIUM_UPLOAD_TOKEN']) console.log('No PODIUM_UPLOAD_TOKEN set: anyone can upload.')
  })
}
