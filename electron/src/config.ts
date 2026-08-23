import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import YAML from 'yaml'
import { AppConfig } from './types'

const configSaveQueues = new Map<string, Promise<void>>()

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
  feishu: {
    app_id: '',
    app_secret: '',
    base_token: 'ZSmDbR9HEaViOWssgzIc3SZhn7c',
    table_id: 'tblH7nVh6cpx8x3X',
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
  const normalized = path.isAbsolute(target) ? path.normalize(target) : path.resolve(baseDir, target)
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
  normalized.download.clip_output_dir = resolveAppPathWithBase(
    baseDir,
    normalized.download.clip_output_dir || DEFAULT_CONFIG.download.clip_output_dir,
  )
  normalized.database.dsn = resolveAppPathWithBase(baseDir, normalized.database.dsn || DEFAULT_CONFIG.database.dsn)
  normalized.download.filename_template ||= DEFAULT_CONFIG.download.filename_template
  const maxTasks = Number(normalized.download.max_concurrent_tasks)
  normalized.download.max_concurrent_tasks = Number.isFinite(maxTasks) && maxTasks >= 1
    ? Math.floor(maxTasks)
    : DEFAULT_CONFIG.download.max_concurrent_tasks
  const concurrentSegments = Number(normalized.download.concurrent_segments)
  normalized.download.concurrent_segments = Number.isFinite(concurrentSegments) && concurrentSegments >= 1
    ? Math.floor(concurrentSegments)
    : DEFAULT_CONFIG.download.concurrent_segments
  normalized.bilibili.anchor_id ||= 0
  normalized.server.port ||= DEFAULT_CONFIG.server.port
  normalized.bilibili.cookies ||= {}
  normalized.feishu ||= { ...DEFAULT_CONFIG.feishu }
  normalized.feishu.base_token ||= DEFAULT_CONFIG.feishu.base_token
  normalized.feishu.table_id ||= DEFAULT_CONFIG.feishu.table_id
  return normalized
}

export function loadConfigFile(baseDir: string, configPath: string): AppConfig {
  if (!fs.existsSync(configPath)) {
    return normalizeConfigWithBase(baseDir, DEFAULT_CONFIG)
  }
  try {
    const parsed = YAML.parse(fs.readFileSync(configPath, 'utf8')) as Partial<AppConfig> | null
    return normalizeConfigWithBase(baseDir, deepMerge(DEFAULT_CONFIG, parsed ?? {}))
  } catch (error) {
    const backupPath = `${configPath}.bak`
    if (!fs.existsSync(backupPath)) {
      throw error
    }
    try {
      const parsed = YAML.parse(fs.readFileSync(backupPath, 'utf8')) as Partial<AppConfig> | null
      console.warn(`[config] Failed to read ${configPath}; recovered from ${backupPath}`)
      return normalizeConfigWithBase(baseDir, deepMerge(DEFAULT_CONFIG, parsed ?? {}))
    } catch {
      throw error
    }
  }
}

