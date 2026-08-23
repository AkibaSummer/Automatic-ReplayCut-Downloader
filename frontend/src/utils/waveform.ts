export const WAVEFORM_CHUNK_DURATION_SECONDS = 60
export const DEFAULT_WAVEFORM_WINDOW_SECONDS = 120
export const PREVIEW_DURATION_LIMIT_SECONDS = 60

type ApiErrorLike = {
  message?: string
  response?: {
    data?: unknown
    status?: number
    statusText?: string
  }
}

export function initialWaveformViewport(duration: number) {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0
  const zoomWindow = Math.min(safeDuration, DEFAULT_WAVEFORM_WINDOW_SECONDS)
  return {
    zoomWindow,
    scrollOffset: zoomWindow / 2,
  }
}

function decodeErrorPayload(data: unknown) {
  let text = ''
  if (data instanceof ArrayBuffer) {
    text = new TextDecoder().decode(data)
  } else if (ArrayBuffer.isView(data)) {
    text = new TextDecoder().decode(data)
  } else if (typeof data === 'string') {
    text = data
  } else if (data && typeof data === 'object' && 'error' in data) {
    const error = (data as { error?: unknown }).error
    return typeof error === 'string' ? error : ''
  }
  if (!text) return ''
  try {
    const parsed = JSON.parse(text) as { error?: unknown }
    return typeof parsed.error === 'string' ? parsed.error : ''
  } catch {
    return ''
  }
}

export function waveformRequestErrorMessage(error: unknown) {
  const candidate = error && typeof error === 'object' ? error as ApiErrorLike : {}
  const upstreamMessage = decodeErrorPayload(candidate.response?.data)
  if (upstreamMessage) return upstreamMessage
  const status = candidate.response?.status
  if (status) {
    const statusText = candidate.response?.statusText || ''
    return `HTTP ${status}${statusText ? ` ${statusText}` : ''}`
  }
  return candidate.message || 'Unknown error'
}
