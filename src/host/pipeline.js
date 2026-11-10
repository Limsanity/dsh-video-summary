/**
 * 视频 → 转录稿的取数管道。
 *
 * 顺序:
 *   1. yt-dlp -J 取元数据(标题/作者/时长/封面/字幕清单);
 *   2. 有字幕(作者上传或平台自动字幕)就直接用,省掉 ASR;
 *   3. 没有就 yt-dlp 下 bestaudio,再用本地 faster-whisper 转录(CPU int8)。
 *
 * 所有外部命令都吃 AbortSignal:调用方取消(用户按停止)时要真的把子进程杀掉。
 * 二进制与模型都用「先探测、后缓存」的方式拿,探测结果由 index.js 缓存,避免每次
 * 调用都跑一遍 `python -c import faster_whisper`。
 */
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'

/** asr.py 与本模块同级(构建时被复制进 lib/) */
const ASR_SCRIPT = fileURLToPath(new URL('./asr.py', import.meta.url))
/** mlx-whisper 的脚本,和 asr.py 并排放 */
const ASR_MLX_SCRIPT = fileURLToPath(new URL('./asr_mlx.py', import.meta.url))

const EXTRA_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  join(homedir(), 'anaconda3', 'bin'),
  join(homedir(), '.local', 'bin'),
  join(homedir(), '.pyenv', 'shims'),
]

const MODEL_CANDIDATES = [
  'mobiuslabsgmbh--faster-whisper-large-v3-turbo',
  'deepdml--faster-whisper-large-v3-turbo-ct2',
  'Systran--faster-whisper-large-v3',
  'mobiuslabsgmbh--faster-whisper-large-v3',
  'Systran--faster-whisper-medium',
  'Systran--faster-whisper-small',
  'Systran--faster-whisper-base',
]

const LANG_PREFERENCE = ['zh-Hans', 'zh-CN', 'zh', 'zh-Hant', 'zh-TW', 'en', 'en-US']

function pathDirs() {
  const fromEnv = String(process.env.PATH ?? '').split(delimiter).filter(Boolean)
  return [...new Set([...fromEnv, ...EXTRA_PATHS])]
}

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 在 PATH + 常见目录里找一个可执行文件 */
export async function findBinary(name, hint) {
  if (hint) {
    if (await isExecutable(hint)) return hint
    // 允许只给目录
    const guess = join(hint, name)
    if (await isExecutable(guess)) return guess
  }
  for (const dir of pathDirs()) {
    const full = join(dir, name)
    if (await isExecutable(full)) return full
  }
  return ''
}

/**
 * 跑一个子进程并收集输出。
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
export function run(command, args, { signal, timeoutMs = 120_000, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      if (error) reject(error)
      else resolve({ stdout, stderr, code: child.exitCode ?? 0 })
    }
    const timer = timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL')
          finish(new Error(`命令超时(${Math.round(timeoutMs / 1000)}s): ${command} ${args.join(' ')}`))
        }, timeoutMs)
      : null
    const onAbort = () => {
      child.kill('SIGKILL')
      const error = new Error('已取消')
      error.name = 'AbortError'
      finish(error)
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
      // 元数据 JSON 可能很大,但 8MB 足够任何单集
      if (stdout.length > 32 * 1024 * 1024) {
        child.kill('SIGKILL')
        finish(new Error('子进程输出过大'))
      }
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 4 * 1024 * 1024) stderr = stderr.slice(-1024 * 1024)
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-6).join(' | ')
        return finish(new Error(`${command} 退出码 ${code}${tail ? `: ${tail}` : ''}`))
      }
      finish()
    })
  })
}

// ------------------------------------------------------------- 链接归一化 ---

/** 去掉跟踪参数,拿到规范链接 */
export function canonicalUrl(input) {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`)
    for (const key of [...url.searchParams.keys()]) {
      if (/^(spm|vd_source|share_source|share_medium|share_plat|share_tag|timestamp|unique_k|from|seid|bbid|ts|trackid|track_id|image_material_id|from_bcg|creative_id|title_encode|title_material_id|linked_creative_id|caid|resource_id|source_id|request_id|from_spmid)$/i.test(key)) {
        url.searchParams.delete(key)
      }
    }
    url.hash = ''
    return url.toString()
  } catch {
    return input
  }
}

function bilibiliKey(url) {
  const text = String(url)
  const bv = /(BV[0-9A-Za-z]{10})/.exec(text)?.[1]
  if (bv) return { key: `bilibili:${bv}`, platform: 'bilibili', url: `https://www.bilibili.com/video/${bv}` }
  const av = /\/av(\d+)/i.exec(text)?.[1]
  if (av) return { key: `bilibili:av${av}`, platform: 'bilibili', url: `https://www.bilibili.com/video/av${av}` }
  return null
}

