<#
双击 launchWindow.cmd 或直接运行本文件：把本仓库源码连同本插件一起跑起来（Windows）。
macOS/Linux 用 launchMac.command。

环境缺什么就装什么：Node（优先 nvm，其次 winget）、pnpm（corepack）、仓库依赖、构建产物，
@echo off
set "NVM_HOME=%LOCALAPPDATA%\nvm"
set "NVM_SYMLINK=C:\Program Files\nodejs"
set "PATH=%NVM_HOME%;%NVM_SYMLINK%;%PATH%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" %*
pause再把本插件挂进 dsh profile 的用户层（install-profile.mjs，不改 upstream），
最后启动 Web UI 并打开浏览器。已就绪的步骤直接跳过。
#>

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
function Write-Debug([string]$Text) { Write-Host "      [DEBUG] $Text" -ForegroundColor Gray }

function Test-Command([string]$Name) {
    [bool](Get-Command $Name -ErrorAction SilentlyContinue) -or
    [bool](Get-Command $Name -ErrorAction SilentlyContinue -CommandType Function) -or
    [bool](Get-Command $Name -ErrorAction SilentlyContinue -CommandType Alias)
}

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

# 刷新 PATH 环境变量，并保留当前 nvm 的 NVM_HOME / NVM_SYMLINK
function Update-SessionPath {
  $parts = @()
  if ($env:NVM_SYMLINK) { $parts += $env:NVM_SYMLINK }
  if ($env:NVM_HOME) { $parts += $env:NVM_HOME }

  $process = [Environment]::GetEnvironmentVariable('Path', 'Process')
  if ($process) { $parts += ($process -split ';' | Where-Object { $_ -and $_.Trim() }) }

  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')

  if ($machine) { $parts += ($machine -split ';' | Where-Object { $_ -and $_.Trim() }) }
  if ($user) { $parts += ($user -split ';' | Where-Object { $_ -and $_.Trim() }) }

  $seen = @{}
  $filtered = @()
  foreach ($item in $parts) {
    if (-not $item) { continue }
    $trimmed = $item.Trim()
    if (-not $trimmed) { continue }
    $key = $trimmed.ToLowerInvariant()
    if (-not $seen.ContainsKey($key)) {
      $seen[$key] = $true
      $filtered += $trimmed
    }
  }

  $env:Path = ($filtered | Select-Object -Unique) -join ';'
}

function Remove-StaleNodePathsFromPath {
  $filtered = @()
  foreach ($item in ($env:Path -split ';')) {
    if (-not $item) { continue }
    $trimmed = $item.Trim()
    if (-not $trimmed) { continue }
    $lower = $trimmed.ToLowerInvariant()

    $isNodeLike = $lower -match '(^|[\\/])nodejs([\\/]|$)' -or
      $lower -match '(^|[\\/])nvm([\\/]|$)' -or
      $lower -match '(^|[\\/])node\.exe$'
    $isCwdNode = $lower -match 'git[\\/]deepseek-harness-web' -or $lower -match 'deepseek-harness-web'

    if ($isNodeLike -and -not $isCwdNode) {
      continue
    }
    $filtered += $trimmed
  }
  $env:Path = ($filtered | Select-Object -Unique) -join ';'
}

function Ensure-CurrentNodeFromNvm {
  param([string]$Version)

  $nvmHome = $env:NVM_HOME
  $nvmSymlink = $env:NVM_SYMLINK

  if (-not $nvmHome) { return $null }

  $candidates = @()
  if ($nvmSymlink) { $candidates += (Join-Path $nvmSymlink 'node.exe') }
  if ($nvmHome) {
    $candidates += (Join-Path $nvmHome ("v$Version\node.exe"))
    $candidates += (Join-Path $nvmHome 'node.exe')
  }

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      $dir = Split-Path $candidate
      Remove-StaleNodePathsFromPath
      $env:Path = "$dir;$env:Path"
      if ($nvmSymlink -and (Test-Path $nvmSymlink)) {
        $env:Path = "$nvmSymlink;$env:Path"
      }
      if ($nvmHome -and (Test-Path $nvmHome)) {
        $env:Path = "$nvmHome;$env:Path"
      }
      return $candidate
    }
  }

  return $null
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

