export type AppConfig = {
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

export type ReplayRecord = {
  ID: number
  UpdatedAt: string
  replay_id: number
  live_key: string
  room_id: number
  title: string
  start_time: number
  end_time: number
  duration: number
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
  status: string
  message: string
  verify_ok: boolean
  actual_duration: number
  streams: StreamSlice[]
}

export type ReplayPatch = Partial<
  Pick<
    ReplayRecord,
    | 'status'
    | 'message'
    | 'progress'
    | 'speed'
    | 'elapsed'
    | 'eta'
    | 'file_path'
    | 'file_size'
    | 'resolution'
    | 'bitrate'
    | 'verify_ok'
    | 'actual_duration'
    | 'replay_id'
    | 'room_id'
    | 'title'
    | 'start_time'
    | 'end_time'
    | 'duration'
    | 'cover_url'
    | 'local_cover'
  >
>

export type StreamSlice = {
  id: number
  replay_id: number
  start_time: number
  end_time: number
  stream: string
  type: number
  m3u8_text: string
}

export type RuntimeSnapshot = {
  paused: boolean
  max_concurrent_tasks: number
  concurrent_segments: number
  downloading_tasks: number
  queued_tasks: number
  paused_tasks: number
  failed_tasks: number
}

export type ScanSummary = {
  fetched: number
  new_records: number
  updated_records: number
  covers_updated: number
  marked_deleted: number
  already_up_to_date: number
}

export type ProgressUpdate = {
  live_key: string
  updated_at: string
  progress: number
  merge_progress: number
  status: string
  message: string
  speed: string
  speed_history: number[]
  elapsed: string
  eta: string
}

export type TaskHandle = {
  controller: AbortController
  promise: Promise<void>
  generation: number
}

export type FileInfo = {
  size: number
  resolution: string
  bitrate: string
}

export type M3U8Segment = {
  url: string
  duration: number
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
  progress: number
  status: 'pending' | 'processing' | 'done' | 'error'
  message: string
}
