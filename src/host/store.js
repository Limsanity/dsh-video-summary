/**
 * 总结记录本:一个 JSON 文件,原子写入 + 备份 + 「没读过盘就不写」的保护。
 *
 * 记录结构(只有 id 必需,其余字段由各调用点补齐):
 *   { id, key, platform, url, title, author, duration, cover, publishedAt,
 *     status, stage, source, lang, chars, segments, summary, takeaways,
 *     error, sessionId, createdAt, updatedAt }
 *
 * status: working(转录中) | transcribed(有稿待总结) | summarized(已完成) | failed
 */
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const VERSION = 1
const MAX_ITEMS = 500

function nowIso() {
  return new Date().toISOString()
}

export class Store {
  /**
   * @param file 记录文件绝对路径
   * @param options.max 最多保留多少条
   * @param options.log 日志接口(默认 console)
   */
  constructor(file, { max = MAX_ITEMS, log = console } = {}) {
    this.file = file
    this.max = max
    this.log = log
    /** 内存里的记录(按 createdAt 倒序) */
    this.records = []
    /** 是否成功读过盘 —— 没读过就绝不写盘,免得用空表覆盖历史 */
    this.loaded = false
    /** 读到坏 JSON 时置 true,此后拒绝写入,留给人工抢救 */
    this.loadFailed = false
    this.pending = Promise.resolve()
  }

  async ensureLoaded() {
    if (this.loaded || this.loadFailed) return
    try {
      const raw = await readFile(this.file, 'utf8')
      const data = JSON.parse(raw)
      const items = Array.isArray(data?.items) ? data.items : []
      this.records = items
        .filter((item) => item && typeof item.id === 'string' && item.id)
        .map((item) => ({ ...item }))
        .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
      this.loaded = true
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // 还没写过,正常
        this.loaded = true
        this.records = []
        return
      }
      this.loadFailed = true
      this.log.warn?.(`video-summary: 读取 ${this.file} 失败,本次会话拒绝写盘: ${error?.message ?? error}`)
    }
  }

  /** 只读快照(按时间倒序) */
  list() {
    return this.records.map((item) => ({ ...item }))
  }

  get(id) {
    const hit = this.records.find((item) => item.id === id)
    return hit ? { ...hit } : null
  }

  findByKey(key) {
    if (!key) return null
    const hit = this.records.find((item) => item.key === key)
    return hit ? { ...hit } : null
  }

  /**
   * 合并写一条记录(id 相同则局部更新),返回写入后的记录。
   * @param patch 至少包含 id
   */
  async upsert(patch) {
    await this.ensureLoaded()
    const id = String(patch?.id ?? '').trim()
    if (!id) throw new Error('upsert 需要 id')
    if (this.loadFailed) throw new Error('记录文件损坏,已停止写入(请先修好 library.json)')

    const at = nowIso()
    const index = this.records.findIndex((item) => item.id === id)
    let record
    if (index >= 0) {
      record = { ...this.records[index], ...patch, id, updatedAt: at }
      this.records[index] = record
    } else {
      record = { createdAt: at, status: 'working', ...patch, id, updatedAt: at }
      this.records.unshift(record)
    }
    // createdAt 倒序 + 截断
    this.records.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    if (this.records.length > this.max) this.records.length = this.max
    await this.flush()
    return { ...record }
  }

  async remove(id) {
    await this.ensureLoaded()
    if (this.loadFailed) throw new Error('记录文件损坏,已停止写入')
    const before = this.records.length
    this.records = this.records.filter((item) => item.id !== id)
    if (this.records.length !== before) await this.flush()
    return before !== this.records.length
  }

  /** 落盘:先备份上一版,再 tmp + rename */
  async flush() {
    if (!this.loaded || this.loadFailed) return
    this.pending = this.pending.then(async () => {
      const payload = JSON.stringify({ version: VERSION, items: this.records }, null, 1)
      await mkdir(dirname(this.file), { recursive: true })
      try {
        await copyFile(this.file, `${this.file}.bak`)
      } catch {
        /* 第一次写没有旧文件 */
      }
      const tmp = join(dirname(this.file), `.library.${process.pid}.${Date.now()}.tmp`)
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, this.file)
    })
    return this.pending
  }
}
