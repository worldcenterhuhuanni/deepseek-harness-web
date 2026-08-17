import { describe, expect, it } from 'vitest'
import { DsWebAdapter } from '../src/adapter.ts'
import { WebSession } from '../src/session.ts'

// 只测目录契约,不发请求,所以端点指向一个不会被访问的地址即可。
function adapter(): DsWebAdapter {
  return new DsWebAdapter({ session: new WebSession({ endpoint: 'http://127.0.0.1:9222' }) })
}

describe('model catalog contract', () => {
  it('advertises one model whose provider matches the route', async () => {
    // buildModelCatalog 先 listModels 再逐个 resolveModelInfo,任何一步抛错
    // 整个 provider 分组都会被丢掉 —— 模型选择器里就什么都没有。
    const models = await adapter().listModels('deepseek-web')
    expect(models).toHaveLength(1)
    expect(models[0]?.provider).toBe('deepseek-web')
    expect(models[0]?.id).toBe('deepseek-web')
  })

  it('satisfies the runtime INVALID_MODEL_INFO checks', async () => {
    const resolved = await adapter().resolveModel('deepseek-web', 'deepseek-web')
    // 与 LlmRuntime.resolveModelInfoFor 的校验逐条对应。
    expect(typeof resolved.provider).toBe('string')
    expect(resolved.provider).toBe('deepseek-web')
    expect(typeof resolved.id).toBe('string')
    expect(resolved.id).toBe('deepseek-web')
    expect(typeof resolved.name).toBe('string')
    expect(resolved.name.length).toBeGreaterThan(0)
    // context 省略是合法的;给了就必须是正整数,所以这里确认没有半吊子值。
    expect(resolved.context).toBeUndefined()
  })

  it('names the route in providerInfo', () => {
    const info = adapter().providerInfo('deepseek-web')
    expect(info.id).toBe('deepseek-web')
    expect(info.name.length).toBeGreaterThan(0)
  })
})
