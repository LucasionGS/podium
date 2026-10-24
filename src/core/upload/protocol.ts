import type { Clip } from '@shared/ipc'

/** The Podium upload protocol's wire format and client rules (docs/upload-protocol.md), without any I/O. */

export const PROTOCOL_NAME = 'podium-upload'
export const PROTOCOL_VERSION = 1

/** Waits between retries of a failed request; after the last one the upload fails. */
export const RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000, 60_000]
/** A request that makes no progress for this long counts as a network error. */
export const IDLE_TIMEOUT_MS = 60_000

export interface ServerInfo {
  name: string
  versions: number[]
  account: { name: string } | null
  maxFileSize: number | null
  accept: string[] | null
}

export interface UploadSession {
  id: string
  chunkSize: number
  offset: number
}

export interface RemoteClip {
  id: string
  url: string | null
  thumbnailUrl: string | null
}

export interface StartRequest {
  fileName: string
  size: number
  contentType: string
  sha256: string
  clip: {
    id: string
    title: string
    game: { id: string; name: string } | null
    recordedAt: string
    duration: number
    width: number
    height: number
    fps: number
    audioTracks: string[]
  }
}

/** An error response, or a broken one, in a form the client can act on. */
export class ProtocolError extends Error {
  constructor(
    message: string,
    /** HTTP status; 0 for a network error or a response that broke the protocol. */
    readonly status: number,
    readonly code: string | null = null,
    /** The server's offset, sent with `offset_mismatch` and `incomplete`. */
    readonly offset: number | null = null,
    /** Seconds from `Retry-After`. */
    readonly retryAfter: number | null = null
  ) {
    super(message)
    this.name = 'ProtocolError'
  }

  /** Network errors, timeouts, rate limits and server errors are worth another try. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500
  }
}

type Raw = Record<string, unknown>
const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const UPLOAD_ID = /^[A-Za-z0-9._-]{1,128}$/

const broken = (what: string): ProtocolError =>
  new ProtocolError(`The server's answer doesn't follow the Podium upload protocol (${what}).`, 0)

/**
 * Cleans up what the user typed as a server URL. Adds `https://` when no scheme is given and drops
 * trailing slashes, a query and a fragment.
 * @throws Error when it isn't an http(s) URL.
 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Enter the server’s URL.')
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(`“${trimmed}” isn’t a valid URL.`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('The server URL must start with https:// or http://.')
  if (url.username || url.password) throw new Error('Put the access token in its own field, not in the URL.')
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/** Plain http to anything but this machine sends the token and the clip unencrypted. */
export function isInsecureUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url)
    return protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(hostname)
  } catch {
    return false
  }
}

/** `base` + path segments, each percent-encoded. */
export const endpoint = (base: string, ...segments: string[]): string =>
  [base.replace(/\/+$/, ''), ...segments.map(encodeURIComponent)].join('/')

export function parseServerInfo(body: unknown): ServerInfo {
  if (!isObject(body) || body['protocol'] !== PROTOCOL_NAME)
    throw new ProtocolError('This URL isn’t a Podium-compatible upload server.', 0)
  const versions = Array.isArray(body['versions']) ? body['versions'].filter(isCount) : []
  if (!versions.includes(PROTOCOL_VERSION)) {
    throw new ProtocolError(
      `The server speaks protocol version ${versions.join(', ') || 'unknown'}, but this Podium needs version ${PROTOCOL_VERSION}. Update the server or Podium.`,
      0
    )
  }
  const account = isObject(body['account']) && typeof body['account']['name'] === 'string'
  return {
    name: typeof body['name'] === 'string' && body['name'].trim() ? body['name'].trim() : 'Upload server',
    versions,
    account: account ? { name: (body['account'] as Raw)['name'] as string } : null,
    maxFileSize: isCount(body['maxFileSize']) ? body['maxFileSize'] : null,
    accept: Array.isArray(body['accept'])
      ? body['accept'].filter((t): t is string => typeof t === 'string')
      : null
  }
}

/** Whether the server takes this file at all, as a readable reason when it doesn't. */
export function rejectionReason(info: ServerInfo, size: number, contentType: string): string | null {
  if (info.maxFileSize !== null && size > info.maxFileSize)
    return `The clip is too large for ${info.name} (it takes files up to ${formatSize(info.maxFileSize)}).`
  if (info.accept && info.accept.length && !info.accept.includes(contentType))
    return `${info.name} doesn’t take ${contentType} files.`
  return null
}

