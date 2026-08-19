#!/usr/bin/env bash
# 双击或命令行运行：把本仓库源码连同本插件一起跑起来（macOS/Linux）。
# Windows 用 launch.cmd。
#
# 环境缺什么就装什么：Node（nvm）、pnpm（corepack）、仓库依赖、构建产物，
# 再把本插件挂进 dsh profile 的用户层（install-profile.mjs，不改 upstream），
# 最后启动 Web UI 并打开浏览器。已就绪的步骤直接跳过。
set -uo pipefail

readonly NVM_VERSION=v0.40.3
readonly NODE_INSTALL_MAJOR=24
readonly FIRST_PORT=3080
readonly PROFILE=web
readonly TOTAL=6

launcher_dir=$(cd "$(dirname "$0")" && pwd)
repo_root=$(cd "$launcher_dir/../../../.." && pwd)

step() { printf '\033[1;36m[%s/%s]\033[0m %s\n' "$1" "$TOTAL" "$2"; }
ok() { printf '      \033[32m✓\033[0m %s\n' "$1"; }
note() { printf '      %s\n' "$1"; }

# 双击启动的窗口可能在脚本退出后关闭，出错必须停住让用户看到原因。
die() {
  printf '      \033[31m✗\033[0m %s\n' "$1" >&2
  printf '\n出错了。可把上面的内容截图反馈。\n'
  read -r -p '按回车键关闭…' _
  exit 1
}

[ -f "$repo_root/apps/cli/src/bin.ts" ] || die "在 $repo_root 找不到 apps/cli/src/bin.ts；本脚本需要放在仓库内的 packages/llm/llm-deepseek-web/launcher/ 下"
cd "$repo_root" || die "无法进入 $repo_root"

# 只接受 package.json engines.node 声明的范围：^22.19 || >=24。
node_version_ok() {
  local v major minor rest
  v=${1#v}
  case "$v" in *.*) ;; *) return 1 ;; esac
  major=${v%%.*}
  rest=${v#*.}
  minor=${rest%%.*}
  case "$major" in '' | *[!0-9]*) return 1 ;; esac
  case "$minor" in '' | *[!0-9]*) return 1 ;; esac
  [ "$major" -ge 24 ] && return 0
  { [ "$major" -eq 22 ] && [ "$minor" -ge 19 ]; } && return 0
  return 1
}

self_test() {
  local failures=0 case_ expect
  for case_ in 'v24.14.1:0' 'v25.0.0:0' 'v22.19.0:0' 'v22.30.2:0' 'v22.18.0:1' 'v23.11.0:1' 'v20.11.1:1' 'nonsense:1' 'v22:1'; do
    expect=${case_##*:}
    if node_version_ok "${case_%%:*}"; then [ "$expect" = 0 ] || { echo "node_version_ok ${case_%%:*} 应拒绝" >&2; failures=1; }
    else [ "$expect" = 1 ] || { echo "node_version_ok ${case_%%:*} 应接受" >&2; failures=1; }; fi
  done
  [ "$failures" = 0 ] || exit 1
  echo 'self-test: node_version_ok 全部用例通过'
}

# bash 内建 /dev/tcp 探测，避免依赖 nc/lsof。
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

free_port() {
  local port=$FIRST_PORT
  while port_busy "$port"; do
    port=$((port + 1))
    [ "$port" -lt $((FIRST_PORT + 20)) ] || die "$FIRST_PORT–$((FIRST_PORT + 19)) 全被占用"
  done
  printf '%s' "$port"
}

load_nvm() {
  NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  [ -s "$NVM_DIR/nvm.sh" ] || return 1
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null
  command -v nvm >/dev/null
}

case "${1:-}" in
  --self-test) self_test; exit 0 ;;
  --rebuild) rebuild=1 ;;
  -h | --help)
    cat <<EOF
用法：./launchMac.command [--rebuild|--self-test]

把本仓库源码连同 llm-deepseek-web 插件一起启动，缺失的环境自动安装。
双击本文件即可，无需参数。

  --rebuild    强制重新构建
  --self-test  只跑内部版本判断用例

