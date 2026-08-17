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

/** Normalize the user-supplied endpoint into an absolute http origin. */
export function normalizeEndpoint(endpoint: string): string {
  const withScheme = /^https?:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`
  return withScheme.replace(/\/+$/, '')
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, signal ? { signal } : {})
  if (!response.ok) throw new CdpError(`${url} 返回 ${response.status}`, 'http')
  return await response.json() as T
}

/** List page targets the browser currently exposes. */
export async function listTargets(endpoint: string, signal?: AbortSignal): Promise<CdpTarget[]> {
  return await getJson<CdpTarget[]>(`${normalizeEndpoint(endpoint)}/json/list`, signal)
}

/** Open a new tab and return its target. */
export async function createTarget(
  endpoint: string,
  url: string,
  signal?: AbortSignal,
): Promise<CdpTarget> {
  const base = normalizeEndpoint(endpoint)
  const target = `${base}/json/new?${encodeURIComponent(url)}`
  // 新版 Chrome 只接受 PUT;旧版只认 GET,所以失败再退回去试一次。
  const response = await fetch(target, { method: 'PUT', ...signal ? { signal } : {} })
  if (response.ok) return await response.json() as CdpTarget
  return await getJson<CdpTarget>(target, signal)
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
   * Resolve on the next occurrence of one CDP event.
   *
   * Register it *before* issuing the command that triggers it, or a fast event
   * lands before anyone is listening. Resolves false on timeout rather than
   * throwing: every caller here has a usable fallback path.
   *
   * @param method - CDP event name, e.g. `Page.loadEventFired`.
   * @param timeoutMs - give up after this long.
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

  /** Issue one CDP command and await its result. */
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
   * Evaluate an expression in the page and return its value.
   * @param expression - JavaScript evaluated in the page's main world.
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

  /** Attach local files to the first file input matching `selector`. */
  async setFileInput(selector: string, paths: readonly string[]): Promise<void> {
    const doc = await this.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: -1 })
    const { nodeId } = await this.send<{ nodeId: number }>('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector,
    })
    if (!nodeId) throw new CdpError(`页面上找不到文件输入框 (${selector})`, 'DOM.querySelector')
    await this.send('DOM.setFileInputFiles', { nodeId, files: [...paths] })
  }

  close(): void {
    this.fail(new CdpError('CDP 连接已关闭。', 'close'))
    this.socket.close()
  }
}
