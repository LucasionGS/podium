import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Clip, type UploadSettings } from '@shared/ipc'
import { normalizeSettings } from '@core/settings'
import {
  contentRange,
  contentTypeFor,
  endpoint,
  isInsecureUrl,
  nextChunk,
  normalizeServerUrl,
  parseCompletion,
  parseError,
  parseOffset,
  parseRetryAfter,
  parseServerInfo,
  parseStartResponse,
  rejectionReason,
  retryDelayMs,
  startRequest
} from '@core/upload/protocol'
import { autoUploadTarget, resolveTarget } from '@core/upload/targets'

const target = (id: string) => ({ id, name: id, protocol: 'podium' as const, url: `https://${id}.example` })

describe('server URLs', () => {
  it('normalizes what users type', () => {
    expect(normalizeServerUrl('clips.example.com')).toBe('https://clips.example.com')
    expect(normalizeServerUrl(' https://clips.example.com/api/podium/// ')).toBe(
      'https://clips.example.com/api/podium'
    )
    expect(normalizeServerUrl('http://localhost:8787/?x=1#y')).toBe('http://localhost:8787')
  })

  it('rejects what is not an http(s) server', () => {
    expect(() => normalizeServerUrl('')).toThrow(/Enter/)
    expect(() => normalizeServerUrl('ftp://example.com')).toThrow(/https/)
    expect(() => normalizeServerUrl('https://user:secret@example.com')).toThrow(/token/)
  })

  it('warns about plain http except on this machine', () => {
    expect(isInsecureUrl('http://192.168.1.10:8787')).toBe(true)
    expect(isInsecureUrl('http://localhost:8787')).toBe(false)
    expect(isInsecureUrl('https://clips.example.com')).toBe(false)
  })

  it('joins and encodes endpoints', () => {
    expect(endpoint('https://a.example/api/', 'uploads', 'x y')).toBe('https://a.example/api/uploads/x%20y')
  })
})

describe('protocol responses', () => {
  it('reads the server info and checks the version', () => {
    const info = parseServerInfo({
      protocol: 'podium-upload',
      versions: [1, 2],
      name: ' Ion ',
      account: { name: 'ion' },
      maxFileSize: 1000,
      accept: ['video/mp4'],
      future: true
    })
    expect(info).toEqual({
      name: 'Ion',
      versions: [1, 2],
      account: { name: 'ion' },
      maxFileSize: 1000,
      accept: ['video/mp4']
    })
    expect(() => parseServerInfo('<html>')).toThrow(/isn’t a Podium-compatible/)
    expect(() => parseServerInfo({ protocol: 'podium-upload', versions: [2] })).toThrow(/version 2/)
  })

  it('turns down files the server said it would not take', () => {
    const info = parseServerInfo({ protocol: 'podium-upload', versions: [1], name: 'S', maxFileSize: 2e9 })
    expect(rejectionReason(info, 3e9, 'video/mp4')).toMatch(/too large for S.*2 GB/)
    expect(rejectionReason(info, 1e9, 'video/mp4')).toBeNull()
    expect(rejectionReason({ ...info, accept: ['video/webm'] }, 1, 'video/mp4')).toMatch(/video\/mp4/)
  })

  it('reads sessions, offsets and finished clips', () => {
    expect(parseStartResponse(201, { id: 'u_1', chunkSize: 10, offset: 0 })).toEqual({
      kind: 'session',
      session: { id: 'u_1', chunkSize: 10, offset: 0 }
    })
    // 200: the server already had the file.
    expect(parseStartResponse(200, { clip: { id: 'c', url: 'https://x/c' } })).toEqual({
      kind: 'done',
      clip: { id: 'c', url: 'https://x/c', thumbnailUrl: null }
    })
    expect(() => parseStartResponse(201, { id: '../etc', chunkSize: 10 })).toThrow(/upload id/)
    expect(() => parseStartResponse(201, { id: 'u', chunkSize: 0 })).toThrow(/chunk size/)
    expect(parseOffset({ offset: 42 })).toBe(42)
    expect(() => parseOffset({ offset: -1 })).toThrow()
    // Only http(s) links are kept, so a server can't hand Podium something like javascript:.
    expect(parseCompletion({ clip: { id: 'c', url: 'javascript:alert(1)' } }).url).toBeNull()
  })

  it('keeps the server’s error message and offset, and knows what to retry', () => {
    const error = parseError(409, 'Conflict', {
      error: { code: 'offset_mismatch', message: 'Expected byte 8.' },
      offset: 8
    })
    expect(error).toMatchObject({
      status: 409,
      code: 'offset_mismatch',
      offset: 8,
      message: 'Expected byte 8.'
    })
    expect(error.retryable).toBe(false)
    expect(parseError(401, 'Unauthorized', null).message).toMatch(/access token/)
    expect(parseError(502, 'Bad Gateway', '<html>').message).toBe('The server answered 502 Bad Gateway.')
    expect(parseError(502, '', null).retryable).toBe(true)
    expect(parseError(429, '', null, '7')).toMatchObject({ retryable: true, retryAfter: 7 })
  })

  it('follows the retry schedule and Retry-After', () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => retryDelayMs(n))).toEqual([1000, 2000, 5000, 10_000, 30_000, 60_000])
    expect(retryDelayMs(6)).toBeNull()
    expect(retryDelayMs(0, 3)).toBe(3000)
    expect(retryDelayMs(0, 86_400)).toBe(600_000)
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 0)).toBe(10)
    expect(parseRetryAfter('soon')).toBeNull()
  })
})