插件通过 \$DSH_HOME/profiles/$PROFILE 的用户层挂载，不修改仓库内 upstream 文件。
EOF
    exit 0 ;;
esac
rebuild=${rebuild:-0}

step 1 '检查 Node.js 运行环境'
if command -v node >/dev/null && node_version_ok "$(node -v)"; then
  ok "已安装 Node $(node -v)"
else
  current='未安装'
  command -v node >/dev/null && current="版本 $(node -v) 过旧"
  note "$current（需要 22.19 以上或 24 以上）"
  load_nvm || {
    note "正在安装 nvm $NVM_VERSION"
    if command -v curl >/dev/null; then curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | PROFILE=/dev/null bash
    else die '需要 curl；请到 https://nodejs.org 下载 Node.js LTS 安装包后重试'; fi
    load_nvm || die 'nvm 安装后仍不可用'
  }
  note "正在安装 Node $NODE_INSTALL_MAJOR"
  nvm install "$NODE_INSTALL_MAJOR" || die 'Node 安装失败，请检查网络'
  nvm use "$NODE_INSTALL_MAJOR" >/dev/null
  node_version_ok "$(node -v)" || die "安装得到 Node $(node -v)，不满足要求"
  ok "已安装 Node $(node -v)"
fi

step 2 '检查 pnpm'
if command -v pnpm >/dev/null; then
  ok "已安装 pnpm $(pnpm -v)"
else
  want=$(node -p "require('$repo_root/package.json').packageManager")
  # corepack 随 Node 分发，按 packageManager 落地正确版本，无需全局安装。
  corepack enable pnpm >/dev/null 2>&1 || npm install -g "$want" >/dev/null || die "无法安装 $want"
  command -v pnpm >/dev/null || die "安装 $want 后 pnpm 仍不可用"
  ok "已安装 pnpm $(pnpm -v)"
fi

step 3 '安装仓库依赖（已是最新时几乎瞬间完成）'
pnpm install || die 'pnpm install 失败'
ok '依赖就绪'

# 产物「存在」不等于「是最新的」:插件是以 main: lib/index.js 被 Node 加载的,
# 改了 src 却不重建,跑起来仍是旧代码 —— 而进度里却显示成功,最难查。
# 所以判据是时间戳:任一源文件比产物新就重建。find 命中即停,不扫全树。
stale_sources() {
  # 只看 src:tsdown 只打包它,测试文件改动不影响产物,拿它触发全量重建是白等几分钟。
  find packages apps -name node_modules -prune \
    -o -path '*/src/*' -name '*.ts' -newer apps/cli/lib/bin.js -print -quit 2>/dev/null
}

step 4 '构建'
if [ "$rebuild" = 1 ]; then
  note '强制重建'
elif [ ! -f apps/cli/lib/bin.js ] || [ ! -f apps/web/dist/index.html ]; then
  note '尚无构建产物'
elif [ -n "$(stale_sources)" ]; then
  note "源码已改动（$(stale_sources) 等），产物过期，重新构建"
else
  ok '产物是最新的，跳过'
  skip_build=1
fi
if [ "${skip_build:-0}" = 0 ]; then
  note '全量构建需要数分钟'
  pnpm run build || die '构建失败'
  ok '构建完成'
fi

step 5 "把 llm-deepseek-web 挂进 profile：$PROFILE"
node "$launcher_dir/install-profile.mjs" "$PROFILE" || die 'profile 挂载失败'

port=$(free_port)
url="http://127.0.0.1:$port"
step 6 "启动 Web UI：$url"
note '浏览器会自动打开；关掉本窗口即停止服务'

# 后台等端口就绪再开浏览器，主进程留在前台显示日志。
(
  for _ in $(seq 1 180); do
    port_busy "$port" && { open "$url"; exit 0; }
    sleep 1
  done
) &

# `dsh web` 是 `--profile web` 的 alias，且只有它接受 web app 自己的 --port。
pnpm dsh web --port "$port"
status=$?
[ "$status" -eq 0 ] || die "dsh 退出，代码 $status"
