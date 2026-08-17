import { describe, expect, it } from 'vitest'
import { DsWebAdapter } from '../src/adapter.ts'
import type { AskRequest, BridgeEvent, WebSession } from '../src/session.ts'

/** Capture what the adapter would send, without touching a browser. */
function fakeSession(sent: AskRequest[]): WebSession {
  return {
    ask(request: AskRequest): AsyncGenerator<BridgeEvent> {
      sent.push(request)
      return (async function* () {
        yield { kind: 'text', text: '好的' }
      })()
    },
  } as unknown as WebSession
}

function message(id: string, role: 'user' | 'assistant', text: string) {
  return { id, role, content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function request(sessionId: string, messages: unknown[]) {
  return {
    provider: 'deepseek-web',
    model: 'deepseek-web',
    sessionId,
    system: '你是助手。',
    messages,
  } as never
}

async function drain(adapter: DsWebAdapter, options: never): Promise<void> {
  for await (const _chunk of adapter.stream(options)) { /* consume */ }
}

describe('web conversation reuse', () => {
  it('opens a new chat first, then continues with only the new turn', async () => {
    const sent: AskRequest[] = []
    const adapter = new DsWebAdapter({ session: fakeSession(sent), useAttachment: () => false })

    await drain(adapter, request('s1', [message('m1', 'user', '第一个问题')]))
    await drain(adapter, request('s1', [
      message('m1', 'user', '第一个问题'),
      message('a1', 'assistant', '第一个回答'),
      message('m2', 'user', '第二个问题'),
    ]))

    expect(sent).toHaveLength(2)
    expect(sent[0]?.newChat).toBe(true)
    // 续问必须复用网页会话,否则历史列表会被每一轮灌满。
    expect(sent[1]?.newChat).toBe(false)
    // 只带新增内容:旧问题不重发,模型自己的回答更不该回灌。
    expect(sent[1]?.prompt).toContain('第二个问题')
    expect(sent[1]?.prompt).not.toContain('第一个问题')
    expect(sent[1]?.prompt).not.toContain('第一个回答')
  })

  it('starts over when compaction rewrote the delivered prefix', async () => {
    const sent: AskRequest[] = []
    const adapter = new DsWebAdapter({ session: fakeSession(sent), useAttachment: () => false })

    await drain(adapter, request('s1', [message('m1', 'user', '第一个问题')]))
    // 压缩会把历史换成另一批消息;此时网页记得的东西已经不是 dsh 认为的了。
    await drain(adapter, request('s1', [
      message('sum', 'user', '前情摘要'),
      message('m2', 'user', '第二个问题'),
    ]))

    expect(sent[1]?.newChat).toBe(true)
    expect(sent[1]?.prompt).toContain('前情摘要')
  })

  it('starts over for a different dsh session', async () => {
    const sent: AskRequest[] = []
    const adapter = new DsWebAdapter({ session: fakeSession(sent), useAttachment: () => false })

    await drain(adapter, request('s1', [message('m1', 'user', '问题')]))
    await drain(adapter, request('s2', [message('m1', 'user', '问题'), message('m2', 'user', '再问')]))

    expect(sent[1]?.newChat).toBe(true)
  })

  it('starts over when the tool set changed', async () => {
    const sent: AskRequest[] = []
    const adapter = new DsWebAdapter({ session: fakeSession(sent), useAttachment: () => false })

    const first = request('s1', [message('m1', 'user', '问题')])
    await drain(adapter, first)

    const withTool = {
      ...(first as object),
      tools: [{ name: 'read', description: '读文件', parameters: {} }],
      messages: [message('m1', 'user', '问题'), message('m2', 'user', '再问')],
    } as never
    await drain(adapter, withTool)

    // 工具目录只在开场那一轮讲过,换了工具就必须重新开场。
    expect(sent[1]?.newChat).toBe(true)
    expect(sent[1]?.prompt).toContain('read')
  })
})
