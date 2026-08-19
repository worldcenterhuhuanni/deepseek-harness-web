/**
 * Bring up a debuggable Chrome of our own.
 *
 * A running Chrome cannot be made debuggable after the fact — the port is a
 * startup flag, deliberately, or any local process could hijack the browser
 * you are already using. So instead of asking the user to quit theirs, we
 * launch a second instance with its own `--user-data-dir`. It coexists with
 * their daily browser and keeps its own login, which persists across restarts.
 *
 * @module @deepseek-ai/dsh-llm-deepseek-web/launch
 */

import { spawn } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeEndpoint } from './cdp.ts'

/**
 * 用户没指定时，专用浏览器 profile 的落地位置。
 * @returns `$DSH_HOME/deepseek-web-profile`；`DSH_HOME` 未设时退回 `~/.dsh`。
 */
export function defaultUserDataDir(): string {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return join(home, 'deepseek-web-profile')
}

/** Candidate Chrome binaries, most preferred first. */
function candidatePaths(): string[] {
  const fromEnv = process.env['CHROME_PATH']
  const candidates = fromEnv ? [fromEnv] : []
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    )
  } else if (process.platform === 'win32') {
    const programFiles = process.env['PROGRAMFILES'] ?? 'C:\\Program Files'
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'
    candidates.push(
      join(programFiles, 'Google/Chrome/Application/chrome.exe'),
      join(programFilesX86, 'Google/Chrome/Application/chrome.exe'),
      join(programFiles, 'Microsoft/Edge/Application/msedge.exe'),
    )
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    )
  }
  return candidates
}

/**
 * 按候选顺序找一个可执行的 Chrome。
 * @returns 第一个存在的候选路径；我们找的位置都没有时返回 undefined。
 */
export async function findChrome(): Promise<string | undefined> {
  for (const candidate of candidatePaths()) {
    try {
      await access(candidate)
      return candidate
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * 探测调试端口是否已经在应答。
 * @param endpoint - 调试端口地址。
 * @param timeoutMs - 单次探测的超时，默认 1 秒。
 * @returns `/json/version` 返回 2xx 为 true；任何失败（含超时）都是 false，不抛错。
 */
export async function isEndpointUp(endpoint: string, timeoutMs = 1_000): Promise<boolean> {
  try {
    const response = await fetch(`${normalizeEndpoint(endpoint)}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok
  } catch {
    return false
  }
}

/** 拉起并等待一个可调试浏览器所需的参数。 */
export interface LaunchOptions {
  /** 探测与等待用的调试端口地址。 */
  endpoint: string
  /** 传给浏览器的 `--remote-debugging-port`。 */
  port: number
  /** 传给浏览器的 `--user-data-dir`，与用户日常 profile 分开。 */
  userDataDir: string
  /** 指定的 Chrome 可执行文件；不填则自动探测。 */
  chromePath?: string
  /** First page the new window lands on; defaults to DeepSeek so login is one click away. */
  startUrl?: string
  /** How long to wait for the new browser to answer on its port. */
  readyTimeoutMs?: number
}

const DEFAULT_READY_TIMEOUT_MS = 30_000

/**
 * 确保有一个可调试的浏览器在监听，必要时拉起一个。
 * @param options - 端口、profile 目录与可执行文件等启动参数。
 * @returns 浏览器是否由本次调用启动（已在运行则为 false）。
 */
export async function ensureChrome(options: LaunchOptions): Promise<boolean> {
  if (await isEndpointUp(options.endpoint)) return false

  const binary = options.chromePath ?? await findChrome()
  if (binary === undefined) {
    throw new Error(
      '找不到 Chrome 可执行文件。请安装 Chrome，或用 CHROME_PATH 环境变量指定路径，'
      + '也可以关掉 autoLaunch 后自行用 --remote-debugging-port 启动浏览器。',
    )
  }

  await mkdir(options.userDataDir, { recursive: true })

  // 独立 user-data-dir 是关键:没有它,新进程会把参数转交给已在运行的 Chrome
  // 然后自己退出,端口永远打不开。
  const child = spawn(binary, [
    `--remote-debugging-port=${options.port}`,
    `--user-data-dir=${options.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // 窗口保持可见并直接落在 DeepSeek 上:首次要在里面登录。
    options.startUrl ?? 'https://chat.deepseek.com/',
  ], {
    detached: true,
    stdio: 'ignore',
  })
  // 让浏览器脱离 dsh 生命周期:dsh 重启时它还在,登录态不用重来。
  child.unref()

  const deadline = Date.now() + (options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
  for (;;) {
    if (await isEndpointUp(options.endpoint)) return true
    if (Date.now() > deadline) {
      throw new Error(
        `已启动 Chrome 但 ${options.port} 端口在超时前没有响应。`
        + '请检查该端口是否被占用，或改用其他端口。',
      )
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300)
    })
  }
}
