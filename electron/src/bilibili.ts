import { AppConfig, ReplayRecord, StreamSlice } from './types'
import { safeNumber } from './utils'
import { SqliteStore } from './db'

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'

export class BilibiliClient {
  private cookies = new Map<string, string>()
  private customFetch: typeof globalThis.fetch

  constructor(
    private config: AppConfig,
    private db: SqliteStore,
    customFetch?: typeof globalThis.fetch,
  ) {
    this.customFetch = customFetch || globalThis.fetch
  }

  public loadCookies() {
    const fromConfig = this.config.bilibili.cookies || {}
    for (const [key, value] of Object.entries(fromConfig)) {
      this.cookies.set(key, value)
    }
    const cookieFile = this.config.bilibili.cookie_file
    if (!cookieFile) return
    try {
      // Avoid fs here if possible, assume it's loaded in main and passed, or just read it
      const fs = require('node:fs')
      if (fs.existsSync(cookieFile)) {
        const parsed = JSON.parse(fs.readFileSync(cookieFile, 'utf8')) as Record<string, string>
        for (const [key, value] of Object.entries(parsed)) {
          this.cookies.set(key, value)
        }
      }
    } catch {
      // Ignore
    }
  }

  public async saveCookies() {
    const cookieFile = this.config.bilibili.cookie_file
    if (!cookieFile) return
    const payload = Object.fromEntries(this.cookies.entries())
    const fsp = require('node:fs/promises')
    await fsp.writeFile(cookieFile, JSON.stringify(payload, null, 2), 'utf8')
  }

  public cookieHeader() {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ')
  }

  public async fetchJSON<T>(url: string, init?: RequestInit) {
    const response = await this.fetchWithCookies(url, init)
    const text = await response.text()
    return JSON.parse(text) as T
  }

  public async fetchWithCookies(url: string | URL, init?: RequestInit) {
    const controller = new AbortController()
    const externalSignal = init?.signal
    let timer: NodeJS.Timeout | undefined
    let cleanedUp = false
    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      if (timer) clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    }
    const onExternalAbort = () => {
      controller.abort(externalSignal?.reason)
      cleanup()
    }
    if (externalSignal?.aborted) {
      onExternalAbort()
    } else {
      externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
    }
    if (!controller.signal.aborted) {
      timer = setTimeout(() => {
        controller.abort(new Error('Request Timeout'))
        cleanup()
      }, 15_000)
    }

