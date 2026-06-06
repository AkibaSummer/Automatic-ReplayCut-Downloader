import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CheckCircle,
  Edit3,
  FolderOpen,
  Loader2,
  Pause,
  Play,
  Scissors,
} from 'lucide-react'
import type { ClipPageProps } from './types'
import { getErrorMessage } from './utils'

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
  const [url, setUrl] = useState('')
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

  // Fetch clip output directory on mount
  useEffect(() => {
    apiClient.get('/api/clip/output-dir').then(res => {
      setClipOutputDir(res.data.path || '')
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

  const fetchInfo = async () => {
    setClipLoading(true)
    setClipError('')
    setVideoInfo(null)
    setChunkPeaks({})
    setChunkStatus({})

    setAudioQualityIndex(0)
    try {
      const res = await apiClient.post('/api/clip/info', { url })
      const info = res.data as { title: string; duration: number; author: string; cover: string; audioProxyPath: string; qualities?: { audio: { id: number; bandwidth: number; codecs: string; baseUrl?: string }[]; video: { id: number; bandwidth: number; codecs: string; width: number; height: number; frameRate: string; baseUrl?: string }[] } }
      setVideoInfo(info)
      setStartTime(0)
      setEndTime(Math.min(info.duration, 30))
      setScrollOffset(Math.min(info.duration, 30) / 2)
      setZoomWindow(120)
    } catch (e) {
      setClipError(getErrorMessage(e))
    }
    setClipLoading(false)
  }

  const CHUNK_DURATION = 60
  const PEAKS_PER_SEC = 30

  // Track in-flight requests so we can cancel low-priority ones
  const inflightRef = useRef<Map<number, AbortController>>(new Map())

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
    const inflight = inflightRef.current
    for (const [chunkIdx, controller] of inflight.entries()) {
      const priority = chunkPriority(chunkIdx)
      if (priority > 360) { // > 6 minutes away from any focus point
        controller.abort()
        inflight.delete(chunkIdx)
        setChunkStatus(prev => {
          const next = { ...prev }
          delete next[chunkIdx] // Reset so it can be re-queued later
          return next
        })
      }
    }
    
    // Collect chunks that need loading (not loaded, not currently in-flight)
    const loadable: number[] = []
    for (let i = 0; i < totalChunks; i++) {
      if (!chunkStatus[i] && !inflight.has(i)) loadable.push(i)
    }
    if (loadable.length === 0) return

    // Sort by priority (closest to user focus first)
    loadable.sort((a, b) => chunkPriority(a) - chunkPriority(b))

    // How many slots are free? (max 3 concurrent)
    const freeSlots = Math.max(0, 3 - inflight.size)
    if (freeSlots === 0) return

    // Only load chunks within a reasonable distance
    const toLoad = loadable.slice(0, freeSlots).filter(c => chunkPriority(c) < 600)
    if (toLoad.length === 0) return

    toLoad.forEach(chunkIdx => {
      const controller = new AbortController()
      inflight.set(chunkIdx, controller)
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
      apiClient.get(audioUrl, { responseType: 'arraybuffer', signal: controller.signal }).then(async resp => {
         inflight.delete(chunkIdx)
         const ctx = audioCtxRef.current!
         if (ctx.state === 'suspended') await ctx.resume()
         const buffer = await ctx.decodeAudioData(resp.data as ArrayBuffer)
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
      }).catch(err => {
         inflight.delete(chunkIdx)
         if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return // Intentional cancel
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
    
    setPlaying(true)
    try {
       const lowestQualityAudio = videoInfo.qualities!.audio[videoInfo.qualities!.audio.length - 1]
       const queryParams = new URLSearchParams({
         url: lowestQualityAudio.baseUrl || videoInfo.audioProxyPath.split('?url=')[1] || '',
         start: startTime.toString(),
         duration: (endTime - startTime).toString()
       })
       const audioUrl = `/api/clip/audio-proxy?${queryParams.toString()}`
       const resp = await apiClient.get(audioUrl, { responseType: 'arraybuffer' })
       const buffer = await ctx.decodeAudioData(resp.data as ArrayBuffer)
       const source = ctx.createBufferSource()
       source.buffer = buffer
       source.connect(ctx.destination)
       source.start(0)
       source.onended = () => setPlaying(false)
       sourceRef.current = source
    } catch (e) {
       console.error(e)
       setPlaying(false)
       showToast({ tone: 'error', title: 'Preview failed', message: getErrorMessage(e) })
    }
  }

  const stopPreview = () => {
    if (sourceRef.current) {
      try { sourceRef.current.stop() } catch {}
      sourceRef.current = null
    }
    setPlaying(false)
  }

  const executeClip = async () => {
    if (!videoInfo) return
    setClipLoading(true)
    setClipError('')
    try {
      const res = await apiClient.post('/api/clip/execute', { 
        url, 
        title: clipTitle || videoInfo.title,
        startTime, 
        endTime, 
        audioQualityIndex,
        videoQualityIndex 
      })
      showToast({ tone: 'success', title: 'Added to Task Queue', message: `Task ID: ${res.data.taskId}` })
      setShowClipDialog(false)
    } catch (e) {
      setClipError(getErrorMessage(e))
      showToast({ tone: 'error', title: 'Failed to add task', message: getErrorMessage(e) })
    }
    setClipLoading(false)
  }

  const openClipDialog = () => {
    if (!videoInfo) return
    setClipTitle(videoInfo.title)
    setShowClipDialog(true)
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <Scissors className="w-6 h-6 text-[var(--color-bili-blue)]" />
        <h2 className="text-2xl font-bold tracking-tight">{t('common.clip')}</h2>
      </div>

      {/* URL Input + Fetch */}
      <div className="flex gap-3">
        <input
          value={url}
          onChange={e => setUrl(e.target.value)}
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
          onChange={e => setClipOutputDir(e.target.value)}
          onBlur={() => {
            if (clipOutputDir.trim()) {
              apiClient.post('/api/clip/output-dir', { path: clipOutputDir.trim() }).then(res => {
                setClipOutputDir(res.data.path || clipOutputDir)
              }).catch(e => showToast({ tone: 'error', title: 'Failed to set output dir', message: getErrorMessage(e) }))
            }
          }}
          placeholder="clips"
          className="flex-1 px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-[var(--color-bili-blue)] outline-none bg-white"
        />
        <button
          onClick={async () => {
            const picked = await window.desktopAPI?.pickFolder?.(clipOutputDir)
            if (picked) {
              setClipOutputDir(picked)
              apiClient.post('/api/clip/output-dir', { path: picked }).then(res => {
                setClipOutputDir(res.data.path || picked)
              }).catch(e => showToast({ tone: 'error', title: 'Failed to set output dir', message: getErrorMessage(e) }))
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
                      <option key={a.id} value={i}>
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
                      <option key={v.id} value={i}>
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
              Add to Clip Tasks
            </button>
          </div>

          {clipTasks && clipTasks.filter(t => t.url === url).length > 0 && (
            <div className="space-y-2 mt-2 max-w-xl">
              <div className="text-sm font-semibold text-slate-700 mb-2">Tasks for this video</div>
              {clipTasks.filter(t => t.url === url).map(task => (
                <div key={task.id} className="bg-white border border-slate-200 rounded-lg p-3 shadow-sm flex flex-col gap-2">
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium text-slate-800 truncate pr-2">{task.title}</span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${task.status === 'done' ? 'bg-green-100 text-green-700' : task.status === 'error' ? 'bg-red-100 text-red-700' : 'bg-[var(--color-bili-blue)] text-white'}`}>
                      {task.status}
                    </span>
                  </div>
                  {(task.status === 'processing' || task.status === 'pending') && (
                    <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                      <div className="bg-[var(--color-bili-blue)] h-1.5 rounded-full transition-all duration-300" style={{ width: `${task.progress}%` }} />
                    </div>
                  )}
                  {task.status === 'error' && <div className="text-xs text-red-500 truncate" title={task.message}>{task.message}</div>}
                  {task.status === 'done' && <div className="text-xs text-green-600 truncate" title={task.file_path}>{task.file_path}</div>}
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
              <div className="font-bold text-lg">Clip Settings</div>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  <Edit3 className="w-3.5 h-3.5 inline mr-1" />
                  File Name
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
              {clipOutputDir && (
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <FolderOpen className="w-3.5 h-3.5" />
                  <span className="truncate">{clipOutputDir}</span>
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-3 bg-slate-50">
              <button
                onClick={() => setShowClipDialog(false)}
                className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition"
              >
                Cancel
              </button>
              <button
                onClick={executeClip}
                disabled={clipLoading || !clipTitle.trim()}
                className="flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-[var(--color-bili-pink)] rounded-lg hover:brightness-110 transition disabled:opacity-50"
              >
                {clipLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scissors className="w-4 h-4" />}
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
