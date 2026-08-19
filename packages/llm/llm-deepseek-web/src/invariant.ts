/**
 * 本包的不变量伴生插件：`@deepseek-ai/dsh-llm-deepseek-web`。
 * @module @deepseek-ai/dsh-llm-deepseek-web/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-deepseek-web'

/** Cordis 伴生插件名。 */
export const name = 'llm-deepseek-web-invariant'
/** 认领包归属前必须就位的服务。 */
export const inject = ['invariants']

/**
 * No runtime invariant: 本包只把一次请求翻译成网页交互再翻译回 chunk 流。
 * 网页会话的增量账本（`Conversation.sentIds`）是适配器私有状态，页面本身的状态
 * 也不由本包拥有；两者都不构成独立于 LLM seam 的事件序列或可变数据关系，而
 * 请求与回复的对应关系由 seam 自己的 chunk 语法校验把守。
 */
const install: InvariantInstaller = () => {}

/**
 * 注册本包的不变量伴生插件。
 * @param ctx - 携带 invariants 服务的 Cordis 上下文。
 * @returns 注册成功后的 disposer。
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
