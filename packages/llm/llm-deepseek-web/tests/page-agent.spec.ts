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
import { PAGE_AGENT, type PageSnapshot } from '../src/page-agent.ts'

/** Composer nested deep enough that `composerBox()` (input + 6 parents) excludes the transcript. */
const composer = (extra = '') =>
  `<div><div><div><div><div><div>${extra}<textarea placeholder="给 DeepSeek 发送消息"></textarea></div></div></div></div></div></div>`

function pageWith(transcript: string, composerExtra = ''): PageSnapshot {
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
  return (dom.window as unknown as { __dshWeb: { snapshot(): PageSnapshot } }).__dshWeb.snapshot()
}

describe('snapshot state detection', () => {
  let sane: PageSnapshot
  beforeEach(() => { sane = pageWith('你好。<br>好的，我来看一下。') })

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
    expect(snapshot.failed).toBe('解析失败')
    expect(snapshot.failedElsewhere).toBe('')
  })

  it('records an out-of-composer hint without treating it as a failure', () => {
    // 漏报的唯一线索:判据仍是空,但超时报错会带上这段文本。
    const snapshot = pageWith('助手：这里写了 解析失败 两个字')
    expect(snapshot.failed).toBe('')
    expect(snapshot.failedElsewhere).toBe('解析失败')
  })

  it('still reports a real busy state shown in the composer', () => {
    const snapshot = pageWith('无关对话', '<div>上传中…</div>')
    expect(snapshot.busy).toBe(true)
  })
})
