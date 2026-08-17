/**
 * 把本插件挂进一个 dsh profile 的用户层，不改动 upstream 任何文件。
 *
 * 扩展位由 packages/boot/app-boot/src/profile.ts 定义：profile 目录下的
 * package.json 承载 out-of-tree 插件依赖，cordis.patch.yml 是在所有 bundle
 * 层之后应用的用户 patch 层。因此本脚本只写 $DSH_HOME/profiles/<name>/，
 * 上游更新永不冲突。
 *
 * 用法：node install-profile.mjs [profile 名，默认 web]
 * 幂等：已挂好则原样返回，不重复写入、不重复 pnpm install。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageName = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).name
const profileName = process.argv[2] ?? 'web'
const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', profileName)

/** patch 层里代表本插件的一行；id 供后续按 id 覆盖配置。 */
const PATCH_YAML = `- insert:
    - id: llm-deepseek-web
      name: '${packageName}'
`

function fail(message) {
  console.error(`install-profile: ${message}`)
  process.exit(1)
}

if (!existsSync(profileDir)) {
  fail(`profile 目录不存在：${profileDir}\n  先运行一次 dsh --profile ${profileName} 让它初始化，或改用已存在的 profile 名。`)
}

// 1) 依赖：profile 的 node_modules 由 pnpm 管理，link: 指向工作区里的本包。
const manifestPath = join(profileDir, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.dependencies ??= {}
const wantSpec = `link:${packageDir}`
let dependencyChanged = false
if (manifest.dependencies[packageName] === wantSpec) {
  console.log(`install-profile: 依赖已就绪 ${packageName}`)
} else {
  manifest.dependencies[packageName] = wantSpec
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`install-profile: 已写入依赖 ${packageName} -> ${wantSpec}`)
  dependencyChanged = true
}

// 2) patch 层：只替换空数组模板。用户已有自定义内容时不猜测合并意图，明确报错。
const patchPath = join(profileDir, 'cordis.patch.yml')
const patchText = readFileSync(patchPath, 'utf8')
if (patchText.includes(packageName)) {
  console.log('install-profile: patch 层已包含本插件')
} else if (/^\[\]\s*$/m.test(patchText)) {
  writeFileSync(patchPath, patchText.replace(/^\[\]\s*$/m, PATCH_YAML))
  console.log(`install-profile: 已在 patch 层插入 ${packageName}`)
} else {
  fail(`${patchPath} 已有自定义内容，未改动。请自行加入这一段：\n${PATCH_YAML}`)
}

// 3) 依赖有变化时才装，避免每次启动都跑 pnpm。
if (dependencyChanged) {
  console.log('install-profile: 在 profile 目录执行 pnpm install')
  execFileSync('pnpm', ['install'], { cwd: profileDir, stdio: 'inherit' })
}

console.log(`install-profile: profile ${profileName} 就绪（${profileDir}）`)
