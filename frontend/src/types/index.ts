import type { AxiosInstance } from 'axios'

export interface Replay {
  ID: number
  UpdatedAt: string
  replay_id: number
  live_key: string
  title: string
  start_time: number
  end_time: number
  duration: number
  status: string
  message: string
  output_state?: 'available' | 'unavailable' | 'ownership_changed' | 'unknown' | 'not_applicable'
  portable_relocation_pending?: boolean
  file_path: string
  cover_url: string
  local_cover: string
  file_size: number
  resolution: string
  bitrate: string
  progress: number
  speed: string
  elapsed: string
  eta: string
  verify_ok: boolean
  actual_duration: number
  cover_src?: string
  streams?: StreamSlice[]
}

export interface StreamSlice {
  replay_id: number
  start_time: number
  end_time: number
  stream: string
  type: number
  m3u8_text: string
}

export interface Config {
  bilibili: {
    anchor_id: number
    cookies: Record<string, string>
    cookie_file: string
  }
  download: {
    output_dir: string
    temp_dir: string
    filename_template: string
    max_concurrent_tasks: number
    concurrent_segments: number
    clip_output_dir: string
  }
  database: {
    dsn: string
  }
  server: {
    port: number
  }
  feishu: {
    app_id: string
    app_secret: string
    base_token: string
    table_id: string
  }
}

export interface Progress {
  live_key: string
  updated_at?: string
  progress: number
  merge_progress: number
  status: string
  message: string
  speed: string
  speed_history: number[]
  elapsed: string
  eta: string
}

export interface Me {
  logged_in: boolean
  uname: string
  face: string
}

export interface Runtime {
  paused: boolean
  max_concurrent_tasks: number
  concurrent_segments: number
  downloading_tasks: number
  queued_tasks: number
  paused_tasks: number
  failed_tasks: number
}

export interface ScanSummary {
  fetched: number
  new_records: number
  updated_records: number
  covers_updated: number
  marked_deleted: number
  unavailable_outputs: number
  already_up_to_date: number
}

export interface DiskStats {
  path: string
  total_bytes: number
  free_bytes: number
  used_by_service_bytes: number
}

export type PageKey = 'downloads' | 'settings' | 'clip'

export type FsEntry = { name: string; path: string }
export type FsListResponse = { current: string; parent: string; entries: FsEntry[] }

export type ToastTone = 'loading' | 'success' | 'error' | 'info'
export type Toast = { id: number; tone: ToastTone; title: string; message?: string }

export interface ClipPageProps {
  apiClient: AxiosInstance
  apiBase: string
  showToast: (toast: { tone: ToastTone; title: string; message?: string; durationMs?: number }) => void
  t: (key: string, options?: any) => string
  clipTasks: ClipTaskRecord[]
}

export type ClipTaskRecord = {
  id: number
  created_at: string
  updated_at: string
  url: string
  title: string
  start_time: number
  end_time: number
  file_path: string
  part_path: string
  artifact_state: '' | 'building' | 'built' | 'verified' | 'published_cleanup' | 'cleanup_pending'
  artifact_identity: string
  part_identity?: string
  portable_relocation_pending?: boolean
  output_state?: 'available' | 'unavailable' | 'ownership_changed' | 'unknown' | 'not_applicable'
  progress: number
  status: 'pending' | 'processing' | 'cancelling' | 'done' | 'error'
  message: string
}

export type FeishuRecord = {
  record_id: string
  song_name: string
  replay_url: string
  replay_link_text: string
  start_time: string
  end_time: string
  date: string
}

export type FeishuPageResult = {
  records: FeishuRecord[]
  has_more: boolean
  page_token: string
  total: number
}

export type FeishuSetupStatus = {
  ok: boolean
  stage: 'not_configured' | 'token_failed' | 'no_permission' | 'ready'
  message: string
  hint?: string
}
