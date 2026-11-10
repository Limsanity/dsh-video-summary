/**
 * 视频总结面板。
 *
 * 只依赖 react(宿主以 external 提供),样式全部走 DSH 的 --dsw-* 设计令牌,
 * 所以浅色/深色主题自动跟随。数据来自宿主插件的 /v-sum/* 路由。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { coverSrc, formatClock, formatWhen, statusOf, stageOf } from './format.js'
import { renderMarkdown } from './markdown.js'

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'summarized', label: '已总结' },
  { key: 'transcribed', label: '待总结' },
  { key: 'failed', label: '失败' },
]

async function getJson(path, options) {
  const res = await fetch(path, { cache: 'no-store', ...options })
  const data = await res.json().catch(() => null)
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${res.status}`)
  return data
}

function StatusBadge({ status, stage, statusText }) {
  const meta = statusOf(status, statusText)
  const extra = status === 'working' ? stageOf(stage) : ''
  return (
    <span className={`vs-badge vs-badge-${meta.tone}`}>
      {meta.text}
      {extra ? <em>{extra}</em> : null}
    </span>
  )
}

/**
 * 环境状态:挤在筛选 tab 那一行的右侧。
 * 之前它单独占一行、又比列表晚 1~2 秒才到,加载完成时把列表整体往下推 —— 典型的 CLS。
 * 塞进固定 32px 高的 tabs 行里,变长变短都只影响这一行,不再动列表。
 */
function HealthStatus({ health, onRetry }) {
  if (!health) return null
  const backend = health.probe?.asr
  const modelName = String(backend?.model?.label ?? '')
    .split('/')
    .pop()
    .replace(/^whisper-/, '')
  const detail = [
    `yt-dlp: ${health.probe?.ytDlp?.path ?? '未找到'}${health.probe?.ytDlp?.version ? ` (${health.probe.ytDlp.version})` : ''}`,
    `ffmpeg: ${health.probe?.ffmpeg?.path ?? '未找到'}`,
    `转录后端: ${backend ? `${backend.backend}(${backend.python})` : '无'}`,
    `模型: ${backend?.model?.path ?? '无'}`,
    `数据目录: ${health.dataDir ?? ''}`,
  ].join('\n')

  if (health.probe?.ready) {
    return (
      <span className="vs-health" title={detail}>
        <span className="vs-dot" />
        <span className="vs-health-text">
          就绪 · {backend.backend === 'mlx' ? 'MLX(GPU)' : 'CPU'} · {modelName}
        </span>
      </span>
    )
  }
  const missing = [
    !health.probe?.ytDlp?.ok ? 'yt-dlp' : '',
    !health.probe?.asr ? 'mlx-whisper / faster-whisper' : '',
  ].filter(Boolean)
  return (
    <span className="vs-health vs-health-bad" title={detail}>
      <span className="vs-dot vs-dot-bad" />
      <span className="vs-health-text">环境缺 {missing.join(' / ') || '依赖'},转录会失败</span>
      <button type="button" className="vs-link-btn" onClick={onRetry}>
        重新探测
      </button>
    </span>
  )
}

