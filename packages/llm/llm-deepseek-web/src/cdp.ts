/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Only what driving one page needs: target discovery over HTTP, one WebSocket
 * per page, request/response correlation, and file-input population. `ws` is
 * already a workspace dependency, so this adds nothing new.
 *
 * @module @deepseek-ai/dsh-llm-deepseek-web/cdp
 */

import { WebSocket, type RawData } from 'ws'

/** One debuggable target as reported by `/json/list`. */
export interface CdpTarget {
  id: string
  type: string
  url: string
  title: string
  webSocketDebuggerUrl?: string
}

/** A CDP call that the browser answered with an error. */
export class CdpError extends Error {
  constructor(message: string, readonly method: string) {
    super(message)
    this.name = 'CdpError'
  }
}

function decode(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data as ArrayBuffer).toString('utf8')
}

/**
 * 把用户填的地址规整成绝对的 http origin。
 * @param endpoint - 配置里的调试端口地址，可省略协议，也可带尾部斜杠。
 * @returns 带协议、无尾部斜杠的 origin。
 */
export function normalizeEndpoint(endpoint: string): string {
  const withScheme = /^https?:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`
  return withScheme.replace(/\/+$/, '')
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, signal ? { signal } : {})
  if (!response.ok) throw new CdpError(`${url} 返回 ${response.status}`, 'http')
  return await response.json() as T
}

/**
 * 列出浏览器当前暴露的所有可调试目标。
 * @param endpoint - 调试端口地址，交给 {@link normalizeEndpoint} 规整。
 * @param signal - 取消信号，会一路传给 fetch。
 * @returns `/json/list` 返回的目标列表；HTTP 非 2xx 时抛 {@link CdpError}。
 */
export async function listTargets(endpoint: string, signal?: AbortSignal): Promise<CdpTarget[]> {
  return await getJson<CdpTarget[]>(`${normalizeEndpoint(endpoint)}/json/list`, signal)
}

/**
 * Open a new tab without taking the foreground, and return its target.
 *
 * `/json/new` cannot do this: Chrome activates the tab it creates, which pulls
 * the page out from under whoever is looking at the browser. Measured — a tab
 * that was foreground reports `document.hidden === true` right after. Only
 * `Target.createTarget` takes `background`, and only on a browser-level
 * connection, so this opens one for the call.
 *
 * @param endpoint - the DevTools endpoint.
 * @param url - the URL to open.
 * @param signal - abort the request.
 * @returns the new target, with a debugger address when Chrome reports one.
 */
export async function createTarget(
  endpoint: string,
  url: string,
  signal?: AbortSignal,
): Promise<CdpTarget> {
  const base = normalizeEndpoint(endpoint)
  const version = await getJson<{ webSocketDebuggerUrl?: string }>(`${base}/json/version`, signal)
  if (version.webSocketDebuggerUrl !== undefined) {
    const browser = await CdpConnection.open(version.webSocketDebuggerUrl, signal)
    try {
      const created = await browser.send<{ targetId: string }>(
        'Target.createTarget', { url, background: true },
      )
      // Target.createTarget 只回 id;ws 地址要从列表里取。
      const listed = (await listTargets(endpoint, signal)).find(t => t.id === created.targetId)
      if (listed) return listed
      // 刚建的标签页还没进列表:回一个只带 id 的壳,调用方会再列一次取 ws 地址。
      return { id: created.targetId, type: 'page', url, title: '' }
    } finally {
      browser.close()
    }
  }
  // 拿不到 browser 连接时退回 HTTP:会抢前台,但比开不出标签页好。
  const target = `${base}/json/new?${encodeURIComponent(url)}`
  // 新版 Chrome 只接受 PUT;旧版只认 GET,所以失败再退回去试一次。
  const response = await fetch(target, { method: 'PUT', ...signal ? { signal } : {} })
  if (response.ok) return await response.json() as CdpTarget
  return await getJson<CdpTarget>(target, signal)
}

/**
 * Close one tab.
 * @param endpoint - the DevTools endpoint.
 * @param id - the target id to close.
 * @param signal - abort the request.
 * @returns nothing; a target that is already gone is not an error.
 */
export async function closeTarget(endpoint: string, id: string, signal?: AbortSignal): Promise<void> {
  const url = `${normalizeEndpoint(endpoint)}/json/close/${encodeURIComponent(id)}`
  try {
    await fetch(url, { ...signal ? { signal } : {} })
  } catch (error: unknown) {
    // 关不掉只会多留一个标签页,不该让整轮问答失败。调用方已经拿到回复了。
    if (error instanceof Error && error.name === 'AbortError') throw error
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** One live CDP session against a single page. */
export class CdpConnection {
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>()
  private seq = 0
  private closedReason: Error | undefined

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      this.receive(decode(data))
    })
    socket.on('close', () => {
      this.fail(new CdpError('CDP 连接已关闭。', 'close'))
    })
    socket.on('error', (error) => {
      this.fail(error instanceof Error ? error : new CdpError(String(error), 'socket'))
    })
  }

  /**
   * 连上一个目标的调试 WebSocket。
   *
   * 最大载荷放到 256 MiB：整段对话历史会通过一次 `Runtime.evaluate` 回传，默认上限
   * （100 MiB）在长会话里会把连接直接断掉。
   * @param wsUrl - 目标的 `webSocketDebuggerUrl`。
   * @param signal - 取消信号；在连上之前中止会关掉这个 socket。
   * @returns 已经连上的连接。
   */
  static async open(wsUrl: string, signal?: AbortSignal): Promise<CdpConnection> {
    const socket = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 })
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup()
        resolve()
      }
      const onError = (error: unknown) => {
        cleanup()
        reject(error instanceof Error ? error : new CdpError(String(error), 'open'))
      }
      const onAbort = () => {
        cleanup()
        socket.close()
        reject(new CdpError('连接被取消。', 'open'))
      }
      const cleanup = () => {
        socket.off('open', onOpen)
        socket.off('error', onError)
        signal?.removeEventListener('abort', onAbort)
      }
      socket.on('open', onOpen)
      socket.on('error', onError)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    return new CdpConnection(socket)
  }

  private receive(raw: string): void {
    let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }
    try {
      message = JSON.parse(raw) as typeof message
    } catch {
      return
    }
    // 没有 id 的是事件通知,派发给等待者。
    if (message.method !== undefined) {
      const waiting = this.listeners.get(message.method)
      if (waiting) for (const listener of [...waiting]) listener(message.params)
      return
    }
    if (message.id === undefined) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) pending.reject(new CdpError(message.error.message ?? 'CDP 调用失败', 'call'))
    else pending.resolve(message.result)
  }

  private fail(error: Error): void {
    this.closedReason ??= error
    for (const [, pending] of this.pending) pending.reject(error)
    this.pending.clear()
  }

  /**
   * Subscribe to a CDP event for as long as the returned disposer is unused.
   * @param method - CDP event name, e.g. `Runtime.bindingCalled`.
   * @param listener - receives the event params.
   * @returns the unsubscribe function.
   */
  on(method: string, listener: (params: unknown) => void): () => void {
    const set = this.listeners.get(method) ?? new Set()
    set.add(listener)
    this.listeners.set(method, set)
    return () => {
      this.listeners.get(method)?.delete(listener)
    }
  }

  /**
   * 等某个 CDP 事件的下一次出现。
   *
   * 必须在发出触发它的命令**之前**注册，否则快事件会在还没人监听时就到了。超时返回
   * false 而不是抛错：这里的每个调用方都有可用的兜底路径。
   *
   * @param method - CDP 事件名，例如 `Page.loadEventFired`。
   * @param timeoutMs - 超过这个时长就放弃。
   * @returns 事件到达返回 true；超时返回 false，不抛错。
   */
  once(method: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const listener = () => {
        cleanup()
        resolve(true)
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve(false)
      }, timeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        this.listeners.get(method)?.delete(listener)
      }
      const set = this.listeners.get(method) ?? new Set()
      set.add(listener)
      this.listeners.set(method, set)
    })
  }

  /**
   * 发一条 CDP 命令并等它的结果。
   * @param method - CDP 方法名，例如 `Runtime.evaluate`。
   * @param params - 该方法的参数对象；没有参数时整个字段不出现在报文里。
   * @returns 命令的 result 字段。连接已关闭、发送失败或浏览器回错时抛错。
   */
  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.closedReason) throw this.closedReason
    const id = ++this.seq
    const payload = JSON.stringify({ id, method, ...params ? { params } : {} })
    const result = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(payload, (error) => {
        if (!error) return
        this.pending.delete(id)
        reject(error)
      })
    })
    return result as T
  }

  /**
   * 在页面里求值一个表达式并取回结果。
   * @param expression - 在页面主世界里执行的 JavaScript；promise 会被等待。
   * @returns 按值序列化回来的求值结果。页面脚本抛异常时转成 {@link CdpError}。
   */
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{
      result?: { value?: T }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new CdpError(`页面脚本执行失败: ${detail ?? '未知错误'}`, 'Runtime.evaluate')
    }
    return result.result?.value as T
  }

  /**
   * 把本地文件挂到第一个匹配 `selector` 的文件输入框上。
   * @param selector - 定位 `input[type=file]` 的选择器。
   * @param paths - 要挂载的本地文件绝对路径。
   * @returns 挂载完成；页面上找不到该输入框时抛 {@link CdpError}。
   */
  async setFileInput(selector: string, paths: readonly string[]): Promise<void> {
    const doc = await this.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: -1 })
    const { nodeId } = await this.send<{ nodeId: number }>('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector,
    })
    if (!nodeId) throw new CdpError(`页面上找不到文件输入框 (${selector})`, 'DOM.querySelector')
    await this.send('DOM.setFileInputFiles', { nodeId, files: [...paths] })
  }

  /** 主动关闭连接，并让所有在途命令以「连接已关闭」失败。 */
  close(): void {
    this.fail(new CdpError('CDP 连接已关闭。', 'close'))
    this.socket.close()
  }
}
