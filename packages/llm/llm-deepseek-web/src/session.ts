/**
 * Drive one chat.deepseek.com turn through CDP.
 *
 * The plugin attaches to a Chrome the user is already running (started with
 * `--remote-debugging-port`), so the logged-in session, cookies, and browser
 * fingerprint are the real ones — no extension to install, no separate login.
 *
 * @module @deepseek-ai/dsh-llm-deepseek-web/session
 */

import { CdpConnection, CdpError, createTarget, listTargets, type CdpTarget } from './cdp.ts'
import { defaultUserDataDir, ensureChrome } from './launch.ts'
import { PAGE_AGENT, type PageSnapshot } from './page-agent.ts'

export const DEEPSEEK_URL = 'https://chat.deepseek.com/'

/** One piece of a reply, already classified. */
export interface BridgeEvent {
  kind: 'text' | 'thinking' | 'progress'
  text: string
}

/** Why a bridged request failed; the adapter maps this onto a dsh error code. */
export type BridgeErrorKind = 'not-logged-in' | 'rate-limited' | 'transport' | 'unknown'

export class BridgeError extends Error {
  constructor(message: string, readonly kind: BridgeErrorKind) {
    super(message)
    this.name = 'BridgeError'
  }
}

export interface AskRequest {
  prompt: string
  /**
   * Start a fresh web conversation instead of continuing the open one.
   * False means the page already holds the earlier turns, so `prompt` carries
   * only what is new.
   */
  newChat: boolean
  /** Absolute path of a file to attach; the caller owns its lifetime. */
  filePath?: string
  signal?: AbortSignal
}

export interface WebSessionOptions {
  /** Chrome DevTools endpoint, e.g. `http://127.0.0.1:9222`. */
  endpoint: string
  /** Start our own browser when the endpoint is not answering. */
  autoLaunch?: boolean
  /** Profile directory for the browser we launch; separate from the user's daily one. */
  userDataDir?: string
  /** Explicit Chrome binary; auto-detected when absent. */
  chromePath?: string
  /** Give up after this long without any new reply text. */
  idleTimeoutMs?: number
  /** Absolute ceiling for one turn. */
  hardTimeoutMs?: number
  /** Turn the site's "deep thinking" mode on before asking. */
  deepThinking?: boolean
  /** Turn the site's "web search" mode on before asking; off keeps first-token latency low. */
  webSearch?: boolean
}

const DEFAULT_IDLE_TIMEOUT_MS = 180_000
const DEFAULT_HARD_TIMEOUT_MS = 600_000
const POLL_INTERVAL_MS = 400
const READY_TIMEOUT_MS = 30_000
const NAVIGATION_TIMEOUT_MS = 30_000
/** 上限而非固定等待:发送键通常几十毫秒内就绪。 */
const SENDABLE_TIMEOUT_MS = 5_000
/** 上限而非固定等待:等不到就说明回车没生效,退回去点发送控件。 */
const SUBMIT_TIMEOUT_MS = 3_000
/** 页面用它把变化推回来,取代外部轮询。 */
const PUSH_BINDING = '__dshEmit'
/** 页面内合并 mutation 的窗口:流式输出的 mutation 非常密集。 */
const PUSH_THROTTLE_MS = 120
/** 文本连续这么多轮不变才算说完,约 1.6 秒,够跨过流式输出中的停顿。 */
const STABLE_TICKS_TO_FINISH = 4

/**
 * A one-holder gate over a single resource.
 *
 * Callers are served in arrival order; each awaits the previous holder's
 * release. Kept separate from {@link WebSession} so its mutual exclusion is
 * testable without a browser.
 *
 * @returns acquire — resolves to the release function once the resource is free.
 */
