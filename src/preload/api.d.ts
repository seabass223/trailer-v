import type { TrailerApi } from '../shared/ipc'

declare global {
  interface Window {
    api: TrailerApi
  }
}

export {}