# -------- 自动探测所有盘符的 nvm --------
function Find-NvmOnAllDrives {
  $candidates = @()

  foreach ($envKey in @('NVM_HOME', 'NVM_SYMLINK')) {
    $value = [Environment]::GetEnvironmentVariable($envKey, 'User')
    if (-not $value) { $value = [Environment]::GetEnvironmentVariable($envKey, 'Machine') }
    if ($value) { $candidates += $value }
  }

  $userProfile = [Environment]::GetFolderPath('UserProfile')
  $appData = [Environment]::GetFolderPath('ApplicationData')
  $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
  $programFiles = ${env:ProgramFiles}
  $programFilesX86 = ${env:ProgramFiles(x86)}

  foreach ($base in @(
      $appData,
      $localAppData,
      $userProfile,
      (Join-Path $userProfile 'AppData\Roaming'),
      (Join-Path $userProfile 'AppData\Local'),
      $programFiles,
      $programFilesX86,
      'C:\Users\' + ([Environment]::UserName),
      'C:\Program Files',
      'C:\tools',
      'C:\dev',
      'C:\scoop\apps'
  )) {
    if (-not $base) { continue }
    foreach ($sub in @(
        'nvm',
        'Program Files\nvm',
        'tools\nvm',
        'dev\nvm',
        'devtools\nvm',
        'nodejs\nvm',
        'apps\nvm',
        'scoop\apps\nvm\current',
        'AppData\Roaming\nvm',
        'AppData\Local\nvm'
    )) {
      $candidates += (Join-Path $base $sub)
    }
  }

  $seen = @{}
  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    $candidate = [System.IO.Path]::GetFullPath($candidate)
    if ($seen.ContainsKey($candidate)) { continue }
    $seen[$candidate] = $true

    if (Test-Path (Join-Path $candidate 'nvm.exe')) {
      Write-Debug "找到 nvm.exe: $(Join-Path $candidate 'nvm.exe')"
      return $candidate
    }
    if (Test-Path (Join-Path $candidate 'nvm.psm1')) {
      Write-Debug "找到 nvm 模块: $(Join-Path $candidate 'nvm.psm1')"
      return $candidate
    }
    if (Test-Path (Join-Path $candidate 'nvm.ps1')) {
      Write-Debug "找到 nvm 脚本: $(Join-Path $candidate 'nvm.ps1')"
      return $candidate
    }
  }

  $drives = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -gt 0 } | ForEach-Object { $_.Root }
  $subPaths = @(
    "nvm",
    "Program Files\nvm",
    "tools\nvm",
    "dev\nvm",
    "devtools\nvm",
    "nodejs\nvm",
    "apps\nvm",
    "scoop\apps\nvm\current",
    "Users\$([Environment]::UserName)\AppData\Roaming\nvm",
    "Users\$([Environment]::UserName)\AppData\Local\nvm"
  )

  foreach ($drive in $drives) {
    foreach ($sub in $subPaths) {
      $path = [System.IO.Path]::GetFullPath((Join-Path $drive $sub))
      if (Test-Path (Join-Path $path 'nvm.exe')) {
        Write-Debug "找到 nvm.exe: $(Join-Path $path 'nvm.exe')"
        return $path
      }
      if (Test-Path (Join-Path $path 'nvm.psm1')) {
        Write-Debug "找到 nvm 模块: $(Join-Path $path 'nvm.psm1')"
        return $path
      }
      if (Test-Path (Join-Path $path 'nvm.ps1')) {
        Write-Debug "找到 nvm 脚本: $(Join-Path $path 'nvm.ps1')"
        return $path
      }
    }
  }

  return $null
}

