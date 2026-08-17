import { describe, expect, it } from 'vitest'
import { normalizeEndpoint } from '../src/cdp.ts'
import { defaultUserDataDir } from '../src/launch.ts'
import { BridgeError, WebSession } from '../src/session.ts'

// 没有任何东西会监听这里,用来复现「浏览器没起来」。
const DEAD_ENDPOINT = 'http://127.0.0.1:9'

/** autoLaunch 必须关掉:否则测试会真的在开发机上拉起一个 Chrome 窗口。 */
function offlineSession() {
  return new WebSession({ endpoint: DEAD_ENDPOINT, autoLaunch: false })
}

describe('normalizeEndpoint', () => {
  it('adds a scheme when the user omits one', () => {
    expect(normalizeEndpoint('127.0.0.1:9222')).toBe('http://127.0.0.1:9222')
    expect(normalizeEndpoint('localhost:9222')).toBe('http://localhost:9222')
  })

  it('keeps an explicit scheme and trims trailing slashes', () => {
    expect(normalizeEndpoint('http://127.0.0.1:9222/')).toBe('http://127.0.0.1:9222')
    expect(normalizeEndpoint('https://example:9222///')).toBe('https://example:9222')
  })
})

describe('defaultUserDataDir', () => {
  it('keeps the launched browser profile out of the daily one', () => {
    const dir = defaultUserDataDir()
    expect(dir).toContain('deepseek-web-profile')
    // 绝不能落到 Chrome 自己的 profile 上:那会逼用户退出日常浏览器。
    expect(dir).not.toContain('Google/Chrome')
  })
})

describe('WebSession with autoLaunch disabled', () => {
  it('reports a transport failure naming the endpoint', async () => {
    const error = await offlineSession().ask({ prompt: 'hi', newChat: true }).next().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(BridgeError)
    expect((error as BridgeError).kind).toBe('transport')
    expect((error as BridgeError).message).toContain(DEAD_ENDPOINT)
  })

  it('aborts promptly when the caller cancels', async () => {
    const stream = offlineSession().ask({ prompt: 'hi', newChat: true, signal: AbortSignal.abort() })
    await expect(stream.next()).rejects.toThrow()
  })
})
