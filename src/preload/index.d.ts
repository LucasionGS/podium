import type { PodiumApi } from '@shared/ipc'

declare global {
  interface Window {
    podium: PodiumApi
  }
}
