/**
 * Register a `deepseek-web` provider route backed by the logged-in
 * chat.deepseek.com session instead of an API key.
 *
 * The plugin drives a Chrome the user is already running, over the DevTools
 * Protocol — nothing to install in the browser, and the login, cookies, and
 * fingerprint are the real ones. Every request is stateless: a fresh chat
 * carrying the full history, so dsh keeps ownership of the conversation and
 * its compaction behaviour is unchanged.
 *
 * Unlike the API adapters there is no credential to resolve: the credential is
 * the user's browser session, and its absence surfaces per request as
 * `MISSING_CREDENTIAL` rather than at plugin load.
 *
 * @module @deepseek-ai/dsh-llm-deepseek-web
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { DEFAULT_INLINE_LIMIT, DsWebAdapter } from './adapter.ts'
import { WebSession } from './session.ts'

export { DsWebAdapter, DEFAULT_INLINE_LIMIT } from './adapter.ts'
export { BridgeError, WebSession, DEEPSEEK_URL } from './session.ts'
export { CdpConnection, CdpError, listTargets, createTarget, normalizeEndpoint } from './cdp.ts'
export { defaultUserDataDir, ensureChrome, findChrome, isEndpointUp } from './launch.ts'
export { splitReply, parseToolCall, visibleEnd } from './parse.ts'
export { CompletionStreamDecoder } from './sse.ts'
export type { StreamEvent } from './sse.ts'
export { renderRequest } from './render.ts'
export { PAGE_AGENT } from './page-agent.ts'
export type { PageSnapshot } from './page-agent.ts'

export const name = 'llm-deepseek-web'
export const inject = ['llm']

/** The single provider route this plugin owns. */
export const PROVIDER = 'deepseek-web'

/** Chrome's default DevTools endpoint when started with `--remote-debugging-port=9222`. */
export const DEFAULT_CDP_ENDPOINT = 'http://127.0.0.1:9222'

const NS = settingsNamespace('llm-deepseek-web')

export interface Config {
  endpoint: string
  autoLaunch: boolean
  userDataDir: string
  chromePath: string
  inlineLimit: number
  useAttachment: boolean
  idleTimeoutMs: number
  hardTimeoutMs: number
  deepThinking: boolean
  webSearch: boolean
}

export const Config: z<Config> = z.object({
  endpoint: z.string().default(DEFAULT_CDP_ENDPOINT)
    .description('Chrome 调试端口地址。'),
  autoLaunch: z.boolean().default(true)
    .description('端口无响应时自动拉起一个带独立 profile 的 Chrome，不影响你日常用的那个。'),
  userDataDir: z.string().default('')
    .description('自动启动时使用的浏览器 profile 目录，留空则用 $DSH_HOME/deepseek-web-profile。'),
  chromePath: z.string().default('')
    .description('Chrome 可执行文件路径，留空自动探测（也可用 CHROME_PATH 环境变量）。'),
  inlineLimit: z.number().step(1).min(0).default(DEFAULT_INLINE_LIMIT)
    .description('超过该字符数的请求改用 .md 附件发送，而不是打进输入框。'),
  useAttachment: z.boolean().default(true)
    .description('关闭后一律走输入框；网页端拒收 .md 附件时用它兜底。'),
  idleTimeoutMs: z.number().step(1).min(1_000).default(180_000)
    .description('页面多久没有任何动静就判定失败。'),
  hardTimeoutMs: z.number().step(1).min(1_000).default(600_000)
    .description('单轮等待的绝对上限。'),
  deepThinking: z.boolean().default(false)
    .description('是否开启网页端「深度思考」。开启会显著拉长首字延迟。'),
  webSearch: z.boolean().default(false)
    .description('是否开启网页端「智能搜索」。站点默认开启，但每轮联网搜索会让首字延迟高达 30 秒以上。'),
})

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config

  // 端点在构造时定死:换它要重建会话。其余几项每次请求现读,
  // 所以在设置里改 inlineLimit / useAttachment 下一次调用就生效。
  const session = new WebSession({
    endpoint: config.endpoint,
    autoLaunch: config.autoLaunch,
    idleTimeoutMs: config.idleTimeoutMs,
    hardTimeoutMs: config.hardTimeoutMs,
    deepThinking: config.deepThinking,
    webSearch: config.webSearch,
    // 空字符串代表「用默认」,不能当成显式配置传下去。
    ...config.userDataDir ? { userDataDir: config.userDataDir } : {},
    ...config.chromePath ? { chromePath: config.chromePath } : {},
  })
  const adapter = new DsWebAdapter({
    session,
    inlineLimit: () => current().inlineLimit,
    useAttachment: () => current().useAttachment,
    // 网页那边意外多出一堆独立对话时,这条日志是唯一能说清为什么的东西。
    log: (message) => {
      ctx.logger.info(`llm-deepseek-web: ${message}`)
    },
  })

  // 两套登记各管一头:registerAdapter 让路由可用,registerConfigurableProviders
  // 给它一个设置地址,模型页才能显示并配置这张卡片。
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'DeepSeek 网页（已登录）', settingsNs: NS, settingsPath: [] },
  ])
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    // 没有注册期捕获的事实需要重建:可变项都在请求时现读。
    onChange: () => {},
  })

  ctx.effect(() => () => {
    registration()
  }, 'llm-deepseek-web: release route')
}
