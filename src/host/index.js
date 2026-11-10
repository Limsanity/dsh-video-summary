/**
 * 视频总结 · 宿主侧
 *
 * 干三件事:
 *   1. 提供 tool:`video_summary`(链接 → 转录稿)、`video_summary_save`(存总结)、
 *      `video_summary_list` / `video_summary_transcript`(回看);
 *   2. 把每次总结记到 $DSH_HOME/video-summary/library.json,转录稿另存
 *      transcripts/<id>.json(按需读,避免面板一次拉几十万字);
 *   3. 给面板提供只读路由(/v-sum/*),以及一次环境探测(yt-dlp / ffmpeg / python / 模型)。
 *
 * 数据都在宿主机磁盘上:换个浏览器/手机访问同一个 dsh 看到的是同一份记录。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'
import { Store } from './store.js'
import {
  cleanupWork,
  clock,
  fetchMeta,
  formatTranscript,
  normalizeInput,
  probeEnvironment,
  transcribeUrl,
} from './pipeline.js'

export const name = 'video-summary'

/** tools:注册工具;webServer:面板路由 */
export const inject = ['tools', 'webServer']

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DEFAULT_DATA_DIR = join(DSH_HOME, 'video-summary')
const STATUS_TEXT = {
  working: '转录中',
  transcribed: '待总结',
  summarized: '已总结',
  failed: '失败',
}

