import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Edit3,
  FolderOpen,
  Loader2,
  Music,
  Pause,
  Play,
  RefreshCw,
  Scissors,
  Upload,
} from 'lucide-react'
import type { ClipPageProps, ClipTaskRecord, FeishuRecord, FeishuPageResult } from './types'
import { getErrorMessage } from './utils'
import { useAppStore } from './store'
import { WaveformRequestRegistry } from './utils/waveformRequests'

/** Parse time strings like "1:14:06", "30:00", "90" into seconds */
function parseTimeInput(input: string): number | null {
  const s = input.trim()
  if (!s) return null
  // Pure number → seconds
  const asNum = Number(s)
  if (!isNaN(asNum) && s.match(/^\d+(\.\d+)?$/)) return asNum
  // H:MM:SS or MM:SS
  const parts = s.split(':')
  if (parts.length === 3) {
    const [h, m, sec] = parts.map(Number)
    if ([h, m, sec].some(isNaN)) return null
    return h * 3600 + m * 60 + sec
  }
  if (parts.length === 2) {
    const [m, sec] = parts.map(Number)
    if ([m, sec].some(isNaN)) return null
    return m * 60 + sec
  }
  return null
}

/** Format seconds to H:MM:SS */
function formatTimeInput(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

export function ClipPage({ apiClient, apiBase, showToast, t, clipTasks }: ClipPageProps) {
  const configuredClipOutputDir = useAppStore(state => state.config?.download.clip_output_dir)
  const [url, setUrl] = useState('')
  const [loadedUrl, setLoadedUrl] = useState('')
  const [videoInfo, setVideoInfo] = useState<{ title: string; duration: number; author: string; cover: string; audioProxyPath: string; qualities?: { audio: { id: number; bandwidth: number; codecs: string; baseUrl?: string }[]; video: { id: number; bandwidth: number; codecs: string; width: number; height: number; frameRate: string; baseUrl?: string }[] } } | null>(null)
  const [startTime, setStartTime] = useState(0)
  const [endTime, setEndTime] = useState(30)
  const [clipLoading, setClipLoading] = useState(false)
  const [clipError, setClipError] = useState('')
  const [chunkPeaks, setChunkPeaks] = useState<Record<number, Float32Array>>({})
  const [chunkStatus, setChunkStatus] = useState<Record<number, 'loading' | 'loaded' | 'error'>>({})
  const [playing, setPlaying] = useState(false)
  const [zoomWindow, setZoomWindow] = useState(120)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [audioQualityIndex, setAudioQualityIndex] = useState(0)
  const [videoQualityIndex, setVideoQualityIndex] = useState(0)
  const [clipOutputDir, setClipOutputDir] = useState('')
  const [showClipDialog, setShowClipDialog] = useState(false)
  const [clipTitle, setClipTitle] = useState('')
  const [clipPrefixCut, setClipPrefixCut] = useState(true)
  const [clipSuffixTime, setClipSuffixTime] = useState(true)
  const [clipMode, setClipMode] = useState<'copy' | 'reencode' | 'smart'>('smart')
  const clipOutputRevisionRef = useRef(0)
  const waveformRequestsRef = useRef(new WaveformRequestRegistry())
  const infoRequestRef = useRef<AbortController | null>(null)
  const previewRequestRef = useRef<AbortController | null>(null)
  const previewSequenceRef = useRef(0)

  // --- Feishu song list state ---
  const [feishuOpen, setFeishuOpen] = useState(false)
  const [feishuRecords, setFeishuRecords] = useState<FeishuRecord[]>([])
  const [feishuHasMore, setFeishuHasMore] = useState(false)
  const [feishuNextPageToken, setFeishuNextPageToken] = useState('')
  const [feishuLoading, setFeishuLoading] = useState(false)
  const [feishuLoadingMore, setFeishuLoadingMore] = useState(false)
  const [feishuError, setFeishuError] = useState('')
  const [feishuWritingBack, setFeishuWritingBack] = useState<string | null>(null)
  const [activeFeishuRecord, setActiveFeishuRecord] = useState<FeishuRecord | null>(null)
  const [feishuKeyword, setFeishuKeyword] = useState('')
  const feishuSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const feishuScrollRef = useRef<HTMLDivElement>(null)
  const PAGE_SIZE = 20

  // --- Feishu setup state ---
  const [feishuStatus, setFeishuStatus] = useState<import('./types').FeishuSetupStatus | null>(null)
  const [feishuSetupAppId, setFeishuSetupAppId] = useState('')
  const [feishuSetupSecret, setFeishuSetupSecret] = useState('')
  const [feishuSetupSaving, setFeishuSetupSaving] = useState(false)
  const [feishuSetupStep, setFeishuSetupStep] = useState(1)

  const applyClipOutputDir = useCallback((path: string) => {
    setClipOutputDir(path)
    const { config, setConfig } = useAppStore.getState()
    if (config && config.download.clip_output_dir !== path) {
      setConfig({ ...config, download: { ...config.download, clip_output_dir: path } })
    }
  }, [])

  // The global config is canonical. Selecting only this scalar means unrelated
  // settings edits do not disturb a path the user is currently typing here.
  useEffect(() => {
    if (configuredClipOutputDir !== undefined) {
      clipOutputRevisionRef.current += 1
      setClipOutputDir(configuredClipOutputDir)
    }
  }, [configuredClipOutputDir])

  // Check feishu status on mount
  useEffect(() => {
    apiClient.get('/api/feishu/status').then(res => {
      if (res.data.config) useAppStore.getState().setConfig(res.data.config)
      const { config: _canonicalConfig, ...status } = res.data
      setFeishuStatus(status)
    }).catch(() => {
      setFeishuStatus({ ok: false, stage: 'not_configured', message: '无法连接后端' })
    })
  }, [apiClient])

  // Fetch clip output directory on mount
  useEffect(() => {
    const revision = clipOutputRevisionRef.current
    apiClient.get('/api/clip/output-dir').then(res => {
      // AppController also loads /api/config. Do not let a slower mount request
      // overwrite a path already edited in Settings while ClipPage is hidden.
      if (!useAppStore.getState().config && clipOutputRevisionRef.current === revision) {
        setClipOutputDir(res.data.path || '')
      }
    }).catch(() => {})
  }, [apiClient])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<AudioBufferSourceNode | null>(null)
  const dragRef = useRef<'start' | 'end' | 'pan' | null>(null)
  const panStartRef = useRef<{ x: number; offset: number } | null>(null)

  // Create ONE AudioContext at mount time, never close until unmount
  useEffect(() => {
    const ctx = new AudioContext()
    audioCtxRef.current = ctx
    return () => {
      ctx.close().catch(() => {})
    }
  }, [])

  // No auto-load audio segment here. Handled by the chunk loader effect.

  const fmtTime = useCallback((s: number) => {
    const m = Math.floor(s / 60)
    const sec = (s % 60).toFixed(1)
    return `${m}:${String(sec).padStart(4, '0')}`
  }, [])

  const fmtTimeLong = useCallback((s: number) => {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(1).padStart(4, '0')}`
  }, [])

  const formatBandwidth = (bps: number) => {
    if (bps >= 1000000) return `${(bps / 1000000).toFixed(1)} Mbps`
    if (bps >= 1000) return `${(bps / 1000).toFixed(0)} kbps`
    return `${bps} bps`
  }

  const beginVideoSession = useCallback(() => {
    infoRequestRef.current?.abort()
    infoRequestRef.current = null
    previewRequestRef.current?.abort()
    previewRequestRef.current = null
    previewSequenceRef.current += 1
    try { sourceRef.current?.stop() } catch {}
    sourceRef.current = null
    const generation = waveformRequestsRef.current.beginSession()
    setVideoInfo(null)
    setLoadedUrl('')
    setChunkPeaks({})
    setChunkStatus({})
    setPlaying(false)
    setAudioQualityIndex(0)
    setVideoQualityIndex(0)
    setActiveFeishuRecord(null)
    return generation
  }, [])

  useEffect(() => () => {
    infoRequestRef.current?.abort()
    previewRequestRef.current?.abort()
    previewSequenceRef.current += 1
    waveformRequestsRef.current.beginSession()
  }, [])

  const fetchInfo = async () => {
    const targetUrl = url.trim()
    const generation = beginVideoSession()
    const controller = new AbortController()
    infoRequestRef.current = controller
    setClipLoading(true)
    setClipError('')

    try {
      const res = await apiClient.post('/api/clip/info', { url: targetUrl }, { signal: controller.signal })
      if (!waveformRequestsRef.current.isGenerationCurrent(generation) || controller.signal.aborted) return
      const info = res.data as { title: string; duration: number; author: string; cover: string; audioProxyPath: string; qualities?: { audio: { id: number; bandwidth: number; codecs: string; baseUrl?: string }[]; video: { id: number; bandwidth: number; codecs: string; width: number; height: number; frameRate: string; baseUrl?: string }[] } }
      setVideoInfo(info)
      setLoadedUrl(targetUrl)
      setStartTime(0)
      setEndTime(info.duration)
      setScrollOffset(info.duration / 2)
      setZoomWindow(info.duration + 40)
    } catch (e) {
      if (!waveformRequestsRef.current.isGenerationCurrent(generation) || controller.signal.aborted) return
      setClipError(getErrorMessage(e))
    } finally {
      if (infoRequestRef.current === controller) infoRequestRef.current = null
      if (waveformRequestsRef.current.isGenerationCurrent(generation)) setClipLoading(false)
    }
  }

  const CHUNK_DURATION = 60
  const PEAKS_PER_SEC = 30

  // Progressive Chunk Loader Effect with cancellation
  useEffect(() => {
    if (!videoInfo || !videoInfo.qualities?.audio?.length) return
    const dur = videoInfo.duration
    const totalChunks = Math.ceil(dur / CHUNK_DURATION)
    
    const viewStart = Math.max(0, Math.min(dur - zoomWindow, scrollOffset - zoomWindow / 2))
    const viewEnd = Math.min(dur, viewStart + zoomWindow)
    const viewCenter = (viewStart + viewEnd) / 2

    // Priority function: lower = higher priority
    const chunkPriority = (c: number) => {
      const t = (c + 0.5) * CHUNK_DURATION
      return Math.min(
        Math.abs(t - viewCenter),
        Math.abs(t - startTime),
        Math.abs(t - endTime)
      )
    }

    // Cancel in-flight requests that are now far from the viewport
    const requests = waveformRequestsRef.current
    for (const [chunkIdx, token] of requests.entries()) {
      const priority = chunkPriority(chunkIdx)
      if (priority > 360) { // > 6 minutes away from any focus point
        requests.abort(token)
        setChunkStatus(prev => {
          const next = { ...prev }
          delete next[chunkIdx] // Reset so it can be re-queued later
          return next
        })
      }
    }
    
    // Collect chunks that need loading — only those near the current viewport
    // Buffer: load 2 extra chunks beyond each edge of the visible area
    const BUFFER_CHUNKS = 2
    const visStartChunk = Math.max(0, Math.floor(viewStart / CHUNK_DURATION) - BUFFER_CHUNKS)
    const visEndChunk = Math.min(totalChunks - 1, Math.floor(viewEnd / CHUNK_DURATION) + BUFFER_CHUNKS)
    const loadable: number[] = []
    for (let i = visStartChunk; i <= visEndChunk; i++) {
      if (!chunkStatus[i] && !requests.has(i)) loadable.push(i)
    }
    if (loadable.length === 0) return

    // Sort by priority (closest to user focus first)
    loadable.sort((a, b) => chunkPriority(a) - chunkPriority(b))

    // How many slots are free? (max 3 concurrent)
    const freeSlots = Math.max(0, 3 - requests.size)
    if (freeSlots === 0) return

    const toLoad = loadable.slice(0, freeSlots)
    if (toLoad.length === 0) return

    toLoad.forEach(chunkIdx => {
      const token = requests.create(chunkIdx)
      if (!token) return
      setChunkStatus(prev => ({ ...prev, [chunkIdx]: 'loading' }))
      
      const fetchStart = chunkIdx * CHUNK_DURATION
      const fetchDuration = Math.min(CHUNK_DURATION, dur - fetchStart)
      const lowestQualityAudio = videoInfo.qualities!.audio[videoInfo.qualities!.audio.length - 1]
      const queryParams = new URLSearchParams({
        url: lowestQualityAudio.baseUrl || videoInfo.audioProxyPath.split('?url=')[1] || '',
        start: fetchStart.toString(),
        duration: fetchDuration.toString()
      })
      
      const audioUrl = `/api/clip/audio-proxy?${queryParams.toString()}`
      apiClient.get(audioUrl, { responseType: 'arraybuffer', signal: token.controller.signal }).then(async resp => {
         if (!requests.isCurrent(token)) return
         const ctx = audioCtxRef.current!
         if (ctx.state === 'suspended') await ctx.resume()
         const buffer = await ctx.decodeAudioData(resp.data as ArrayBuffer)
         if (!requests.isCurrent(token)) return
         const data = buffer.getChannelData(0)
         const sampleRate = buffer.sampleRate
         const expectedPeaks = Math.ceil(fetchDuration * PEAKS_PER_SEC)
         const peaks = new Float32Array(expectedPeaks)
         const step = sampleRate / PEAKS_PER_SEC
         for (let i = 0; i < expectedPeaks; i++) {
           const startSample = Math.floor(i * step)
           const endSample = Math.min(data.length, Math.floor((i + 1) * step))
           let max = 0
           for (let j = startSample; j < endSample; j++) {
             const v = Math.abs(data[j])
             if (v > max) max = v
           }
           peaks[i] = max
         }
         setChunkPeaks(prev => ({ ...prev, [chunkIdx]: peaks }))
         setChunkStatus(prev => ({ ...prev, [chunkIdx]: 'loaded' }))
         requests.finish(token)
       }).catch(err => {
          const belongsToCurrentVideo = requests.isGenerationCurrent(token.generation) && requests.owns(token)
          requests.finish(token)
          if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return // Intentional cancel
          if (!belongsToCurrentVideo) return
          console.error('Failed to load chunk', chunkIdx, err)
         setChunkStatus(prev => ({ ...prev, [chunkIdx]: 'error' }))
      })
    })
  }, [videoInfo, startTime, endTime, scrollOffset, zoomWindow, chunkStatus, apiClient])

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !videoInfo) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    const w = rect.width
    const h = rect.height
    canvas.width = w * dpr
    canvas.height = h * dpr
    ctx.scale(dpr, dpr)
    canvas.style.width = w + 'px'
    canvas.style.height = h + 'px'

    const dur = videoInfo.duration
    const viewStart = Math.max(0, Math.min(dur - zoomWindow, scrollOffset - zoomWindow / 2))
    const viewEnd = Math.min(dur, viewStart + zoomWindow)
    const viewDur = Math.max(0.1, viewEnd - viewStart)

    ctx.clearRect(0, 0, w, h)
    const mid = h / 2
    const pixelsPerSecond = w / viewDur
    const startX = (startTime - viewStart) * pixelsPerSecond
    const endX = (endTime - viewStart) * pixelsPerSecond

    const visibleStartChunk = Math.floor(viewStart / CHUNK_DURATION)
    const visibleEndChunk = Math.floor(viewEnd / CHUNK_DURATION)

    // Create striped pattern for loading state
    const pCanvas = document.createElement('canvas')
    pCanvas.width = 20; pCanvas.height = 20;
    const pCtx = pCanvas.getContext('2d')!
    pCtx.fillStyle = 'rgba(241,245,249,0.5)'
    pCtx.fillRect(0, 0, 20, 20)
    pCtx.strokeStyle = 'rgba(226,232,240,0.5)'
    pCtx.lineWidth = 2
    pCtx.beginPath()
    pCtx.moveTo(0, 20); pCtx.lineTo(20, 0)
    pCtx.moveTo(-10, 10); pCtx.lineTo(10, -10)
    pCtx.moveTo(10, 30); pCtx.lineTo(30, 10)
    pCtx.stroke()
    const loadingPattern = ctx.createPattern(pCanvas, 'repeat')

    // Background blocks for loading/unloaded
    for (let c = visibleStartChunk; c <= visibleEndChunk; c++) {
      const cStartT = Math.max(viewStart, c * CHUNK_DURATION)
      const cEndT = Math.min(viewEnd, (c + 1) * CHUNK_DURATION)
      const xStart = (cStartT - viewStart) * pixelsPerSecond
      const xEnd = (cEndT - viewStart) * pixelsPerSecond
      
      const status = chunkStatus[c]
      if (status !== 'loaded') {
         ctx.fillStyle = status === 'loading' ? (loadingPattern || 'rgba(0,161,214,0.1)') : 'rgba(148,163,184,0.05)'
         ctx.fillRect(xStart, 0, xEnd - xStart, h)
      }
    }

    // Peaks
    for (let i = 0; i < w; i++) {
       const t = viewStart + (i / w) * viewDur
       const chunkIdx = Math.floor(t / CHUNK_DURATION)
       const status = chunkStatus[chunkIdx]
       if (status === 'loaded') {
          const peaks = chunkPeaks[chunkIdx]
          if (peaks) {
            const peakIdx = Math.floor((t % CHUNK_DURATION) * PEAKS_PER_SEC)
            const val = peakIdx < peaks.length ? peaks[peakIdx] : 0
            const barH = val * mid * 1.5
            const inRange = t >= startTime && t <= endTime
            ctx.fillStyle = inRange ? 'rgba(0,161,214,0.8)' : 'rgba(148,163,184,0.55)'
            ctx.fillRect(i, mid - barH / 2, 1.5, Math.max(1, barH))
          }
       }
    }

    if (endX > startX) { ctx.fillStyle = 'rgba(0,161,214,0.08)'; ctx.fillRect(startX, 0, endX - startX, h) }

    const drawHandle = (x: number, label: string) => {
      ctx.strokeStyle = 'rgba(0,161,214,0.9)'; ctx.lineWidth = 2
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
      ctx.fillStyle = 'rgba(0,161,214,1)'
      ctx.beginPath(); ctx.arc(x, 0, 6, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#fff'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'
      ctx.fillText(label, Math.max(15, Math.min(w - 15, x)), 16)
    }
    if (startX >= 0 && startX <= w) drawHandle(startX, fmtTime(startTime))
    if (endX >= 0 && endX <= w) drawHandle(endX, fmtTime(endTime))
  }, [chunkPeaks, chunkStatus, startTime, endTime, zoomWindow, scrollOffset, fmtTime, videoInfo])

  useEffect(() => {
    drawWaveform()
  }, [drawWaveform])

  useEffect(() => {
    return () => {
      if (sourceRef.current) {
        try { sourceRef.current.stop() } catch {}
      }
    }
  }, [])

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!videoInfo) return
    const canvas = canvasRef.current; if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const dur = videoInfo.duration
    const viewStart = Math.max(0, Math.min(dur - zoomWindow, scrollOffset - zoomWindow / 2))
    const viewDur = Math.min(dur - viewStart, zoomWindow)
    const pps = rect.width / viewDur
    const startX = (startTime - viewStart) * pps
    const endX = (endTime - viewStart) * pps
    const threshold = 12
    if (Math.abs(x - startX) < threshold) { dragRef.current = 'start' }
    else if (Math.abs(x - endX) < threshold) { dragRef.current = 'end' }
    else {
      dragRef.current = 'pan'
      panStartRef.current = { x: e.clientX, offset: scrollOffset }
    }
  }

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragRef.current || !videoInfo) return
    const canvas = canvasRef.current; if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const dur = videoInfo.duration
    if (dragRef.current === 'pan' && panStartRef.current) {
      const dx = (panStartRef.current.x - e.clientX) * (zoomWindow / rect.width)
      setScrollOffset(Math.max(zoomWindow / 2, Math.min(dur - zoomWindow / 2, panStartRef.current.offset + dx)))
      return
    }
    const viewStart = Math.max(0, Math.min(dur - zoomWindow, scrollOffset - zoomWindow / 2))
    const viewDur = Math.min(dur - viewStart, zoomWindow)
    const t = viewStart + (Math.max(0, Math.min(rect.width, e.clientX - rect.left)) / rect.width) * viewDur
    if (dragRef.current === 'start') setStartTime(Math.max(0, Math.min(endTime - 0.5, t)))
    else setEndTime(Math.max(startTime + 0.5, Math.min(dur, t)))
  }

  const handleCanvasMouseUp = () => { dragRef.current = null; panStartRef.current = null }

  const handleCanvasWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!videoInfo) return
    e.preventDefault()
    const canvas = canvasRef.current; if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const dur = videoInfo.duration
    const viewStart = Math.max(0, Math.min(dur - zoomWindow, scrollOffset - zoomWindow / 2))
    const cursorX = (e.clientX - rect.left) / rect.width
    const cursorTime = viewStart + cursorX * zoomWindow

    if (e.ctrlKey || e.metaKey) {
      const factor = e.deltaY > 0 ? 1.5 : 1 / 1.5
      const newZoom = Math.max(5, Math.min(dur, zoomWindow * factor))
      const newViewStart = cursorTime - cursorX * newZoom
      setZoomWindow(newZoom)
      setScrollOffset(Math.max(newZoom / 2, Math.min(dur - newZoom / 2, newViewStart + newZoom / 2)))
    } else {
      const shift = (e.deltaY / 100) * (zoomWindow / 2)
      setScrollOffset(Math.max(zoomWindow / 2, Math.min(dur - zoomWindow / 2, scrollOffset + shift)))
    }
  }

  const playPreview = async () => {
    if (!videoInfo) return
    const ctx = audioCtxRef.current
    if (!ctx) return
    if (ctx.state === 'closed') return
    if (ctx.state === 'suspended') await ctx.resume()
    if (sourceRef.current) {
      try { sourceRef.current.stop() } catch {}
    }
    previewRequestRef.current?.abort()
    const controller = new AbortController()
    const sequence = ++previewSequenceRef.current
    previewRequestRef.current = controller
    setPlaying(true)
    try {
       const lowestQualityAudio = videoInfo.qualities!.audio[videoInfo.qualities!.audio.length - 1]
       const queryParams = new URLSearchParams({
         url: lowestQualityAudio.baseUrl || videoInfo.audioProxyPath.split('?url=')[1] || '',
         start: startTime.toString(),
         duration: (endTime - startTime).toString()
       })
       const audioUrl = `/api/clip/audio-proxy?${queryParams.toString()}`
       const resp = await apiClient.get(audioUrl, { responseType: 'arraybuffer', signal: controller.signal })
       const buffer = await ctx.decodeAudioData(resp.data as ArrayBuffer)
       if (controller.signal.aborted || previewSequenceRef.current !== sequence) return
       const source = ctx.createBufferSource()
       source.buffer = buffer
       source.connect(ctx.destination)
       source.start(0)
       source.onended = () => {
         if (previewSequenceRef.current === sequence) setPlaying(false)
       }
       sourceRef.current = source
    } catch (e) {
       if (controller.signal.aborted || previewSequenceRef.current !== sequence) return
       console.error(e)
       setPlaying(false)
       showToast({ tone: 'error', title: 'Preview failed', message: getErrorMessage(e) })
    } finally {
       if (previewRequestRef.current === controller) previewRequestRef.current = null
    }
  }

  const stopPreview = () => {
    previewRequestRef.current?.abort()
    previewRequestRef.current = null
    previewSequenceRef.current += 1
    if (sourceRef.current) {
      try { sourceRef.current.stop() } catch {}
      sourceRef.current = null
    }
    setPlaying(false)
  }

  const executeClip = async () => {
    if (!videoInfo || !loadedUrl || loadedUrl !== url.trim()) return
    const selectedAudioQuality = videoInfo.qualities?.audio?.[audioQualityIndex]
    const selectedVideoQuality = videoInfo.qualities?.video?.[videoQualityIndex]
    setClipLoading(true)
    setClipError('')
    try {
      const res = await apiClient.post('/api/clip/execute', { 
        url: loadedUrl,
        title: clipTitle || videoInfo.title,
        startTime, 
        endTime, 
        audioQualityIndex,
        videoQualityIndex,
        audioQualityId: selectedAudioQuality?.id,
        audioQualityCodec: selectedAudioQuality?.codecs,
        videoQualityId: selectedVideoQuality?.id,
        videoQualityCodec: selectedVideoQuality?.codecs,
        prefixCut: clipPrefixCut,
        suffixTime: clipSuffixTime,
        clipMode,
      })
      showToast({ tone: 'success', title: 'Added to Task Queue', message: `Task ID: ${res.data.taskId}` })
      setShowClipDialog(false)
      void apiClient.get<ClipTaskRecord[]>('/api/clip/tasks', { params: { _t: Date.now() } })
        .then(tasks => useAppStore.getState().mergeClipTasks(tasks.data))
        .catch(() => {})
    } catch (e) {
      setClipError(getErrorMessage(e))
      showToast({ tone: 'error', title: 'Failed to add task', message: getErrorMessage(e) })
    }
    setClipLoading(false)
  }

  // --- Feishu setup methods ---
  const saveFeishuSetup = async () => {
    setFeishuSetupSaving(true)
    try {
      const res = await apiClient.post('/api/feishu/config', {
        app_id: feishuSetupAppId.trim(),
        app_secret: feishuSetupSecret.trim(),
      })
      if (res.data.config) useAppStore.getState().setConfig(res.data.config)
      const { config: _canonicalConfig, ...status } = res.data
      setFeishuStatus(status)
      if (status.ok) {
        showToast({ tone: 'success', title: t('feishu.setupSuccess'), message: '' })
        fetchFeishuRecords(true)
      }
    } catch (e) {
      showToast({ tone: 'error', title: t('feishu.setupFailed'), message: getErrorMessage(e) })
    }
    setFeishuSetupSaving(false)
  }

  // --- Feishu song list methods ---
  const fetchFeishuRecords = async (reset = true, searchKeyword?: string) => {
    const kw = searchKeyword !== undefined ? searchKeyword : feishuKeyword
    if (reset) {
      setFeishuLoading(true)
      setFeishuError('')
    } else {
      setFeishuLoadingMore(true)
    }
    try {
      const token = reset ? '' : feishuNextPageToken
      const params = `page_token=${encodeURIComponent(token)}&limit=${PAGE_SIZE}&keyword=${encodeURIComponent(kw)}`
      const res = await apiClient.get<FeishuPageResult>(`/api/feishu/records?${params}`)
      const data = res.data
      if (reset) {
        setFeishuRecords(data.records)
      } else {
        setFeishuRecords(prev => [...prev, ...data.records])
      }
      setFeishuHasMore(data.has_more)
      setFeishuNextPageToken(data.page_token || '')
    } catch (e) {
      const msg = getErrorMessage(e)
      setFeishuError(msg)
      showToast({ tone: 'error', title: t('feishu.fetchFailed'), message: msg })
    }
    setFeishuLoading(false)
    setFeishuLoadingMore(false)
  }

  const handleFeishuFill = (rec: FeishuRecord) => {
    if (!rec.replay_url) {
      showToast({ tone: 'error', title: t('feishu.noReplayUrl'), message: rec.song_name })
      return
    }
    const normalizedUrl = rec.replay_url.replace(/^http:\/\//, 'https://')
    const generation = beginVideoSession()
    setUrl(normalizedUrl)
    setClipTitle(rec.song_name)
    setActiveFeishuRecord(rec)
    const parsedStart = parseTimeInput(rec.start_time)
    const parsedEnd = parseTimeInput(rec.end_time)
    if (parsedStart !== null) setStartTime(parsedStart)
    if (parsedEnd !== null) setEndTime(parsedEnd)
    const controller = new AbortController()
    infoRequestRef.current = controller
    setClipLoading(true)
    setClipError('')
    apiClient.post('/api/clip/info', { url: normalizedUrl }, { signal: controller.signal }).then(res => {
        if (!waveformRequestsRef.current.isGenerationCurrent(generation) || controller.signal.aborted) return
        const info = res.data as any
        setVideoInfo(info)
        setLoadedUrl(normalizedUrl)
        // Keep the feishu times instead of resetting
        const s = parsedStart ?? 0
        const e2 = parsedEnd ?? info.duration
        if (parsedStart === null) setStartTime(0)
        if (parsedEnd === null) setEndTime(info.duration)
        // Zoom to show the selected range with 20s padding on each side
        const rangeLen = e2 - s
        const zoomW = rangeLen + 40 // 20s padding each side
        setZoomWindow(Math.min(zoomW, info.duration + 40))
        setScrollOffset(s + rangeLen / 2)
    }).catch(e => {
      if (!waveformRequestsRef.current.isGenerationCurrent(generation) || controller.signal.aborted) return
      setClipError(getErrorMessage(e))
    }).finally(() => {
      if (infoRequestRef.current === controller) infoRequestRef.current = null
      if (waveformRequestsRef.current.isGenerationCurrent(generation)) setClipLoading(false)
    })
  }

  const handleFeishuWriteback = async (rec: FeishuRecord) => {
    setFeishuWritingBack(rec.record_id)
    try {
      await apiClient.put(`/api/feishu/records/${rec.record_id}`, {
        fields: {
          '录播时间': formatTimeInput(startTime),
          '结束时间': formatTimeInput(endTime),
        }
      })
      showToast({ tone: 'success', title: t('feishu.writebackOk'), message: rec.song_name })
      setFeishuRecords(prev => prev.map(r =>
        r.record_id === rec.record_id
          ? { ...r, start_time: formatTimeInput(startTime), end_time: formatTimeInput(endTime) }
          : r
      ))
    } catch (e) {
      showToast({ tone: 'error', title: t('feishu.writebackFailed'), message: getErrorMessage(e) })
    }
    setFeishuWritingBack(null)
  }

  // Infinite scroll handler
  const handleFeishuScroll = useCallback(() => {
    const el = feishuScrollRef.current
    if (!el || !feishuHasMore || feishuLoadingMore) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 100) {
      fetchFeishuRecords(false)
    }
  }, [feishuHasMore, feishuLoadingMore, feishuNextPageToken])

  const openClipDialog = () => {
    if (!videoInfo || loadedUrl !== url.trim()) return
    if (activeFeishuRecord) {
      const date = activeFeishuRecord.date ? activeFeishuRecord.date.split(' ')[0].replace(/-/g, '') : ''
      setClipTitle(date ? `${date}_${activeFeishuRecord.song_name}` : activeFeishuRecord.song_name)
      setClipPrefixCut(false)
      setClipSuffixTime(false)
    } else {
      setClipTitle(videoInfo.title)
      setClipPrefixCut(true)
      setClipSuffixTime(true)
    }
    setShowClipDialog(true)
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <Scissors className="w-6 h-6 text-[var(--color-bili-blue)]" />
        <h2 className="text-2xl font-bold tracking-tight">{t('common.clip')}</h2>
      </div>

      {/* Feishu Song List Panel */}
      <div className="rounded-2xl border border-slate-200 bg-white/90 backdrop-blur-sm overflow-hidden">
        <button
          onClick={() => {
            const willOpen = !feishuOpen
            setFeishuOpen(willOpen)
            if (willOpen && feishuStatus?.ok && feishuRecords.length === 0) fetchFeishuRecords()
          }}
          className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-slate-50 transition"
        >
          <div className="flex items-center gap-2.5">
            <Music className="w-5 h-5 text-[var(--color-bili-pink)]" />
            <span className="font-semibold text-sm">{t('feishu.songListTitle')}</span>
            {feishuRecords.length > 0 && (
              <span className="text-xs text-slate-400 bg-slate-100 rounded-full px-2 py-0.5">{feishuRecords.length}</span>
            )}
          </div>
          {feishuOpen ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
        </button>

        {feishuOpen && (
          <div className="border-t border-slate-200">
            {/* Toolbar with auth status */}
            {/* Toolbar / Setup */}
            {feishuStatus?.ok ? (
              /* ✅ Ready — show fetch button */
              <div className="flex items-center gap-2 px-5 py-2.5 bg-slate-50/80">
                <span className="flex items-center gap-1.5 text-xs text-green-600 bg-green-50 border border-green-200 rounded-full px-2.5 py-1">
                  <CheckCircle className="w-3 h-3" />
                  {t('feishu.connected')}
                </span>
                <button
                  onClick={() => fetchFeishuRecords(true)}
                  disabled={feishuLoading}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition disabled:opacity-50"
                >
                  {feishuLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  {feishuLoading ? t('feishu.fetchingBtn') : t('feishu.fetchBtn')}
                </button>
                {feishuError && <span className="text-xs text-red-500 truncate">{feishuError}</span>}
              </div>
            ) : (
              /* 🔧 Setup guide */
              <div className="px-5 py-4 bg-gradient-to-b from-slate-50 to-white space-y-3">
                <div className="text-sm text-slate-600">
                  {feishuStatus?.stage === 'no_permission' ? (
                    <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                      <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                      <div>
                        <p className="font-medium text-amber-700">{t('feishu.permissionError')}</p>
                        <p className="text-xs text-amber-600 mt-1">{feishuStatus.hint || t('feishu.permissionHint')}</p>
                        <button
                          onClick={() => apiClient.get('/api/feishu/status').then(r => setFeishuStatus(r.data))}
                          className="mt-2 text-xs text-[var(--color-bili-blue)] hover:underline"
                        >
                          {t('feishu.retryCheck')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {/* Step indicator */}
                      <div className="flex items-center gap-2">
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${feishuSetupStep === 1 ? 'bg-[var(--color-bili-blue)] text-white' : 'bg-slate-200 text-slate-500'}`}>1</div>
                        <div className="h-px w-6 bg-slate-200" />
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${feishuSetupStep === 2 ? 'bg-[var(--color-bili-blue)] text-white' : 'bg-slate-200 text-slate-500'}`}>2</div>
                      </div>

                      {feishuSetupStep === 1 ? (
                        <div className="space-y-3">
                          <p className="text-sm font-medium text-slate-700">{t('feishu.setupStep1Title')}</p>
                          <ol className="text-xs text-slate-500 space-y-1.5 list-decimal list-inside">
                            <li>{t('feishu.setupStep1a')} <a href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer" className="text-[var(--color-bili-blue)] hover:underline">{t('feishu.devConsole')} ↗</a></li>
                            <li>{t('feishu.setupStep1b')}</li>
                            <li>{t('feishu.setupStep1c')}</li>
                          </ol>
                          <button
                            onClick={() => setFeishuSetupStep(2)}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[var(--color-bili-blue)] text-white rounded-lg hover:brightness-110 transition"
                          >
                            {t('feishu.nextStep')}
                          </button>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <p className="text-sm font-medium text-slate-700">{t('feishu.setupStep2Title')}</p>
                          <div className="space-y-2">
                            <input
                              type="text"
                              value={feishuSetupAppId}
                              onChange={e => setFeishuSetupAppId(e.target.value)}
                              placeholder="App ID (cli_xxxxxxxxxxxx)"
                              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-bili-blue)]/30 focus:border-[var(--color-bili-blue)]"
                            />
                            <input
                              type="password"
                              value={feishuSetupSecret}
                              onChange={e => setFeishuSetupSecret(e.target.value)}
                              placeholder="App Secret"
                              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-bili-blue)]/30 focus:border-[var(--color-bili-blue)]"
                            />
                          </div>
                          {feishuStatus?.stage === 'token_failed' && (
                            <p className="text-xs text-red-500">{feishuStatus.message}</p>
                          )}
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => setFeishuSetupStep(1)}
                              className="px-3 py-1.5 text-xs font-medium bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition"
                            >
                              {t('feishu.prevStep')}
                            </button>
                            <button
                              onClick={saveFeishuSetup}
                              disabled={!feishuSetupAppId.trim() || !feishuSetupSecret.trim() || feishuSetupSaving}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[var(--color-bili-blue)] text-white rounded-lg hover:brightness-110 transition disabled:opacity-50"
                            >
                              {feishuSetupSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                              {t('feishu.saveAndVerify')}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Search input */}
            {feishuStatus?.ok && (
              <div className="px-4 py-2 border-b border-slate-100">
                <input
                  type="text"
                  value={feishuKeyword}
                  onChange={e => {
                    const val = e.target.value
                    setFeishuKeyword(val)
                    if (feishuSearchTimer.current) clearTimeout(feishuSearchTimer.current)
                    feishuSearchTimer.current = setTimeout(() => {
                      fetchFeishuRecords(true, val)
                    }, 400)
                  }}
                  placeholder={t('feishu.searchPlaceholder')}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-slate-50 focus:ring-2 focus:ring-[var(--color-bili-blue)] outline-none placeholder:text-slate-400"
                />
              </div>
            )}

            {/* Song list with scroll */}
            <div
              ref={feishuScrollRef}
              onScroll={handleFeishuScroll}
              className="max-h-[360px] overflow-y-auto"
            >
              {feishuLoading && feishuRecords.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-slate-400">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" />
                  {t('feishu.fetchingBtn')}
                </div>
              ) : feishuRecords.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-sm text-slate-400">
                  {t('feishu.empty')}
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {feishuRecords.map((rec) => (
                    <div
                      key={rec.record_id}
                      className="flex items-center gap-3 px-5 py-2.5 hover:bg-slate-50/80 transition group"
                    >
                      {/* Song info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm text-slate-800 truncate">{rec.song_name}</span>
                        </div>
                        <div className="flex items-center gap-3 mt-0.5 text-xs text-slate-400">
                          <span>{rec.date ? rec.date.split(' ')[0] : ''}</span>
                          {rec.start_time && <span>{t('feishu.startTime')}: {rec.start_time}</span>}
                          {rec.end_time && <span>{t('feishu.endTime')}: {rec.end_time}</span>}
                          {rec.replay_link_text && <span className="truncate max-w-[160px]" title={rec.replay_url}>{rec.replay_link_text}</span>}
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => handleFeishuFill(rec)}
                          className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-[var(--color-bili-blue)] text-white rounded-lg hover:brightness-110 transition"
                          title={t('feishu.fillBtn')}
                        >
                          <Play className="w-3 h-3" />
                          {t('feishu.fillBtn')}
                        </button>

                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Load more footer */}
              {feishuRecords.length > 0 && (
                <div className="flex items-center justify-center py-3 border-t border-slate-100">
                  {feishuLoadingMore ? (
                    <div className="flex items-center text-xs text-slate-400">
                      <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                      {t('feishu.loadingMore')}
                    </div>
                  ) : feishuHasMore ? (
                    <button
                      onClick={() => fetchFeishuRecords(false)}
                      className="text-xs font-medium text-[var(--color-bili-blue)] hover:underline"
                    >
                      {t('feishu.loadMore')}
                    </button>
                  ) : (
                    <span className="text-xs text-slate-300">{t('feishu.noMore')}</span>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* URL Input + Fetch */}
      <div className="flex gap-3">
        <input
          value={url}
          onChange={e => {
            const nextUrl = e.target.value
            setUrl(nextUrl)
            if (nextUrl.trim() !== loadedUrl && (videoInfo || infoRequestRef.current || activeFeishuRecord)) {
              beginVideoSession()
            }
          }}
          placeholder="https://www.bilibili.com/video/BV..."
          className="flex-1 px-4 py-3 border border-slate-300 rounded-xl text-sm focus:ring-2 focus:ring-[var(--color-bili-blue)] focus:border-transparent outline-none transition"
          onKeyDown={e => { if (e.key === 'Enter') fetchInfo() }}
        />
        <button
          onClick={fetchInfo}
          disabled={clipLoading || !url.trim()}
          className="px-6 py-3 bg-[var(--color-bili-blue)] text-white font-medium rounded-xl hover:brightness-110 transition disabled:opacity-50"
        >
          {clipLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Fetch Info'}
        </button>
      </div>

      {/* Output Directory */}
      <div className="flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-xl p-3">
        <FolderOpen className="w-4 h-4 text-slate-500 flex-shrink-0" />
        <label className="text-xs font-medium text-slate-500 flex-shrink-0">{t('common.saveTo')}:</label>
        <input
          value={clipOutputDir}
          onChange={e => {
            clipOutputRevisionRef.current += 1
            setClipOutputDir(e.target.value)
          }}
          onBlur={() => {
            const nextPath = clipOutputDir.trim()
            const configuredPath = useAppStore.getState().config?.download.clip_output_dir
            if (!nextPath) {
              clipOutputRevisionRef.current += 1
              setClipOutputDir(configuredPath || '')
              return
            }
            if (nextPath === configuredPath) return
            const revision = clipOutputRevisionRef.current
            apiClient.post('/api/clip/output-dir', { path: nextPath }).then(res => {
              const currentPath = useAppStore.getState().config?.download.clip_output_dir
              if (clipOutputRevisionRef.current !== revision || currentPath !== configuredPath) return
              if (res.data.config) useAppStore.getState().setConfig(res.data.config)
              applyClipOutputDir(res.data.path || nextPath)
            }).catch(e => {
              if (clipOutputRevisionRef.current === revision) setClipOutputDir(configuredPath || '')
              showToast({ tone: 'error', title: t('clipTask.outputDirFailed'), message: getErrorMessage(e) })
            })
          }}
          placeholder="clips"
          className="flex-1 px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-[var(--color-bili-blue)] outline-none bg-white"
        />
        <button
          onClick={async () => {
            const picked = await window.desktopAPI?.pickFolder?.(clipOutputDir)
            if (picked) {
              clipOutputRevisionRef.current += 1
              setClipOutputDir(picked)
              const revision = clipOutputRevisionRef.current
              const configuredPath = useAppStore.getState().config?.download.clip_output_dir
              apiClient.post('/api/clip/output-dir', { path: picked }).then(res => {
                const currentPath = useAppStore.getState().config?.download.clip_output_dir
                if (clipOutputRevisionRef.current !== revision || currentPath !== configuredPath) return
                if (res.data.config) useAppStore.getState().setConfig(res.data.config)
                applyClipOutputDir(res.data.path || picked)
              }).catch(e => {
                if (clipOutputRevisionRef.current === revision) setClipOutputDir(configuredPath || '')
                showToast({ tone: 'error', title: t('clipTask.outputDirFailed'), message: getErrorMessage(e) })
              })
            }
          }}
          className="px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 transition flex-shrink-0"
        >
          {t('common.browse')}
        </button>
      </div>

      {clipError && (
        <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">{clipError}</div>
      )}

      {/* Video Info Card */}
      {videoInfo && (
        <div className="app-card rounded-2xl border border-white/70 bg-white/90 p-5 backdrop-blur-sm space-y-4">
          <div className="flex gap-4">
            {videoInfo.cover && (
              <img
                src={videoInfo.cover.startsWith('http') ? videoInfo.cover : `${apiBase}${videoInfo.cover}`}
                alt=""
                className="w-40 h-24 object-cover rounded-lg flex-shrink-0"
              />
            )}
            <div className="min-w-0">
              <div className="font-semibold text-slate-900 text-lg leading-6 truncate">{videoInfo.title}</div>
              <div className="text-sm text-slate-500 mt-1">By {videoInfo.author}</div>
              <div className="text-sm text-slate-500 mt-0.5">{t('common.duration')}: {fmtTime(videoInfo.duration)}</div>
            </div>
          </div>

          {/* Quality Selectors */}
          {videoInfo.qualities && (
            <div className="flex flex-wrap gap-4">
              {videoInfo.qualities.audio.length > 1 && (
                <div className="flex items-center gap-2">
                  <label className="text-xs font-medium text-slate-600">Audio Quality:</label>
                  <select
                    value={audioQualityIndex}
                    onChange={e => setAudioQualityIndex(Number(e.target.value))}
                    className="px-2 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-[var(--color-bili-blue)] outline-none"
                  >
                    {videoInfo.qualities.audio.map((a, i) => (
                      <option key={`${a.id}:${a.codecs}`} value={i}>
                        {formatBandwidth(a.bandwidth)} {a.codecs ? `(${a.codecs})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {videoInfo.qualities.video.length > 1 && (
                <div className="flex items-center gap-2">
                  <label className="text-xs font-medium text-slate-600">Video Quality:</label>
                  <select
                    value={videoQualityIndex}
                    onChange={e => setVideoQualityIndex(Number(e.target.value))}
                    className="px-2 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-[var(--color-bili-blue)] outline-none"
                  >
                    {videoInfo.qualities.video.map((v, i) => (
                      <option key={`${v.id}:${v.codecs}`} value={i}>
                        {v.width}x{v.height} {formatBandwidth(v.bandwidth)} {v.codecs ? `(${v.codecs})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {/* Time Range Inputs */}
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-slate-600">{t('common.startTime')}:</label>
              <input
                type="text"
                defaultValue={formatTimeInput(startTime)}
                key={`start-${startTime}`}
                onBlur={e => {
                  const parsed = parseTimeInput(e.target.value)
                  if (parsed !== null) setStartTime(Math.max(0, Math.min(endTime - 0.5, parsed)))
                }}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                placeholder="0:00"
                className="w-24 px-2 py-1.5 border border-slate-300 rounded-lg text-sm text-center focus:ring-2 focus:ring-[var(--color-bili-blue)] outline-none"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-slate-600">{t('common.endTime')}:</label>
              <input
                type="text"
                defaultValue={formatTimeInput(endTime)}
                key={`end-${endTime}`}
                onBlur={e => {
                  const parsed = parseTimeInput(e.target.value)
                  if (parsed !== null) setEndTime(Math.max(startTime + 0.5, Math.min(videoInfo.duration, parsed)))
                }}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                placeholder="0:30"
                className="w-24 px-2 py-1.5 border border-slate-300 rounded-lg text-sm text-center focus:ring-2 focus:ring-[var(--color-bili-blue)] outline-none"
              />
            </div>
            <div className="text-xs text-slate-400">({fmtTimeLong(endTime - startTime)} / {fmtTimeLong(videoInfo.duration)})</div>
            {activeFeishuRecord && (
              <button
                onClick={() => handleFeishuWriteback(activeFeishuRecord)}
                disabled={feishuWritingBack === activeFeishuRecord.record_id}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-amber-50 border border-amber-300 text-amber-700 rounded-lg hover:bg-amber-100 transition disabled:opacity-50"
                title={t('feishu.writebackBtn')}
              >
                {feishuWritingBack === activeFeishuRecord.record_id
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Upload className="w-3.5 h-3.5" />}
                {t('feishu.writebackBtn')} ({activeFeishuRecord.song_name})
              </button>
            )}
          </div>

          {/* Range sliders */}
          <div className="relative w-full h-2 bg-slate-200 rounded-lg mt-4 mb-2">
            <style>{`
              .dual-range {
                -webkit-appearance: none;
                appearance: none;
                background: transparent;
                pointer-events: none;
              }
              .dual-range::-webkit-slider-thumb {
                pointer-events: auto;
                -webkit-appearance: none;
                height: 16px;
                width: 16px;
                border-radius: 50%;
                background: var(--color-bili-blue);
                cursor: pointer;
                border: 2px solid white;
                box-shadow: 0 1px 3px rgba(0,0,0,0.3);
              }
            `}</style>
            
            {/* Highlight track between start and end */}
            <div 
              className="absolute h-full bg-[var(--color-bili-blue)] rounded-lg opacity-50 pointer-events-none"
              style={{
                left: `${(startTime / videoInfo.duration) * 100}%`,
                right: `${100 - (endTime / videoInfo.duration) * 100}%`
              }}
            ></div>

            <input
              type="range"
              value={startTime}
              onChange={e => setStartTime(Math.max(0, Math.min(endTime - 0.5, parseFloat(e.target.value))))}
              min="0"
              max={videoInfo.duration}
              step="0.1"
              className="absolute top-0 left-0 w-full h-full dual-range m-0 outline-none"
            />
            <input
              type="range"
              value={endTime}
              onChange={e => setEndTime(Math.max(startTime + 0.5, Math.min(videoInfo.duration, parseFloat(e.target.value))))}
              min="0"
              max={videoInfo.duration}
              step="0.1"
              className="absolute top-0 left-0 w-full h-full dual-range m-0 outline-none"
            />
          </div>
        </div>
      )}

      {/* Waveform */}
      {videoInfo && (
        <div className="app-card rounded-2xl border border-white/70 bg-white/90 p-5 backdrop-blur-sm space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="text-sm font-semibold text-slate-700">Audio Waveform</div>
            <div className="flex items-center gap-3">
              {Object.values(chunkStatus).some(s => s === 'loading') && (
                <div className="flex items-center text-xs text-[var(--color-bili-blue)]">
                  <Loader2 className="w-3 h-3 animate-spin mr-1" />
                  Loading segments...
                </div>
              )}
              <div className="text-xs text-slate-400">
                Ctrl+Wheel zoom · drag to pan · {fmtTime(zoomWindow)} view
              </div>
            </div>
          </div>
          <canvas
            ref={canvasRef}
            className="w-full h-24 rounded-lg bg-slate-50 border border-slate-200 cursor-col-resize"
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp}
            onMouseLeave={handleCanvasMouseUp}
            onWheel={handleCanvasWheel}
          />

          {/* Play/Pause */}
          {Object.keys(chunkPeaks).length > 0 && (
            <div className="flex items-center gap-3">
              <button
                onClick={playing ? stopPreview : playPreview}
                className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-300 rounded-lg text-sm font-medium hover:bg-slate-50 transition"
              >
                {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                {playing ? 'Stop' : 'Play Preview'}
              </button>
              <span className="text-xs text-slate-500">
                {fmtTime(startTime)} – {fmtTime(endTime)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Execute Clip */}
      {videoInfo && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <button
              onClick={openClipDialog}
              disabled={clipLoading}
              className="flex items-center gap-2 px-6 py-3 bg-[var(--color-bili-pink)] text-white font-medium rounded-xl hover:brightness-110 transition disabled:opacity-50 shadow-sm"
            >
              {clipLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Scissors className="w-5 h-5" />}
              {t('clipTask.addToTasks')}
            </button>
          </div>

          {clipTasks && clipTasks.filter(task => task.url.trim() === loadedUrl).length > 0 && (
            <div className="space-y-2 mt-2 max-w-xl">
              <div className="text-sm font-semibold text-slate-700 mb-2">{t('clipTask.tasksForVideo')}</div>
              {clipTasks.filter(task => task.url.trim() === loadedUrl).map(task => (
                <div key={task.id} className="bg-white border border-slate-200 rounded-lg p-3 shadow-sm flex flex-col gap-2">
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium text-slate-800 truncate pr-2">{task.title}</span>
                    <div className="flex items-center gap-2">
                      {(task.status === 'processing' || task.status === 'pending') && (
                        <button
                          onClick={() => {
                            apiClient.post(`/api/clip/cancel/${task.id}`).then(() => {
                              useAppStore.getState().upsertClipTask({
                                ...task,
                                status: 'error',
                                message: 'Cancelled',
                                file_path: '',
                                updated_at: task.updated_at,
                              })
                              return apiClient.get<ClipTaskRecord[]>('/api/clip/tasks', { params: { _t: Date.now() } })
                            }).then(response => {
                              if (response) useAppStore.getState().mergeClipTasks(response.data)
                            }).catch(error => {
                              showToast({ tone: 'error', title: t('clipTask.failed'), message: getErrorMessage(error) })
                            })
                          }}
                          className="text-[10px] text-slate-500 hover:text-red-500 hover:underline px-1 cursor-pointer"
                        >
                          {t('clipTask.cancel') || 'Cancel'}
                        </button>
                      )}
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${task.status === 'done' ? 'bg-green-100 text-green-700' : task.status === 'error' ? 'bg-red-100 text-red-700' : 'bg-[var(--color-bili-blue)] text-white'}`}>
                        {task.status}
                      </span>
                    </div>
                  </div>
                  {(task.status === 'processing' || task.status === 'pending') && (
                    <>
                      <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                        <div className="bg-[var(--color-bili-blue)] h-1.5 rounded-full transition-all duration-300" style={{ width: `${task.progress}%` }} />
                      </div>
                      {task.message && <div className="text-xs text-slate-500 mt-0.5">{task.message}</div>}
                    </>
                  )}
                  {task.status === 'error' && <div className="text-xs text-red-500 truncate" title={task.message}>{task.message}</div>}
                  {task.status === 'done' && task.message && <div className="text-xs text-green-600 mt-0.5">{task.message}</div>}
                  {task.status === 'done' && (
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-green-600 truncate flex-1" title={task.file_path}>{task.file_path}</span>
                      <button
                        onClick={() => { void apiClient.post('/api/clip/open-file', { filePath: task.file_path }).catch(error => showToast({ tone: 'error', title: t('messages.openFailed'), message: getErrorMessage(error) })) }}
                        className="text-xs text-[var(--color-bili-blue)] hover:underline flex-shrink-0"
                        title={t('clipTask.openFile')}
                      >
                        {t('clipTask.openFile')}
                      </button>
                      <button
                        onClick={() => { void apiClient.post('/api/clip/open-folder', { filePath: task.file_path }).catch(error => showToast({ tone: 'error', title: t('messages.openFailed'), message: getErrorMessage(error) })) }}
                        className="text-xs text-[var(--color-bili-blue)] hover:underline flex-shrink-0"
                        title={t('clipTask.openFolder')}
                      >
                        {t('clipTask.openFolder')}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Clip Naming Dialog */}
      {showClipDialog && videoInfo && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-[100]"
          onClick={e => { if (e.target === e.currentTarget) setShowClipDialog(false) }}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden app-scale-in">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center gap-3">
              <Scissors className="w-5 h-5 text-[var(--color-bili-pink)]" />
              <div className="font-bold text-lg">{t('clipTask.clipSettings')}</div>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  <Edit3 className="w-3.5 h-3.5 inline mr-1" />
                  {t('clipTask.fileName')}
                </label>
                <input
                  value={clipTitle}
                  onChange={e => setClipTitle(e.target.value)}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:ring-2 focus:ring-[var(--color-bili-pink)] focus:border-transparent outline-none transition"
                  placeholder={videoInfo.title}
                  autoFocus
                  onKeyDown={e => { if (e.key === 'Enter' && clipTitle.trim()) executeClip() }}
                />
              </div>
              <div className="flex items-center gap-4 text-sm text-slate-500 bg-slate-50 rounded-xl p-3">
                <div><span className="font-medium text-slate-700">Start:</span> {formatTimeInput(startTime)}</div>
                <div><span className="font-medium text-slate-700">End:</span> {formatTimeInput(endTime)}</div>
                <div><span className="font-medium text-slate-700">Duration:</span> {formatTimeInput(endTime - startTime)}</div>
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-500 bg-slate-50 rounded-xl p-3">
                <span className="font-medium text-slate-700">{t('clipTask.preview')}:</span>
                <span className="text-slate-600">
                  {clipPrefixCut ? '[cut] ' : ''}{clipTitle}{clipSuffixTime ? ` (${formatTimeInput(startTime)}-${formatTimeInput(endTime)})` : ''}.mp4
                </span>
              </div>
              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={clipPrefixCut}
                    onChange={e => setClipPrefixCut(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-300 text-[var(--color-bili-pink)] focus:ring-[var(--color-bili-pink)]"
                  />
                  {t('clipTask.prefixCut')}
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={clipSuffixTime}
                    onChange={e => setClipSuffixTime(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-300 text-[var(--color-bili-pink)] focus:ring-[var(--color-bili-pink)]"
                  />
                  {t('clipTask.suffixTime')}
                </label>
              </div>
              {/* Clip Mode Selector */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">{t('clipTask.clipMode')}</label>
                <div className="space-y-2">
                  {[
                    { value: 'smart' as const, label: t('clipTask.modeSmart') || 'Smart Cut', desc: t('clipTask.modeSmartDesc') || 'Fast & precise (recommended)' },
                    { value: 'copy' as const, label: t('clipTask.modeCopy'), desc: t('clipTask.modeCopyDesc') },
                    { value: 'reencode' as const, label: t('clipTask.modeReencode'), desc: t('clipTask.modeReencodeDesc') },
                  ].map(opt => (
                    <label
                      key={opt.value}
                      className={`flex items-start gap-3 p-3 rounded-xl cursor-pointer border transition ${
                        clipMode === opt.value
                          ? 'border-[var(--color-bili-pink)] bg-pink-50/50'
                          : 'border-slate-200 hover:border-slate-300 bg-white'
                      }`}
                    >
                      <input
                        type="radio"
                        name="clipMode"
                        value={opt.value}
                        checked={clipMode === opt.value}
                        onChange={() => setClipMode(opt.value)}
                        className="mt-0.5 w-4 h-4 text-[var(--color-bili-pink)] focus:ring-[var(--color-bili-pink)]"
                      />
                      <div>
                        <div className="text-sm font-medium text-slate-800">{opt.label}</div>
                        <div className="text-xs text-slate-500 mt-0.5">{opt.desc}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-3 bg-slate-50">
              <button
                onClick={() => setShowClipDialog(false)}
                className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition"
              >
                {t('clipTask.cancel')}
              </button>
              <button
                onClick={executeClip}
                disabled={clipLoading || !clipTitle.trim()}
                className="flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-[var(--color-bili-pink)] rounded-lg hover:brightness-110 transition disabled:opacity-50"
              >
                {clipLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scissors className="w-4 h-4" />}
                {t('clipTask.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