function youtubeKey(url) {
  const text = String(url)
  const id =
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/.exec(text)?.[1] ??
    ''
  if (!id) return null
  return { key: `youtube:${id}`, platform: 'youtube', url: `https://www.youtube.com/watch?v=${id}` }
}

/**
 * 把用户随手粘的链接整理成 {key, platform, url}。
 * b23.tv 这类短链要跟一次跳转才知道是哪个视频。
 */
export async function normalizeInput(input, { signal } = {}) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('链接是空的')
  let url = canonicalUrl(raw)
  if (/b23\.tv|bili2233\.cn|bili22\.cn|bili23\.cn/i.test(new URL(url).hostname)) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA },
        redirect: 'follow',
        signal: signal ?? AbortSignal.timeout(15_000),
      })
      url = canonicalUrl(res.url || url)
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      // 跟不到跳转也没关系:yt-dlp 自己会跟
    }
  }
  const bili = bilibiliKey(url)
  if (bili) return { ...bili, raw: raw }
  const yt = youtubeKey(url)
  if (yt) return { ...yt, raw: raw }
  return { key: '', platform: '', url, raw }
}

// ------------------------------------------------------------------ 元数据 ---

function pickAuthor(raw) {
  return raw?.uploader || raw?.channel || raw?.creator || raw?.uploader_id || ''
}

function normalizeMeta(raw, fallback) {
  const key =
    fallback?.key ||
    (raw?.extractor_key === 'BiliBili' && raw?.id ? `bilibili:${raw.id}` : '') ||
    (raw?.id ? `${String(raw.extractor_key ?? 'video').toLowerCase()}:${raw.id}` : '')
  const platform =
    fallback?.platform ||
    (raw?.extractor_key === 'BiliBili' ? 'bilibili' : String(raw?.extractor_key ?? raw?.extractor ?? 'video').toLowerCase())
  const published = raw?.upload_date ? `${raw.upload_date}` : ''
  return {
    key,
    platform,
    url: raw?.webpage_url || fallback?.url || '',
    title: raw?.title || raw?.fulltitle || '',
    author: pickAuthor(raw),
    duration: Number(raw?.duration ?? 0) || 0,
    cover: raw?.thumbnail ?? '',
    publishedAt: /^\d{8}$/.test(published) ? `${published.slice(0, 4)}-${published.slice(4, 6)}-${published.slice(6)}` : '',
    description: String(raw?.description ?? '').slice(0, 2000),
    subtitles: raw?.subtitles ?? {},
    automaticCaptions: raw?.automatic_captions ?? {},
    raw,
  }
}

export async function fetchMeta({ url, ytDlp, signal }) {
  const { stdout } = await run(
    ytDlp,
    ['-J', '--no-warnings', '--no-playlist', '--socket-timeout', '20', '--retries', '2', url],
    { signal, timeoutMs: 180_000 },
  )
  let raw
  try {
    raw = JSON.parse(stdout)
  } catch {
    throw new Error('yt-dlp 返回的元数据不是合法 JSON(站点可能改了页面结构)')
  }
  if (raw?.entries?.length) raw = raw.entries[0]
  return normalizeMeta(raw, { url })
}

// -------------------------------------------------------------------- 字幕 ---

