import fs from 'node:fs'
import path from 'node:path'
import { ReplayRecord } from './types'

export const START_LAYOUT_RE = /\{start:([^}]+)\}/g
export const END_LAYOUT_RE = /\{end:([^}]+)\}/g

export function formatSeconds(totalSeconds: number) {
  const safe = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = safe % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function sanitizeFilename(name: string) {
  return name
    .replace(/[\x00-\x1f\x7f]/g, '')           // Remove control characters
    .replace(/[\u200b-\u200f\u2028-\u202f\ufeff]/g, '') // Remove zero-width / invisible Unicode chars
    .replace(/[\\/:*?"<>|]/g, '_')              // Replace Windows-illegal chars
    .replace(/\s+/g, ' ')                       // Collapse whitespace (incl. newlines)
    .replace(/_+/g, '_')                        // Collapse multiple underscores
    .trim()
}

export function formatDate(date: Date, layout: string) {
  const tokens: Record<string, string> = {
    '2006': `${date.getFullYear()}`,
    '06': `${date.getFullYear()}`.slice(-2),
    '01': `${date.getMonth() + 1}`.padStart(2, '0'),
    '02': `${date.getDate()}`.padStart(2, '0'),
    '15': `${date.getHours()}`.padStart(2, '0'),
    '04': `${date.getMinutes()}`.padStart(2, '0'),
    '05': `${date.getSeconds()}`.padStart(2, '0'),
  }
  let out = layout
  for (const [token, value] of Object.entries(tokens)) {
    out = out.replaceAll(token, value)
  }
  return out
}

export function renderFilenameTemplate(template: string, replay: ReplayRecord) {
  const start = new Date(replay.start_time * 1000)
  const end = new Date(replay.end_time * 1000)
  let out = template

  out = out.replace(START_LAYOUT_RE, (_, layout: string) => formatDate(start, layout))
  out = out.replace(END_LAYOUT_RE, (_, layout: string) => formatDate(end, layout))
  out = out
    .replaceAll('{title}', replay.title)
    .replaceAll('{live_key}', replay.live_key)
    .replaceAll('{yyyy}', `${start.getFullYear()}`)
    .replaceAll('{yy}', formatDate(start, '06'))
    .replaceAll('{MM}', formatDate(start, '01'))
    .replaceAll('{dd}', formatDate(start, '02'))
    .replaceAll('{start}', formatDate(start, '2006-01-02 15-04-05'))
    .replaceAll('{end}', formatDate(end, '2006-01-02 15-04-05'))
    .replaceAll('{start_unix}', `${replay.start_time}`)
    .replaceAll('{end_unix}', `${replay.end_time}`)

  return sanitizeFilename(out || replay.live_key)
}

export function uniquePath(targetPath: string) {
  if (!fs.existsSync(targetPath)) {
    return targetPath
  }
  const ext = path.extname(targetPath)
  const dir = path.dirname(targetPath)
  const base = path.basename(targetPath, ext)
  for (let i = 1; i < 10000; i += 1) {
    const candidate = path.join(dir, `${base} (${i})${ext}`)
    if (!fs.existsSync(candidate)) {
      return candidate
    }
  }
  return targetPath
}

export function safeNumber(value: unknown) {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

export function boolFromDb(value: unknown) {
  return value === 1 || value === '1' || value === true
}

export function ensureDir(dir: string) {
  if (dir) {
    fs.mkdirSync(dir, { recursive: true })
  }
}