async function sqliteFileIsUsable(filePath: string) {
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined
  try {
    handle = await fsp.open(filePath, 'r')
    const header = Buffer.alloc(16)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    return bytesRead === header.length && header.toString('binary') === 'SQLite format 3\0'
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function sampledFileFingerprint(filePath: string) {
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined
  try {
    const stat = await fsp.stat(filePath, { bigint: true })
    if (!stat.isFile()) return ''
    handle = await fsp.open(filePath, 'r')
    const sampleBytes = 64 * 1024
    const size = Number(stat.size)
    const offsets = [...new Set([
      0,
      Math.max(0, Math.floor(size / 2) - Math.floor(sampleBytes / 2)),
      Math.max(0, size - sampleBytes),
    ])]
    const hash = createHash('sha256').update(String(stat.size))
    for (const offset of offsets) {
      const buffer = Buffer.alloc(Math.min(sampleBytes, Math.max(0, size - offset)))
      if (buffer.length === 0) continue
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } catch {
    return ''
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function findPortableDatabaseCandidate(baseDir: string, legacyPath: string) {
  const basename = path.basename(legacyPath)
  const rootCandidate = path.join(baseDir, basename)
  if (await sqliteFileIsUsable(rootCandidate)) return rootCandidate
  let entries: fs.Dirent[] = []
  try {
    entries = await fsp.readdir(baseDir, { withFileTypes: true })
  } catch {}
  const candidates: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'resources') continue
    const candidate = path.join(baseDir, entry.name, basename)
    if (await sqliteFileIsUsable(candidate)) candidates.push(candidate)
  }
  return candidates.length === 1 ? candidates[0] : ''
}

/**
 * Old portable builds persisted normalized absolute paths. After copying the
 * whole application directory, that made the new executable silently keep
 * using the database in the old folder. Relocate only when the new base has one
 * valid SQLite candidate and either the old path is unavailable or both files
 * have the same size/sample fingerprint. The proven old base can then safely
 * remap the other package-local paths without touching genuine external paths.
 */
export async function recoverPortableConfigPaths(
  baseDir: string,
  configPath: string,
  input: AppConfig,
) {
  const config = structuredClone(input)
  const legacyDsn = path.resolve(config.database.dsn)
  const dsnRelativeToCurrent = path.relative(baseDir, legacyDsn)
  const alreadyCurrent = dsnRelativeToCurrent === ''
    || (!dsnRelativeToCurrent.startsWith(`..${path.sep}`) && dsnRelativeToCurrent !== '..' && !path.isAbsolute(dsnRelativeToCurrent))
  if (alreadyCurrent) return config

  const candidate = await findPortableDatabaseCandidate(baseDir, legacyDsn)
  if (!candidate || path.resolve(candidate) === legacyDsn) return config

  const oldFingerprint = await sampledFileFingerprint(legacyDsn)
  const candidateFingerprint = await sampledFileFingerprint(candidate)
  if (!candidateFingerprint || (oldFingerprint && oldFingerprint !== candidateFingerprint)) return config

  const candidateRelative = path.relative(baseDir, candidate)
  const legacyLower = path.normalize(legacyDsn).toLocaleLowerCase()
  const suffixLower = path.normalize(candidateRelative).toLocaleLowerCase()
  const suffixIndex = legacyLower.endsWith(`${path.sep}${suffixLower}`)
    ? legacyDsn.length - candidateRelative.length
    : -1
  const oldBase = suffixIndex > 0
    ? legacyDsn.slice(0, suffixIndex).replace(/[\\/]$/, '')
    : path.dirname(legacyDsn)
  const remapPackageLocalPath = (value: string) => {
    if (!value || !path.isAbsolute(value)) return value
    const relative = path.relative(oldBase, path.resolve(value))
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return value
    return path.resolve(baseDir, relative)
  }

  config.database.dsn = candidate
  config.bilibili.cookie_file = remapPackageLocalPath(config.bilibili.cookie_file)
  config.download.output_dir = remapPackageLocalPath(config.download.output_dir)
  config.download.temp_dir = remapPackageLocalPath(config.download.temp_dir)
  config.download.clip_output_dir = remapPackageLocalPath(config.download.clip_output_dir)
  await saveConfigFile(baseDir, configPath, config)
  Object.defineProperty(config, '__portable_previous_base', {
    value: oldBase,
    enumerable: false,
    configurable: false,
  })
  console.warn(`[config] Relocated copied portable database from ${legacyDsn} to ${candidate}`)
  return config
}

async function replaceFile(sourcePath: string, destinationPath: string) {
  try {
    await fsp.rename(sourcePath, destinationPath)
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM') {
      throw error
    }
  }

  // Windows may refuse rename-over-existing. Move the destination aside first;
  // if installing the replacement fails, restore it before returning the error.
  const displacedPath = `${destinationPath}.${process.pid}.${Date.now()}.old`
  let displaced = false
  try {
    await fsp.rename(destinationPath, displacedPath)
    displaced = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  try {
    await fsp.rename(sourcePath, destinationPath)
  } catch (error) {
    if (displaced) {
      await fsp.rename(displacedPath, destinationPath).catch(() => undefined)
    }
    throw error
  }
  if (displaced) {
    await fsp.rm(displacedPath, { force: true })
  }
}

async function writeConfigAtomically(configPath: string, serialized: string) {
  const directory = path.dirname(configPath)
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
  const tempPath = path.join(directory, `.${path.basename(configPath)}.${nonce}.tmp`)
  const backupPath = `${configPath}.bak`
  const backupTempPath = `${backupPath}.${nonce}.tmp`

  await fsp.mkdir(directory, { recursive: true })
  try {
    const handle = await fsp.open(tempPath, 'wx')
    try {
      await handle.writeFile(serialized, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    if (fs.existsSync(configPath)) {
      await fsp.copyFile(configPath, backupTempPath, fs.constants.COPYFILE_EXCL)
      await replaceFile(backupTempPath, backupPath)
    }
    await replaceFile(tempPath, configPath)
  } finally {
    await Promise.all([
      fsp.rm(tempPath, { force: true }),
      fsp.rm(backupTempPath, { force: true }),
    ])
  }
}

export function saveConfigFile(baseDir: string, configPath: string, config: AppConfig) {
  const clone = structuredClone(config)
  clone.bilibili.cookie_file = relativizeAppPath(baseDir, clone.bilibili.cookie_file)
  clone.download.output_dir = relativizeAppPath(baseDir, clone.download.output_dir)
  clone.download.temp_dir = relativizeAppPath(baseDir, clone.download.temp_dir)
  clone.download.clip_output_dir = relativizeAppPath(baseDir, clone.download.clip_output_dir)
  clone.database.dsn = relativizeAppPath(baseDir, clone.database.dsn)
  const serialized = YAML.stringify(clone)
  const queueKey = path.resolve(configPath)
  const previous = configSaveQueues.get(queueKey) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(() => writeConfigAtomically(configPath, serialized))
  configSaveQueues.set(queueKey, current)
  return current.finally(() => {
    if (configSaveQueues.get(queueKey) === current) {
      configSaveQueues.delete(queueKey)
    }
  })
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