function pickSubtitleTrack(meta, preferLangs = LANG_PREFERENCE) {
  const groups = [
    { kind: 'manual', dict: meta.subtitles ?? {} },
    { kind: 'auto', dict: meta.automaticCaptions ?? {} },
  ]
  for (const { kind, dict } of groups) {
    const langs = Object.keys(dict).filter((lang) => lang && !/^live_chat/i.test(lang))
    for (const want of preferLangs) {
      const hit =
        langs.find((lang) => lang.toLowerCase() === want.toLowerCase()) ??
        langs.find((lang) => lang.toLowerCase().startsWith(want.toLowerCase() + '-'))
      if (!hit) continue
      const formats = Array.isArray(dict[hit]) ? dict[hit] : []
      const vtt = formats.find((f) => f?.ext === 'vtt' && f?.url) ?? formats.find((f) => f?.url)
      if (vtt?.url) return { kind, lang: hit, url: vtt.url, ext: vtt.ext ?? '' }
    }
  }
  return null
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
}

function parseTimestamp(value) {
  const parts = value.trim().split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] ?? 0
}

/** 极简 VTT 解析:YouTube 自动字幕的 `<c>` 标签与滚动重复行都在这里处理掉 */
export function parseVtt(text) {
  const blocks = String(text)
    .replace(/\r/g, '')
    .split(/\n{2,}/)
  const segments = []
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim() !== '')
    if (lines.length === 0) continue
    const timingIndex = lines.findIndex((line) => line.includes('-->'))
    if (timingIndex < 0) continue
    const [from, to] = lines[timingIndex].split('-->')
    const start = parseTimestamp(from)
    // 时间轴后面可能跟着 align/position 之类的 cue 设置,先 trim 再取第一段
    const end = parseTimestamp(String(to).trim().split(/\s+/)[0])
    const body = lines
      .slice(timingIndex + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!body) continue
    const clean = decodeEntities(body)
    const previous = segments[segments.length - 1]
    if (previous && previous.text === clean) {
      previous.end = Math.max(previous.end, end)
      continue
    }
    // 滚动字幕:新行包含旧行全文时,用更长的替换
    if (previous && clean.startsWith(previous.text) && clean.length > previous.text.length) {
      previous.text = clean
      previous.end = Math.max(previous.end, end)
      continue
    }
    segments.push({ start, end, text: clean })
  }
  return segments
}

async function fetchSubtitles({ meta, signal, preferLangs }) {
  const track = pickSubtitleTrack(meta, preferLangs)
  if (!track) return null
  const res = await fetch(track.url, {
    headers: { 'user-agent': UA, accept: '*/*' },
    signal: signal ?? AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`字幕下载失败 HTTP ${res.status}`)
  const body = await res.text()
  const segments = parseVtt(body)
  const chars = segments.reduce((sum, seg) => sum + seg.text.length, 0)
  if (segments.length === 0 || chars < 80) return null
  return { segments, lang: track.lang, kind: track.kind }
}

// ---------------------------------------------------------------- 音频/ASR ---

async function findAudioFile(workDir) {
  const entries = await readdir(workDir).catch(() => [])
  const audio = entries.find((name) => /^audio\.(m4a|webm|mp3|opus|aac|ogg|wav)$/i.test(name))
  if (!audio) return ''
  const full = join(workDir, audio)
  const info = await stat(full).catch(() => null)
  return info && info.size > 1024 ? full : ''
}

async function ensureAudio({ url, ytDlp, workDir, signal }) {
  await mkdir(workDir, { recursive: true })
  const cached = await findAudioFile(workDir)
  if (cached) return { path: cached, cached: true }
  await run(
    ytDlp,
    [
      '-f',
      'bestaudio/best',
      '--no-playlist',
      '--no-warnings',
      '--no-part',
      '--socket-timeout',
      '20',
      '--retries',
      '3',
      '-o',
      join(workDir, 'audio.%(ext)s'),
      url,
    ],
    { signal, timeoutMs: 20 * 60_000 },
  )
  const path = await findAudioFile(workDir)
  if (!path) throw new Error('音频下载完成但没找到文件')
  return { path, cached: false }
}

/** 转录:MLX(Apple GPU)优先,退化到 CPU 上的 faster-whisper;脚本不同,输出同一份 JSON */
async function runAsr({ audio, asr, ffmpegDir, lang, workDir, signal }) {
  await mkdir(workDir, { recursive: true })
  const out = join(workDir, 'transcript.json')
  const script = asr.backend === 'mlx' ? ASR_MLX_SCRIPT : ASR_SCRIPT
  const candidates = [lang, 'zh', 'en'].filter(Boolean)
  let lastError = null
  for (const candidate of candidates) {
    try {
      const env = { ...process.env }
      if (ffmpegDir) env.PATH = `${ffmpegDir}${delimiter}${env.PATH ?? ''}`
      const args = [script, '--audio', audio, '--model', asr.model.path, '--lang', candidate, '--out', out]
      await run(asr.python, args, { signal, timeoutMs: 45 * 60_000, env })
      const parsed = JSON.parse(await readFile(out, 'utf8'))
      return { segments: parsed.segments ?? [], lang: parsed.lang ?? candidate, duration: parsed.duration }
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      lastError = error
    }
  }
  throw lastError ?? new Error('转录失败')
}

// ------------------------------------------------------------------ 探测 ---

const HF_CACHE_ROOT = () =>
  join(process.env.HF_HOME || join(homedir(), '.cache', 'huggingface'), 'hub')

/** mlx-whisper 的 venv:数据目录下的、默认数据目录下的,都不存在就换下一个候选 */
function mlxVenvPythons(config) {
  const homeVenv = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'video-summary', 'venv', 'bin', 'python')
  const roots = [
    config.dataDir,
    process.env.VIDEO_SUMMARY_DIR,
    process.env.VIDEO_SUMMARY_VENV,
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'video-summary'),
  ].filter(Boolean)
  return [...new Set([...roots.map((root) => (root.endsWith('python') ? root : join(root, 'venv', 'bin', 'python'))), homeVenv])]
}

