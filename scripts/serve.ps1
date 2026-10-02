# Windows 下把服务作为独立进程稳定启动（不依赖当前命令会话/终端）。
#
# 为什么不用 Start-Process / 直接前台运行：
#   PowerShell/命令会话结束时会把整棵进程树终止（job/树式清理）。Start-Process 的
#   子进程属于该会话树，会话一结束进程就被杀——表现正是“短暂监听后退出、无异常栈、无日志”。
#   WMI Win32_Process.Create 创建的进程不属于任何命令会话树，因此常驻。
#
# 日志：stdout/stderr 重定向到 server.log；进程内未捕获异常/未处理拒绝会先写明日志
# 再优雅退出（见 src/index.ts 的 uncaughtException / unhandledRejection / exit 处理）。
# 被外部强杀（任务管理器/树终止）时进程本身无法记录——那属于启动机制问题，不是代码问题。
#
# 幂等：若端口监听者已是本服务（命令行含 dist/src/index.js 且 health 200），报“已在运行”。
# 本脚本不在 PowerShell 变量里保存 token（token 只经 node 读出用于 HTTP 头）。
#
# 注意：本文件含中文注释，必须以 UTF-8 with BOM 保存——Windows PowerShell 5.1
# 对无 BOM 的 UTF-8 会按本地 ANSI(GBK) 解码，中文注释变成乱码字节后 param()
# 的默认值会在解析中被破坏（实测 $Log 变为空字符串，重定向目标拼出空文件名）。
param([string]$Log = "server.log")

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$logAbs = Join-Path $root $Log
if (-not (Test-Path (Join-Path $root "dist\src\index.js"))) {
  throw "dist/src/index.js 不存在：请先在项目根目录运行 npm run build"
}
if (-not (Test-Path (Join-Path $root "config.json"))) {
  throw "config.json 不存在：请先 npm run token 生成 token 并配置 bind/port"
}

# 端口经 scripts/read-config.js 读取（与 src/config.ts 同一规则），规避 PowerShell
# 在部分会话上下文下 Get-Content/ConvertFrom-Json 读到空对象的问题。
$port = [int](node (Join-Path $root "scripts\read-config.js") (Join-Path $root "config.json") port)

function Get-ListenerPid {
  param([int]$Port)
  $line = ((netstat -ano | Select-String ":$Port " | Select-String "LISTENING") | Select-Object -First 1).Line
  if (-not $line) { return $null }
  return ($line -split '\s+')[-1].Trim()
}

function Test-OurService {
  param([int]$Port)
  # 判据：端口有监听者；监听者命令行含我们的入口（排除 PI-Desktop 等同端口服务）
  $lp = Get-ListenerPid -Port $Port
  if (-not $lp) { return $false }
  if ("$lp" -notmatch '^\d+$') { return $false }
  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $lp" -ErrorAction Stop
    if (-not $proc) { return $false }
    if ($proc.CommandLine -notlike "*index.js*") { return $false }
  } catch { return $false }
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

if (Test-OurService -Port $port) {
  Write-Output ("already running on port " + $port + " (listener pid=" + (Get-ListenerPid -Port $port) + ") - nothing to do")
  exit 0
}

$cmdLine = "cmd /c title palmdock && cd /d `"$root`" && node dist/src/index.js >> `"$logAbs`" 2>&1"
$m = ([wmiclass]"Win32_Process").Create($cmdLine)
if ($m.ReturnValue -ne 0) {
  throw "WMI 启动失败，ReturnValue=$($m.ReturnValue)"
}
$pidLaunched = $m.ProcessId
Write-Output ("launched independent pid=$pidLaunched (WMI, 不属于命令会话树)")

$ready = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-OurService -Port $port) { $ready = $true; break }
}
if ($ready) {
  Write-Output ("running ok: port " + $port + " /api/health -> 200 (listener pid=" + (Get-ListenerPid -Port $port) + ")")
  exit 0
}
Write-Output "10 秒内服务未就绪（端口 $port）。退出码 1；失败原因见 $logAbs（含异常栈与 exit 码）"
exit 1
