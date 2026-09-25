import { create } from 'zustand'
import type { ExportJobState, ExportRequest } from '@shared/ipc'
import { toast } from './feedback'

interface ExportsState {
  jobs: ExportJobState[]
}

export const useExports = create<ExportsState>(() => ({ jobs: [] }))

let wired = false

/** Mirrors main's export queue and announces finished jobs. */
export function wireExports(): void {
  if (wired) return
  wired = true
  window.podium.exports.onUpdate((jobs) => {
    const before = new Map(useExports.getState().jobs.map((j) => [j.id, j.state]))
    for (const job of jobs) {
      const previous = before.get(job.id)
      if (previous === job.state) continue
      if (job.state === 'done') toast(`${job.name}: done`, 'success')
      if (job.state === 'error') toast(`${job.name} failed: ${job.message ?? 'unknown error'}`, 'error')
    }
    useExports.setState({ jobs })
  })
  void window.podium.exports.list().then((jobs) => useExports.setState({ jobs }))
}

export const startExport = (request: ExportRequest): Promise<string> => window.podium.exports.start(request)
