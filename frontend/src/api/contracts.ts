import type { AxiosInstance } from 'axios'
import type { Replay } from '../types'

type PostClient = Pick<AxiosInstance, 'post'>

export function scanReplays(apiClient: PostClient) {
  return apiClient.post('/api/scan')
}

export function deleteReplayFile(apiClient: PostClient, liveKey: string) {
  return apiClient.post<Replay>(`/api/replays/${encodeURIComponent(liveKey)}/delete-file`)
}

export function quitDesktopApp(desktopAPI?: { quitApp?: () => Promise<void> }) {
  if (!desktopAPI?.quitApp) {
    return Promise.reject(new Error('Desktop quit is unavailable'))
  }
  return desktopAPI.quitApp()
}
