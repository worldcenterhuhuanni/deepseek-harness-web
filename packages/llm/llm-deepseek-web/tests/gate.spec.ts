/**
 * The tab gate. Without it, dsh's session-title request runs `Input.insertText`
 * into the same composer as the main request and the site receives both prompts
 * concatenated — it then answers whichever instruction it read last, so the user
 * gets the generated title as their reply.
 *
 * @module @deepseek-ai/dsh-llm-deepseek-web/tests/gate
 */

import { describe, expect, it } from 'vitest'
import { createGate } from '../src/session.ts'

describe('createGate', () => {
  it('lets the first caller through immediately', async () => {
    const acquire = createGate()
    const release = await acquire()
    expect(typeof release).toBe('function')
    release()
  })

  it('keeps a second caller out until the first releases', async () => {
    const acquire = createGate()
    const first = await acquire()
    let entered = false
    const second = acquire().then((release) => {
      entered = true
      return release
    })

    // 让微任务跑干:没有释放,第二个不该进来。
    await Promise.resolve()
    await Promise.resolve()
    expect(entered).toBe(false)

    first()
    await second
    expect(entered).toBe(true)
  })

  it('never interleaves two critical sections', async () => {
    const acquire = createGate()
    const trace: string[] = []

    const run = async (label: string): Promise<void> => {
      const release = await acquire()
      trace.push(`${label}:enter`)
      await new Promise(resolve => setTimeout(resolve, 5))
      trace.push(`${label}:exit`)
      release()
    }

    await Promise.all([run('a'), run('b'), run('c')])

    // 每个 enter 后面紧跟自己的 exit,顺序即到达顺序。
    expect(trace).toEqual([
      'a:enter', 'a:exit',
      'b:enter', 'b:exit',
      'c:enter', 'c:exit',
    ])
  })

  it('stays usable after a holder throws, as long as release is called', async () => {
    const acquire = createGate()
    const release = await acquire()
    try {
      throw new Error('boom')
    } catch {
      release()
    }
    const next = await acquire()
    expect(typeof next).toBe('function')
    next()
  })
})