function Add-NvmToPath {
  param([string]$NvmRoot)

  if (-not $NvmRoot) { return }

  $nvmDir = $NvmRoot
  if (-not (Test-Path (Join-Path $nvmDir 'nvm.exe'))) {
    $nvmDir = [System.IO.Path]::GetDirectoryName((Get-ChildItem $nvmDir -Filter 'nvm.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName))
  }

  if (-not $nvmDir) { return }

  $paths = $env:Path -split ';' | Where-Object { $_ -and $_.Trim() }
  if (-not ($paths -contains $nvmDir)) {
    $env:Path = "$nvmDir;$env:Path"
  }

  $nvmHome = (Resolve-Path $NvmRoot -ErrorAction SilentlyContinue).Path
  if ($nvmHome) { $env:NVM_HOME = $nvmHome }

  $nodeJsCandidates = @(
    'C:\Program Files\nodejs',
    'C:\Program Files (x86)\nodejs',
    (Join-Path $env:ProgramData 'nodejs'),
    (Join-Path $env:LOCALAPPDATA 'nodejs'),
    (Join-Path $NvmRoot '..\nodejs')
  )

  $resolvedNodeJs = $null
  foreach ($candidate in $nodeJsCandidates) {
    if ($candidate -and (Test-Path $candidate)) {
      $resolvedNodeJs = (Resolve-Path $candidate).Path
      break
    }
  }

  if (-not $resolvedNodeJs) {
    $resolvedNodeJs = 'C:\Program Files\nodejs'
  }

  $env:NVM_SYMLINK = $resolvedNodeJs
  if (-not ($paths -contains $resolvedNodeJs)) {
    $env:Path = "$resolvedNodeJs;$env:Path"
  }
}

# -------- nvm 加载函数（带验证） --------
function Load-Nvm {
  # 先刷新 PATH
  Update-SessionPath

  # 先尝试直接调用 nvm 命令
  if (Test-Command nvm) {
    Write-Debug "nvm 已加载 (直接检测到)"
    return $true
  }

  Write-Note "未找到 nvm 命令，正在全盘搜索 nvm..."

  $nvmRoot = Find-NvmOnAllDrives
  if (-not $nvmRoot) {
    Write-Note "全盘搜索未找到 nvm"
    return $false
  }

  Add-NvmToPath -NvmRoot $nvmRoot
  Update-SessionPath

  if (Test-Command nvm) {
    Write-Debug "nvm 加载验证成功，已补充 PATH"
    return $true
  }

  if (Test-Path (Join-Path $nvmRoot 'nvm.psm1')) {
    Write-Debug "尝试 Import-Module: $(Join-Path $nvmRoot 'nvm.psm1')"
    try {
      Import-Module (Join-Path $nvmRoot 'nvm.psm1') -ErrorAction Stop
      Write-Debug "Import-Module 成功"
    } catch {
      Write-Debug "Import-Module 失败: $_"
      return $false
    }
  } elseif (Test-Path (Join-Path $nvmRoot 'nvm.ps1')) {
    Write-Debug "尝试 source: $(Join-Path $nvmRoot 'nvm.ps1')"
    try {
      . (Join-Path $nvmRoot 'nvm.ps1')
      Write-Debug "source 成功"
    } catch {
      Write-Debug "source 失败: $_"
      return $false
    }
  }

  Update-SessionPath
  $nvmLoaded = Test-Command nvm

  if ($nvmLoaded) {
    Write-Debug "nvm 加载验证成功"
    return $true
  }

  $nvmExe = Get-Command nvm.exe -ErrorAction SilentlyContinue
  if ($nvmExe) {
    Write-Debug "找到 nvm.exe: $($nvmExe.Source)"
    $nvmDir = Split-Path $nvmExe.Source
    $env:Path = "$nvmDir;$env:Path"
    Update-SessionPath
    return (Test-Command nvm)
  }

  return $false
}

function Get-NvmExecutable {
  $cmd = Get-Command nvm.exe -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }

  $cmd2 = Get-Command nvm -All -ErrorAction SilentlyContinue | Where-Object { $_.CommandType -in @('Application', 'ExternalScript', 'Alias', 'Function') } | Select-Object -First 1
  if ($cmd2 -and $cmd2.Source) { return $cmd2.Source }

  $whereResult = & where.exe nvm 2>$null
  if ($whereResult) {
    foreach ($line in $whereResult) {
      $trimmed = $line.Trim()
      if ($trimmed -and (Test-Path $trimmed)) {
        return $trimmed
      }
    }
  }

  $candidates = @(
    "$env:NVM_HOME\nvm.exe",
    "$env:NVM_SYMLINK\nvm.exe",
    "$env:LOCALAPPDATA\nvm\nvm.exe",
    "$env:APPDATA\nvm\nvm.exe",
    "$env:USERPROFILE\AppData\Roaming\nvm\nvm.exe",
    "$env:USERPROFILE\AppData\Local\nvm\nvm.exe",
    'C:\Program Files\nvm\nvm.exe',
    'C:\Program Files (x86)\nvm\nvm.exe',
    'D:\Program Files\nvm\nvm.exe',
    'E:\Program Files\nvm\nvm.exe',
    'F:\Program Files\nvm\nvm.exe'
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  foreach ($drive in 'C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z') {
    $root = "${drive}:"
    if (-not (Test-Path $root)) { continue }

    $userName = [Environment]::UserName
    foreach ($subPath in @(
      "Users\$userName\AppData\Roaming\nvm\nvm.exe",
      "Users\$userName\AppData\Local\nvm\nvm.exe",
      'Program Files\nvm\nvm.exe',
      'Program Files (x86)\nvm\nvm.exe',
      'nvm\nvm.exe'
    )) {
      $target = [System.IO.Path]::Combine($root, $subPath)
      if (Test-Path $target) { return $target }
    }
  }

  return $null
}

function Invoke-Nvm {
  param([Parameter(ValueFromRemainingArguments = $true)] [string[]]$Args)

  $nvmExe = Get-NvmExecutable
  if (-not $nvmExe) {
    throw "nvm.exe not found in PATH or common install locations"
  }

  $output = & $nvmExe @Args 2>&1
  $exitCode = $LASTEXITCODE
  return [pscustomobject]@{ ExitCode = $exitCode; Output = $output }
}

# -------- 通过 nvm 安装/切换 Node 版本 --------
function Install-NodeViaNvm {
  param([string]$Version)

  Write-Note "尝试加载 nvm..."

  $nvmLoaded = Load-Nvm
  if (-not $nvmLoaded) {
    Write-Note "未能加载 nvm，跳过 nvm 方式。"
    return $false
  }

  $nvmExe = Get-NvmExecutable
  if (-not $nvmExe) {
    Write-Note "nvm.exe 仍不可用，跳过"
    return $false
  }

  Write-Note "nvm 已就绪，优先尝试切到 Node v$Version"

  Remove-StaleNodePathsFromPath
  if ($env:NVM_SYMLINK) { $env:Path = "$env:NVM_SYMLINK;$env:Path" }
  if ($env:NVM_HOME) { $env:Path = "$env:NVM_HOME;$env:Path" }

  $nvmListResult = Invoke-Nvm list
  $nvmList = ($nvmListResult.Output | Out-String)
  Write-Debug "当前 nvm 版本列表: $nvmList"

  # nvm list 输出无 v 前缀，例如 22.19.0，不是 v22.19.0
  $targetInstalled = $nvmList -match ([regex]::Escape($Version))

  if (-not $targetInstalled) {
    Write-Note "目标版本 v$Version 尚未安装，先安装再切换"
    $installResult = Invoke-Nvm install $Version
    if ($installResult.ExitCode -ne 0) {
      Write-Note "nvm install $Version 失败"
      return $false
    }
  } else {
    Write-Note "已在 nvm 中发现 v$Version，直接切换"
  }

  $useResult = Invoke-Nvm use $Version
  if ($useResult.ExitCode -ne 0) {
    Write-Note "nvm use $Version 失败，重新安装并再试一次"
    $installRetry = Invoke-Nvm install $Version
    if ($installRetry.ExitCode -ne 0) {
      Write-Note "重新安装 v$Version 失败"
      return $false
    }

    $useRetry = Invoke-Nvm use $Version
    if ($useRetry.ExitCode -ne 0) {
      Write-Note "重新切换到 v$Version 仍然失败"
      return $false
    }
  }

  $resolvedNode = Ensure-CurrentNodeFromNvm -Version $Version
  if (-not $resolvedNode) {
    if ($env:NVM_SYMLINK) { $env:Path = "$env:NVM_SYMLINK;$env:Path" }
    if ($env:NVM_HOME) { $env:Path = "$env:NVM_HOME;$env:Path" }
    Remove-StaleNodePathsFromPath
  }

  if (-not (Test-Command node)) {
    if ($resolvedNode -and (Test-Path $resolvedNode)) {
      $nodeDir = Split-Path $resolvedNode
      $env:Path = "$nodeDir;$env:Path"
    }
  }

  if (-not (Test-Command node)) {
    Write-Note "切换后 node 命令不可用"
    return $false
  }

  $nodeVer = node -v
  if ($nodeVer -ne "v$Version") {
    if ($resolvedNode -and (Test-Path $resolvedNode)) {
      $nodeVer = & $resolvedNode -v
    }
    if ($nodeVer -ne "v$Version") {
      Write-Note "切换后 Node 版本是 $nodeVer，不是目标版本 v$Version"
      return $false
    }
  }

  if (-not (Test-NodeVersion $nodeVer)) {
    Write-Note "切换后 Node 版本 $nodeVer 仍不满足要求"
    return $false
  }

  Write-Ok "成功切换到 Node $nodeVer"
  return $true
}

# 主逻辑：先尝试当前 node，不满足则依次尝试 nvm -> winget
if ((Test-Command node) -and (Test-NodeVersion (node -v))) {
  Write-Ok "已安装 Node $(node -v)"
} else {
  $current = if (Test-Command node) { "版本 $(node -v) 过旧" } else { '未安装' }
  Write-Note "$current（需要 22.19 以上或 24 以上）"

  # 第一优先：nvm
  if (Install-NodeViaNvm -Version "22.19.0") {
    Write-Ok "通过 nvm 安装/切换到 Node $(node -v)"
  }
  # 第二优先：winget
  elseif (Test-Command winget) {
    Write-Note '正在通过 winget 安装 Node.js LTS'
    winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    Update-SessionPath
    if (-not (Test-Command node)) { Stop-Setup '安装后仍找不到 node，请重开窗口再试' }
    if (-not (Test-NodeVersion (node -v))) { Stop-Setup "安装得到 Node $(node -v)，不满足要求" }
    Write-Ok "已安装 Node $(node -v)"
  }
  # 都没有
  else {
    Stop-Setup '没有 nvm 也没有 winget，请到 https://nodejs.org 下载 Node.js v22.19.0+ 或 v24+ 安装包后重试'
  }
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

Write-Step 4 '构建'
if (-not $Rebuild -and (Test-Path 'apps/cli/lib/bin.js') -and (Test-Path 'apps/web/dist/index.html')) {
  Write-Ok '产物已存在，跳过（-Rebuild 可强制重建）'
} else {
  Write-Note '首次构建需要数分钟'
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