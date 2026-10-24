import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Clip, PodiumUploadTarget } from '@shared/ipc'
import { PodiumProtocol } from '../../src/main/upload/podium'
import type { UploadRequest } from '../../src/main/upload/Protocol'
import { createUploadServer, type UploadServerOptions } from '../../docs/upload-reference-server'

// The real client against the reference server from docs/, with failures injected on the server side.

let work: string
let clipPath: string
let content: Buffer
const servers: Array<{ close(): void }> = []

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'podium-upload-'))
  clipPath = join(work, 'clip.mp4')
  content = randomBytes(250_000)
  writeFileSync(clipPath, content)
})
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})
afterAll(() => rmSync(work, { recursive: true, force: true }))

async function serve(
  options: Partial<UploadServerOptions> = {}
): Promise<{ target: PodiumUploadTarget; dir: string }> {
  const dir = mkdtempSync(join(work, 'server-'))
  const server = createUploadServer({ dir, token: 'secret', chunkSize: 64 * 1024, ...options })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const { port } = server.address() as AddressInfo
  return { dir, target: { id: 't', name: 'Test', protocol: 'podium', url: `http://127.0.0.1:${port}` } }
}

const client = new PodiumProtocol({ userAgent: 'Podium/test', retryDelay: (n) => (n < 3 ? 10 : null) })

const clip: Clip = {
  id: 'clip-1',
  path: '',
  title: 'Test clip',
  gameId: null,
  gameName: null,
  createdAt: 0,
  duration: 1,
  width: 16,
  height: 9,
  fps: 60,
  size: 0,
  audioTracks: [],
  bookmark: false,
  favorite: false,
  uploads: []
}

function request(
  over: Partial<UploadRequest> = {}
): UploadRequest & { progress: number[]; states: string[] } {
  const progress: number[] = []
  const states: string[] = []
  return {
    clip,
    path: clipPath,
    fileName: 'clip.mp4',
    size: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    token: 'secret',
    signal: new AbortController().signal,
    onProgress: (n) => progress.push(n),
    onState: (s) => states.push(s),
    onMessage: () => {},
    progress,
    states,
    ...over
  }
}

const stored = (dir: string): Buffer[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.mp4'))
    .map((f) => readFileSync(join(dir, f)))

describe('Podium upload client', () => {
  it('tests the connection and the token', async () => {
    const { target } = await serve({ name: 'Ion’s clips' })
    expect(await client.test(target, 'secret')).toEqual({
      ok: true,
      serverName: 'Ion’s clips',
      account: 'owner'
    })
    expect(await client.test(target, 'wrong')).toEqual({
      ok: false,
      message: 'The access token is missing or wrong.'
    })
    expect(await client.test({ ...target, url: `${target.url}/nothing` }, 'secret')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/isn’t a Podium-compatible/)
    })
    expect(await client.test({ ...target, url: 'http://127.0.0.1:1' }, null)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Couldn’t reach/)
    })
  })

  it('uploads a file in chunks and returns its link', async () => {
    const { target, dir } = await serve()
    const req = request()
    const remote = await client.upload(target, req)
    expect(remote.url).toMatch(new RegExp(`^${target.url}/c/`))
    expect(stored(dir)).toEqual([content])
    expect(req.progress.at(-1)).toBe(content.length)
    expect(req.states).toEqual(['finishing'])
    // The link serves the clip.
    expect(Buffer.from(await (await fetch(remote.url!)).arrayBuffer())).toEqual(content)
  })

  it('sends the whole file at once when the server asks for one big chunk', async () => {
    const { target, dir } = await serve({ chunkSize: 1e9 })
    let chunks = 0
    const server = await serve({ chunkSize: 1e9, fault: () => (chunks++, 'none') })
    await client.upload(server.target, request())
    expect(chunks).toBe(1)
    await client.upload(target, request())
    expect(stored(dir)).toEqual([content])
  })

  it('resumes after chunks fail before and after the server stored them', async () => {
    const { target, dir } = await serve({
      fault: (n) => (n === 1 ? 'fail-before-write' : n === 3 ? 'fail-after-write' : 'none')
    })
    await client.upload(target, request())
    expect(stored(dir)).toEqual([content])
  })

  it('finishes instantly when the server already has the file', async () => {
    const { target } = await serve()
    const first = await client.upload(target, request())
    let chunks = 0
    const again = await client.upload(target, { ...request(), onProgress: () => chunks++ })
    expect(again.id).toBe(first.id)
    expect(chunks).toBe(1)
  })

  it('starts over once when the checksum does not match', async () => {
    const { target } = await serve()
    await expect(client.upload(target, request({ sha256: '0'.repeat(64) }))).rejects.toThrow(
      'The uploaded bytes do not match the checksum.'
    )
  })

  it('stops at errors that retrying would not fix', async () => {
    const { target } = await serve({ maxFileSize: 1000 })
    await expect(client.upload(target, request())).rejects.toThrow(/too large for Podium reference server/)
    const open = await serve()
    await expect(client.upload(open.target, request({ token: 'wrong' }))).rejects.toThrow(/access token/)
  })

  it('gives up after the retries run out', async () => {
    const { target } = await serve({ fault: () => 'fail-before-write' })
    await expect(client.upload(target, request())).rejects.toThrow('Injected failure before the write.')
  })

  it('cancels and tells the server to drop the partial upload', async () => {
    const { target, dir } = await serve()
    const abort = new AbortController()
    const req = request({
      signal: abort.signal,
      onProgress: (n) => n > 100_000 && abort.abort()
    })
    await expect(client.upload(target, req)).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 200))
    expect(readdirSync(join(dir, '.partial'))).toEqual([])
  })
})
