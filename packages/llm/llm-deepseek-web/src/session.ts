/**
 * Drive one chat.deepseek.com turn through CDP.
 *
 * The plugin attaches to a Chrome the user is already running (started with
 * `--remote-debugging-port`), so the logged-in session, cookies, and browser
 * fingerprint are the real ones — no extension to install, no separate login.
 *
 * @module @deepseek-ai/dsh-llm-deepseek-web/session
 */

import { CdpConnection, CdpError, closeTarget, createTarget, listTargets, type CdpTarget } from './cdp.ts'
import { defaultUserDataDir, ensureChrome } from './launch.ts'
import { DEFAULT_PAGE_HINTS, PAGE_AGENT, type PageHints, type PageSnapshot } from './page-agent.ts'
import { CompletionStreamDecoder, type StreamEvent } from './sse.ts'

/** 新对话导航到的站点地址。 */
export const DEEPSEEK_URL = 'https://chat.deepseek.com/'

/**
 * One piece of a reply, already classified.
 *
 * Every kind is incremental. Reply content comes from the site's own
 * `text/event-stream`, whose deltas are append-only and never revised, so the
 * concatenation of `text` events is exactly what the model produced — including
 * escapes the DOM's rendered `innerText` would have collapsed.
 */
export type BridgeEvent =
  | { kind: 'text' | 'thinking' | 'progress'; text: string }
  /** The conversation's running token total, whenever the stream states it. */
  | { kind: 'usage'; totalTokens: number }
  /**
   * The prompt has entered the web conversation.
   *
   * Everything before this is recoverable: the page never saw this turn, so an
   * open conversation stays valid. After it, what the page received is no longer
   * knowable from here.
   */
  | { kind: 'submitted' }
  /**
   * Something the bridge could not interpret, for the log.
   *
   * Reported rather than held because the session has no logger of its own; the
   * adapter owns that route.
   */
  | { kind: 'diagnostic'; text: string }

/** A tab ready for one turn, with whether it already sits on a blank conversation. */
interface ResolvedTab {
  target: CdpTarget
  /** True when the page is not inside a conversation, so `newChat` needs no navigation. */
  blank: boolean
}

/** Whether a tab URL is the composer with no conversation open. */
function isBlankConversation(url: string): boolean {
  return !url.includes('/a/chat/s/')
}

/** A watch on the reply stream, armed before the prompt is sent. */
interface ReplyStream {
  /** Consume the reply; resolves when the site reports the turn finished. */
  events: (signal?: AbortSignal) => AsyncGenerator<BridgeEvent>
  /** Release the CDP listeners. */
  dispose: () => void
}

/** Why a bridged request failed; the adapter maps this onto a dsh error code. */
export type BridgeErrorKind = 'not-logged-in' | 'rate-limited' | 'transport' | 'page-blocked' | 'unknown'

/**
 * 桥接层失败；`kind` 由适配器映射成 dsh 的错误码。
 *
 * `page-blocked` 与 `transport` 的区别决定了上层能不能靠重发解决：`transport`
 * 是一次偶发故障，原样重发就有希望；`page-blocked` 是站点在拒绝这个页面继续发送
 * （输入区里留着上一次的残留），同一个页面重发多少次都是同一个结果，必须先换一条
 * 通道。两者共用一个 kind 时，重试只会在同一个坏页面上反复堆残留。
 */
export class BridgeError extends Error {
  constructor(message: string, readonly kind: BridgeErrorKind) {
    super(message)
    this.name = 'BridgeError'
  }
}

/** 一次问答请求。 */
export interface AskRequest {
  /** 要填进输入框的文本；正文走附件时这里只有 preamble。 */
  prompt: string
  /**
   * Start a fresh web conversation instead of continuing the open one.
   * False means the page already holds the earlier turns, so `prompt` carries
   * only what is new.
   */
  newChat: boolean
  /**
   * Run this turn in a throwaway tab instead of the conversation's own.
   *
   * Anything that is not the agent loop — a session title, a summary — needs one
   * web conversation and never returns to it. Sharing the main tab would
   * navigate the main conversation away, and the next agent turn would then have
   * to navigate back and reload its whole history.
   */
  isolated?: boolean
  /** Absolute path of a file to attach; the caller owns its lifetime. */
  filePath?: string
  signal?: AbortSignal
}

