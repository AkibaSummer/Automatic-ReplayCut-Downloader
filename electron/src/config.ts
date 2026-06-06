import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { AppConfig } from './types'

export const DEFAULT_CONFIG: AppConfig = {
  bilibili: {
    anchor_id: 0,
    cookies: {},
    cookie_file: 'cookies.json',
  },
  download: {
    output_dir: 'downloads',
    temp_dir: 'temp',
    filename_template: '{yy}-{MM}-{dd} {start:150405} {title}.mp4',
    max_concurrent_tasks: 2,
    concurrent_segments: 5,
    clip_output_dir: 'clips',
  },
  database: {
    dsn: 'replays.db',
  },
  server: {
    port: 8081,
  },
}

export function deepMerge<T>(base: T, patch: Partial<T>): T {
  if (Array.isArray(base) || Array.isArray(patch)) {
    return (patch ?? base) as T
  }
  if (typeof base !== 'object' || base === null || typeof patch !== 'object' || patch === null) {
    return (patch ?? base) as T
  }
  const next: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch)) {
    const current = next[key]
    next[key] = deepMerge(current as never, value as never)
  }
  return next as T
}

export function resolveAppPathWithBase(baseDir: string, target: string) {
  if (!target) return ''
  if (path.isAbsolute(target)) return path.normalize(target)
  return path.resolve(baseDir, target)
}

export function relativizeAppPath(baseDir: string, target: string) {
  if (!target) return ''
  const normalized = path.resolve(target)
  const relative = path.relative(baseDir, normalized)
  if (!relative || relative.startsWith('..')) {
    return normalized
  }
  return relative
}

export function normalizeConfigWithBase(baseDir: string, config: AppConfig): AppConfig {
  const normalized = structuredClone(config)
  normalized.bilibili.cookie_file = resolveAppPathWithBase(baseDir, normalized.bilibili.cookie_file || DEFAULT_CONFIG.bilibili.cookie_file)
  normalized.download.output_dir = resolveAppPathWithBase(baseDir, normalized.download.output_dir || DEFAULT_CONFIG.download.output_dir)
  normalized.download.temp_dir = resolveAppPathWithBase(baseDir, normalized.download.temp_dir || DEFAULT_CONFIG.download.temp_dir)
  normalized.database.dsn = resolveAppPathWithBase(baseDir, normalized.database.dsn || DEFAULT_CONFIG.database.dsn)
  normalized.download.filename_template ||= DEFAULT_CONFIG.download.filename_template
  normalized.download.max_concurrent_tasks ||= DEFAULT_CONFIG.download.max_concurrent_tasks
  normalized.download.concurrent_segments ||= DEFAULT_CONFIG.download.concurrent_segments
  normalized.download.clip_output_dir ||= DEFAULT_CONFIG.download.clip_output_dir
  normalized.bilibili.anchor_id ||= 0
  normalized.server.port ||= DEFAULT_CONFIG.server.port
  normalized.bilibili.cookies ||= {}
  return normalized
}

export function loadConfigFile(baseDir: string, configPath: string): AppConfig {
  if (!fs.existsSync(configPath)) {
    return normalizeConfigWithBase(baseDir, DEFAULT_CONFIG)
  }
  const parsed = YAML.parse(fs.readFileSync(configPath, 'utf8')) as Partial<AppConfig> | null
  return normalizeConfigWithBase(baseDir, deepMerge(DEFAULT_CONFIG, parsed ?? {}))
}

export async function saveConfigFile(baseDir: string, configPath: string, config: AppConfig) {
  const clone = structuredClone(config)
  clone.bilibili.cookie_file = relativizeAppPath(baseDir, clone.bilibili.cookie_file)
  clone.download.output_dir = relativizeAppPath(baseDir, clone.download.output_dir)
  clone.download.temp_dir = relativizeAppPath(baseDir, clone.download.temp_dir)
  clone.download.clip_output_dir = relativizeAppPath(baseDir, clone.download.clip_output_dir)
  clone.database.dsn = relativizeAppPath(baseDir, clone.database.dsn)
  await fsp.writeFile(configPath, YAML.stringify(clone), 'utf8')
}

export function detectBaseDir(fallbackCwd: string) {
  const envDir = process.env.APP_BASE_DIR?.trim()
  if (envDir) {
    return path.resolve(envDir)
  }
  const cwdConfig = path.join(fallbackCwd, 'config.yaml')
  if (fs.existsSync(cwdConfig)) {
    return fallbackCwd
  }
  const exeDir = path.dirname(process.execPath)
  if (fs.existsSync(path.join(exeDir, 'config.yaml'))) {
    return exeDir
  }
  return fallbackCwd
}
