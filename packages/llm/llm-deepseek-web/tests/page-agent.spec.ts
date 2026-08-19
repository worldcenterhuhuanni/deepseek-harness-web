/**
 * `snapshot()` must read STATE, never conversation CONTENT.
 *
 * The regression this guards: `snapshot()` matched `FAIL_HINT` and `BUSY_HINT`
 * against `document.body.innerText`, which contains the whole transcript. A task
 * that merely discussed JSON parsing put the words 「解析失败」 on the page, so
 * the attachment was reported as failed with the site's own wording — the text
 * actually came from the model's reply — and the transcript never loses those
 * words, so every later turn failed too. 「处理中」/「Loading」 hit the same way
 * and pinned `busy` on until the 120s attach timeout.
 *
 * @module @deepseek-ai/dsh-llm-deepseek-web/tests/page-agent
 */

import { JSDOM } from 'jsdom'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PAGE_HINTS, PAGE_AGENT, type PageHints, type PageSnapshot } from '../src/page-agent.ts'
import { sendFailureFrom } from '../src/session.ts'

/** Composer nested deep enough that `composerBox()` (input + 6 parents) excludes the transcript. */
const composer = (extra = '') =>
  `<div><div><div><div><div><div>${extra}<textarea placeholder="给 DeepSeek 发送消息"></textarea></div></div></div></div></div></div>`

function pageWith(transcript: string, composerExtra = '', hints: PageHints = DEFAULT_PAGE_HINTS): PageSnapshot {
  const dom = new JSDOM(
    `<body><div id="app"><div id="chat">${transcript}</div>${composer(composerExtra)}</div></body>`,
    { runScripts: 'outside-only' },
  )
  // jsdom 不实现 innerText;页面脚本用它读可见文本,所以映射到 textContent。
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) { return this.textContent },
  })
  dom.window.eval(PAGE_AGENT)
  return (dom.window as unknown as { __dshWeb: { snapshot(h: PageHints): PageSnapshot } })
    .__dshWeb.snapshot(hints)
}

describe('a send failure explains itself from the page', () => {
  const base = { loggedIn: true, hasInput: true, failed: '', failedElsewhere: '', busy: false }

  it('names the site refusal and asks for a different channel', () => {
    const error = sendFailureFrom({ ...base, blocked: '请删除异常文件再发送', hint: '请删除异常文件再发送' }, '无法发送消息')
    // 分类决定补救动作:page-blocked 才会让下一轮换一条网页对话。
    expect(error.kind).toBe('page-blocked')
    expect(error.message).toContain('请删除异常文件再发送')
  })

  it('quotes the composer verbatim when no hint word matches', () => {
    // 站点换了文案时的唯一线索。旧实现在这里写死「页面可能已改版」,把真正的原因藏掉了。
    const error = sendFailureFrom({ ...base, blocked: '', hint: '本对话已达上限，请开启新对话' }, '无法发送消息')
    expect(error.kind).toBe('transport')
    expect(error.message).toContain('本对话已达上限')
  })

  it('says so when the composer shows nothing at all', () => {
    const error = sendFailureFrom({ ...base, blocked: '', hint: '' }, '无法发送消息')
    expect(error.kind).toBe('transport')
    expect(error.message).toContain('没有任何提示文字')
  })
})

describe('snapshot state detection', () => {
  let sane: PageSnapshot
  beforeEach(() => { sane = pageWith('你好。<br>好的，我来看一下。') })

  it('reports the site refusing to send, apart from a failed attachment', () => {
    // 这一条与 failed 的区别决定上层要不要换通道:残留不清掉,同一个页面永远发不出去。
    const snapshot = pageWith('无关对话', '<div>文件上传失败，请删除异常文件再发送</div>')
    expect(snapshot.blocked).toContain('请删除异常文件')
    expect(snapshot.hint).toContain('请删除异常文件')
  })

  it('always carries the composer text so an unknown refusal is still legible', () => {
    // 词表只认得已知文案。站点换了说法时,这段原文是错误消息里唯一的线索。
    const snapshot = pageWith('无关对话', '<div>本对话已达上限，请开启新对话</div>')
    expect(snapshot.blocked).toBe('')
    expect(snapshot.hint).toContain('本对话已达上限')
  })

  it('judges nothing when a hint table is empty', () => {
    // 空词表拼成的 new RegExp('') 会匹配一切:那会让每一次快照都判失败、判忙。
    const snapshot = pageWith('无关对话', '<div>解析失败</div>', { login: [], fail: [], busy: [], blocked: [] })
    expect(snapshot).toMatchObject({ failed: '', failedElsewhere: '', blocked: '', busy: false })
  })

  it('sees a healthy composer', () => {
    expect(sane).toMatchObject({ hasInput: true, loggedIn: true, failed: '', busy: false })
  })

  it('does not read a failure out of the transcript', () => {
    // 真实触发场景:任务本身就在讨论「非法 JSON / 解析失败」。
    const snapshot = pageWith('用户：非法 json 希望看到完整内容<br>助手：JSON 解析失败时应展示该行')
    expect(snapshot.failed).toBe('')
  })

  it('does not read busy out of the transcript', () => {
    const snapshot = pageWith('助手：任务处理中，Loading 状态要有进度条，Parsing 之后再渲染')
    expect(snapshot.busy).toBe(false)
  })

  it('still reports a real failure shown in the composer', () => {
    // 收缩范围不能把真故障一起丢掉:站点贴在输入区的提示仍然算失败。
    const snapshot = pageWith('无关对话', '<div>解析失败</div>')
    expect(snapshot.failed).toContain('解析失败')
    expect(snapshot.failedElsewhere).toBe('')
  })

  it('records an out-of-composer hint without treating it as a failure', () => {
    // 漏报的唯一线索:判据仍是空,但超时报错会带上这段文本。
    const snapshot = pageWith('助手：这里写了 解析失败 两个字')
    expect(snapshot.failed).toBe('')
    expect(snapshot.failedElsewhere).toContain('解析失败')
  })

  it('still reports a real busy state shown in the composer', () => {
    const snapshot = pageWith('无关对话', '<div>上传中…</div>')
    expect(snapshot.busy).toBe(true)
  })
})