export function VideoPanel({ startSummary, openExternal, openSession }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [health, setHealth] = useState(null)
  const [compose, setCompose] = useState('')
  const [detailId, setDetailId] = useState('')
  const [detail, setDetail] = useState(null)
  const [detailError, setDetailError] = useState('')
  const [detailLoading, setDetailLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const pollRef = useRef(null)

  const refresh = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true)
    try {
      const data = await getJson('/v-sum/library')
      setItems(Array.isArray(data.items) ? data.items : [])
      setError('')
    } catch (err) {
      if (!quiet) setError(String(err?.message ?? err))
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])

  const loadHealth = useCallback(async () => {
    try {
      const data = await getJson('/v-sum/health')
      setHealth(data)
    } catch {
      setHealth(null)
    }
  }, [])

  useEffect(() => {
    refresh()
    loadHealth()
  }, [refresh, loadHealth])

  // 有任务在转录时勤刷(宿主的记录会从「转录中」走到「待总结」)
  useEffect(() => {
    clearInterval(pollRef.current)
    const busy = items.some((item) => item.status === 'working')
    pollRef.current = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      refresh({ quiet: true })
    }, busy ? 3000 : 20000)
    return () => clearInterval(pollRef.current)
  }, [items, refresh])

  useEffect(() => {
    if (!detailId) {
      setDetail(null)
      return
    }
    let cancelled = false
    setDetailLoading(true)
    setDetailError('')
    getJson(`/v-sum/item?id=${encodeURIComponent(detailId)}`)
      .then((data) => {
        if (!cancelled) setDetail(data)
      })
      .catch((err) => {
        if (!cancelled) setDetailError(String(err?.message ?? err))
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [detailId])

  const counts = useMemo(() => {
    return {
      all: items.length,
      summarized: items.filter((item) => item.status === 'summarized').length,
      transcribed: items.filter((item) => item.status === 'transcribed').length,
      failed: items.filter((item) => item.status === 'failed').length,
    }
  }, [items])

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return items.filter((item) => {
      if (filter !== 'all' && item.status !== filter) return false
      if (!keyword) return true
      return (
        String(item.title ?? '').toLowerCase().includes(keyword) ||
        String(item.author ?? '').toLowerCase().includes(keyword) ||
        String(item.summary ?? '').toLowerCase().includes(keyword)
      )
    })
  }, [items, filter, query])

  const submitCompose = (event) => {
    event?.preventDefault?.()
    const url = compose.trim()
    if (!url) return
    const ok = startSummary(url)
    if (ok) setCompose('')
  }

  const removeItem = async (item) => {
    const label = item.title || item.id
    if (!window.confirm(`删除这条总结?\n\n${label}\n\n(转录稿文件也会一起删掉)`)) return
    try {
      await getJson(`/v-sum/item?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' })
      if (detailId === item.id) setDetailId('')
      await refresh({ quiet: true })
    } catch (err) {
      window.alert(`删除失败:${err?.message ?? err}`)
    }
  }

  const copyTranscript = async () => {
    const segments = detail?.transcript?.segments ?? []
    if (segments.length === 0) return
    const text = segments.map((seg) => `[${formatClock(seg.start)}] ${seg.text}`).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* 剪贴板不可用就算了 */
    }
  }

  return (
    <div className="vs-root">
      <style>{STYLES}</style>

      {detailId ? (
        <DetailView
          detail={detail}
          loading={detailLoading}
          error={detailError}
          copied={copied}
          onCopy={copyTranscript}
          onBack={() => setDetailId('')}
          onOpenVideo={(url) => openExternal(url)}
          onOpenSession={(id) => openSession(id)}
          onSummarize={(url) => startSummary(url)}
          onDelete={(item) => removeItem(item)}
        />
      ) : (
        <>
          <header className="vs-head">
            <div className="vs-head-main">
              <h1 className="vs-title">视频总结</h1>
              <span className="vs-sub">
                {counts.all > 0 ? `${counts.all} 条记录 · ${counts.summarized} 篇总结` : '还没有记录'}
              </span>
            </div>
            <div className="vs-head-actions">
              <input
                className="vs-input vs-search"
                placeholder="搜索标题 / 作者 / 总结"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button type="button" className="vs-btn" onClick={() => refresh()} title="刷新">
                刷新
              </button>
            </div>
          </header>

          <form className="vs-compose" onSubmit={submitCompose}>
            <input
              className="vs-input vs-compose-input"
              placeholder="粘贴视频链接(B站 / YouTube / 抖音 …),回车新开会话开始总结"
              value={compose}
              onChange={(event) => setCompose(event.target.value)}
            />
            <button type="submit" className="vs-btn vs-btn-primary" disabled={!compose.trim()}>
              开始总结
            </button>
          </form>

          <div className="vs-tabs">
            {FILTERS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={`vs-tab ${filter === tab.key ? 'is-active' : ''}`}
                onClick={() => setFilter(tab.key)}
              >
                {tab.label}
                <em>{counts[tab.key] ?? 0}</em>
              </button>
            ))}
            <HealthStatus health={health} onRetry={loadHealth} />
          </div>

          <div className="vs-list">
            {loading && items.length === 0 ? <div className="vs-empty">加载中…</div> : null}
            {error ? (
              <div className="vs-error">
                读取记录失败:{error}
                <button type="button" className="vs-link-btn" onClick={() => refresh()}>
                  重试
                </button>
              </div>
            ) : null}
            {!loading && filtered.length === 0 && !error ? (
              <div className="vs-empty">
                <div className="vs-empty-title">{items.length === 0 ? '还没有总结过视频' : '没有匹配的记录'}</div>
                <div className="vs-empty-hint">
                  在上面的输入框粘一个视频链接回车:会新开一个 DSH 会话,模型调用 <code>video_summary</code> 转录、
                  写完总结再存回这里。也可以直接对 agent 说「总结这个视频:&lt;链接&gt;」。
                </div>
              </div>
            ) : null}

            {filtered.map((item) => (
              <article key={item.id} className="vs-card" onClick={() => setDetailId(item.id)}>
                {item.cover ? (
                  <img
                    className="vs-cover"
                    src={coverSrc(item.cover, 160)}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={(event) => {
                      event.currentTarget.style.visibility = 'hidden'
                    }}
                  />
                ) : (
                  <div className="vs-cover vs-cover-empty" />
                )}
                <div className="vs-card-main">
                  <div className="vs-card-top">
                    <h2 className="vs-card-title">{item.title || '(无标题)'}</h2>
                    <StatusBadge status={item.status} stage={item.stage} statusText={item.statusText} />
                  </div>
                  <div className="vs-card-sub">
                    <span>{item.platformText || item.platform || '视频'}</span>
                    {item.author ? <span>· {item.author}</span> : null}
                    {item.duration ? <span>· {item.durationText || formatClock(item.duration)}</span> : null}
                    <span>· {formatWhen(item.createdAt)}</span>
                  </div>
                  <p className="vs-card-summary">
                    {item.summary
                      ? item.summary.replace(/[#>*`\-]/g, '').replace(/\s+/g, ' ').slice(0, 220)
                      : item.error
                        ? `失败:${item.error}`
                        : item.status === 'working'
                          ? '正在下载 / 转录,完成后这里会出现文稿与总结…'
                          : '已有转录稿,还没写总结。'}
                  </p>
                  <div className="vs-card-foot">
                    <span className="vs-card-stat">
                      {item.chars ? `${item.chars} 字` : ''}
                      {item.chars && item.segments ? ' · ' : ''}
                      {item.segments ? `${item.segments} 段` : ''}
                      {item.source
                        ? ` · ${item.source === 'asr' ? (item.asrBackend === 'mlx' ? 'MLX' : 'Whisper') : '字幕'}`
                        : ''}
                    </span>
                    <span className="vs-card-actions" onClick={(event) => event.stopPropagation()}>
                      {item.url ? (
                        <button type="button" className="vs-link-btn" onClick={() => openExternal(item.url)}>
                          原视频 ↗
                        </button>
                      ) : null}
                      <button type="button" className="vs-link-btn vs-danger" onClick={() => removeItem(item)}>
                        删除
                      </button>
                    </span>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function DetailView({ detail, loading, error, copied, onCopy, onBack, onOpenVideo, onOpenSession, onSummarize, onDelete }) {
  const item = detail?.item
  const segments = detail?.transcript?.segments ?? []
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    setShowAll(false)
  }, [item?.id])

  const visible = showAll ? segments : segments.slice(0, 80)

  return (
    <>
      <header className="vs-head vs-detail-head">
        <button type="button" className="vs-back" onClick={onBack}>
          ← 返回
        </button>
        <div className="vs-head-main">
          <h1 className="vs-title vs-detail-title">{item?.title || (loading ? '加载中…' : '(无标题)')}</h1>
          <span className="vs-sub">
            {[
              item?.platformText || item?.platform,
              item?.author,
              item?.durationText,
              item?.chars ? `${item.chars} 字` : '',
              item?.createdAt ? formatWhen(item.createdAt) : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
        <div className="vs-head-actions">
          {item?.sessionId ? (
            <button type="button" className="vs-btn" onClick={() => onOpenSession(item.sessionId)}>
              回到会话
            </button>
          ) : null}
          {item?.url ? (
            <button type="button" className="vs-btn" onClick={() => onOpenVideo(item.url)}>
              原视频 ↗
            </button>
          ) : null}
          <button type="button" className="vs-btn vs-danger" onClick={() => item && onDelete(item)}>
            删除
          </button>
        </div>
      </header>

      <div className="vs-detail">
        {error ? <div className="vs-error">读取详情失败:{error}</div> : null}
        {loading && !item ? <div className="vs-empty">加载中…</div> : null}

        {item ? (
          <>
            {item.status === 'working' ? (
              <div className="vs-warn">
                正在{stageOf(item.stage) || '处理'}…面板会自动刷新,不用等在这里。
              </div>
            ) : null}
            {item.status === 'failed' ? <div className="vs-error">上次失败:{item.error || '未知错误'}</div> : null}

            <div className="vs-detail-body">
              <div className="vs-detail-main">
                {item.summary ? (
                  <div className="vs-summary">{renderMarkdown(item.summary)}</div>
                ) : (
                  <div className="vs-empty vs-empty-inline">
                    <div className="vs-empty-title">还没有总结</div>
                    <div className="vs-empty-hint">
                      文稿已经在记录里了。新开一个会话说一句「用已有文稿写总结」即可;或者直接点下面按钮。
                    </div>
                    <button type="button" className="vs-btn vs-btn-primary" onClick={() => onSummarize(item.url)}>
                      让 AI 写总结
                    </button>
                  </div>
                )}

                {Array.isArray(item.takeaways) && item.takeaways.length > 0 ? (
                  <section className="vs-takeaways">
                    <h3 className="vs-h">要点</h3>
                    <ul className="vs-list">
                      {item.takeaways.map((takeaway, index) => (
                        <li key={index}>{takeaway}</li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </div>

              <aside className="vs-detail-side">
                {item.cover ? (
                  <img
                    className="vs-detail-cover"
                    src={coverSrc(item.cover)}
                    alt=""
                    referrerPolicy="no-referrer"
                    onError={(event) => {
                      event.currentTarget.style.visibility = 'hidden'
                    }}
                  />
                ) : null}
                <dl className="vs-kv">
                  <dt>状态</dt>
                  <dd>
                    <StatusBadge status={item.status} stage={item.stage} statusText={detail?.statusText} />
                  </dd>
                  <dt>来源</dt>
                  <dd>{item.source === 'asr' ? '本地 Whisper 转录' : item.source ? '平台字幕' : '—'}</dd>
                  <dt>语言</dt>
                  <dd>{item.lang || '—'}</dd>
                  <dt>文稿</dt>
                  <dd>
                    {item.chars ? `${item.chars} 字 / ${segments.length} 段` : '—'}
                  </dd>
                  <dt>记录</dt>
                  <dd className="vs-mono">{item.id}</dd>
                </dl>
              </aside>
            </div>

            <details className="vs-transcript">
              <summary>
                转录稿{segments.length ? `(${segments.length} 段)` : '(空)'}
                {segments.length ? (
                  <button
                    type="button"
                    className="vs-link-btn"
                    onClick={(event) => {
                      event.preventDefault()
                      onCopy()
                    }}
                  >
                    {copied ? '已复制' : '复制全文'}
                  </button>
                ) : null}
              </summary>
              <div className="vs-transcript-body">
                {visible.map((segment, index) => (
                  <div key={index} className="vs-seg">
                    <span className="vs-seg-time">{formatClock(segment.start)}</span>
                    <span className="vs-seg-text">{segment.text}</span>
                  </div>
                ))}
                {segments.length > visible.length ? (
                  <button type="button" className="vs-btn vs-more" onClick={() => setShowAll(true)}>
                    展开剩余 {segments.length - visible.length} 段
                  </button>
                ) : null}
              </div>
            </details>
          </>
        ) : null}
      </div>
    </>
  )
}

export function VideoIcon({ size = 18, active = false }) {
  return (
    <span
      style={{
        color: active ? 'var(--dsw-alias-brand-primary)' : 'inherit',
        display: 'inline-flex',
        alignItems: 'center',
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="5" width="18" height="14" rx="2.5" />
        <path d="M10 9.5l4.5 2.5L10 14.5z" fill="currentColor" stroke="none" />
      </svg>
    </span>
  )
}

const STYLES = `
.vs-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.vs-head{flex:none;display:flex;align-items:center;gap:12px;
  padding:14px max(24px,calc((100% - 1040px)/2)) 10px}
.vs-head-main{min-width:0;flex:1;display:flex;align-items:baseline;gap:10px}
.vs-title{margin:0;font-size:16px;font-weight:600;letter-spacing:.2px}
.vs-detail-title{font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vs-sub{font-size:11.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vs-head-actions{display:flex;align-items:center;gap:8px;flex:none}
.vs-input{height:30px;padding:0 10px;border-radius:var(--dsw-radius-sm);
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font-size:12.5px;outline:none;transition:border-color .15s}
.vs-input:focus{border-color:var(--dsw-alias-brand-primary)}
.vs-input::placeholder{color:var(--dsw-alias-label-caption)}
.vs-search{width:180px}
.vs-btn{height:30px;padding:0 12px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12.5px;
  cursor:pointer;transition:background .15s,color .15s,border-color .15s;white-space:nowrap}
.vs-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.vs-btn:disabled{opacity:.45;cursor:not-allowed}
.vs-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;
  color:var(--dsw-alias-bg-base);font-weight:500}
.vs-btn-primary:hover{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);opacity:.88}
.vs-btn.vs-btn-primary:disabled{opacity:1;background:var(--dsw-alias-bg-layer-1);
  border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);cursor:not-allowed}
.vs-danger{color:var(--dsw-alias-state-error-primary)}
.vs-btn.vs-danger{border-color:var(--dsw-alias-border-l1)}
.vs-compose{flex:none;display:flex;gap:8px;padding:0 max(24px,calc((100% - 1040px)/2)) 12px}
.vs-compose-input{flex:1;height:34px;font-size:13px}
.vs-tabs{flex:none;display:flex;align-items:center;gap:2px;padding:0 max(24px,calc((100% - 1040px)/2));
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.vs-tab{flex:none;height:32px;padding:0 10px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);
  font-size:12.5px;cursor:pointer;border-bottom:2px solid transparent;display:inline-flex;align-items:center;gap:5px}
.vs-tab em{font-style:normal;font-size:11px;color:var(--dsw-alias-label-caption)}
.vs-tab:hover{color:var(--dsw-alias-label-primary)}
.vs-tab.is-active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary)}
.vs-health{margin-left:auto;flex:0 1 auto;min-width:0;display:inline-flex;align-items:center;gap:6px;
  font-size:11px;color:var(--dsw-alias-label-caption);padding-left:14px;white-space:nowrap}
.vs-health-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.vs-health-bad{color:var(--dsw-alias-state-error-primary)}
.vs-dot-bad{background:var(--dsw-alias-state-error-primary);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent)}
.vs-warn{flex:none;display:flex;align-items:center;gap:6px;font-size:11.5px;margin:10px 0;
  color:var(--dsw-alias-state-error-primary);justify-content:flex-start}
.vs-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}
.vs-list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px;
  padding:12px max(24px,calc((100% - 1040px)/2)) 24px}
.vs-card{display:flex;gap:12px;padding:10px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);cursor:pointer;
  transition:border-color .15s,background .15s}
.vs-card:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}
.vs-cover{flex:none;width:132px;height:82px;border-radius:var(--dsw-radius-sm);object-fit:cover;
  background:var(--dsw-alias-bg-base)}
.vs-cover-empty{background:var(--dsw-alias-bg-base);border:1px dashed var(--dsw-alias-border-l1)}
.vs-card-main{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}
.vs-card-top{display:flex;align-items:flex-start;gap:8px}
.vs-card-title{margin:0;font-size:13.5px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;flex:1}
.vs-card-sub{font-size:11.5px;color:var(--dsw-alias-label-tertiary);display:flex;gap:5px;flex-wrap:wrap}
.vs-card-summary{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.55;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.vs-card-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:2px}
.vs-card-stat{font-size:11px;color:var(--dsw-alias-label-caption)}
.vs-card-actions{display:flex;gap:10px}
.vs-badge{flex:none;height:20px;padding:0 7px;border-radius:999px;font-size:11px;line-height:20px;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);
  background:var(--dsw-alias-bg-base);white-space:nowrap}
.vs-badge em{font-style:normal;margin-left:4px;color:var(--dsw-alias-label-caption)}
.vs-badge-done{color:var(--dsw-alias-state-business-primary);border-color:currentColor}
.vs-badge-warn{color:var(--dsw-alias-label-secondary)}
.vs-badge-busy{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.vs-badge-error{color:var(--dsw-alias-state-error-primary);border-color:currentColor}
.vs-link-btn{padding:0;border:0;background:transparent;color:var(--dsw-alias-brand-primary);
  font-size:11.5px;cursor:pointer}
.vs-link-btn:hover{opacity:.8}
.vs-link-btn.vs-danger{color:var(--dsw-alias-state-error-primary)}
.vs-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;
  padding:56px 24px;color:var(--dsw-alias-label-tertiary);text-align:center}
.vs-empty-inline{padding:32px 0;align-items:flex-start;text-align:left}
.vs-empty-title{font-size:13px;color:var(--dsw-alias-label-secondary)}
.vs-empty-hint{font-size:12px;line-height:1.7;max-width:560px}
.vs-empty-hint code{background:var(--dsw-alias-bg-layer-1);padding:1px 4px;border-radius:4px;font-size:11.5px}
.vs-error{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:10px max(24px,calc((100% - 1040px)/2))}
.vs-back{height:28px;padding:0 8px 0 4px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;
  color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;flex:none}
.vs-back:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.vs-detail-head{border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:10px}
.vs-detail{flex:1;min-height:0;overflow-y:auto;padding:14px max(24px,calc((100% - 1040px)/2)) 40px}
.vs-detail-body{display:flex;gap:20px;align-items:flex-start}
.vs-detail-main{flex:1;min-width:0}
.vs-detail-side{flex:none;width:208px}
.vs-detail-cover{width:100%;border-radius:var(--dsw-radius-md);margin-bottom:10px;background:var(--dsw-alias-bg-layer-1)}
.vs-kv{display:grid;grid-template-columns:44px 1fr;gap:4px 8px;margin:0;font-size:11.5px}
.vs-kv dt{color:var(--dsw-alias-label-caption)}
.vs-kv dd{margin:0;color:var(--dsw-alias-label-secondary);word-break:break-all}
.vs-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px}
.vs-summary{font-size:13.5px;line-height:1.75;color:var(--dsw-alias-label-primary)}
.vs-p{margin:0 0 10px}
.vs-h{margin:16px 0 8px;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.vs-h3{margin:14px 0 6px;font-size:13.5px}
.vs-h4{margin:14px 0 6px;font-size:13.5px}
.vs-h5,.vs-h6{margin:12px 0 6px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.vs-md-list{margin:0 0 10px;padding-left:20px}
.vs-md-list li{margin:3px 0}
.vs-quote{margin:0 0 10px;padding:6px 10px;border-left:3px solid var(--dsw-alias-border-l2);
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-radius:0 var(--dsw-radius-sm) var(--dsw-radius-sm) 0}
.vs-pre{margin:0 0 10px;padding:10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);
  overflow-x:auto;font-size:12px}
.vs-code{background:var(--dsw-alias-bg-layer-1);padding:1px 4px;border-radius:4px;font-size:12px;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.vs-link{color:var(--dsw-alias-brand-primary);text-decoration:none}
.vs-link:hover{text-decoration:underline}
.vs-hr{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:14px 0}
.vs-takeaways{margin-top:18px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}
.vs-transcript{margin-top:18px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px}
.vs-transcript summary{display:flex;align-items:center;gap:10px;cursor:pointer;font-size:12.5px;
  color:var(--dsw-alias-label-secondary);list-style:none}
.vs-transcript summary::-webkit-details-marker{display:none}
.vs-transcript summary:before{content:"▸";color:var(--dsw-alias-label-caption);transition:transform .15s}
.vs-transcript[open] summary:before{transform:rotate(90deg)}
.vs-transcript-body{margin-top:10px;max-height:420px;overflow-y:auto;font-size:12px;
  display:flex;flex-direction:column;gap:4px}
.vs-seg{display:flex;gap:10px}
.vs-seg-time{flex:none;width:44px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.vs-seg-text{color:var(--dsw-alias-label-secondary)}
.vs-more{margin:8px 0}
`