describe('chunks and requests', () => {
  it('splits a file into chunks of the server’s size', () => {
    expect(nextChunk(0, 25, 10)).toEqual({ first: 0, last: 9 })
    expect(nextChunk(20, 25, 10)).toEqual({ first: 20, last: 24 })
    expect(nextChunk(25, 25, 10)).toBeNull()
    // A chunk size bigger than the file sends it in one go.
    expect(nextChunk(0, 25, 1e9)).toEqual({ first: 0, last: 24 })
    expect(contentRange(0, 9, 25)).toBe('bytes 0-9/25')
  })

  it('describes the clip for the server', () => {
    const clip: Clip = {
      id: 'id',
      path: '/lib/Apex/a.mp4',
      title: 'a',
      gameId: 'steam:1',
      gameName: 'Apex',
      createdAt: Date.UTC(2026, 9, 24),
      duration: 30,
      width: 1920,
      height: 1080,
      fps: 60,
      size: 10,
      audioTracks: ['Desktop', 'Microphone'],
      bookmark: false,
      favorite: false,
      uploads: []
    }
    expect(startRequest(clip, 'a.MKV', 10, 'f'.repeat(64))).toEqual({
      fileName: 'a.MKV',
      size: 10,
      contentType: 'video/x-matroska',
      sha256: 'f'.repeat(64),
      clip: {
        id: 'id',
        title: 'a',
        game: { id: 'steam:1', name: 'Apex' },
        recordedAt: '2026-10-24T00:00:00.000Z',
        duration: 30,
        width: 1920,
        height: 1080,
        fps: 60,
        audioTracks: ['Desktop', 'Microphone']
      }
    })
    expect(contentTypeFor('clip')).toBe('application/octet-stream')
  })
})

describe('targets', () => {
  const settings = (over: Partial<UploadSettings>): UploadSettings => ({
    ...DEFAULT_SETTINGS.upload,
    targets: [target('a'), target('b')],
    ...over
  })

  it('picks the asked-for target, then the default, then the first', () => {
    expect(resolveTarget(settings({}), 'b')?.id).toBe('b')
    expect(resolveTarget(settings({}), 'gone')).toBeNull()
    expect(resolveTarget(settings({ defaultTarget: 'b' }))?.id).toBe('b')
    expect(resolveTarget(settings({ defaultTarget: 'gone' }))?.id).toBe('a')
    expect(resolveTarget(settings({ targets: [] }))).toBeNull()
  })

  it('auto-uploads clips but not bookmarks, and only when turned on', () => {
    const clip = { kind: 'clip', seconds: 30 } as const
    expect(autoUploadTarget(settings({}), clip)).toBeNull()
    expect(autoUploadTarget(settings({ auto: true }), clip)?.id).toBe('a')
    expect(autoUploadTarget(settings({ auto: true }), { kind: 'bookmark' })).toBeNull()
  })

  it('normalizes upload settings from disk', () => {
    expect(normalizeSettings({}).upload).toEqual({
      targets: [],
      defaultTarget: null,
      auto: false,
      copyLink: true
    })
    const upload = normalizeSettings({
      upload: {
        targets: [
          { id: 'a', name: '', protocol: 'podium', url: 'clips.example.com/' },
          { id: 'a', name: 'duplicate', protocol: 'podium', url: 'https://x.example' },
          { id: 'b', name: 'B', protocol: 'youtube', url: 'https://x.example' },
          { id: 'c', name: 'C', protocol: 'podium', url: 'ftp://x' }
        ],
        defaultTarget: 'b',
        auto: true,
        copyLink: false
      }
    }).upload
    expect(upload).toEqual({
      targets: [{ id: 'a', name: 'clips.example.com', protocol: 'podium', url: 'https://clips.example.com' }],
      defaultTarget: null,
      auto: true,
      copyLink: false
    })
    // Auto-upload needs somewhere to upload to.
    expect(normalizeSettings({ upload: { targets: [], auto: true } }).upload.auto).toBe(false)
  })
})