function dataDirOf(config) {
  return config?.dataDir || process.env.VIDEO_SUMMARY_DIR || DEFAULT_DATA_DIR
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function hashId(input) {
  return createHash('sha1').update(String(input)).digest('hex').slice(0, 12)
}

/** 记录 id:能认得平台就用人能读的 key,否则对链接取哈希 */
function idOf(key, url) {
  const clean = String(key || '').replace(/[^0-9A-Za-z:\-_.]/g, '')
  if (clean.length >= 6) return clean.slice(0, 80).toLowerCase()
  return `url-${hashId(url)}`
}

function platformText(platform) {
  const map = { bilibili: 'B站', youtube: 'YouTube', douyin: '抖音', xiaoyuzhou: '小宇宙' }
  return map[String(platform).toLowerCase()] || platform || '视频'
}

export function apply(ctx, config = {}) {
  const log = ctx.logger ?? console
  const dataDir = dataDirOf(config)
  const store = new Store(join(dataDir, 'library.json'), { log })
  const transcriptDir = join(dataDir, 'transcripts')
  const workRoot = join(dataDir, 'work')
  const maxChars = Math.max(4_000, Number(config.maxChars) || 24_000)

  /** 环境探测结果缓存 60 秒:python import 要 1~2 秒,别每次调用都跑 */
  let probeCache = { at: 0, value: null, pending: null }
  const getProbe = async (force = false) => {
    if (!force && probeCache.value && Date.now() - probeCache.at < 60_000) return probeCache.value
    if (probeCache.pending) return probeCache.pending
    probeCache.pending = probeEnvironment(config)
      .then((value) => {
        probeCache = { at: Date.now(), value, pending: null }
        return value
      })
      .catch((error) => {
        probeCache.pending = null
        throw error
      })
    return probeCache.pending
  }

  // 同一链接只跑一次:并发点两下不会起两个 whisper
  const inflight = new Map()

  async function writeTranscript(id, payload) {
    await mkdir(transcriptDir, { recursive: true })
    const file = join(transcriptDir, `${id}.json`)
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(payload), 'utf8')
    await rename(tmp, file)
    return file
  }

  async function readTranscript(id) {
    try {
      const raw = await readFile(join(transcriptDir, `${id}.json`), 'utf8')
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  function packet(record, segments, { note = '', includeSummary = true } = {}) {
    const formatted = formatTranscript(segments ?? [], { maxChars })
    const header = [
      `# ${record.title || '(无标题)'}`,
      [
        platformText(record.platform),
        record.author ? `作者 ${record.author}` : '',
        record.duration ? `时长 ${clock(record.duration)}` : '',
        record.source ? `文稿来源 ${record.source === 'asr' ? '本地 Whisper 转录' : '平台字幕'}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      `记录 id: ${record.id}`,
      record.url ? `链接: ${record.url}` : '',
    ]
      .filter(Boolean)
      .join('\n')

    const parts = [header, '', `## 转录稿(全文 ${formatted.total} 字)`, formatted.text]
    if (formatted.truncated) {
      parts.push(
        '',
        `> 文稿太长只给了前 ${formatted.text.length} 字;继续读调用 video_summary_transcript({ id: "${record.id}", offset: ${formatted.nextOffset} })。`,
      )
    }
    if (includeSummary && record.summary) {
      parts.push('', '## 已有总结', record.summary)
    }
    parts.push(
      '',
      '---',
      includeSummary && record.summary
        ? '这条视频之前总结过:直接把已有总结转述给用户;想重新转录并更新总结就再调用 video_summary({ url, force: true })。'
        : `下一步:写一份中文总结(先给 2~4 句结论,再按时间轴分段,最后列要点/立场/需要注意的地方),然后调用 video_summary_save({ id: "${record.id}", summary: "<总结 markdown>" }) 存进面板。`,
    )
    return {
      id: record.id,
      key: record.key ?? '',
      title: record.title ?? '',
      author: record.author ?? '',
      platform: record.platform ?? '',
      url: record.url ?? '',
      cover: record.cover ?? '',
      duration: Math.round(Number(record.duration) || 0),
      durationText: clock(record.duration ?? 0),
      source: record.source ?? '',
      lang: record.lang ?? '',
      chars: Number(record.chars) || 0,
      segments: Array.isArray(segments) ? segments.length : 0,
      truncated: formatted.truncated,
      existing: Boolean(includeSummary && record.summary),
      note,
      text: parts.join('\n'),
    }
  }

  // ------------------------------------------------------------- 工具 ---

  ctx.tools.register(
    defineTool({
      name: 'video_summary',
      description:
        '把一个视频链接变成可总结的转录稿:自动取元数据 → 有平台字幕就用字幕,没有就下音频并用本地 faster-whisper 转录 → 写入「视频总结」面板的一条记录,返回带时间戳的文稿。' +
        '拿到文稿后请直接写中文总结(结论 + 时间轴 + 要点),再调用 video_summary_save 把它存进同一条记录。' +
        '支持 B站 / YouTube 以及 yt-dlp 能处理的大多数站点;同一链接第二次调用会直接返回已存记录(传 force=true 可强制重新转录)。',
      parameters: {
        url: {
          type: 'string',
          required: true,
          description: '视频链接。B站可传 BV 号链接或 b23.tv 短链,YouTube 可传 youtu.be 短链。',
        },
        force: {
          type: 'boolean',
          description: '已有总结也重新转录(默认 false:直接回放已存记录)',
        },
        lang: {
          type: 'string',
          description: 'ASR 语言提示,默认 zh',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            key: { type: 'string', required: true },
            title: { type: 'string', required: true },
            author: { type: 'string', required: true },
            platform: { type: 'string', required: true },
            url: { type: 'string', required: true },
            cover: { type: 'string', required: true },
            duration: { type: 'integer', required: true },
            durationText: { type: 'string', required: true },
            source: { type: 'string', required: true },
            lang: { type: 'string', required: true },
            chars: { type: 'integer', required: true },
            segments: { type: 'integer', required: true },
            truncated: { type: 'boolean', required: true },
            existing: { type: 'boolean', required: true },
            note: { type: 'string', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        const signal = exec.signal
        const input = String(args.url ?? '').trim()
        if (!input) throw new Error('url 不能为空')
        const sessionId = exec.agent?.session?.id ?? ''
        const force = args.force === true

        const normalized = await normalizeInput(input, { signal })
        await store.ensureLoaded()

        // 已经跑过这条视频:不重复下载。有总结就直接回放,只有文稿就复用文稿
        if (normalized.key && !force) {
          const existing = store.findByKey(normalized.key)
          if (existing) {
            const stored = await readTranscript(existing.id)
            if (existing.summary && existing.status === 'summarized') {
              return packet(existing, stored.segments ?? [], {
                note: '已存在总结,直接回放;需要重新转录请传 force=true',
              })
            }
            if (existing.status === 'transcribed' && stored) {
              return packet(existing, stored.segments ?? [], {
                note: '复用了已有转录稿(这条还没写总结);直接把总结写出来并调用 video_summary_save',
              })
            }
          }
        }

        const probe = await getProbe()
        if (!probe.ytDlp.ok) throw new Error('找不到 yt-dlp:先 `brew install yt-dlp`(或配置 ytDlpPath)')
        if (!probe.python.ok) throw new Error(probe.python.error || '找不到装了 faster_whisper 的 python')

        const joinedKey = normalized.key || normalized.url
        if (inflight.has(joinedKey)) return inflight.get(joinedKey)

        const task = (async () => {
          const provisionalId = normalized.key ? idOf(normalized.key, normalized.url) : ''
          let id = provisionalId
          let record = null

          const workingPatch = (extra = {}) =>
            store.upsert({
              id,
              key: normalized.key || joinedKey,
              url: normalized.url,
              platform: normalized.platform || '',
              status: 'working',
              stage: 'meta',
              sessionId: sessionId || undefined,
              ...(force ? { summary: '', takeaways: [] } : {}),
              ...extra,
            })

          if (provisionalId) record = await workingPatch({ title: '' })

          try {
            const meta = await fetchMeta({ url: normalized.url, ytDlp: probe.ytDlp.path, signal })
            const finalId = idOf(meta.key || normalized.key || normalized.url, normalized.url)
            if (provisionalId && finalId !== provisionalId) {
              await store.remove(provisionalId)
              id = finalId
            }
            id = finalId
            record = await store.upsert({
              id,
              key: meta.key || joinedKey,
              platform: meta.platform || normalized.platform || '',
              url: meta.url || normalized.url,
              title: meta.title,
              author: meta.author,
              duration: meta.duration,
              cover: meta.cover,
              publishedAt: meta.publishedAt,
              status: 'working',
              stage: 'meta',
              sessionId: sessionId || record?.sessionId || undefined,
              summary: force ? '' : record?.summary ?? '',
              ...(force ? { takeaways: [] } : {}),
            })

            const workDir = join(workRoot, id)
            const result = await transcribeUrl({
              url: meta.url || normalized.url,
              workDir,
              config: { ...config, asrLang: args.lang || config?.asrLang },
              probe,
              signal,
              meta,
              onStage: async (stage) => {
                await store.upsert({ id, stage, status: 'working' })
              },
            })

            const segments = result.segments ?? []
            const chars = segments.reduce((sum, seg) => sum + String(seg.text ?? '').length, 0)
            if (chars === 0) throw new Error('转录结果为空(视频没有音轨,或站点拦了下载)')
            await writeTranscript(id, {
              lang: result.lang,
              duration: result.meta?.duration ?? meta.duration,
              source: result.source,
              segments,
            })
            record = await store.upsert({
              id,
              status: 'transcribed',
              stage: '',
              source: result.source,
              asrBackend: result.source === 'asr' ? probe.asr?.backend ?? '' : '',
              lang: result.lang,
              chars,
              segments: segments.length,
              error: '',
            })
            if (config.keepAudio !== true) await cleanupWork(workDir)
            return packet(record, segments)
          } catch (error) {
            if (error?.name === 'AbortError') {
              await store.upsert({ id, status: 'failed', stage: '', error: '已取消' }).catch(() => {})
              throw error
            }
            log.warn?.(`video-summary: ${id} 失败: ${error?.stack ?? error}`)
            if (id) await store.upsert({ id, status: 'failed', stage: '', error: String(error?.message ?? error) }).catch(() => {})
            throw error
          } finally {
            inflight.delete(joinedKey)
          }
        })()

        inflight.set(joinedKey, task)
        return task
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'video_summary_save',
      description:
        '把写好的总结存进「视频总结」面板对应的那条记录(video_summary 返回的 id)。写完总结后必须调用一次,否则面板里只有文稿、没有总结。' +
        '总结用 markdown:先 2~4 句结论,再按时间轴分段,可附 takeaways 要点数组。',
      parameters: {
        id: { type: 'string', required: true, description: 'video_summary 返回的记录 id' },
        summary: { type: 'string', required: true, description: 'markdown 总结正文(建议 300~3000 字)' },
        takeaways: {
          type: 'array',
          description: '可选:3~8 条一句话要点',
          items: { type: 'string' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            url: { type: 'string', required: true },
            status: { type: 'string', required: true },
            summaryChars: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `已保存总结:《${value.title || value.id}》${value.summaryChars} 字 · 面板「视频总结」里可查看`,
          },
        ],
      },
      async execute(args) {
        const id = String(args.id ?? '').trim()
        await store.ensureLoaded()
        const existing = store.get(id)
        if (!existing) throw new Error(`没有这条记录:${id}(先调用 video_summary 拿 id)`)
        const summary = String(args.summary ?? '').trim()
        if (summary.length < 10) throw new Error('summary 太短了,至少写 10 个字')
        const takeaways = Array.isArray(args.takeaways)
          ? args.takeaways.map((item) => String(item).trim()).filter(Boolean).slice(0, 12)
          : []
        const record = await store.upsert({ id, summary, takeaways, status: 'summarized', stage: '', error: '' })
        return {
          ok: true,
          id,
          title: record.title ?? '',
          url: record.url ?? '',
          status: record.status,
          summaryChars: summary.length,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'video_summary_list',
      description: '列出「视频总结」面板里已有的记录(按时间倒序),可按标题/作者关键词过滤。想知道某个视频是否总结过、拿了哪些 id 时用。',
      parameters: {
        query: { type: 'string', description: '标题/作者关键词,可空' },
        limit: { type: 'integer', description: '最多返回几条,默认 20,上限 50' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            total: { type: 'integer', required: true },
            items: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  author: { type: 'string', required: true },
                  platform: { type: 'string', required: true },
                  durationText: { type: 'string', required: true },
                  status: { type: 'string', required: true },
                  createdAt: { type: 'string', required: true },
                  summaryHead: { type: 'string', required: true },
                  url: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (value.items.length === 0) return [{ type: 'text', text: '还没有任何记录。' }]
          const lines = value.items.map(
            (item) =>
              `- [${item.status}] ${item.title || '(无标题)'}${item.author ? ` · ${item.author}` : ''}${item.durationText ? ` · ${item.durationText}` : ''} — id=${item.id}`,
          )
          return [{ type: 'text', text: `${value.total} 条记录:\n${lines.join('\n')}` }]
        },
      },
      async execute(args) {
        await store.ensureLoaded()
        const query = String(args.query ?? '').trim().toLowerCase()
        const limit = Math.min(50, Math.max(1, Number(args.limit) || 20))
        const all = store.list()
        const filtered = query
          ? all.filter(
              (item) =>
                String(item.title ?? '').toLowerCase().includes(query) ||
                String(item.author ?? '').toLowerCase().includes(query) ||
                String(item.summary ?? '').toLowerCase().includes(query),
            )
          : all
        return {
          total: filtered.length,
          items: filtered.slice(0, limit).map((item) => ({
            id: item.id,
            title: item.title ?? '',
            author: item.author ?? '',
            platform: item.platform ?? '',
            durationText: clock(item.duration ?? 0),
            status: STATUS_TEXT[item.status] ?? item.status ?? '',
            createdAt: item.createdAt ?? '',
            summaryHead: String(item.summary ?? '').replace(/\s+/g, ' ').slice(0, 120),
            url: item.url ?? '',
          })),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'video_summary_transcript',
      description: '按 id 读某条记录的转录稿(可分段读)。video_summary 返回的文稿被截断、或过一会儿要回看细节时用。',
      parameters: {
        id: { type: 'string', required: true, description: '记录 id' },
        offset: { type: 'integer', description: '从第几个字开始读,默认 0' },
        maxChars: { type: 'integer', description: '本次最多读多少字,默认 12000' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            total: { type: 'integer', required: true },
            offset: { type: 'integer', required: true },
            nextOffset: { type: 'integer', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args) {
        const id = String(args.id ?? '').trim()
        const stored = await readTranscript(id)
        if (!stored) throw new Error(`没有 ${id} 的转录稿(video_summary 跑过才会有)`)
        const offset = Math.max(0, Number(args.offset) || 0)
        const limit = Math.min(maxChars, Math.max(1_000, Number(args.maxChars) || 12_000))
        const formatted = formatTranscript(stored.segments ?? [], { maxChars: limit, offset })
        return {
          id,
          title: store.get(id)?.title ?? '',
          total: formatted.total,
          offset: formatted.offset,
          nextOffset: formatted.nextOffset,
          text: formatted.text,
        }
      },
    }),
  )

  // ------------------------------------------------------------- 路由 ---

  /** 封面图走宿主代理:B站 CDN 有 Referer ACL,页面来源(127.0.0.1)会被 403 */
  const coverCache = new Map()
  const COVER_CACHE_MAX = 160
  const COVER_CACHE_BYTES = 96 * 1024 * 1024
  let coverBytes = 0

  function coverReferer(url) {
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {
      return ''
    }
    if (/hdslb\.com$|bilibili\.com$|biliimg\.com$/.test(host)) return 'https://www.bilibili.com/'
    if (/ytimg\.com$|youtube\.com$|ggpht\.com$|googleusercontent\.com$/.test(host)) return 'https://www.youtube.com/'
    if (/douyinpic\.com$|douyinstatic\.com$|douyin\.com$/.test(host)) return 'https://www.douyin.com/'
    // 空 Referer 对大多数 CDN 都放行
    return ''
  }

  /** 只代理公网图片,别把本机/内网地址当代理跳板 */
  function isPrivateHost(host) {
    if (!host) return true
    if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) return true
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true
    if (host === '0.0.0.0' || host === '::1' || host === '[::1]') return true
    return false
  }

  function rememberCover(url, body, type) {
    coverCache.set(url, { at: Date.now(), body, type })
    coverBytes += body.length
    while (coverBytes > COVER_CACHE_BYTES || coverCache.size > COVER_CACHE_MAX) {
      const oldest = coverCache.keys().next().value
      if (oldest === undefined) break
      coverBytes -= coverCache.get(oldest)?.body?.length ?? 0
      coverCache.delete(oldest)
    }
  }

  const disposers = []

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/v-sum/health',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const probe = await getProbe(true)
          await store.ensureLoaded()
          return sendJson(res, 200, {
            ok: true,
            probe,
            dataDir,
            counts: {
              total: store.records.length,
              summarized: store.records.filter((item) => item.status === 'summarized').length,
              working: store.records.filter((item) => item.status === 'working').length,
            },
          })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/v-sum/library',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          await store.ensureLoaded()
          const url = new URL(req.url ?? '/v-sum/library', 'http://localhost')
          const query = String(url.searchParams.get('q') ?? '').trim().toLowerCase()
          const all = store.list()
          const items = query
            ? all.filter(
                (item) =>
                  String(item.title ?? '').toLowerCase().includes(query) ||
                  String(item.author ?? '').toLowerCase().includes(query) ||
                  String(item.summary ?? '').toLowerCase().includes(query),
              )
            : all
          return sendJson(res, 200, {
            ok: true,
            items: items.map((item) => ({
              id: item.id,
              key: item.key ?? '',
              platform: item.platform ?? '',
              platformText: platformText(item.platform),
              url: item.url ?? '',
              title: item.title ?? '',
              author: item.author ?? '',
              duration: Number(item.duration) || 0,
              durationText: clock(item.duration ?? 0),
              cover: item.cover ?? '',
              status: item.status ?? '',
              statusText: STATUS_TEXT[item.status] ?? item.status ?? '',
              stage: item.stage ?? '',
              source: item.source ?? '',
              asrBackend: item.asrBackend ?? '',
              lang: item.lang ?? '',
              chars: Number(item.chars) || 0,
              segments: Number(item.segments) || 0,
              summary: item.summary ?? '',
              takeaways: Array.isArray(item.takeaways) ? item.takeaways : [],
              error: item.error ?? '',
              sessionId: item.sessionId ?? '',
              createdAt: item.createdAt ?? '',
              updatedAt: item.updatedAt ?? '',
              publishedAt: item.publishedAt ?? '',
            })),
          })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/v-sum/cover',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        }
        let target = ''
        try {
          const url = new URL(req.url ?? '/v-sum/cover', 'http://localhost')
          target = String(url.searchParams.get('u') ?? '').trim()
          const parsed = new URL(target)
          if (!/^https?:$/.test(parsed.protocol)) throw new Error('只支持 http/https')
          if (isPrivateHost(parsed.hostname)) throw new Error('不代理内网地址')
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }

        const cached = coverCache.get(target)
        if (cached && Date.now() - cached.at < 7 * 24 * 3600_000) {
          res.writeHead(200, {
            'content-type': cached.type,
            'cache-control': 'public, max-age=86400',
            'content-length': cached.body.length,
          })
          return res.end(req.method === 'HEAD' ? undefined : cached.body)
        }

        try {
          const upstream = await fetch(target, {
            headers: {
              'user-agent': UA,
              referer: coverReferer(target),
              accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(15_000),
          })
          if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`)
          const type = upstream.headers.get('content-type') ?? 'image/jpeg'
          if (!type.startsWith('image/')) throw new Error(`不是图片:${type}`)
          const body = Buffer.from(await upstream.arrayBuffer())
          if (body.length > 8 * 1024 * 1024) throw new Error('图片过大')
          rememberCover(target, body, type)
          res.writeHead(200, {
            'content-type': type,
            'cache-control': 'public, max-age=86400',
            'content-length': body.length,
          })
          return res.end(req.method === 'HEAD' ? undefined : body)
        } catch (error) {
          return sendJson(res, 502, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/v-sum/item',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/v-sum/item', 'http://localhost')
        const id = String(url.searchParams.get('id') ?? '').trim()
        if (req.method === 'GET') {
          if (!id) return sendJson(res, 400, { ok: false, error: 'id required' })
          await store.ensureLoaded()
          const item = store.get(id)
          if (!item) return sendJson(res, 404, { ok: false, error: 'not found' })
          const stored = await readTranscript(id)
          return sendJson(res, 200, {
            ok: true,
            item,
            statusText: STATUS_TEXT[item.status] ?? item.status,
            platformText: platformText(item.platform),
            transcript: {
              lang: stored?.lang ?? '',
              source: stored?.source ?? '',
              segments: stored?.segments ?? [],
            },
          })
        }
        if (req.method === 'DELETE') {
          if (!id) return sendJson(res, 400, { ok: false, error: 'id required' })
          const removed = await store.remove(id)
          await rm(join(transcriptDir, `${id}.json`), { force: true }).catch(() => {})
          await cleanupWork(join(workRoot, id))
          return sendJson(res, 200, { ok: true, removed })
        }
        if (req.method === 'POST') {
          try {
            const body = JSON.parse(await readBody(req)) ?? {}
            const target = String(body.id ?? id).trim()
            if (!target) return sendJson(res, 400, { ok: false, error: 'id required' })
            const existing = store.get(target)
            if (!existing) return sendJson(res, 404, { ok: false, error: 'not found' })
            const patch = { id: target }
            if (typeof body.sessionId === 'string' && body.sessionId) patch.sessionId = body.sessionId.slice(0, 100)
            if (typeof body.summary === 'string') patch.summary = body.summary.slice(0, 200_000)
            if (Array.isArray(body.takeaways)) {
              patch.takeaways = body.takeaways.map((item) => String(item).slice(0, 300)).slice(0, 12)
            }
            const record = await store.upsert(patch)
            return sendJson(res, 200, { ok: true, item: record })
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        }
        return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      },
    }),
  )

  ctx.effect?.(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* 卸载时别抛 */
      }
    }
  }, 'video-summary: dispose routes')
}