    try {
      const headers = new Headers(init?.headers ?? {})
      headers.set('user-agent', USER_AGENT)
      headers.set('accept', '*/*')
      headers.set('accept-language', 'zh-CN,zh;q=0.9,en;q=0.8')
      if (!headers.has('referer')) {
        headers.set('referer', 'https://www.bilibili.com/')
      }
      if (!headers.has('origin')) {
        headers.set('origin', 'https://www.bilibili.com')
      }
      const cookie = this.cookieHeader()
      if (cookie) {
        headers.set('cookie', cookie)
      }

      const response = await this.customFetch(url, { ...init, headers, signal: controller.signal })
      const setCookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
      for (const line of setCookies) {
        const pair = line.split(';', 1)[0]
        const index = pair.indexOf('=')
        if (index > 0) {
          this.cookies.set(pair.slice(0, index), pair.slice(index + 1))
        }
      }
      if (!response.body) {
        cleanup()
        return response
      }

      const reader = response.body.getReader()
      const body = new ReadableStream<Uint8Array>({
        async pull(streamController) {
          try {
            const chunk = await reader.read()
            if (chunk.done) {
              cleanup()
              streamController.close()
            } else {
              streamController.enqueue(chunk.value)
            }
          } catch (error) {
            cleanup()
            streamController.error(error)
          }
        },
        async cancel(reason) {
          cleanup()
          await reader.cancel(reason)
        },
      })
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } catch (error) {
      cleanup()
      throw error
    }
  }


  public async getCurrentUser() {
    try {
      const result = await this.fetchJSON<{
        code: number
        data?: { uname?: string; face?: string }
      }>('https://api.bilibili.com/x/web-interface/nav')
      if (result.code !== 0 || !result.data) {
        return { logged_in: false, uname: '', face: '' }
      }
      return {
        logged_in: true,
        uname: result.data.uname || '',
        face: result.data.face || '',
      }
    } catch {
      return { logged_in: false, uname: '', face: '' }
    }
  }

  public async getBilibiliVideoInfo(rawUrl: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const parsed = this.parseBilibiliUrl(rawUrl)
    if (!parsed) throw new Error('无法解析 B站视频链接')
    const queryParam = parsed.type === 'bv' ? `bvid=${parsed.id}` : `aid=${parsed.id}`
    const info = await this.fetchJSON<{ code: number; message: string; data: { title: string; duration: number; cid: number; owner: { name: string; face: string }; pic: string; stat: { view: number; danmaku: number }; pages?: Array<{ cid: number; page: number; part: string; duration: number }> } }>(
      `https://api.bilibili.com/x/web-interface/view?${queryParam}`,
      signal ? { signal } : undefined,
    )
    signal?.throwIfAborted()
    if (info.code !== 0) throw new Error(info.message || '获取视频信息失败')
    
    let { title, duration, cid, owner, pic } = info.data
    const pages = info.data.pages || []
    if (pages.length > 0) {
      const pageIndex = parsed.p - 1
      if (pageIndex >= 0 && pageIndex < pages.length) {
        cid = pages[pageIndex].cid
        duration = pages[pageIndex].duration
        if (pages.length > 1 && pages[pageIndex].part) {
          title = `${title} - P${parsed.p} ${pages[pageIndex].part}`
        }
      }
    }

    let playUrl = await this.fetchJSON<{ code: number; message?: string; data: { dash?: { audio: Array<{ id: number; base_url: string; bandwidth: number; codecs: string }>; video: Array<{ id: number; base_url: string; bandwidth: number; codecs: string; width: number; height: number; frame_rate: string }> } } }>(
      `https://api.bilibili.com/x/player/playurl?${queryParam}&cid=${cid}&qn=127&fourk=1&fnval=4048`,
      signal ? { signal } : undefined,
    )
    signal?.throwIfAborted()
    if (playUrl.code !== 0 || !playUrl?.data?.dash?.audio?.length) {
      // 尝试降级请求（不要求 4K，qn=32），用于兼容未登录状态
      playUrl = await this.fetchJSON<{ code: number; message?: string; data: { dash?: { audio: Array<{ id: number; base_url: string; bandwidth: number; codecs: string }>; video: Array<{ id: number; base_url: string; bandwidth: number; codecs: string; width: number; height: number; frame_rate: string }> } } }>(
        `https://api.bilibili.com/x/player/playurl?${queryParam}&cid=${cid}&qn=32&fnval=4048`,
        signal ? { signal } : undefined,
      )
      signal?.throwIfAborted()
    }
    if (playUrl.code !== 0) {
      throw new Error(`无法获取播放地址: ${playUrl.message || playUrl.code} (可能需要登录)`)
    }

    const audioList = playUrl?.data?.dash?.audio || []
    const videoList = playUrl?.data?.dash?.video || []
    if (audioList.length === 0) throw new Error('此视频没有提供 DASH 音频流，通常是因为未登录或视频格式受限')
    audioList.sort((a, b) => b.bandwidth - a.bandwidth)
    const audioUrl = audioList[0].base_url

    return {
      title, duration, cid, author: owner.name, cover: pic,
      audioUrl, audioCodec: audioList[0].codecs || 'aac',
      qualities: {
        audio: audioList.map(a => ({ id: a.id, bandwidth: a.bandwidth, codecs: a.codecs, baseUrl: a.base_url })),
        video: videoList.map(v => ({ id: v.id, bandwidth: v.bandwidth, codecs: v.codecs, width: v.width, height: v.height, frameRate: v.frame_rate, baseUrl: v.base_url })),
      },
    }
  }

  public async fetchReplays(roomId: string | number, page: number, pageSize: number) {
    const url = `https://api.live.bilibili.com/xlive/web-room/v1/record/getList?room_id=${roomId}&page=${page}&page_size=${pageSize}`
    const result = await this.fetchJSON<{
      code: number; message: string; data?: { list?: Array<{ id: number; live_key: string; title: string; start_time: number; end_time: number; duration: number; cover: string }> }
    }>(url)
    if (result.code !== 0) throw new Error(result.message || 'Fetch replays failed')
    return result.data?.list || []
  }

  public parseBilibiliUrl(url: string): { type: 'bv' | 'av'; id: string; p: number } | null {
    const pMatch = url.match(/[?&]p=(\d+)/)
    const p = pMatch ? parseInt(pMatch[1], 10) : 1
    const bvMatch = url.match(/BV([a-zA-Z0-9]+)/)
    if (bvMatch) return { type: 'bv', id: `BV${bvMatch[1]}`, p }
    const avMatch = url.match(/av(\d+)/i)
    if (avMatch) return { type: 'av', id: avMatch[1], p }
    return null
  }

  public async cacheReplayM3U8(replay: ReplayRecord, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const params = new URLSearchParams({
      live_key: replay.live_key,
      start_time: `${replay.start_time}`,
      end_time: `${replay.end_time}`,
      live_uid: `${this.config.bilibili.anchor_id}`,
      web_location: '444.194',
    })
    const payload = await this.fetchJSON<{
      code: number
      message: string
      data?: { list?: Array<{ start_time: number; end_time: number; stream: string; type: number }> }
    }>(`https://api.live.bilibili.com/xlive/web-room/v1/videoService/GetUserSliceStream?${params.toString()}`, signal ? { signal } : undefined)
    signal?.throwIfAborted()
    if (payload.code !== 0) {
      throw new Error(payload.message || 'Load streams failed')
    }
    const list = payload.data?.list ?? []
    if (list.length === 0) {
      throw new Error('No replay streams were returned')
    }
    const rows: StreamSlice[] = []
    for (const item of list) {
      signal?.throwIfAborted()
      const response = await this.fetchWithCookies(item.stream, signal ? { signal } : undefined)
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(`Load replay stream failed: HTTP ${response.status}`)
      }
      const m3u8Text = await response.text()
      const normalizedM3U8 = m3u8Text.trimStart()
      if (!normalizedM3U8.startsWith('#EXTM3U') || !normalizedM3U8.includes('#EXTINF:')) {
        throw new Error('Load replay stream failed: invalid M3U8 playlist')
      }
      rows.push({
        id: 0,
        replay_id: replay.replay_id,
        start_time: safeNumber(item.start_time),
        end_time: safeNumber(item.end_time),
        stream: item.stream,
        type: safeNumber(item.type),
        m3u8_text: m3u8Text,
      })
    }
    signal?.throwIfAborted()
    this.db.withTransaction(() => {
      this.db.prepare('DELETE FROM stream_slices WHERE replay_id = ?').run(replay.replay_id)
      const insert = this.db.prepare(
        `INSERT INTO stream_slices (created_at, updated_at, replay_id, start_time, end_time, stream, type, m3_u8_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const now = new Date().toISOString()
      for (const row of rows) {
        insert.run(now, now, row.replay_id, row.start_time, row.end_time, row.stream, row.type, row.m3u8_text)
      }
    })
  }
}
