import { create } from 'zustand'
import type { ClipView, UploadJobState } from '@shared/ipc'
import { resolveTarget } from '@core/upload/targets'
import { navigate, useApp } from './app'
import { toast } from './feedback'

interface UploadsState {
  jobs: UploadJobState[]
  /** Targets that have a saved token. */
  tokens: Record<string, boolean>
}

export const useUploads = create<UploadsState>(() => ({ jobs: [], tokens: {} }))

export const ACTIVE_STATES: ReadonlyArray<UploadJobState['state']> = [
  'queued',
  'preparing',
  'uploading',
  'finishing'
]
export const isActive = (job: UploadJobState): boolean => ACTIVE_STATES.includes(job.state)

let wired = false

/** Mirrors main's upload queue and announces finished uploads. */
export function wireUploads(): void {
  if (wired) return
  wired = true
  window.podium.uploads.onUpdate((jobs) => {
    const before = new Map(useUploads.getState().jobs.map((j) => [j.id, j.state]))
    const copyLink = useApp.getState().settings?.upload.copyLink
    for (const job of jobs) {
      if (before.get(job.id) === job.state) continue
      if (job.state === 'done')
        toast(
          `Uploaded “${job.clipTitle}” to ${job.targetName}${job.url && copyLink ? ' · link copied' : ''}`,
          'success'
        )
      if (job.state === 'error')
        toast(`Upload to ${job.targetName} failed: ${job.message ?? 'unknown error'}`, 'error')
    }
    useUploads.setState({ jobs })
  })
  void window.podium.uploads.list().then((jobs) => useUploads.setState({ jobs }))
  void refreshTokens()
}

export async function refreshTokens(): Promise<void> {
  useUploads.setState({ tokens: await window.podium.uploads.tokens() })
}

/** Uploads a clip, or sends the user to set up a target when there is none yet. */
export async function uploadClip(clip: ClipView, targetId?: string): Promise<void> {
  const settings = useApp.getState().settings
  const target = settings ? resolveTarget(settings.upload, targetId) : null
  if (!target) {
    toast('Set up an upload target first.')
    navigate({ view: 'settings', tab: 'uploads' })
    return
  }
  try {
    await window.podium.uploads.start(clip.id, target.id)
    toast(`Uploading “${clip.title}” to ${target.name}…`)
  } catch (error) {
    toast(
      error instanceof Error
        ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
        : String(error),
      'error'
    )
  }
}

/** The most recent link a clip was uploaded to, if any. */
export const latestLink = (clip: ClipView): string | null =>
  [...clip.uploads].reverse().find((u) => u.url)?.url ?? null
