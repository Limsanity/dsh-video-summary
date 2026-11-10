/** 面板里用到的格式化小工具 */

export function formatClock(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0))
  const h = Math.floor(value / 3600)
  const m = Math.floor((value % 3600) / 60)
  const s = value % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function formatWhen(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  if (sameDay) return `今天 ${hh}:${mm}`
  const yesterday = new Date(now.getTime() - 86_400_000)
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${hh}:${mm}`
  const sameYear = date.getFullYear() === now.getFullYear()
  const md = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return sameYear ? `${md} ${hh}:${mm}` : `${date.getFullYear()}-${md}`
}

export function formatCount(value) {
  const n = Number(value) || 0
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`
  return String(n)
}

const STATUS = {
  working: { text: '转录中', tone: 'busy' },
  transcribed: { text: '待总结', tone: 'warn' },
  summarized: { text: '已总结', tone: 'done' },
  failed: { text: '失败', tone: 'error' },
}

export function statusOf(status, fallback) {
  return STATUS[status] ?? { text: fallback || status || '未知', tone: 'idle' }
}

export function stageOf(stage) {
  return (
    {
      meta: '取元数据',
      subtitle: '找字幕',
      audio: '下音频',
      transcribe: '转录中',
    }[stage] ?? ''
  )
}

export function coverUrl(url) {
  if (!url) return ''
  return String(url).replace(/^http:/i, 'https:')
}

/** 封面统一走宿主代理:B站 CDN 认 Referer,浏览器直连会被 403 */
export function coverSrc(url, width = 0) {
  const clean = width ? thumbUrl(url, width) : coverUrl(url)
  if (!clean) return ''
  return `/v-sum/cover?u=${encodeURIComponent(clean)}`
}

/** B站封面带 @ 参数可以直接要小图,省流量 */
export function thumbUrl(url, width = 160) {
  const clean = coverUrl(url)
  if (!clean) return ''
  return clean.includes('hdslb.com') ? `${clean.split('@')[0]}@${width}w_${Math.round(width * 0.62)}h_1c.webp` : clean
}
