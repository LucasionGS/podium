import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import { buildWindowsArgs, CHANNELS, concatList, pickSegments, SAMPLE_RATE } from '@core/capture/windows'

/**
 * The Windows engine can't run here, but everything after the grabber can: this runs the exact
 * argument list Podium builds, with a test pattern in place of ddagrab (and x264 in place of the GPU
 * encoder), FIFOs in place of the named pipes, and real-time PCM streamed into them.
 */
const work = mkdtempSync(join(tmpdir(), 'podium-winring-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const probe = (
  path: string
): { duration: number; streams: Array<{ codec_type: string; duration: string }> } => {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    {
      encoding: 'utf8'
    }
  )
  const data = JSON.parse(out) as {
    format: { duration: string }
    streams: Array<{ codec_type: string; duration: string }>
  }
  return { duration: Number(data.format.duration), streams: data.streams }
}

describe.skipIf(process.platform !== 'linux')('Windows segment ring (simulated)', () => {
  it('records two raw audio tracks into a wrapping ring and saves the last seconds', async () => {
    const ring = join(work, 'ring')
    execFileSync('mkdir', ['-p', ring])
    const pipes = ['desktop', 'mic'].map((name) => {
      const path = join(work, `${name}.pcm`)
      execFileSync('mkfifo', [path])
      return path
    })
    const capture = { ...DEFAULT_SETTINGS.capture, fps: 30, bitrateKbps: 2000, bufferSeconds: 5 }
    const args = buildWindowsArgs({
      capture,
      audio: DEFAULT_SETTINGS.audio,
      outputIndex: 0,
      vendor: 'software',
      segmentDir: ring,
      audioPipes: pipes
    })
      .map((a) => (a.startsWith('ddagrab=') ? 'testsrc2=size=640x360:rate=30' : a))
      .map((a) => (a === 'hwdownload,format=bgra,format=yuv420p' ? 'format=yuv420p' : a))

    const ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    ffmpeg.stderr.on('data', (d: Buffer) => (stderr += d.toString()))

    // Stream 20 ms chunks in real time, like the capture page does: a tone and silence. Each pipe is fed on
    // its own, like the engine's pipe servers: FFmpeg may read one input before it opens the next (6.x does),
    // so opening them one after another from a single thread would deadlock.
    const streams = pipes.map((p) => createWriteStream(p))
    const frames = SAMPLE_RATE / 50
    let t = 0
    const seconds = 9
    for (let chunk = 0; chunk < seconds * 50; chunk++) {
      const tone = new Float32Array(frames * CHANNELS)
      for (let i = 0; i < frames; i++, t++)
        tone.fill(Math.sin((2 * Math.PI * 440 * t) / SAMPLE_RATE) * 0.3, i * 2, i * 2 + 2)
      streams[0]!.write(Buffer.from(tone.buffer))
      streams[1]!.write(Buffer.alloc(frames * CHANNELS * 4))
      await new Promise((r) => setTimeout(r, 20))
    }

    // Save while recording, the way a hotkey would.
    const segments = readdirSync(ring).map((name) => {
      const info = statSync(join(ring, name))
      return { path: join(ring, name), size: info.size, mtimeMs: info.mtimeMs }
    })
    // The ring wraps at bufferSeconds + 3 files, however long it has been recording.
    expect(segments.length).toBeLessThanOrEqual(8)
    const list = join(work, 'list.txt')
    writeFileSync(list, concatList(pickSegments(segments, 3).map((s) => s.path)))
    const output = join(work, 'clip.mp4')
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-map',
      '0',
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      output
    ])

    ffmpeg.stdin.end('q')
    streams.forEach((s) => s.end())
    await new Promise((r) => ffmpeg.once('exit', r))
    expect(stderr).toBe('')

    const clip = probe(output)
    expect(clip.streams.map((s) => s.codec_type)).toEqual(['video', 'audio', 'audio'])
    // 3 s asked for: whole segments, so between 3 and 5 s.
    expect(clip.duration).toBeGreaterThanOrEqual(2.9)
    expect(clip.duration).toBeLessThanOrEqual(5.2)
    // Audio and video cover the same stretch (raw PCM has no timestamps of its own to drift with).
    const [video, ...audio] = clip.streams.map((s) => Number(s.duration))
    for (const track of audio) expect(Math.abs(track - video!)).toBeLessThan(0.25)
  }, 60_000)
})
