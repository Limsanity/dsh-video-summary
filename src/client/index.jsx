/**
 * 视频总结 · 客户端半
 *
 * 注册两处:
 *  - sidebar.panellist:左侧图标栏一个入口(label 由侧栏渲染);
 *  - main(keyed):点开后占据主列的面板,key 必须等于侧栏条目的 id。
 *
 * 面板顶部粘一个链接就新开 DSH 会话,并把「总结这个视频」的任务预填进输入框:
 * 模型接着调 video_summary 工具,记录与会话 id 都会由宿主侧写回,不需要前端猜。
 */
import { VideoPanel, VideoIcon } from './Panel.jsx'
import { buildPrompt } from './prompt.js'

export const PANEL_ID = 'video-summary'

/** 侧栏与主面板两套 slot 都由 dsh-client-ui 提供。 */
export const inject = ['slots']

export function apply(ctx) {
  // uiWorkspace 可能晚于 slots 就绪,在子 fiber 里等,别卡住面板注册。
  let workspace
  ctx.inject(['uiWorkspace'], (child) => {
    workspace = child.uiWorkspace
    return () => {
      workspace = undefined
    }
  })

  const openExternal = (url) => {
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }

  const openSession = (sessionId) => {
    if (!sessionId || !workspace || typeof workspace.openSession !== 'function') return false
    try {
      workspace.openSession(sessionId)
      return true
    } catch (error) {
      ctx.logger?.error?.('video-summary: openSession failed: %o', error)
      return false
    }
  }

  /** 新开一个会话,把总结任务预填进输入框(回车即开跑) */
  const startSummary = (url) => {
    const target = String(url ?? '').trim()
    if (!target) return false
    if (!workspace || typeof workspace.startSession !== 'function') {
      openExternal(target)
      return false
    }
    try {
      workspace.startSession(undefined, {
        prompt: buildPrompt(target),
        clearPreviousDraft: true,
      })
      return true
    } catch (error) {
      ctx.logger?.error?.('video-summary: startSession failed: %o', error)
      openExternal(target)
      return false
    }
  }

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 17,
        label: '视频总结',
      },
      VideoIcon,
    ),
  )

  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        inject: () => ({ startSummary, openExternal, openSession }),
      },
      VideoPanel,
    ),
  )
}
