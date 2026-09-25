import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const electron = createRequire(import.meta.url)('electron') as unknown as string
const root = resolve(import.meta.dirname, '../..')
let workDir: string
let library: string

/**
 * Runs the built app offscreen with the fake capture engine, executes `script` in the page
 * (it gets `window.podium`) and returns what the script resolved with.
 */
function runApp(script: string, name: string): unknown {
  const scriptPath = join(workDir, `${name}.js`)
  writeFileSync(scriptPath, `(async () => JSON.stringify(await (async () => { ${script} })()))()`)
  const run = spawnSync(electron, [root, ...(process.env['CI'] ? ['--no-sandbox'] : [])], {
    env: {
      ...process.env,
      PODIUM_BACKEND: 'fake',
      PODIUM_LIBRARY_DIR: library,
      PODIUM_SCREENSHOT: join(workDir, `${name}.png`),
      PODIUM_DEBUG_SCRIPT: scriptPath,
      PODIUM_SCREENSHOT_DELAY: '1500'
    },
    timeout: 150_000,
    encoding: 'utf8'
  })
  const line = run.stdout.split('\n').find((l) => l.startsWith('[script] '))
  if (!line) throw new Error(`No script result.\nstdout: ${run.stdout}\nstderr: ${run.stderr}`)
  return JSON.parse(line.slice('[script] '.length))
}

function probe(path: string): { duration: number; streams: Array<{ codec_type: string; width?: number }> } {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    {
      encoding: 'utf8'
    }
  )
  const data = JSON.parse(out) as {
    format: { duration: string }
    streams: Array<{ codec_type: string; width?: number }>
  }
  return { duration: Number(data.format.duration), streams: data.streams }
}

const videos = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.mp4') && !f.startsWith('.'))
    .map((f) => join(dir, f))

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'podium-e2e-'))
  library = join(workDir, 'library')
})

afterAll(() => rmSync(workDir, { recursive: true, force: true }))

describe('clip → library → export', () => {
  it('saves clips from the buffer into the library with separate audio tracks', () => {
    const result = runApp(
      `
      const clip = await window.podium.capture.save({ kind: 'clip', seconds: 3 })
      const bookmark = await window.podium.capture.save({ kind: 'bookmark' })
      return { clip, bookmark, list: await window.podium.library.list() }
    `,
      'save'
    ) as {
      clip: { path: string; audioTracks: string[]; duration: number }
      bookmark: { bookmark: boolean }
      list: unknown[]
    }

    expect(result.list).toHaveLength(2)
    expect(result.bookmark.bookmark).toBe(true)
    expect(result.clip.audioTracks).toEqual(['Desktop', 'Microphone'])
    expect(result.clip.path.startsWith(join(library, 'Desktop'))).toBe(true)
    const info = probe(result.clip.path)
    expect(info.duration).toBeCloseTo(3, 0)
    expect(info.streams.filter((s) => s.codec_type === 'audio')).toHaveLength(2)
    // The staging folder is emptied as clips are filed.
    expect(readdirSync(join(library, '.podium'))).toEqual([])
  })

  it('adopts files already in the folder and exports every preset', () => {
    const out = join(workDir, 'exports')
    const result = runApp(
      `
      const clips = await window.podium.library.list()
      const clip = clips.find((c) => c.duration < 5)
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const run = async (preset, destination, volumes) => {
        const id = await window.podium.exports.start({ clipId: clip.id, preset, range: { start: 0.5, end: 2.5 }, volumes, destination })
        for (;;) {
          const job = (await window.podium.exports.list()).find((j) => j.id === id)
          if (!['queued', 'running'].includes(job.state)) return job
          await wait(100)
        }
      }
      const jobs = {
        discord: await run('discord', { path: ${JSON.stringify(join(out, 'discord.mp4'))} }, [1, 1]),
        gif: await run('gif', { path: ${JSON.stringify(join(out, 'clip.gif'))} }, [1, 1]),
        mutedMic: await run('high', { path: ${JSON.stringify(join(out, 'high.mp4'))} }, [1, 0]),
        copy: await run('tracks', 'library', [1, 0.5])
      }
      return { jobs, count: (await window.podium.library.list()).length }
    `,
      'export'
    ) as {
      jobs: Record<string, { state: string; message: string | null; outputPath: string }>
      count: number
    }

    for (const [name, job] of Object.entries(result.jobs))
      expect(job.state, `${name}: ${job.message}`).toBe('done')
    // Two clips adopted from the folder (the profile, and so the index, is new each run) plus the copy.
    expect(result.count).toBe(3)

    const discord = probe(join(out, 'discord.mp4'))
    expect(discord.duration).toBeCloseTo(2, 0)
    expect(statSync(join(out, 'discord.mp4')).size).toBeLessThan(10_000_000)
    expect(discord.streams.filter((s) => s.codec_type === 'audio')).toHaveLength(1)

    expect(probe(join(out, 'clip.gif')).streams[0]?.width).toBe(480)
    // The muted microphone is left out of the mix entirely.
    expect(probe(join(out, 'high.mp4')).streams.filter((s) => s.codec_type === 'audio')).toHaveLength(1)

    const copy = result.jobs['copy']!.outputPath
    expect(existsSync(copy)).toBe(true)
    expect(probe(copy).streams.filter((s) => s.codec_type === 'audio')).toHaveLength(2)
    expect(videos(library)).toHaveLength(3)
  })
})