/** 构造一个网页会话所需的参数，全部来自插件 Config。 */
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
  /** 页面状态提示词表；每次读取页面时现取，配置改了下一次判定即生效。 */
  pageHints?: () => PageHints
  /** 等发送键从禁用变为可用的上限。 */
  sendableTimeoutMs?: number
  /** 等一种提交方式生效（输入框清空）的上限。 */
  submitTimeoutMs?: number
  /** 等附件上传并被站点解析完的上限。 */
  attachTimeoutMs?: number
}

/** 页面多久没有新内容就判本轮失败。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 180_000
/** 单轮等待的绝对上限，与页面有没有动静无关。 */
export const DEFAULT_HARD_TIMEOUT_MS = 600_000
const POLL_INTERVAL_MS = 400
const READY_TIMEOUT_MS = 30_000
const NAVIGATION_TIMEOUT_MS = 30_000
/** 上限而非固定等待：发送键通常几十毫秒内就绪。 */
export const DEFAULT_SENDABLE_TIMEOUT_MS = 5_000
/** 上限而非固定等待：等不到就说明这一种提交方式没生效，换下一种。 */
export const DEFAULT_SUBMIT_TIMEOUT_MS = 3_000
/** 附件上传加站点解析的等待上限；大文件或慢网络需要更久。 */
export const DEFAULT_ATTACH_TIMEOUT_MS = 120_000
/** The site's own completion endpoint; its response body is the reply stream. */
const COMPLETION_URL = 'https://chat.deepseek.com/api/v0/chat/completion'
/** 发送后等这么久还没看到回复请求,就当页面改版了。 */
const REQUEST_WAIT_MS = 30_000

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

/**
 * Classify the completion request's HTTP status so dsh can route on it.
 * @param status - the response status code, known to be an error.
 * @returns the matching bridge failure kind.
 */
function classifyStatus(status: number): BridgeErrorKind {
  if (status === 429) return 'rate-limited'
  if (status === 401 || status === 403) return 'not-logged-in'
  return 'unknown'
}

/**
 * 把一次「发不出去」变成能自证的失败。
 *
 * 站点拒绝发送的理由只写在页面上，所以判定与消息都取自当下的页面文本：命中拒绝词表
 * 就是 `page-blocked`，否则连输入区原文一起报出去。写死一句「页面可能已改版」会把真正
 * 的原因（例如一张上传失败的附件卡片）藏起来，而那正是唯一能指向补救动作的信息。
 * @param snapshot - 失败当刻的页面状态。
 * @param what - 失败发生在哪一步，用作消息开头。
 * @returns 已分类且带页面原文的失败。
 */
export function sendFailureFrom(snapshot: PageSnapshot, what: string): BridgeError {
  if (snapshot.blocked) {
    return new BridgeError(`${what}：DeepSeek 提示「${snapshot.blocked}」。`, 'page-blocked')
  }
  return new BridgeError(
    snapshot.hint
      ? `${what}。输入区当前显示：「${snapshot.hint}」`
      : `${what}，且输入区没有任何提示文字。`,
    'transport',
  )
}

/** Classify a page-reported failure so dsh can route on it. */
function classify(message: string): BridgeErrorKind {
  if (/未登录|登录|sign in|log in|验证码/i.test(message)) return 'not-logged-in'
  if (/频繁|限流|rate.?limit|too many|稍后再试|繁忙/i.test(message)) return 'rate-limited'
  return 'unknown'
}

/**
 * 一条绑定到自己标签页的网页对话。
 *
 * 请求经由 {@link WebSession.ask} 串行化：一个标签页是一份物理资源，并发写同一个
 * 输入框会让站点收到两段拼在一起的提示词。
 */
export class WebSession {
  private readonly endpoint: string
  private readonly autoLaunch: boolean
  private readonly userDataDir: string
  private readonly chromePath: string | undefined
  private readonly idleTimeoutMs: number
  private readonly hardTimeoutMs: number
  private readonly deepThinking: boolean
  private readonly webSearch: boolean
  private readonly pageHints: () => PageHints
  private readonly sendableTimeoutMs: number
  private readonly submitTimeoutMs: number
  private readonly attachTimeoutMs: number
  /** The tab holding this session's conversation; null until one is bound. */
  private mainTargetId: string | null = null