async function snapshotWith(files) {
  const cacheRoot = HF_CACHE_ROOT()
  const present = await readdir(cacheRoot).catch(() => [])
  const repos = present.filter((name) => name.startsWith('models--'))
  for (const repo of repos) {
    const revisions = await readdir(join(cacheRoot, repo, 'snapshots')).catch(() => [])
    for (const revision of revisions) {
      const dir = join(cacheRoot, repo, 'snapshots', revision)
      let complete = true
      for (const file of files) {
        try {
          await access(join(dir, file), constants.R_OK)
        } catch {
          complete = false
          break
        }
      }
      if (complete) return { dir, repo: repo.replace(/^models--/, '').replace('--', '/') }
    }
  }
  return null
}

async function resolveMlxModel(config) {
  const configured = config.mlxModel || ''
  if (configured) {
    try {
      if ((await stat(configured)).isDirectory()) return { path: configured, label: 'mlx(local)' }
    } catch {
      /* 不是路径就当 HF repo id */
    }
    return { path: configured, label: configured }
  }
  const preferred = [
    'mlx-community--whisper-large-v3-turbo',
    'mlx-community--whisper-large-v3-mlx',
    'mlx-community--whisper-large-v3',
  ]
  const cacheRoot = HF_CACHE_ROOT()
  const present = await readdir(cacheRoot).catch(() => [])
  const ordered = [
    ...preferred.filter((name) => present.includes(`models--${name}`)),
    ...present.filter((name) => /^models--mlx-community--.*whisper/.test(name)).map((name) => name.replace(/^models--/, '')),
  ]
  for (const repo of ordered) {
    const revisions = await readdir(join(cacheRoot, `models--${repo}`, 'snapshots')).catch(() => [])
    for (const revision of revisions) {
      const dir = join(cacheRoot, `models--${repo}`, 'snapshots', revision)
      const ok = await Promise.all(['config.json', 'weights.safetensors'].map((f) => access(join(dir, f), constants.R_OK).then(() => true).catch(() => false)))
      if (ok.every(Boolean)) return { path: dir, label: repo.replace('--', '/') }
    }
  }
  return null
}

