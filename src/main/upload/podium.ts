import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import type { PodiumUploadTarget, UploadTestResult } from '@shared/ipc'
import {
  contentRange,
  contentTypeFor,
  endpoint,
  IDLE_TIMEOUT_MS,
  nextChunk,
  parseCompletion,
  parseError,
  parseOffset,
  parseServerInfo,
  parseStartResponse,
  PROTOCOL_VERSION,
  ProtocolError,
  rejectionReason,
  retryDelayMs,
  startRequest,
  type RemoteClip,
  type ServerInfo
} from '@core/upload/protocol'
import type { UploadProtocol, UploadRequest } from './Protocol'

// No Electron imports here, so the client can be tested against the reference server in plain Node.

interface CallOptions {
  token: string | null
  signal: AbortSignal
  json?: unknown
  /** A byte range of a file to send as the body. */
  file?: { path: string; first: number; last: number; size: number }
  /** Bytes of `file` sent so far. */
  onSent?: (bytes: number) => void
  follow?: boolean
}

interface Response {
  status: number
  body: unknown
}

export interface PodiumProtocolOptions {
  userAgent: string
  /** Replaces the retry schedule (tests use short waits). */
  retryDelay?: (attempt: number, retryAfter: number | null) => number | null
}

/** Waits, or rejects as soon as the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The Podium upload protocol (docs/upload-protocol.md): resumable chunked uploads over HTTP. */
export class PodiumProtocol implements UploadProtocol<PodiumUploadTarget> {
  constructor(private readonly options: PodiumProtocolOptions) {}

  async test(target: PodiumUploadTarget, token: string | null): Promise<UploadTestResult> {
    try {
      const info = await this.serverInfo(target.url, token, AbortSignal.timeout(15_000))
      return { ok: true, serverName: info.name, account: info.account?.name ?? null }
    } catch (error) {
      return { ok: false, message: errorText(error) }
    }
  }

  async upload(target: PodiumUploadTarget, request: UploadRequest): Promise<RemoteClip> {
    const info = await this.retrying(request, () =>
      this.serverInfo(target.url, request.token, request.signal)
    )
    const rejected = rejectionReason(info, request.size, contentTypeFor(request.fileName))
    if (rejected) throw new Error(rejected)
    // An expired session or a corrupted transfer is worth one fresh start.
    for (let fresh = 0; ; fresh++) {
      try {
        return await this.attempt(target.url, request)
      } catch (error) {
        const restartable =
          error instanceof ProtocolError && (error.status === 404 || error.code === 'checksum_mismatch')
        if (!restartable || fresh >= 1 || request.signal.aborted) throw error
        console.warn('[upload] starting over:', error.message)
        request.onProgress(0)
      }
    }
  }

  private async serverInfo(base: string, token: string | null, signal: AbortSignal): Promise<ServerInfo> {
    try {
      const res = await this.call('GET', endpoint(base, 'server'), { token, signal, follow: true })
      return parseServerInfo(res.body)
    } catch (error) {
      if (error instanceof ProtocolError && error.status === 404)
        throw new ProtocolError('This URL isn’t a Podium-compatible upload server.', 404)
      throw error
    }
  }

  /** One upload session from start to finish. */
  private async attempt(base: string, request: UploadRequest): Promise<RemoteClip> {
    const { token, signal, size } = request
    const started = await this.retrying(request, () =>
      this.call('POST', endpoint(base, 'uploads'), {
        token,
        signal,
        json: startRequest(request.clip, request.fileName, size, request.sha256)
      })
    )
    const parsed = parseStartResponse(started.status, started.body)
    if (parsed.kind === 'done') {
      request.onProgress(size)
      return parsed.clip
    }
    const { session } = parsed
    const sessionUrl = endpoint(base, 'uploads', session.id)
    // Cancelling tells the server to drop what it received; nobody waits for the answer.
    const abandon = (): void =>
      void this.call('DELETE', sessionUrl, { token, signal: AbortSignal.timeout(10_000) }).catch(() => {})
    signal.addEventListener('abort', abandon, { once: true })

    try {
      let offset = Math.min(session.offset, size)
      let resync = false
      let stalls = 0
      const sendChunk = async (): Promise<number> => {
        // After a failure the server may have kept all, part or none of the chunk: ask.
        if (resync) {
          offset = Math.min(size, parseOffset((await this.call('GET', sessionUrl, { token, signal })).body))
          resync = false
          if (offset >= size) return offset
        }
        const chunk = nextChunk(offset, size, session.chunkSize)!
        try {
          const res = await this.call('PUT', sessionUrl, {
            token,
            signal,
            file: { path: request.path, ...chunk, size },
            onSent: (bytes) => request.onProgress(chunk.first + bytes)
          })
          return Math.min(size, parseOffset(res.body))
        } catch (error) {
          if (error instanceof ProtocolError && error.code === 'offset_mismatch' && error.offset !== null)
            return Math.min(size, error.offset)
          resync = true
          throw error
        }
      }

      for (;;) {
        while (offset < size) {
          const next = await this.retrying(request, sendChunk)
          // A server that never moves forward would otherwise keep us here forever.
          stalls = next > offset ? 0 : stalls + 1
          if (stalls > 3) throw new ProtocolError('The server keeps refusing the same chunk.', 0)
          offset = next
          request.onProgress(offset)
        }
        request.onState('finishing')
        try {
          const done = await this.retrying(request, () =>
            this.call('POST', `${sessionUrl}/complete`, { token, signal, json: {} })
          )
          return parseCompletion(done.body)
        } catch (error) {
          // The server is missing bytes after all: send them and try again.
          if (!(error instanceof ProtocolError) || error.code !== 'incomplete' || error.offset === null)
            throw error
          if (error.offset >= size) throw error
          offset = error.offset
          request.onState('uploading')
        }
      }
    } finally {
      signal.removeEventListener('abort', abandon)
    }
  }

