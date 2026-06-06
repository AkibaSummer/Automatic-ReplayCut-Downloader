/**
 * feishu.ts — Feishu (Lark) Bitable client via direct HTTP API
 *
 * Uses tenant_access_token (app identity) to access the Bitable.
 * No external CLI tools required — works in a fresh packaged environment.
 *
 * Prerequisites:
 * 1. A Feishu self-built app with app_id + app_secret configured
 * 2. The app has "base:record:read" (and optionally "base:record:update") scopes
 * 3. The app is added as a collaborator on the target Bitable
 */

// --------------- Types ---------------

export interface FeishuRecord {
  record_id: string
  song_name: string
  replay_url: string       // raw URL extracted from markdown link
  replay_link_text: string // display text of the link
  start_time: string       // e.g. "1:20:25"
  end_time: string         // e.g. "1:25:00"
  date: string             // e.g. "2026-05-30"
}

export interface FeishuPageResult {
  records: FeishuRecord[]
  has_more: boolean
  page_token: string
  total: number
}

export interface FeishuConfig {
  app_id: string
  app_secret: string
  base_token: string
  table_id: string
}

export interface FeishuSetupStatus {
  ok: boolean
  stage: 'not_configured' | 'token_failed' | 'no_permission' | 'ready'
  message: string
  hint?: string
}

// --------------- Client ---------------

const FEISHU_API_BASE = 'https://open.feishu.cn'

export class FeishuClient {
  private readonly config: FeishuConfig
  private tenantToken: string = ''
  private tokenExpiry: number = 0 // Unix ms

  constructor(config: FeishuConfig) {
    this.config = config
  }

  // --- Token Management ---

  /** Check if we have a valid (non-expired) tenant token */
  private hasValidToken(): boolean {
    return !!this.tenantToken && Date.now() < this.tokenExpiry - 60_000 // 1 min buffer
  }

  /** Get or refresh tenant_access_token */
  private async ensureToken(): Promise<string> {
    if (this.hasValidToken()) return this.tenantToken

    const resp = await this.post('/open-apis/auth/v3/tenant_access_token/internal/', {
      app_id: this.config.app_id,
      app_secret: this.config.app_secret,
    }, false) // no auth header for this call

    if (resp.code !== 0) {
      throw new Error(`获取飞书 token 失败 (code=${resp.code}): ${resp.msg}`)
    }
    this.tenantToken = resp.tenant_access_token
    this.tokenExpiry = Date.now() + (resp.expire || 7200) * 1000
    return this.tenantToken
  }

  // --- HTTP Helpers ---

