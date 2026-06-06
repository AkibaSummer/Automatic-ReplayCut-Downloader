import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CheckCircle,
  Loader2,
  Pause,
  Play,
  Scissors,
} from 'lucide-react'
import type { ClipPageProps } from './types'
import { getErrorMessage } from './utils'

export function ClipPage({ apiClient, apiBase, showToast, t }: ClipPageProps) {
  const [url, setUrl] = useState('')
  const [videoInfo, setVideoInfo] = useState<{ title: string; duration: number; author: string; cover: string; audioProxyPath: string; qualities?: { audio: { id: number; bandwidth: number; codecs: string }[]; video: { id: number; bandwidth: number; codecs: string; width: number; height: number; frameRate: string }[] } } | null>(null)
  const [startTime, setStartTime] = useState(0)
  const [endTime, setEndTime] = useState(30)
  const [clipLoading, setClipLoading] = useState(false)
  const [clipError, setClipError] = useState('')
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null)
  const [playing, setPlaying] = useState(false)
  const [clipResult, setClipResult] = useState<{ fileName: string; path: string } | null>(null)
  const [audioLoading, setAudioLoading] = useState(false)
  const [zoomWindow, setZoomWindow] = useState(120)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [audioQualityIndex, setAudioQualityIndex] = useState(0)
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
    setAudioBuffer(null)
    setClipResult(null)
    setAudioQualityIndex(0)
    try {
      const res = await apiClient.post('/api/clip/info', { url })
      const info = res.data as { title: string; duration: number; author: string; cover: string; audioProxyPath: string; qualities?: { audio: { id: number; bandwidth: number; codecs: string }[]; video: { id: number; bandwidth: number; codecs: string; width: number; height: number; frameRate: string }[] } }
      setVideoInfo(info)
      setStartTime(0)
      setEndTime(Math.min(info.duration, 30))
      setScrollOffset(Math.min(info.duration, 30) / 2)
      if (info.audioProxyPath) {
        loadAudio(info.audioProxyPath)
      }
    } catch (e) {
      setClipError(getErrorMessage(e))
    }
    setClipLoading(false)
  }

  const loadAudio = async (proxyPath: string) => {
    setAudioLoading(true)
    try {
      const ctx = audioCtxRef.current!
      // Resume context if suspended (autoplay policy)
      if (ctx.state === 'suspended') {
        await ctx.resume()
      }
      const audioUrl = proxyPath.startsWith('http') ? proxyPath : `${apiBase}${proxyPath}`
      const resp = await apiClient.get(audioUrl, { responseType: 'arraybuffer' })
      const buffer = await ctx.decodeAudioData(resp.data as ArrayBuffer)
      setAudioBuffer(buffer)
    } catch (e) {
      showToast({ tone: 'error', title: 'Failed to load audio', message: getErrorMessage(e) })
    }
    setAudioLoading(false)
  }

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current
    const buffer = audioBuffer
    if (!canvas || !buffer) return
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

    const dur = buffer.duration
    const viewStart = Math.max(0, Math.min(dur - zoomWindow, scrollOffset - zoomWindow / 2))
    const viewEnd = Math.min(dur, viewStart + zoomWindow)
    const viewDur = Math.max(0.1, viewEnd - viewStart)

    const data = buffer.getChannelData(0)
    const sampleRate = buffer.sampleRate
    const startSample = Math.floor(viewStart * sampleRate)
    const endSample = Math.min(data.length, Math.ceil(viewEnd * sampleRate))
    const viewSamples = endSample - startSample
    if (viewSamples <= 0) return

    const step = Math.ceil(viewSamples / w)
    ctx.clearRect(0, 0, w, h)
    const mid = h / 2
    const pixelsPerSecond = w / viewDur
    const startX = (startTime - viewStart) * pixelsPerSecond
    const endX = (endTime - viewStart) * pixelsPerSecond

    for (let i = 0; i < w; i++) {
      let max = 0
      const s = startSample + i * step
      const e = Math.min(startSample + (i + 1) * step, data.length)
      for (let j = s; j < e; j++) { const v = Math.abs(data[j]); if (v > max) max = v }
      const barH = max * mid * 1.2
      const inRange = i >= startX && i <= endX
      ctx.fillStyle = inRange ? 'rgba(0,161,214,0.7)' : 'rgba(148,163,184,0.55)'
      ctx.fillRect(i, mid - barH / 2, 1.5, Math.max(1, barH))
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
  }, [audioBuffer, startTime, endTime, zoomWindow, scrollOffset, fmtTime])

  useEffect(() => {
    if (audioBuffer && videoInfo) drawWaveform()
  }, [drawWaveform, audioBuffer, videoInfo])

  useEffect(() => {
    return () => {
      if (sourceRef.current) {
        try { sourceRef.current.stop() } catch {}
      }
    }
  }, [])

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!audioBuffer || !videoInfo) return
    const canvas = canvasRef.current; if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const dur = audioBuffer.duration
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
    if (!dragRef.current || !audioBuffer || !videoInfo) return
    const canvas = canvasRef.current; if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const dur = audioBuffer.duration
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
    if (!audioBuffer) return
    e.preventDefault()
    const canvas = canvasRef.current; if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const dur = audioBuffer.duration
    const viewStart = Math.max(0, Math.min(dur - zoomWindow, scrollOffset - zoomWindow / 2))
    const cursorX = (e.clientX - rect.left) / rect.width // 0..1 fractional position
    const cursorTime = viewStart + cursorX * zoomWindow

    if (e.ctrlKey || e.metaKey) {
      // Ctrl+Wheel = zoom at cursor
      const factor = e.deltaY > 0 ? 1.5 : 1 / 1.5
      const newZoom = Math.max(5, Math.min(dur, zoomWindow * factor))
      // Keep cursor at same pixel position: newViewStart = cursorTime - cursorX * newZoom
      const newViewStart = cursorTime - cursorX * newZoom
      setZoomWindow(newZoom)
      setScrollOffset(Math.max(newZoom / 2, Math.min(dur - newZoom / 2, newViewStart + newZoom / 2)))
    } else {
      const shift = (e.deltaY / 100) * (zoomWindow / 2)
      setScrollOffset(Math.max(zoomWindow / 2, Math.min(dur - zoomWindow / 2, scrollOffset + shift)))
    }
  }

  const playPreview = () => {
    if (!audioBuffer) return
    const ctx = audioCtxRef.current
    if (!ctx) return
    if (ctx.state === 'closed') return
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {})
    }
    if (sourceRef.current) {
      try { sourceRef.current.stop() } catch {}
    }
    const source = ctx.createBufferSource()
    source.buffer = audioBuffer
    source.connect(ctx.destination)
    const offset = Math.max(0, startTime)
    const dur = Math.max(0.1, endTime - startTime)
    source.start(0, offset, dur)
    source.onended = () => setPlaying(false)
    sourceRef.current = source
    setPlaying(true)
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
      const res = await apiClient.post('/api/clip/execute', { url, startTime, endTime, qualityIndex: audioQualityIndex })
      setClipResult(res.data as { fileName: string; path: string })
      showToast({ tone: 'success', title: 'Clip completed', message: (res.data as { fileName: string }).fileName })
    } catch (e) {
      setClipError(getErrorMessage(e))
      showToast({ tone: 'error', title: 'Clip failed', message: getErrorMessage(e) })
    }
    setClipLoading(false)
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
                type="number"
                value={startTime}
                onChange={e => setStartTime(Math.max(0, Math.min(endTime - 0.5, parseFloat(e.target.value) || 0)))}
                step="0.1"
                min="0"
                max={videoInfo.duration}
                className="w-20 px-2 py-1.5 border border-slate-300 rounded-lg text-sm text-center focus:ring-2 focus:ring-[var(--color-bili-blue)] outline-none"
              />
              <span className="text-xs text-slate-400">{t('common.sec')}</span>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-slate-600">{t('common.endTime')}:</label>
              <input
                type="number"
                value={endTime}
                onChange={e => setEndTime(Math.max(startTime + 0.5, Math.min(videoInfo.duration, parseFloat(e.target.value) || 0)))}
                step="0.1"
                min="0"
                max={videoInfo.duration}
                className="w-20 px-2 py-1.5 border border-slate-300 rounded-lg text-sm text-center focus:ring-2 focus:ring-[var(--color-bili-blue)] outline-none"
              />
              <span className="text-xs text-slate-400">{t('common.sec')}</span>
            </div>
            <div className="text-xs text-slate-400">({fmtTime(endTime - startTime)})</div>
          </div>

          {/* Range sliders */}
          <div className="space-y-1">
            <input
              type="range"
              value={startTime}
              onChange={e => setStartTime(Math.max(0, Math.min(endTime - 0.5, parseFloat(e.target.value))))}
              min="0"
              max={videoInfo.duration}
              step="0.1"
              className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-[var(--color-bili-blue)]"
            />
            <input
              type="range"
              value={endTime}
              onChange={e => setEndTime(Math.max(startTime + 0.5, Math.min(videoInfo.duration, parseFloat(e.target.value))))}
              min="0"
              max={videoInfo.duration}
              step="0.1"
              className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-[var(--color-bili-blue)]"
            />
          </div>
        </div>
      )}

      {/* Waveform */}
      {(audioBuffer || audioLoading) && (
        <div className="app-card rounded-2xl border border-white/70 bg-white/90 p-5 backdrop-blur-sm space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="text-sm font-semibold text-slate-700">Audio Waveform</div>
            <div className="text-xs text-slate-400">
              Ctrl+Wheel zoom · drag to pan · {fmtTime(zoomWindow)} view
            </div>
          </div>
          {audioLoading ? (
            <div className="flex items-center justify-center h-32 text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              Loading audio...
            </div>
          ) : audioBuffer ? (
            <canvas
              ref={canvasRef}
              className="w-full h-24 rounded-lg bg-slate-50 border border-slate-200 cursor-col-resize"
              onMouseDown={handleCanvasMouseDown}
              onMouseMove={handleCanvasMouseMove}
              onMouseUp={handleCanvasMouseUp}
              onMouseLeave={handleCanvasMouseUp}
              onWheel={handleCanvasWheel}
            />
          ) : null}

          {/* Play/Pause */}
          {audioBuffer && (
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
        <div className="flex items-center gap-4">
          <button
            onClick={executeClip}
            disabled={clipLoading || !audioBuffer}
            className="flex items-center gap-2 px-6 py-3 bg-[var(--color-bili-pink)] text-white font-medium rounded-xl hover:brightness-110 transition disabled:opacity-50"
          >
            {clipLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Scissors className="w-5 h-5" />}
            Execute Clip
          </button>
        </div>
      )}

      {/* Result */}
      {clipResult && (
        <div className="p-4 rounded-xl bg-green-50 border border-green-200 space-y-1">
          <div className="flex items-center gap-2 text-green-700 text-sm font-semibold">
            <CheckCircle className="w-4 h-4" />
            Clip completed successfully!
          </div>
          <div className="text-sm text-green-600 font-mono">{clipResult.fileName}</div>
        </div>
      )}
    </div>
  )
}