export function createGate(): () => Promise<() => void> {
  let queue: Promise<void> = Promise.resolve()
  return () => {
    const previous = queue
    let release = (): void => {}
    queue = new Promise<void>((resolve) => {
      release = resolve
    })
    return previous.then(() => release)
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new BridgeError('请求已取消。', 'transport'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BridgeError('请求已取消。', 'transport')
}

/** Classify a page-reported failure so dsh can route on it. */
function classify(message: string): BridgeErrorKind {
  if (/未登录|登录|sign in|log in|验证码/i.test(message)) return 'not-logged-in'
  if (/频繁|限流|rate.?limit|too many|稍后再试|繁忙/i.test(message)) return 'rate-limited'
  return 'unknown'
}

export class WebSession {
  private readonly endpoint: string
  private readonly autoLaunch: boolean
  private readonly userDataDir: string
  private readonly chromePath: string | undefined
  private readonly idleTimeoutMs: number
  private readonly hardTimeoutMs: number
  private readonly deepThinking: boolean
  private readonly webSearch: boolean

  constructor(options: WebSessionOptions) {
    this.endpoint = options.endpoint
    this.autoLaunch = options.autoLaunch ?? true
    this.userDataDir = options.userDataDir ?? defaultUserDataDir()
    this.chromePath = options.chromePath
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.hardTimeoutMs = options.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS
    this.deepThinking = options.deepThinking ?? false
    this.webSearch = options.webSearch ?? false
  }

  /** Port from the endpoint, needed as a launch flag. */
  private get port(): number {
    const parsed = Number.parseInt(new URL(this.endpoint).port, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 9222
  }

  /**
   * Start our own browser when nothing answers on the endpoint. A Chrome that is
   * already running cannot be made debuggable, so this launches a second
   * instance with its own profile rather than asking the user to quit theirs.
   */
  private async ensureBrowser(): Promise<void> {
    if (!this.autoLaunch) return
    await ensureChrome({
      endpoint: this.endpoint,
      port: this.port,
      userDataDir: this.userDataDir,
      ...this.chromePath === undefined ? {} : { chromePath: this.chromePath },
    })
  }

  /** Find the DeepSeek tab, or open one. */
  private async resolveTarget(signal?: AbortSignal): Promise<CdpTarget> {
    let targets: CdpTarget[]
    try {
      targets = await listTargets(this.endpoint, signal)
    } catch {
      // 端口没人应答:自己拉起一个带独立 profile 的浏览器再试。
      try {
        await this.ensureBrowser()
        targets = await listTargets(this.endpoint, signal)
      } catch (launchError) {
        throw new BridgeError(
          `连不上 Chrome 调试端口（${this.endpoint}），且未能自动启动浏览器：` +
            (launchError as Error).message,
          'transport',
        )
      }
    }
    const existing = targets.find(
      target => target.type === 'page' && target.url.startsWith('https://chat.deepseek.com'),
    )
    if (existing?.webSocketDebuggerUrl) return existing
    const created = await createTarget(this.endpoint, DEEPSEEK_URL, signal)
    if (!created.webSocketDebuggerUrl) {
      // /json/new 有时只回 id,再列一次把带 ws 地址的那条捞出来。
      const refreshed = (await listTargets(this.endpoint, signal)).find(t => t.id === created.id)
      if (refreshed?.webSocketDebuggerUrl) return refreshed
      throw new BridgeError('新开的 DeepSeek 标签页没有可用的调试地址。', 'transport')
    }
    return created
  }

  /** Install the page agent and wait until the composer exists. */
  private async waitReady(cdp: CdpConnection, signal?: AbortSignal): Promise<PageSnapshot> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    for (;;) {
      throwIfAborted(signal)
      try {
        await cdp.evaluate<boolean>(PAGE_AGENT)
        // 等待留在页面里:一次调用,输入框一出现就返回。
        await cdp.evaluate<boolean>(`window.__dshWeb.waitInput(${READY_TIMEOUT_MS})`)
        const snapshot = await cdp.evaluate<PageSnapshot>('window.__dshWeb.snapshot()')
        if (snapshot.hasInput) return snapshot
        if (!snapshot.loggedIn) {
          throw new BridgeError(
            'DeepSeek 网页未登录。请在这个 Chrome 里打开 chat.deepseek.com 完成登录后重试。',
            'not-logged-in',
          )
        }
      } catch (error) {
        if (error instanceof BridgeError) throw error
        // 导航途中执行上下文会被销毁,注入随之失效;重试直到页面稳定。
        if (Date.now() > deadline) {
          throw new BridgeError(
            `等待 DeepSeek 页面就绪失败：${(error as Error).message}`,
            'transport',
          )
        }
      }
      if (Date.now() > deadline) {
        throw new BridgeError('等待 DeepSeek 输入框出现超时。页面可能仍在加载或已改版。', 'transport')
      }
      await sleep(POLL_INTERVAL_MS, signal)
    }
  }

  /** Attach a local file to the composer and wait for the site to parse it. */
  private async *attach(
    cdp: CdpConnection,
    filePath: string,
    signal?: AbortSignal,
  ): AsyncGenerator<BridgeEvent> {
    yield { kind: 'progress', text: '正在挂载附件…' }
    const selector = await cdp.evaluate<string>('window.__dshWeb.prepareFileInput()')
    if (!selector) throw new BridgeError('页面上找不到附件输入控件，可能已改版。', 'transport')
    await cdp.setFileInput(selector, [filePath])
    await cdp.evaluate<boolean>('window.__dshWeb.notifyFileAttached()')

    const deadline = Date.now() + 120_000
    for (;;) {
      throwIfAborted(signal)
      const snapshot = await cdp.evaluate<PageSnapshot>('window.__dshWeb.snapshot()')
      if (snapshot.failed) {
        throw new BridgeError(`DeepSeek 提示「${snapshot.failed}」，附件未能挂上。`, 'unknown')
      }
      if (!snapshot.busy) {
        yield { kind: 'progress', text: '附件已就绪。' }
        return
      }
      if (Date.now() > deadline) throw new BridgeError('等待 DeepSeek 解析附件超时。', 'transport')
      await sleep(POLL_INTERVAL_MS, signal)
    }
  }

  /**
   * Serialize turns over the single tab.
   *
   * One tab is one physical resource: two concurrent `ask()` calls each run
   * `Input.insertText` into the same composer and the site receives both
   * prompts concatenated, then answers whichever instruction it reads last.
   * This is not an edge case — dsh generates the session title through a second
   * LLM request that overlaps the main one, so every first turn hits it.
   */
  private readonly acquire = createGate()

  /** Send one request and stream the reply, waiting for the tab to be free. */
  async *ask(request: AskRequest): AsyncGenerator<BridgeEvent> {
    const release = await this.acquire()
    try {
      throwIfAborted(request.signal)
      yield* this.askExclusive(request)
    } finally {
      // 必须无条件释放:漏一次会把后面所有请求永久挂住。
      release()
    }
  }

  /** One turn, with exclusive use of the tab already guaranteed. */
  private async *askExclusive(request: AskRequest): AsyncGenerator<BridgeEvent> {
    const target = await this.resolveTarget(request.signal)
    const cdp = await CdpConnection.open(target.webSocketDebuggerUrl ?? '', request.signal)
    try {
      await cdp.send('Page.enable')

      // 让页面自认为可见且获得焦点,但不动窗口、不抢用户的键盘焦点。
      // 需要它是因为:这个 profile 里可能不止一个标签(比如用户也在里面开了 dsh 界面),
      // 非激活标签的 document.hidden 为 true,站点会据此降级 —— 停掉动画、
      // 推迟渲染、暂停流式更新。setWebLifecycleState('active') 管的是冻结/丢弃
      // 生命周期,翻不动 visibility;bringToFront 能翻但会把窗口抬到最前,
      // 每轮问答都跳一次浏览器。焦点模拟两者都不占。
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })

      if (request.newChat) {
        // 只有开新会话才导航;续问时导航会把网页那边的历史一起丢掉。
        yield { kind: 'progress', text: '正在新开 DeepSeek 会话…' }
        // 监听必须先挂上:load 事件可能比 navigate 的响应先到。
        const loaded = cdp.once('Page.loadEventFired', NAVIGATION_TIMEOUT_MS)
        await cdp.send('Page.navigate', { url: DEEPSEEK_URL })
        await loaded
      } else {
        yield { kind: 'progress', text: '在当前会话继续…' }
      }

      const ready = await this.waitReady(cdp, request.signal)
      // 发送前的回复正文:本轮回复算不算「新」全靠跟它比。
      const baselineText = ready.text

      // 新对话会把开关恢复成站点默认(智能搜索是开的),所以每次开场都对齐一遍。
      if (request.newChat) {
        await cdp.evaluate(
          `window.__dshWeb.setModes({ thinking: ${this.deepThinking}, search: ${this.webSearch} })`,
        )
      }

      if (request.filePath !== undefined) yield* this.attach(cdp, request.filePath, request.signal)

      yield* this.compose(cdp, request.prompt, request.signal)
      yield { kind: 'progress', text: '已发送，等待回复…' }

      yield* this.readReply(cdp, baselineText, request.signal)
    } finally {
      cdp.close()
    }
  }

  /**
   * Type the prompt and send it, using browser-level input events.
   *
   * These arrive as `isTrusted` events, unlike anything a page script can
   * synthesize — which matters here because the site dropped `<button>` for
   * `[role=button]` and its composer ignores synthetic keystrokes.
   */
  private async *compose(
    cdp: CdpConnection,
    prompt: string,
    signal?: AbortSignal,
  ): AsyncGenerator<BridgeEvent> {
    throwIfAborted(signal)
    const focused = await cdp.evaluate<boolean>('window.__dshWeb.focusInput()')
    if (!focused) throw new BridgeError('找不到 DeepSeek 输入框。', 'transport')

    await cdp.send('Input.insertText', { text: prompt })
    const typed = await cdp.evaluate<string>('window.__dshWeb.inputValue()')
    if (!typed) throw new BridgeError('提示词没有写进 DeepSeek 输入框。', 'transport')

    // 等发送键真的变可用再动手,而不是睡一个猜出来的固定时长。
    await cdp.evaluate<boolean>(`window.__dshWeb.waitSendable(${SENDABLE_TIMEOUT_MS})`)

    // 首选元素自身的 click():实测三种提交方式只有它稳定生效,回车与完整鼠标序列
    // 都失败过。键鼠事件依赖窗口/焦点状态,而这个插件的正常形态就是在后台跑,
    // DOM 调用不受这些影响,所以把最可靠的一条放在最前面。
    await cdp.evaluate<boolean>('window.__dshWeb.clickSend()')
    if (await cdp.evaluate<boolean>(`window.__dshWeb.waitSubmitted(${SUBMIT_TIMEOUT_MS})`)) return

    // 兜底一:窗口在前台时真实鼠标点击更接近用户操作。
    yield { kind: 'progress', text: '点击未生效，尝试真实鼠标事件…' }
    const point = await cdp.evaluate<{ x: number; y: number } | null>(
      'window.__dshWeb.sendButtonPoint()',
    )
    if (point) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
      if (await cdp.evaluate<boolean>(`window.__dshWeb.waitSubmitted(${SUBMIT_TIMEOUT_MS})`)) return
    }

    // 兜底二:回车。
    yield { kind: 'progress', text: '仍未发出，尝试回车…' }
    for (const type of ['keyDown', 'keyUp'] as const) {
      await cdp.send('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      })
    }
    if (await cdp.evaluate<boolean>(`window.__dshWeb.waitSubmitted(${SUBMIT_TIMEOUT_MS})`)) return

    throw new BridgeError(
      '无法发送消息：点击与回车都没有让输入框清空，页面可能已改版。',
      'transport',
    )
  }

  /**
   * Stream the reply as the page reports it.
   *
   * The page pushes snapshots through a CDP binding whenever its DOM changes,
   * so new text surfaces as soon as it renders instead of on the next poll
   * tick. A slow poll stays as a safety net: the observer can miss a mutation,
   * and completion is decided by text going quiet, which needs a tick even when
   * nothing changes.
   */
  private async *readReply(
    cdp: CdpConnection,
    baselineText: string,
    signal?: AbortSignal,
  ): AsyncGenerator<BridgeEvent> {
    const started = Date.now()
    let pushed: PageSnapshot | undefined
    let wake: (() => void) | null = null
    const offBinding = cdp.on('Runtime.bindingCalled', (params) => {
      const event = params as { name?: string; payload?: string }
      if (event.name !== PUSH_BINDING || typeof event.payload !== 'string') return
      try {
        pushed = JSON.parse(event.payload) as PageSnapshot
      } catch {
        return
      }
      wake?.()
      wake = null
    })

    try {
      await cdp.send('Runtime.addBinding', { name: PUSH_BINDING })
      await cdp.evaluate<boolean>(`window.__dshWeb.startWatch(${PUSH_THROTTLE_MS})`)
    } catch {
      // 推送挂不上就退回纯轮询,慢一点但不影响正确性。
    }

    const take = (): PageSnapshot | undefined => {
      const next = pushed
      pushed = undefined
      return next
    }
    const waitPush = (ms: number): Promise<void> => new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null
        resolve()
      }, ms)
      wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })

    try {
      yield* this.consume(cdp, baselineText, started, take, waitPush, signal)
    } finally {
      offBinding()
      try {
        await cdp.evaluate<boolean>('window.__dshWeb.stopWatch()')
      } catch {
        // 页面可能已经跳走,无所谓。
      }
    }
  }

  /** The reply loop itself, fed by pushes with a poll as backstop. */
  private async *consume(
    cdp: CdpConnection,
    baselineText: string,
    started: number,
    take: () => PageSnapshot | undefined,
    waitPush: (ms: number) => Promise<void>,
    signal?: AbortSignal,
  ): AsyncGenerator<BridgeEvent> {
    let lastActivity = started
    let emitted = ''
    let stableTicks = 0

    for (;;) {
      throwIfAborted(signal)
      let snapshot: PageSnapshot | undefined = take()
      if (!snapshot) {
        try {
          snapshot = await cdp.evaluate<PageSnapshot>('window.__dshWeb.snapshot()')
        } catch (error) {
          if (error instanceof CdpError) throw new BridgeError(error.message, 'transport')
          throw error
        }
      }

      if (snapshot.failed) {
        throw new BridgeError(`DeepSeek 提示「${snapshot.failed}」。`, classify(snapshot.failed))
      }

      // 唯一判据:正文与发送前不同。
      //
      // 不能拿气泡数增长当判据 —— 提问气泡比回复气泡先出现,那一刻正文节点仍是
      // 上一轮的回复,会被当成本轮新内容发出去,续轮的回答就以上一轮的回答开头。
      // 代价是「本轮回答与上一轮逐字相同」时判不出来;但新回复的正文节点从空开始
      // 逐字长,流式期间必然出现过中间态,采样到差异的概率极高,兜底还有 idle 超时。
      const fresh = snapshot.text && snapshot.text !== baselineText ? snapshot.text : ''

      if (fresh && fresh !== emitted) {
        // 流式追加是常态;整段被改写(重新生成)时补发差值不成立,直接以新内容为准。
        const delta = fresh.startsWith(emitted) ? fresh.slice(emitted.length) : fresh
        emitted = fresh
        stableTicks = 0
        lastActivity = Date.now()
        yield { kind: 'text', text: delta }
      } else if (emitted) {
        // 完成判定只看文本是否不再变化:站点改版后停止按钮已不可靠。
        stableTicks += 1
        if (stableTicks >= STABLE_TICKS_TO_FINISH && !snapshot.generating) return
      }

      if (snapshot.generating) {
        lastActivity = Date.now()
        // 思考期正文尚未出现,报活以免上层把仍在工作的请求判死。
        if (!emitted) {
          yield { kind: 'progress', text: `DeepSeek 正在思考…（${Math.round((Date.now() - started) / 1000)}s）` }
        }
      }

      if (Date.now() - lastActivity > this.idleTimeoutMs) {
        throw new BridgeError(
          `DeepSeek 页面 ${Math.round(this.idleTimeoutMs / 1000)} 秒没有任何动静。` +
            '可能卡在登录、风控或排队，请到浏览器里查看。',
          'unknown',
        )
      }
      if (Date.now() - started > this.hardTimeoutMs) {
        throw new BridgeError('单轮等待超过上限，已放弃。', 'unknown')
      }
      // 有推送就立刻醒;没有就到点自查一次,让静默也能推进完成判定。
      await waitPush(POLL_INTERVAL_MS)
    }
  }
}
