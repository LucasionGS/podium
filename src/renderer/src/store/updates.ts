import { create } from 'zustand'
import type { UpdateStatus } from '@shared/ipc'
import { confirm } from './feedback'

interface UpdatesState {
  status: UpdateStatus | null
}

export const useUpdates = create<UpdatesState>(() => ({ status: null }))

let wired = false

/** Mirrors main's updater and offers the restart as soon as an update is installed. */
export function wireUpdates(): void {
  if (wired) return
  wired = true
  window.podium.updates.onChanged((status) => {
    const before = useUpdates.getState().status?.state
    useUpdates.setState({ status })
    if (status.state === 'ready' && before !== 'ready') void offerRestart(status)
  })
  void window.podium.updates.status().then((status) => useUpdates.setState({ status }))
}

async function offerRestart(status: UpdateStatus): Promise<void> {
  const answer = await confirm({
    title: `Podium ${status.available?.version ?? ''} is installed`,
    message: 'Restart now to start using it. The replay buffer starts again right away.',
    confirmLabel: 'Restart now',
    cancelLabel: 'Later'
  })
  if (answer === 'confirm') window.podium.updates.restart()
}

export const installUpdate = (): Promise<void> => window.podium.updates.install()
export const checkForUpdates = async (): Promise<void> => {
  useUpdates.setState({ status: await window.podium.updates.check() })
}
