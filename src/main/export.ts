import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import { EXPORT_IPC, type ExportJobState, type ExportRequest } from '@shared/ipc'
import { buildExportArgs, PRESETS, progressSeconds, type EncoderSpec } from '@core/export/presets'
import { detectEncoders } from './ffmpeg/hwdetect'
import { addClip, getClip, refreshClip } from './library'
import { stagingDir } from './paths'

interface Job {
  state: ExportJobState
  request: ExportRequest
  abort: AbortController
}

const jobs: Job[] = []
let running = false

function broadcast(): void {
  const states = jobs.map((j) => j.state)
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(EXPORT_IPC.update, states)
}

function update(job: Job, patch: Partial<ExportJobState>): void {
  job.state = { ...job.state, ...patch }
  broadcast()
}

function runEncode(ffmpegPath: string, args: string[], duration: number, job: Job): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: job.abort.signal
    })
    let stderr = ''
    let pending = ''
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)))
    child.stdout.on('data', (d: Buffer) => {
      const lines = (pending + d.toString()).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const done = progressSeconds(line)
        if (done !== null) update(job, { progress: Math.min(0.99, done / duration) })
      }
    })
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(stderr.trim().split('\n').at(-1) || `FFmpeg exited with ${code}`))
    )
  })
}

async function runJob(job: Job): Promise<void> {
  const { request } = job
  const clip = await getClip(request.clipId)
  if (!clip) throw new Error('The clip no longer exists')
  const preset = PRESETS[request.preset]
  const start = Math.max(0, Math.min(request.range.start, clip.duration))
  const end = Math.max(start + 0.1, Math.min(request.range.end, clip.duration))

  // Where the result goes. Replacing writes next to the original first, so a failure never loses the clip.
  let output: string
  if (request.destination === 'replace')
    output = join(dirname(clip.path), `.${basename(clip.path)}.partial.mp4`)
  // New library clips are rendered in the staging folder; addClip files them under a unique name.
  else if (request.destination === 'library') output = join(await stagingDir(), `export-${job.state.id}.mp4`)
  else {
    const path = request.destination.path
    output = extname(path) ? path : `${path}.${preset.extension}`
  }
  await mkdir(dirname(output), { recursive: true })
  update(job, { state: 'running', outputPath: output, progress: 0 })

  const encoders = await detectEncoders()
  // GIFs don't use a video encoder; everything else tries the GPU first and falls back to x264.
  const candidates = request.preset === 'gif' ? encoders.slice(-1) : [encoders[0]!, ...encoders.slice(-1)]
  let lastError: unknown = null
  for (const encoder of [...new Set(candidates)]) {
    const spec: EncoderSpec = encoder
    const args = buildExportArgs({
      preset: request.preset,
      input: clip.path,
      output,
      start,
      end,
      volumes: clip.audioTracks.map((_, i) => request.volumes[i] ?? 1),
      trackTitles: clip.audioTracks,
      width: clip.width,
      height: clip.height,
      fps: clip.fps,
      encoder: spec
    })
    try {
      await runEncode(encoder.ffmpegPath, args, end - start, job)
      lastError = null
      break
    } catch (error) {
      lastError = error
      if (job.abort.signal.aborted) break
      console.warn(`[export] ${encoder.name} failed, trying the next encoder`, error)
    }
  }
  if (lastError) {
    await rm(output, { force: true })
    throw lastError
  }

  if (request.destination === 'replace') {
    await rename(output, clip.path)
    await refreshClip(clip.id)
    output = clip.path
  } else if (request.destination === 'library' && request.preset !== 'gif') {
    const added = await addClip(output, {
      game: clip.gameId
        ? { id: clip.gameId, name: clip.gameName ?? '', source: 'window', iconPath: null, heroPath: null }
        : null,
      bookmark: false,
      title: `${clip.title} (edit)`
    })
    output = added.path
  }
  update(job, { state: 'done', progress: 1, outputPath: output })
}

async function pump(): Promise<void> {
  if (running) return
  running = true
  try {
    for (
      let job = jobs.find((j) => j.state.state === 'queued');
      job;
      job = jobs.find((j) => j.state.state === 'queued')
    ) {
      try {
        await runJob(job)
      } catch (error) {
        if (job.abort.signal.aborted) update(job, { state: 'cancelled', message: null })
        else update(job, { state: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    }
  } finally {
    running = false
  }
}

export function startExport(request: ExportRequest): string {
  const id = randomUUID()
  const job: Job = {
    request,
    abort: new AbortController(),
    state: {
      id,
      clipId: request.clipId,
      name: PRESETS[request.preset].label,
      preset: request.preset,
      outputPath: null,
      state: 'queued',
      progress: 0,
      message: null
    }
  }
  // Keep the list short: finished jobs older than the last ten are forgotten.
  const finished = jobs.filter((j) => !['queued', 'running'].includes(j.state.state))
  for (const old of finished.slice(0, Math.max(0, finished.length - 10))) jobs.splice(jobs.indexOf(old), 1)
  jobs.push(job)
  broadcast()
  void pump()
  return id
}

export function cancelAllExports(): void {
  for (const job of jobs) job.abort.abort()
}

export function registerExportIpc(): void {
  ipcMain.handle(EXPORT_IPC.start, (_e, request: ExportRequest) => startExport(request))
  ipcMain.on(EXPORT_IPC.cancel, (_e, id: string) => {
    const job = jobs.find((j) => j.state.id === id)
    if (!job) return
    job.abort.abort()
    if (job.state.state === 'queued') update(job, { state: 'cancelled' })
  })
  ipcMain.handle(EXPORT_IPC.list, () => jobs.map((j) => j.state))
}