  private async post(path: string, body: any, auth = true): Promise<any> {
    const url = `${FEISHU_API_BASE}${path}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
    }
    if (auth) {
      const token = await this.ensureToken()
      headers['Authorization'] = `Bearer ${token}`
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`Feishu API ${resp.status}: ${text.slice(0, 300)}`)
    }
    return resp.json()
  }

  private async get(path: string, params?: Record<string, string>): Promise<any> {
    const token = await this.ensureToken()
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    const url = `${FEISHU_API_BASE}${path}${qs}`
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    })

    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`Feishu API ${resp.status}: ${text.slice(0, 300)}`)
    }
    return resp.json()
  }

  private async put(path: string, body: any): Promise<any> {
    const token = await this.ensureToken()
    const url = `${FEISHU_API_BASE}${path}`
    const resp = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })

    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`Feishu API ${resp.status}: ${text.slice(0, 300)}`)
    }
    return resp.json()
  }

  // --- Public Methods ---

  /** Check if the Feishu integration is properly configured and working */
  async checkStatus(): Promise<FeishuSetupStatus> {
    // Step 1: Check if credentials are configured
    if (!this.config.app_id || !this.config.app_secret) {
      return {
        ok: false,
        stage: 'not_configured',
        message: '飞书应用未配置',
        hint: '请在 config.yaml 中配置 feishu.app_id 和 feishu.app_secret',
      }
    }

    // Step 2: Try to get a token
    try {
      await this.ensureToken()
    } catch (e) {
      return {
        ok: false,
        stage: 'token_failed',
        message: `飞书认证失败: ${(e as Error).message}`,
        hint: '请检查 app_id 和 app_secret 是否正确',
      }
    }

    // Step 3: Try to read the bitable (tests both API scope and document permission)
    try {
      await this.listClippableRecords(undefined, 1)
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('99991672') || msg.includes('scope') || msg.includes('permission') || msg.includes('403')) {
        return {
          ok: false,
          stage: 'no_permission',
          message: '飞书权限不足',
          hint: '请在飞书开发者后台为应用申请 base:record:read 权限，并将应用添加为多维表格的协作者',
        }
      }
      return {
        ok: false,
        stage: 'no_permission',
        message: `飞书 API 调用失败: ${msg}`,
      }
    }

    return {
      ok: true,
      stage: 'ready',
      message: '飞书已连接',
    }
  }

  /**
   * Search records filtered by 纯享可切 = true, sorted by 日期 descending.
   * Uses POST /bitable/v1/.../records/search for filtering + sorting.
   */
  async listClippableRecords(pageToken?: string, pageSize = 20, keyword?: string): Promise<FeishuPageResult> {
    const { base_token, table_id } = this.config
    const path = `/open-apis/bitable/v1/apps/${base_token}/tables/${table_id}/records/search`

    // Checkbox fields require boolean value, not string
    const conditions: any[] = [{
      field_name: '纯享可切',
      operator: 'is',
      value: [true],
    }]
    // NOTE: keyword filtering is done client-side after fetch,
    // because 歌名 may be a rich-text field that doesn't support server-side 'contains'.

    const body: any = {
      page_size: pageSize,
      field_names: ['歌名', '录播链接', '录播时间', '结束时间', '日期', '纯享可切'],
      filter: {
        conjunction: 'and',
        conditions,
      },
      sort: [{
        field_name: '日期',
        desc: true,
      }],
    }
    if (pageToken) {
      body.page_token = pageToken
    }

    const result = await this.post(path, body)
    if (result.code !== 0) {
      throw new Error(`Feishu API error (code=${result.code}): ${result.msg}`)
    }

    const data = result.data
    const items: any[] = data?.items || []

    const records: FeishuRecord[] = items.map(item => {
      const fields = item.fields || {}
      // 歌名 can be text or array of text segments
      const rawName = fields['歌名']
      let songName = ''
      if (Array.isArray(rawName)) {
        songName = rawName.map((seg: any) => typeof seg === 'string' ? seg : seg?.text || '').join('')
      } else if (typeof rawName === 'string') {
        songName = rawName
      }

      // 录播链接 can be a text field with markdown-style link or a URL field
      const rawLink = fields['录播链接']
      let replayUrl = ''
      let replayLinkText = ''
      if (typeof rawLink === 'string') {
        const parsed = extractUrlFromText(rawLink)
        replayUrl = parsed.url
        replayLinkText = parsed.text
      } else if (rawLink && typeof rawLink === 'object') {
        // Could be a URL field object or rich text
        if (rawLink.link) {
          replayUrl = rawLink.link
          replayLinkText = rawLink.text || rawLink.link
        } else if (Array.isArray(rawLink)) {
          // Rich text segments
          const textParts = rawLink.map((seg: any) => seg?.text || '').join('')
          const linkSeg = rawLink.find((seg: any) => seg?.link)
          replayUrl = linkSeg?.link || ''
          replayLinkText = textParts || replayUrl
        }
      }

      // 录播时间 / 结束时间 can be text
      const startTime = extractTextField(fields['录播时间'])
      const endTime = extractTextField(fields['结束时间'])

      // 日期 is a timestamp (ms)
      const rawDate = fields['日期']
      let date = ''
      if (typeof rawDate === 'number') {
        date = new Date(rawDate).toISOString().split('T')[0]
      } else if (typeof rawDate === 'string') {
        date = rawDate.split(' ')[0]
      }

      return {
        record_id: item.record_id || '',
        song_name: songName,
        replay_url: replayUrl,
        replay_link_text: replayLinkText,
        start_time: startTime,
        end_time: endTime,
        date,
      }
    })

    return {
      records,
      has_more: !!data?.has_more,
      page_token: data?.page_token || '',
      total: data?.total || records.length,
    }
  }

  /**
   * Update a single record's fields. Used for writing back
   * calibrated start/end times after clipping.
   *
   * Note: Feishu Text fields (录播时间, 结束时间) accept plain strings
   * for writing, even though they return rich-text segments on read.
   */
  async updateRecord(recordId: string, fields: Record<string, any>): Promise<void> {
    const { base_token, table_id } = this.config
    const path = `/open-apis/bitable/v1/apps/${base_token}/tables/${table_id}/records/${recordId}`

    const result = await this.put(path, { fields })
    if (result.code !== 0) {
      throw new Error(`更新记录失败 (code=${result.code}): ${result.msg}`)
    }
  }
}

// --------------- Helpers ---------------

/** Extract text content from a Bitable field value (handles text, rich text segments) */
function extractTextField(value: any): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) {
    return value.map((seg: any) => typeof seg === 'string' ? seg : seg?.text || '').join('')
  }
  return ''
}

/** Extract URL from markdown-style link or plain text */
function extractUrlFromText(text: string): { url: string; text: string } {
  if (!text) return { url: '', text: '' }
  const match = text.match(/\[([^\]]*)\]\(([^)]+)\)/)
  if (match) return { url: match[2], text: match[1] }
  if (text.startsWith('http')) return { url: text, text }
  return { url: '', text }
}