  constructor(options: WebSessionOptions) {
    this.endpoint = options.endpoint
    this.autoLaunch = options.autoLaunch ?? true
    this.userDataDir = options.userDataDir ?? defaultUserDataDir()
    this.chromePath = options.chromePath
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.hardTimeoutMs = options.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS
    this.deepThinking = options.deepThinking ?? false
    this.webSearch = options.webSearch ?? false
    this.pageHints = options.pageHints ?? (() => DEFAULT_PAGE_HINTS)
    this.sendableTimeoutMs = options.sendableTimeoutMs ?? DEFAULT_SENDABLE_TIMEOUT_MS
    this.submitTimeoutMs = options.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS
    this.attachTimeoutMs = options.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS
  }

  /**
   * 读一次页面状态，词表按当前配置传进去。
   * @param cdp - 已连上目标标签页的连接。
   * @returns 这一刻的页面状态。
   */
  private snapshot(cdp: CdpConnection): Promise<PageSnapshot> {
    return cdp.evaluate<PageSnapshot>(
      `window.__dshWeb.snapshot(${JSON.stringify(this.pageHints())})`,
    )
  }

  /**
   * 读一次页面状态，把它变成一个能自证的发送失败。
   * @param cdp - 已连上目标标签页的连接。
   * @param what - 失败发生在哪一步，用作消息开头。
   * @returns 已分类且带页面原文的失败。
   */
  private async sendFailure(cdp: CdpConnection, what: string): Promise<BridgeError> {
    return sendFailureFrom(await this.snapshot(cdp), what)
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

  /**
   * The tab this session's conversation lives in, or a fresh one for it.
   *
   * The id is remembered so the conversation keeps its own tab: picking "the
   * first DeepSeek tab" every time is what let an isolated turn take the main
   * conversation's page. A tab the user closed falls back to adopting an idle
   * one, and then to opening one.
   *
   * Only a tab with no conversation open is adopted. A tab already showing a
   * conversation is something the user is reading; navigating it away takes the
   * page out from under them, so a new tab is opened instead — which also means
   * the first turn needs no navigation at all.
   *
   * @param signal - abort the lookup.
   * @returns the tab to use, and whether it already sits on a blank conversation.
   */
  private async resolveTarget(signal?: AbortSignal): Promise<ResolvedTab> {
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
    const bound = this.mainTargetId === null
      ? undefined
      : targets.find(target => target.id === this.mainTargetId && target.type === 'page')
    if (bound?.webSocketDebuggerUrl) return { target: bound, blank: isBlankConversation(bound.url) }
    // 只收养停在空白输入页的标签页。一个已经打开某条对话的标签页是用户正在读的
    // 东西,把它导航走等于当着用户的面抢走页面;宁可新开一个。
    const idle = targets.find(
      target => target.type === 'page'
        && target.url.startsWith('https://chat.deepseek.com')
        && isBlankConversation(target.url),
    )
    if (idle?.webSocketDebuggerUrl) {
      this.mainTargetId = idle.id
      return { target: idle, blank: true }
    }
    const created = await this.openTab(signal)
    this.mainTargetId = created.id
    return { target: created, blank: true }
  }

  /**
   * Open one DeepSeek tab.
   * @param signal - abort the request.
   * @returns the new target, with a debugger address.
   */
  private async openTab(signal?: AbortSignal): Promise<CdpTarget> {
    const created = await createTarget(this.endpoint, DEEPSEEK_URL, signal)
    if (created.webSocketDebuggerUrl) return created
    // /json/new 有时只回 id,再列一次把带 ws 地址的那条捞出来。
    const refreshed = (await listTargets(this.endpoint, signal)).find(t => t.id === created.id)
    if (refreshed?.webSocketDebuggerUrl) return refreshed
    throw new BridgeError('新开的 DeepSeek 标签页没有可用的调试地址。', 'transport')
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
        const snapshot = await this.snapshot(cdp)
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

    const deadline = Date.now() + this.attachTimeoutMs
    for (;;) {
      throwIfAborted(signal)
      const snapshot = await this.snapshot(cdp)
      if (snapshot.failed) {
        throw new BridgeError(`DeepSeek 提示「${snapshot.failed}」，附件未能挂上。`, classify(snapshot.failed))
      }
      // 站点已经在拒绝发送,再等下去只会等到超时,而超时报的是「解析超时」——
      // 与真正的原因无关。
      if (snapshot.blocked) {
        throw new BridgeError(`DeepSeek 提示「${snapshot.blocked}」，这个页面已经发不出消息。`, 'page-blocked')
      }
      if (!snapshot.busy) {
        yield { kind: 'progress', text: '附件已就绪。' }
        return
      }
      if (Date.now() > deadline) {
        // 输入区之外的命中不作判据(对话内容会碰撞),但超时是它唯一有用的时刻:
        // 站点若把提示贴在这个范围之外,这句话是看出漏报的唯一线索。
        throw new BridgeError(
          snapshot.failedElsewhere
            ? `等待 DeepSeek 解析附件超时；页面别处出现「${snapshot.failedElsewhere}」，但不在输入区内，未据此判失败。`
            : '等待 DeepSeek 解析附件超时。',
          'transport',
        )
      }
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

  /**
   * 发一次请求并流式取回回复，先等标签页空出来。
   * @param request - 提示词、是否新开对话、可选附件与取消信号。
   * @returns 已分类的桥接事件流；失败时抛 {@link BridgeError}。
   */
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
    // 一次性标签页刚开出来就是空白新对话,不必再导航一次。
    const { target, blank } = request.isolated
      ? { target: await this.openTab(request.signal), blank: true }
      : await this.resolveTarget(request.signal)
    const cdp = await CdpConnection.open(target.webSocketDebuggerUrl ?? '', request.signal)
    try {
      await cdp.send('Page.enable')

      // 一个 agent 任务会让这个标签页在后台待上几十分钟。Chrome 会冻结甚至丢弃
      // 后台标签页来回收内存,连接随之断开,整轮任务就以「CDP 连接已关闭」告终。
      // 焦点模拟管不了这件事 —— 它翻的是 visibility,冻结/丢弃是另一套生命周期。
      try {
        await cdp.send('Page.setWebLifecycleState', { state: 'active' })
      } catch {
        // 这是一层保护而不是前提:旧版 Chrome 不认这个命令,少了它只是更容易
        // 在长任务里被回收,不该让本来能跑的一轮直接失败。
      }

      // 让页面自认为可见且获得焦点,但不动窗口、不抢用户的键盘焦点。
      // 需要它是因为:这个 profile 里可能不止一个标签(比如用户也在里面开了 dsh 界面),
      // 非激活标签的 document.hidden 为 true,站点会据此降级 —— 停掉动画、
      // 推迟渲染、暂停流式更新。setWebLifecycleState('active') 管的是冻结/丢弃
      // 生命周期,翻不动 visibility;bringToFront 能翻但会把窗口抬到最前,
      // 每轮问答都跳一次浏览器。焦点模拟两者都不占。
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })

      if (request.newChat && !blank) {
        // 开新会话才需要导航,而且只在页面确实停在某条对话里时 —— 已经在空白
        // 输入页上就什么都不用做,免掉一次用户看得见的跳转。
        // 续问永不导航:那会把网页那边的历史一起丢掉。
        yield { kind: 'progress', text: '正在新开 DeepSeek 会话…' }
        // 监听必须先挂上:load 事件可能比 navigate 的响应先到。
        const loaded = cdp.once('Page.loadEventFired', NAVIGATION_TIMEOUT_MS)
        await cdp.send('Page.navigate', { url: DEEPSEEK_URL })
        await loaded
      } else {
        yield { kind: 'progress', text: request.newChat ? '使用空白会话…' : '在当前会话继续…' }
      }

      await this.waitReady(cdp, request.signal)

      // 新对话会把开关恢复成站点默认(智能搜索是开的),所以每次开场都对齐一遍。
      if (request.newChat) {
        await cdp.evaluate(
          `window.__dshWeb.setModes({ thinking: ${this.deepThinking}, search: ${this.webSearch} })`,
        )
      }

      // 监听必须先挂:回复请求在 compose 里就发出去了,之后再挂已经错过它。
      const reply = await this.openReplyStream(cdp)
      try {
        if (request.filePath !== undefined) yield* this.attach(cdp, request.filePath, request.signal)

        yield* this.compose(cdp, request.prompt, request.signal)
        yield { kind: 'submitted' }
        yield { kind: 'progress', text: '已发送，等待回复…' }

        yield* reply.events(request.signal)
      } finally {
        reply.dispose()
      }
    } catch (error: unknown) {
      // 裸的「CDP 连接已关闭」说不出该怎么办。到这一层已经知道是哪个标签页,
      // 也知道能断的原因只有这几种。
      if (error instanceof CdpError && error.method === 'close') {
        throw new BridgeError(
          '与 DeepSeek 标签页的调试连接中断。标签页可能被关掉了，'
            + '或者被浏览器冻结/丢弃以回收内存。请确认那个标签页还在。',
          'transport',
        )
      }
      throw error
    } finally {
      cdp.close()
      // 一次性标签页用完即走;主对话的那个必须留着,它就是那条对话。
      if (request.isolated) await closeTarget(this.endpoint, target.id, request.signal)
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

    // 等发送键真的变可用再动手,而不是睡一个猜出来的固定时长。等不到就说明站点
    // 主动禁用了它,这时三种提交方式都注定无效,报出页面的理由比试一遍更有用。
    if (!await cdp.evaluate<boolean>(`window.__dshWeb.waitSendable(${this.sendableTimeoutMs})`)) {
      throw await this.sendFailure(cdp, '发送键一直不可用')
    }

    // 首选元素自身的 click():实测三种提交方式只有它稳定生效,回车与完整鼠标序列
    // 都失败过。键鼠事件依赖窗口/焦点状态,而这个插件的正常形态就是在后台跑,
    // DOM 调用不受这些影响,所以把最可靠的一条放在最前面。
    await cdp.evaluate<boolean>('window.__dshWeb.clickSend()')
    if (await cdp.evaluate<boolean>(`window.__dshWeb.waitSubmitted(${this.submitTimeoutMs})`)) return

    // 兜底一:窗口在前台时真实鼠标点击更接近用户操作。
    yield { kind: 'progress', text: '点击未生效，尝试真实鼠标事件…' }
    const point = await cdp.evaluate<{ x: number; y: number } | null>(
      'window.__dshWeb.sendButtonPoint()',
    )
    if (point) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
      if (await cdp.evaluate<boolean>(`window.__dshWeb.waitSubmitted(${this.submitTimeoutMs})`)) return
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
    if (await cdp.evaluate<boolean>(`window.__dshWeb.waitSubmitted(${this.submitTimeoutMs})`)) return

    throw await this.sendFailure(cdp, '无法发送消息：点击与回车都没有让输入框清空')
  }

  /**
   * Stream the reply from the site's own completion response.
   *
   * The request is the page's, not ours: it carries the site's PoW challenge,
   * cookies, and headers, and we only read the bytes coming back. That keeps
   * the browser fingerprint untouched while giving us the model's exact output
   * instead of its rendered form.
   *
   * `Network.streamResourceContent` is what makes it live. Until it returns,
   * `Network.dataReceived` events carry only lengths, and the bytes they
   * describe come back once in that call's `bufferedData` — so events before it
   * are dropped rather than double-counted.
   */
  private async openReplyStream(cdp: CdpConnection): Promise<ReplyStream> {
    const decoder = new CompletionStreamDecoder()
    const pending: StreamEvent[] = []
    // 这些状态由 CDP 回调写、由下面的循环读。放进对象里而不是写成局部 let:
    // 控制流分析看不到回调的赋值,会把循环里读到的值窄化成初始值。
    const stream: {
      requestId: string | null
      streaming: boolean
      finished: boolean
      failure: { message: string; kind: BridgeErrorKind } | null
    } = { requestId: null, streaming: false, finished: false, failure: null }
    let lastActivity = Date.now()
    const started = lastActivity
    let wake: (() => void) | null = null
    const nudge = () => {
      lastActivity = Date.now()
      wake?.()
      wake = null
    }
    const feed = (bytes: string): void => {
      pending.push(...decoder.push(bytes))
      nudge()
    }

    const offSent = cdp.on('Network.requestWillBeSent', (params) => {
      const event = params as { requestId?: string; request?: { url?: string; method?: string } }
      // 第一个匹配的请求就是刚发出的这一轮:askExclusive 串行化了整个通路。
      if (stream.requestId !== null || event.request?.url !== COMPLETION_URL) return
      stream.requestId = event.requestId ?? null
      nudge()
    })
    const offResponse = cdp.on('Network.responseReceived', (params) => {
      const event = params as { requestId?: string; response?: { status?: number } }
      if (event.requestId !== stream.requestId || stream.streaming) return
      const status = event.response?.status ?? 0
      if (status >= 400) {
        stream.failure = { message: `DeepSeek 接口返回 HTTP ${status}。`, kind: classifyStatus(status) }
        nudge()
        return
      }
      void cdp.send<{ bufferedData?: string }>('Network.streamResourceContent', { requestId: stream.requestId })
        .then((result) => {
          stream.streaming = true
          if (result.bufferedData) feed(Buffer.from(result.bufferedData, 'base64').toString('utf8'))
          else nudge()
        })
        .catch((error: unknown) => {
          stream.failure = {
            message: `无法读取 DeepSeek 回复流：${error instanceof Error ? error.message : String(error)}`,
            kind: 'transport',
          }
          nudge()
        })
    })
    const offData = cdp.on('Network.dataReceived', (params) => {
      const event = params as { requestId?: string; data?: string }
      if (event.requestId !== stream.requestId) return
      if (!stream.streaming || event.data === undefined) {
        // 建流前的事件只报长度,字节由 bufferedData 一次补齐。
        nudge()
        return
      }
      feed(Buffer.from(event.data, 'base64').toString('utf8'))
    })
    const offFinished = cdp.on('Network.loadingFinished', (params) => {
      if ((params as { requestId?: string }).requestId !== stream.requestId) return
      stream.finished = true
      nudge()
    })
    const offFailed = cdp.on('Network.loadingFailed', (params) => {
      const event = params as { requestId?: string; errorText?: string }
      if (event.requestId !== stream.requestId) return
      stream.failure = { message: `DeepSeek 回复连接中断：${event.errorText ?? '未知原因'}`, kind: 'transport' }
      nudge()
    })

    const dispose = (): void => {
      offSent()
      offResponse()
      offData()
      offFinished()
      offFailed()
    }

    try {
      await cdp.send('Network.enable', {})
    } catch (error: unknown) {
      dispose()
      throw error
    }

    const { idleTimeoutMs, hardTimeoutMs } = this
    const events = async function* (signal?: AbortSignal): AsyncGenerator<BridgeEvent> {
      for (;;) {
        throwIfAborted(signal)
        if (stream.failure !== null) throw new BridgeError(stream.failure.message, stream.failure.kind)
        let sawFinish = false
        while (pending.length > 0) {
          // oxlint-disable-next-line typescript/no-non-null-assertion -- 循环条件保证非空
          const event = pending.shift()!
          switch (event.kind) {
            case 'text':
              yield { kind: 'text', text: event.delta }
              break
            case 'reasoning':
              yield { kind: 'thinking', text: event.delta }
              break
            case 'usage':
              yield { kind: 'usage', totalTokens: event.totalTokens }
              break
            case 'finished':
              sawFinish = true
              break
            case 'undecodable':
              yield { kind: 'diagnostic', text: `无法解析的回复帧，已跳过：${event.detail}` }
              break
          }
        }
        // 回复自报完成,或连接收尾:两者任一都不再有字节。
        if (sawFinish || stream.finished) return
        if (Date.now() - lastActivity > idleTimeoutMs) {
          throw new BridgeError(
            `DeepSeek ${Math.round(idleTimeoutMs / 1000)} 秒没有任何动静。` +
              '可能卡在登录、风控或排队，请到浏览器里查看。',
            'unknown',
          )
        }
        if (Date.now() - started > hardTimeoutMs) {
          throw new BridgeError('单轮等待超过上限，已放弃。', 'unknown')
        }
        if (stream.requestId === null && Date.now() - started > REQUEST_WAIT_MS) {
          throw new BridgeError(
            '发送后没有看到 DeepSeek 的回复请求，页面可能已改版。',
            'transport',
          )
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wake = null
            resolve()
          }, POLL_INTERVAL_MS)
          wake = () => {
            clearTimeout(timer)
            resolve()
          }
        })
      }
    }

    return { events, dispose }
  }
}
