import { AppConfig, ReplayRecord, StreamSlice } from './types'
import { safeNumber } from './utils'
import { SqliteStore } from './db'

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'

export class BilibiliClient {
  private cookies = new Map<string, string>()

  constructor(
    private config: AppConfig,
    private db: SqliteStore,
  ) {}

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

  private cookieHeader() {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ')
  }

  public async fetchJSON<T>(url: string, init?: RequestInit) {
    const response = await this.fetchWithCookies(url, init)
    const text = await response.text()
    return JSON.parse(text) as T
  }

  public async fetchWithCookies(url: string | URL, init?: RequestInit) {
    const headers = new Headers(init?.headers ?? {})
    headers.set('user-agent', USER_AGENT)
    headers.set('accept', '*/*')
    headers.set('accept-language', 'zh-CN,zh;q=0.9,en;q=0.8')
    if (!headers.has('referer')) {
      headers.set('referer', 'https://live.bilibili.com/')
    }
    if (!headers.has('origin')) {
      headers.set('origin', 'https://live.bilibili.com')
    }
    const cookie = this.cookieHeader()
    if (cookie) {
      headers.set('cookie', cookie)
    }
    const response = await fetch(url, { ...init, headers })
    const setCookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
    for (const line of setCookies) {
      const pair = line.split(';', 1)[0]
      const index = pair.indexOf('=')
      if (index > 0) {
        this.cookies.set(pair.slice(0, index), pair.slice(index + 1))
      }
    }
    return response
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

  public async getBilibiliVideoInfo(rawUrl: string) {
    const parsed = this.parseBilibiliUrl(rawUrl)
    if (!parsed) throw new Error('无法解析 B站视频链接')
    const queryParam = parsed.type === 'bv' ? `bvid=${parsed.id}` : `aid=${parsed.id}`
    const info = await this.fetchJSON<{ code: number; message: string; data: { title: string; duration: number; cid: number; owner: { name: string; face: string }; pic: string; stat: { view: number; danmaku: number } } }>(
      `https://api.bilibili.com/x/web-interface/view?${queryParam}`,
    )
    if (info.code !== 0) throw new Error(info.message || '获取视频信息失败')
    const { title, duration, cid, owner, pic } = info.data

    const playUrl = await this.fetchJSON<{ code: number; data: { dash?: { audio: Array<{ id: number; base_url: string; bandwidth: number; codecs: string }>; video: Array<{ id: number; base_url: string; bandwidth: number; codecs: string; width: number; height: number; frame_rate: string }> } } }>(
      `https://api.bilibili.com/x/player/playurl?${queryParam}&cid=${cid}&fnval=4048`,
    )
    const audioList = playUrl?.data?.dash?.audio || []
    const videoList = playUrl?.data?.dash?.video || []
    if (audioList.length === 0) throw new Error('无法获取音频流')
    audioList.sort((a, b) => b.bandwidth - a.bandwidth)
    const audioUrl = audioList[0].base_url

    return {
      title, duration, cid, author: owner.name, cover: pic,
      audioUrl, audioCodec: audioList[0].codecs || 'aac',
      qualities: {
        audio: audioList.map(a => ({ id: a.id, bandwidth: a.bandwidth, codecs: a.codecs })),
        video: videoList.map(v => ({ id: v.id, bandwidth: v.bandwidth, codecs: v.codecs, width: v.width, height: v.height, frameRate: v.frame_rate })),
      },
    }
  }

  public parseBilibiliUrl(url: string): { type: 'bv' | 'av'; id: string } | null {
    const bvMatch = url.match(/BV([a-zA-Z0-9]+)/)
    if (bvMatch) return { type: 'bv', id: `BV${bvMatch[1]}` }
    const avMatch = url.match(/av(\d+)/i)
    if (avMatch) return { type: 'av', id: avMatch[1] }
    return null
  }

  public async cacheReplayM3U8(replay: ReplayRecord) {
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
    }>(`https://api.live.bilibili.com/xlive/web-room/v1/videoService/GetUserSliceStream?${params.toString()}`)
    if (payload.code !== 0) {
      throw new Error(payload.message || 'Load streams failed')
    }
    const list = payload.data?.list ?? []
    const rows: StreamSlice[] = []
    for (const item of list) {
      const response = await this.fetchWithCookies(item.stream)
      rows.push({
        replay_id: replay.replay_id,
        start_time: safeNumber(item.start_time),
        end_time: safeNumber(item.end_time),
        stream: item.stream,
        type: safeNumber(item.type),
        m3u8_text: await response.text(),
      })
    }
    this.db.prepare('DELETE FROM stream_slices WHERE replay_id = ?').run(replay.replay_id)
    const insert = this.db.prepare(
      `INSERT INTO stream_slices (created_at, updated_at, replay_id, start_time, end_time, stream, type, m3_u8_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const now = new Date().toISOString()
    for (const row of rows) {
      insert.run(now, now, row.replay_id, row.start_time, row.end_time, row.stream, row.type, row.m3u8_text)
    }
  }
}
