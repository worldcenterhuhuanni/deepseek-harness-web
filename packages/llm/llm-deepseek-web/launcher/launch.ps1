<#
双击 launchWindow.cmd 或直接运行本文件：把本仓库源码连同本插件一起跑起来（Windows）。
macOS/Linux 用 launchMac.command。

环境缺什么就装什么：Node（winget）、pnpm（corepack）、仓库依赖、构建产物，
再把本插件挂进 dsh profile 的用户层（install-profile.mjs，不改 upstream），
最后启动 Web UI 并打开浏览器。已就绪的步骤直接跳过。
#>
[CmdletBinding()]
param([switch]$Rebuild, [switch]$SelfTest)

$ErrorActionPreference = 'Stop'

$NodeInstallMajor = 24
$FirstPort = 3080
$Profile_ = 'web'
$Total = 6

$launcherDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $launcherDir '../../../..')).Path

function Write-Step([int]$Index, [string]$Text) { Write-Host "[$Index/$Total] $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "      OK $Text" -ForegroundColor Green }
function Write-Note([string]$Text) { Write-Host "      $Text" }
function Test-Command([string]$Name) { [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

# 双击启动的窗口可能在脚本退出后关闭，出错必须停住让用户看到原因。
function Stop-Setup([string]$Text) {
  Write-Host "      FAIL $Text" -ForegroundColor Red
  Write-Host "`n出错了。可把上面的内容截图反馈。"
  Read-Host '按回车键关闭' | Out-Null
  exit 1
}

# 只接受 package.json engines.node 声明的范围：^22.19 || >=24。
function Test-NodeVersion([string]$Version) {
  if ($Version -notmatch '^v?(\d+)\.(\d+)\.') { return $false }
  $major = [int]$Matches[1]
  $minor = [int]$Matches[2]
  if ($major -ge 24) { return $true }
  return ($major -eq 22 -and $minor -ge 19)
}

function Invoke-SelfTest {
  $cases = @{ 'v24.14.1' = $true; 'v25.0.0' = $true; 'v22.19.0' = $true; 'v22.30.2' = $true
    'v22.18.0' = $false; 'v23.11.0' = $false; 'v20.11.1' = $false; 'nonsense' = $false; 'v22' = $false }
  $failed = $false
  foreach ($case in $cases.GetEnumerator()) {
    if ((Test-NodeVersion $case.Key) -ne $case.Value) {
      Write-Host "Test-NodeVersion $($case.Key) 期望 $($case.Value)" -ForegroundColor Red
      $failed = $true
    }
  }
  if ($failed) { exit 1 }
  Write-Host 'self-test: Test-NodeVersion 全部用例通过'
}

# winget 写入的是系统 PATH，当前会话读不到，重新拼一次。
function Update-SessionPath {
  $env:Path = @(
    [Environment]::GetEnvironmentVariable('Path', 'Machine')
    [Environment]::GetEnvironmentVariable('Path', 'User')
  ) -join ';'
}

function Test-PortBusy([int]$Port) {
  $client = New-Object Net.Sockets.TcpClient
  try { $client.Connect('127.0.0.1', $Port); return $true }
  catch { return $false }
  finally { $client.Dispose() }
}

function Get-FreePort {
  for ($port = $FirstPort; $port -lt $FirstPort + 20; $port++) {
    if (-not (Test-PortBusy $port)) { return $port }
  }
  Stop-Setup "$FirstPort-$($FirstPort + 19) 全被占用"
}

if ($SelfTest) { Invoke-SelfTest; exit 0 }

if (-not (Test-Path (Join-Path $repoRoot 'apps/cli/src/bin.ts'))) {
  Stop-Setup "在 $repoRoot 找不到 apps/cli/src/bin.ts；本脚本需要放在仓库内的 packages/llm/llm-deepseek-web/launcher/ 下"
}
Set-Location $repoRoot

Write-Step 1 '检查 Node.js 运行环境'
if ((Test-Command node) -and (Test-NodeVersion (node -v))) {
  Write-Ok "已安装 Node $(node -v)"
} else {
  $current = if (Test-Command node) { "版本 $(node -v) 过旧" } else { '未安装' }
  Write-Note "$current（需要 22.19 以上或 24 以上）"
  if (-not (Test-Command winget)) {
    Stop-Setup '系统没有 winget，请到 https://nodejs.org 下载 Node.js LTS 安装包后重试'
  }
  Write-Note '正在通过 winget 安装 Node.js LTS'
  winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  Update-SessionPath
  if (-not (Test-Command node)) { Stop-Setup '安装后仍找不到 node，请重开窗口再试' }
  if (-not (Test-NodeVersion (node -v))) { Stop-Setup "安装得到 Node $(node -v)，不满足要求" }
  Write-Ok "已安装 Node $(node -v)"
}

Write-Step 2 '检查 pnpm'
if (Test-Command pnpm) {
  Write-Ok "已安装 pnpm $(pnpm -v)"
} else {
  $want = node -p "require('$($repoRoot -replace '\\', '/')/package.json').packageManager"
  # corepack 随 Node 分发，按 packageManager 落地正确版本，无需全局安装。
  corepack enable pnpm 2>$null
  Update-SessionPath
  if (-not (Test-Command pnpm)) { npm install -g $want; Update-SessionPath }
  if (-not (Test-Command pnpm)) { Stop-Setup "安装 $want 后 pnpm 仍不可用" }
  Write-Ok "已安装 pnpm $(pnpm -v)"
}

Write-Step 3 '安装仓库依赖（已是最新时几乎瞬间完成）'
pnpm install
if ($LASTEXITCODE -ne 0) { Stop-Setup 'pnpm install 失败' }
Write-Ok '依赖就绪'

# 产物「存在」不等于「是最新的」:插件以 main: lib/index.js 被 Node 加载,改了 src
# 却不重建,跑起来仍是旧代码,而进度显示成功 —— 最难查的一类问题。只看 src:
# tsdown 只打包它,测试文件改动不影响产物。
function Get-StaleSource {
    $stamp = (Get-Item 'apps/cli/lib/bin.js').LastWriteTimeUtc
    return Get-ChildItem -Path 'packages', 'apps' -Recurse -Filter '*.ts' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notlike '*\node_modules\*' -and $_.FullName -like '*\src\*' -and $_.LastWriteTimeUtc -gt $stamp } |
        Select-Object -First 1 -ExpandProperty FullName
}

Write-Step 4 '构建'
$needsBuild = $true
if ($Rebuild) {
    Write-Note '强制重建'
} elseif (-not (Test-Path 'apps/cli/lib/bin.js') -or -not (Test-Path 'apps/web/dist/index.html')) {
    Write-Note '尚无构建产物'
} else {
    $stale = Get-StaleSource
    if ($stale) { Write-Note "源码已改动（$stale 等），产物过期，重新构建" }
    else { Write-Ok '产物是最新的，跳过'; $needsBuild = $false }
}
if ($needsBuild) {
    Write-Note '全量构建需要数分钟'
    pnpm run build
    if ($LASTEXITCODE -ne 0) { Stop-Setup '构建失败' }
    Write-Ok '构建完成'
}

Write-Step 5 "把 llm-deepseek-web 挂进 profile：$Profile_"
node (Join-Path $launcherDir 'install-profile.mjs') $Profile_
if ($LASTEXITCODE -ne 0) { Stop-Setup 'profile 挂载失败' }

$port = Get-FreePort
Write-Step 6 "启动 Web UI：http://127.0.0.1:$port"
Write-Note '浏览器会自动打开；关掉本窗口即停止服务'

# 后台等端口就绪再拉起浏览器，主进程留在前台显示日志。
Start-Job -ScriptBlock {
  param($p)
  for ($i = 0; $i -lt 180; $i++) {
    $c = New-Object Net.Sockets.TcpClient
    try { $c.Connect('127.0.0.1', $p); Start-Process "http://127.0.0.1:$p"; return }
    catch { Start-Sleep -Seconds 1 }
    finally { $c.Dispose() }
  }
} -ArgumentList $port | Out-Null

# `dsh web` 是 `--profile web` 的 alias，且只有它接受 web app 自己的 --port。
pnpm dsh web --port $port
if ($LASTEXITCODE -ne 0) { Stop-Setup "dsh 退出，代码 $LASTEXITCODE" }