/** mlx-whisper 的解释器:配置 > 环境变量 > 数据目录下的 venv */
async function resolveMlx(config) {
  const candidates = [
    config.mlxPythonPath,
    process.env.VIDEO_SUMMARY_MLX_PYTHON,
    ...mlxVenvPythons(config),
  ].filter(Boolean)
  const model = await resolveMlxModel(config)
  if (!model) return null
  for (const candidate of candidates) {
    if (!(await isExecutable(candidate))) continue
    try {
      const { stdout } = await run(candidate, ['-c', 'import sys,mlx_whisper;print(sys.version.split()[0])'], {
        timeoutMs: 120_000,
      })
      return { backend: 'mlx', python: candidate, version: stdout.trim(), model }
    } catch (error) {
      void error
      // 换下一个候选
    }
  }
  return null
}

async function resolvePython(config) {
  const hinted = config.pythonPath || process.env.VIDEO_SUMMARY_PYTHON || ''
  const candidates = []
  if (hinted) candidates.push(hinted)
  // pyenv 多版本:优先新版本
  try {
    const versions = await readdir(join(homedir(), '.pyenv', 'versions'))
    versions
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .forEach((version) => candidates.push(join(homedir(), '.pyenv', 'versions', version, 'bin', 'python')))
  } catch {
    /* 没装 pyenv */
  }
  candidates.push(join(homedir(), 'anaconda3', 'bin', 'python'))
  for (const name of ['python3', 'python']) {
    const found = await findBinary(name)
    if (found) candidates.push(found)
  }
  const seen = new Set()
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    if (!(await isExecutable(candidate))) continue
    try {
      const { stdout } = await run(candidate, ['-c', 'import sys,faster_whisper;print(sys.version.split()[0])'], {
        timeoutMs: 25_000,
      })
      return { path: candidate, version: stdout.trim(), ok: true }
    } catch (error) {
      // 继续试下一个
      void error
    }
  }
  return { path: '', version: '', ok: false, error: '找不到装了 faster_whisper 的 python' }
}

async function resolveModel(config) {
  const configured = config.whisperModel || process.env.VIDEO_SUMMARY_MODEL || ''
  if (configured && configured !== 'auto') {
    if (configured.includes('/') && !configured.startsWith('/')) return { path: configured, label: configured }
    try {
      if ((await stat(configured)).isDirectory()) return { path: configured, label: configured }
    } catch {
      /* 不是路径,当作体积名 */
    }
    return { path: `Systran/faster-whisper-${configured}`, label: configured }
  }
  const cacheRoot = HF_CACHE_ROOT()
  const present = await readdir(cacheRoot).catch(() => [])
  const ordered = [
    ...MODEL_CANDIDATES.filter((name) => present.includes(`models--${name}`)),
    ...present
      .filter((name) => /^models--.*faster-whisper-(large-v3-turbo|large-v3|medium|small|base)$/.test(name))
      .map((name) => name.replace(/^models--/, ''))
      .filter((name) => !MODEL_CANDIDATES.includes(name)),
  ]
  for (const repo of ordered) {
    const snapshots = join(cacheRoot, `models--${repo}`, 'snapshots')
    const revisions = await readdir(snapshots).catch(() => [])
    for (const revision of revisions) {
      const dir = join(snapshots, revision)
      try {
        await access(join(dir, 'model.bin'), constants.R_OK)
        return { path: dir, label: repo.replace('--', '/') }
      } catch {
        /* 换下一个 */
      }
    }
  }
  return { path: 'Systran/faster-whisper-small', label: 'small(需联网下载)', missing: true }
}

/**
 * 探测一次环境:二进制、转录后端(mlx 优先)、模型。
 * index.js 负责缓存(默认 60 秒)。
 */