  /** Runs a request again after network and server errors, following the protocol's retry schedule. */
  private async retrying<T>(request: UploadRequest, run: () => Promise<T>): Promise<T> {
    const delayFor = this.options.retryDelay ?? retryDelayMs
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await run()
        if (attempt > 0) request.onMessage(null)
        return result
      } catch (error) {
        if (request.signal.aborted || !(error instanceof ProtocolError) || !error.retryable) throw error
        const delay = delayFor(attempt, error.retryAfter)
        if (delay === null) throw error
        console.warn(`[upload] retrying in ${delay} ms:`, error.message)
        request.onMessage(`Retrying in ${Math.ceil(delay / 1000)} s: ${error.message}`)
        await sleep(delay, request.signal)
      }
    }
  }

  private async call(method: string, url: string, options: CallOptions): Promise<Response> {
    const headers: Record<string, string> = {
      'Podium-Upload-Version': String(PROTOCOL_VERSION),
      'User-Agent': this.options.userAgent,
      Accept: 'application/json'
    }
    if (options.token) headers['Authorization'] = `Bearer ${options.token}`

    // Aborted by the caller, or when nothing moves for a while (so a slow chunk is fine, a stuck one isn't).
    const idle = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const touch = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => idle.abort(), IDLE_TIMEOUT_MS)
    }
    touch()

    let body: string | ReadableStream<Uint8Array> | undefined
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(options.json)
    } else if (options.file) {
      const { path, first, last, size } = options.file
      headers['Content-Type'] = 'application/octet-stream'
      headers['Content-Length'] = String(last - first + 1)
      headers['Content-Range'] = contentRange(first, last, size)
      let sent = 0
      const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          sent += chunk.byteLength
          touch()
          options.onSent?.(sent)
          controller.enqueue(chunk)
        }
      })
      const stream = Readable.toWeb(
        createReadStream(path, { start: first, end: last })
      ) as ReadableStream<Uint8Array>
      body = stream.pipeThrough(counter)
    }

    try {
      const res = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.any([options.signal, idle.signal]),
        redirect: options.follow ? 'follow' : 'manual',
        // Required by fetch for streamed request bodies.
        ...(options.file ? { duplex: 'half' } : {})
      } as RequestInit)
      touch()
      const text = await res.text()
      let json: unknown = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        // Not JSON (a proxy's error page, say): the status still says what happened.
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        throw new ProtocolError(
          `The server redirects uploads${location ? ` to ${location}` : ''}. Use that address as the server URL.`,
          res.status
        )
      }
      if (!res.ok) throw parseError(res.status, res.statusText, json, res.headers.get('retry-after'))
      return { status: res.status, body: json }
    } catch (error) {
      if (error instanceof ProtocolError) throw error
      if (options.signal.aborted) {
        const reason: unknown = options.signal.reason
        if (reason instanceof Error && reason.name === 'TimeoutError')
          throw new ProtocolError('The server didn’t answer in time.', 0)
        throw reason
      }
      if (idle.signal.aborted) throw new ProtocolError('The server stopped responding.', 0)
      const cause = (error as { cause?: { code?: string; message?: string } }).cause
      throw new ProtocolError(
        `Couldn’t reach the server (${cause?.code ?? cause?.message ?? errorText(error)}).`,
        0
      )
    } finally {
      clearTimeout(timer)
    }
  }
}
