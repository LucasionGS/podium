import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import {
  UPLOAD_IPC,
  type UploadJobState,
  type UploadProtocolKind,
  type UploadTarget,
  type UploadTestResult
} from '@shared/ipc'
import { normalizeServerUrl } from '@core/upload/protocol'
import { resolveTarget } from '@core/upload/targets'
import { getClip, recordUpload } from '../library'
import { getToken, setToken, tokenIds } from '../secrets'
import { getSettings } from '../settings'
import { PodiumProtocol } from './podium'
import type { UploadProtocol } from './Protocol'

interface Job {
  state: UploadJobState
  abort: AbortController
}

const jobs: Job[] = []
let running = false
const finishedListeners = new Set<(job: UploadJobState) => void>()

let protocols: Record<UploadProtocolKind, UploadProtocol> | null = null
function protocolFor(target: UploadTarget): UploadProtocol {
  protocols ??= {
    podium: new PodiumProtocol({ userAgent: `Podium/${app.getVersion()} (${process.platform})` })
  }
  return protocols[target.protocol]
}

function broadcast(): void {
  const states = jobs.map((j) => j.state)
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(UPLOAD_IPC.update, states)
}

function update(job: Job, patch: Partial<UploadJobState>): void {
  job.state = { ...job.state, ...patch }
  broadcast()
}

async function sha256(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const part of createReadStream(path, { signal })) hash.update(part as Buffer)
  return hash.digest('hex')
}

async function runJob(job: Job): Promise<void> {
  const clip = await getClip(job.state.clipId)
  if (!clip) throw new Error('The clip no longer exists.')
  const target = resolveTarget((await getSettings()).upload, job.state.targetId)
  if (!target) throw new Error('The upload target was removed. Pick another one in Settings → Uploads.')
  const signal = job.abort.signal

  update(job, { state: 'preparing', progress: 0 })
  const { size } = await stat(clip.path)
  const checksum = await sha256(clip.path, signal)

  update(job, { state: 'uploading' })
  // Progress events come per read buffer; the window only needs to hear about whole percents.
  let lastPercent = -1
  const remote = await protocolFor(target).upload(target, {
    clip,
    path: clip.path,
    fileName: basename(clip.path),
    size,
    sha256: checksum,
    token: await getToken(target.id),
    signal,
    onProgress: (sent) => {
      const percent = Math.floor((sent / size) * 100)
      if (percent === lastPercent) return
      lastPercent = percent
      update(job, { progress: Math.min(1, sent / size) })
    },
    onState: (state) => update(job, { state }),
    onMessage: (message) => update(job, { message })
  })

  await recordUpload(clip.id, {
    targetId: target.id,
    targetName: target.name,
    remoteId: remote.id,
    url: remote.url,
    uploadedAt: Date.now()
  })
  update(job, { state: 'done', progress: 1, url: remote.url, message: null })
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
        else {
          console.warn('[upload]', job.state.clipTitle, error)
          update(job, { state: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      }
      if (job.state.state === 'done' || job.state.state === 'error')
        for (const listener of finishedListeners) listener(job.state)
    }
  } finally {
    running = false
  }
}

/**
 * Queues an upload of a library clip, to the given target or the default one.
 * @throws Error when the clip or the target doesn't exist.
 */
export async function startUpload(clipId: string, targetId?: string | null, auto = false): Promise<string> {
  const clip = await getClip(clipId)
  if (!clip) throw new Error('The clip no longer exists.')
  const target = resolveTarget((await getSettings()).upload, targetId)
  if (!target) throw new Error('Set up an upload target in Settings → Uploads first.')
  const id = randomUUID()
  const job: Job = {
    abort: new AbortController(),
    state: {
      id,
      clipId,
      clipTitle: clip.title,
      targetId: target.id,
      targetName: target.name,
      state: 'queued',
      auto,
      progress: 0,
      url: null,
      message: null
    }
  }
  // Keep the list short: finished jobs older than the last ten are forgotten.
  const finished = jobs.filter((j) => ['done', 'error', 'cancelled'].includes(j.state.state))
  for (const old of finished.slice(0, Math.max(0, finished.length - 10))) jobs.splice(jobs.indexOf(old), 1)
  jobs.push(job)
  broadcast()
  void pump()
  return id
}

/** Called with every upload that finished or failed (not cancelled ones). */
export function onUploadFinished(listener: (job: UploadJobState) => void): void {
  finishedListeners.add(listener)
}

export function cancelAllUploads(): void {
  for (const job of jobs) job.abort.abort()
}

async function testTarget(target: UploadTarget, token: string | null): Promise<UploadTestResult> {
  let url: string
  try {
    url = normalizeServerUrl(target.url)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  // null tests with the saved token; an empty string tests without one.
  const effective = token === null ? await getToken(target.id) : token.trim() || null
  return protocolFor(target).test({ ...target, url }, effective)
}

export function registerUploadIpc(): void {
  ipcMain.handle(UPLOAD_IPC.start, (_e, clipId: string, targetId?: string) => startUpload(clipId, targetId))
  ipcMain.on(UPLOAD_IPC.cancel, (_e, id: string) => {
    const job = jobs.find((j) => j.state.id === id)
    if (!job) return
    job.abort.abort()
    if (job.state.state === 'queued') update(job, { state: 'cancelled' })
  })
  ipcMain.handle(UPLOAD_IPC.list, () => jobs.map((j) => j.state))
  ipcMain.handle(UPLOAD_IPC.test, (_e, target: UploadTarget, token: string | null) =>
    testTarget(target, token)
  )
  ipcMain.handle(UPLOAD_IPC.setToken, (_e, id: string, token: string | null) => setToken(String(id), token))
  ipcMain.handle(UPLOAD_IPC.tokens, async () =>
    Object.fromEntries((await tokenIds()).map((id) => [id, true] as const))
  )
}