export async function probeEnvironment(config = {}) {
  const preferred = config.asrBackend || 'auto'
  const [ytDlpPath, ffmpegPath, fasterPython, fasterModel, mlx] = await Promise.all([
    findBinary('yt-dlp', config.ytDlpPath),
    findBinary('ffmpeg', config.ffmpegPath),
    resolvePython(config),
    resolveModel(config),
    preferred === 'faster-whisper' ? Promise.resolve(null) : resolveMlx(config),
  ])
  let ytDlpVersion = ''
  if (ytDlpPath) {
    try {
      const { stdout } = await run(ytDlpPath, ['--version'], { timeoutMs: 20_000 })
      ytDlpVersion = stdout.trim()
    } catch {
      /* 版本号拿不到不影响使用 */
    }
  }
  let asr = null
  if (mlx) asr = mlx
  else if (preferred !== 'mlx' && fasterPython.ok) {
    asr = { backend: 'faster-whisper', python: fasterPython.path, version: fasterPython.version, model: fasterModel }
  }
  return {
    ytDlp: { ok: Boolean(ytDlpPath), path: ytDlpPath, version: ytDlpVersion },
    ffmpeg: { ok: Boolean(ffmpegPath), path: ffmpegPath },
    python: fasterPython,
    model: fasterModel,
    asr,
    ready: Boolean(ytDlpPath && asr),
  }
}

// ---------------------------------------------------------------- 主流程 ---

/**
 * 把链接跑成带时间戳的转录稿。
 * @returns {Promise<{meta, segments, lang, source, audioPath}>}
 */
export async function transcribeUrl({ url, workDir, config = {}, probe, signal, onStage, meta: presetMeta }) {
  const ytDlp = probe.ytDlp.path
  if (!ytDlp) throw new Error('找不到 yt-dlp,请先安装(brew install yt-dlp)')
  if (!probe.asr) throw new Error('找不到可用的转录后端:装 mlx-whisper(见 README)或 faster-whisper')

  // 调用方通常已经取过元数据(要先落一条「转录中」记录),这里给个口子复用,别拉两次
  let meta = presetMeta ?? null
  if (!meta) {
    await onStage?.('meta')
    meta = await fetchMeta({ url, ytDlp, signal })
  }

  await onStage?.('subtitle')
  const preferLangs = Array.isArray(config.preferLangs) && config.preferLangs.length ? config.preferLangs : LANG_PREFERENCE
  try {
    const subs = await fetchSubtitles({ meta, signal, preferLangs })
    if (subs) {
      return { meta, segments: subs.segments, lang: subs.lang, source: subs.kind === 'manual' ? 'subtitle' : 'auto-subtitle' }
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    // 字幕拿不到就走 ASR,不打断
  }

  await onStage?.('audio')
  const { path: audioPath } = await ensureAudio({ url: meta.url || url, ytDlp, workDir, signal })

  await onStage?.('transcribe')
  const lang = config.asrLang || 'zh'
  const asr = await runAsr({
    audio: audioPath,
    asr: probe.asr,
    ffmpegDir: probe.ffmpeg.ok ? dirname(probe.ffmpeg.path) : '',
    lang,
    workDir,
    signal,
  })
  return { meta, segments: asr.segments, lang: asr.lang, source: 'asr', audioPath }
}

/** 转录稿 → 模型/面板可读的文本(按约 55 秒聚合一行,带 [mm:ss]) */
export function formatTranscript(segments, { maxChars = 24_000, offset = 0 } = {}) {
  const blocks = []
  let bucket = null
  for (const segment of segments) {
    if (!segment?.text) continue
    const start = Number(segment.start ?? 0)
    if (!bucket || start - bucket.start > 55) {
      bucket = { start, parts: [segment.text] }
      blocks.push(bucket)
    } else {
      bucket.parts.push(segment.text)
    }
  }
  const lines = blocks.map((block) => `[${clock(block.start)}] ${block.parts.join(' ')}`)
  const full = lines.join('\n')
  const total = full.length
  const from = Math.max(0, Math.min(offset, total))
  const slice = full.slice(from, from + maxChars)
  return {
    text: slice,
    total,
    offset: from,
    nextOffset: from + slice.length < total ? from + slice.length : 0,
    truncated: from + slice.length < total || from > 0,
  }
}

/** 秒 → mm:ss / h:mm:ss */
export function clock(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0))
  const h = Math.floor(value / 3600)
  const m = Math.floor((value % 3600) / 60)
  const s = value % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** 清掉一次任务的工作目录(音频很大,默认不留) */
export async function cleanupWork(workDir) {
  await rm(workDir, { recursive: true, force: true }).catch(() => {})
}