const formatSize = (bytes: number): string =>
  bytes >= 1e9 ? `${+(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`

/** `POST /uploads`: either a session to send chunks to, or (200) the server already had the file. */
export function parseStartResponse(
  status: number,
  body: unknown
): { kind: 'session'; session: UploadSession } | { kind: 'done'; clip: RemoteClip } {
  if (status === 200) return { kind: 'done', clip: parseCompletion(body) }
  if (!isObject(body)) throw broken('no upload session')
  const { id, chunkSize, offset } = body
  if (typeof id !== 'string' || !UPLOAD_ID.test(id)) throw broken('bad upload id')
  if (!isCount(chunkSize) || chunkSize < 1) throw broken('bad chunk size')
  return { kind: 'session', session: { id, chunkSize, offset: isCount(offset) ? offset : 0 } }
}

/** `PUT` and `GET /uploads/{id}` answer with the server's offset. */
export function parseOffset(body: unknown): number {
  if (!isObject(body) || !isCount(body['offset'])) throw broken('no offset')
  return body['offset']
}

export function parseCompletion(body: unknown): RemoteClip {
  const clip = isObject(body) ? body['clip'] : null
  if (!isObject(clip) || typeof clip['id'] !== 'string' || !clip['id']) throw broken('no clip id')
  const link = (v: unknown): string | null => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v : null)
  return { id: clip['id'], url: link(clip['url']), thumbnailUrl: link(clip['thumbnailUrl']) }
}

/** Turns an error response into a ProtocolError with the server's message when it sent one. */
export function parseError(
  status: number,
  statusText: string,
  body: unknown,
  retryAfter: string | null = null
): ProtocolError {
  const error = isObject(body) && isObject(body['error']) ? body['error'] : null
  const code = typeof error?.['code'] === 'string' ? error['code'] : null
  const serverMessage = typeof error?.['message'] === 'string' ? error['message'].trim() : ''
  const offset = isObject(body) && isCount(body['offset']) ? body['offset'] : null
  const fallback =
    status === 401
      ? 'The server didn’t accept the access token. Check it in Settings → Uploads.'
      : `The server answered ${status}${statusText ? ` ${statusText}` : ''}.`
  return new ProtocolError(serverMessage || fallback, status, code, offset, parseRetryAfter(retryAfter))
}

/** `Retry-After` in seconds; the HTTP-date form is accepted too. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null
  if (/^\d+$/.test(value.trim())) return Number(value.trim())
  const date = Date.parse(value)
  return Number.isNaN(date) ? null : Math.max(0, Math.round((date - now) / 1000))
}

/** How long to wait before retry number `attempt` (0-based), or null when it's time to give up. */
export function retryDelayMs(attempt: number, retryAfter: number | null = null): number | null {
  const delay = RETRY_DELAYS_MS[attempt]
  if (delay === undefined) return null
  // The server's own wish wins, within reason: a day-long Retry-After would look like a hang.
  return retryAfter !== null ? Math.min(retryAfter * 1000, 10 * 60_000) : delay
}

/** The next chunk to send as inclusive byte positions, or null when everything was sent. */
export function nextChunk(
  offset: number,
  size: number,
  chunkSize: number
): { first: number; last: number } | null {
  if (offset >= size) return null
  return { first: offset, last: Math.min(size, offset + Math.max(1, chunkSize)) - 1 }
}

/** Example: bytes 0-8388607/187465321 */
export const contentRange = (first: number, last: number, size: number): string =>
  `bytes ${first}-${last}/${size}`

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime'
}

export function contentTypeFor(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return (dot >= 0 && CONTENT_TYPES[fileName.slice(dot).toLowerCase()]) || 'application/octet-stream'
}

/** The body of `POST /uploads` for a library clip. */
export function startRequest(clip: Clip, fileName: string, size: number, sha256: string): StartRequest {
  return {
    fileName,
    size,
    contentType: contentTypeFor(fileName),
    sha256,
    clip: {
      id: clip.id,
      title: clip.title,
      game: clip.gameId ? { id: clip.gameId, name: clip.gameName ?? '' } : null,
      recordedAt: new Date(clip.createdAt).toISOString(),
      duration: clip.duration,
      width: clip.width,
      height: clip.height,
      fps: clip.fps,
      audioTracks: clip.audioTracks
    }
  }
}
