# 把“指向真实 DSH 的底座实例”作为独立进程启动（不影响 8811 主服务）。
#
# 为什么需要独立实例：
#   8811 主服务在 DSH 适配器存在之前就已启动（进程内清单不含 dsh-agent，
#   环境也无 DSH_BASE_URL）。重启 8811 会中断现有任务并动其配置/数据，
#   因此另起一个实例：独立 cwd（dsh-instance/）、独立 config.json、
#   独立 SQLite（dsh-instance/data/）、独立日志，端口 8812。
#
# DSH 指向：DSH_BASE_URL=http://127.0.0.1:3080（用户正式 DSH 内嵌的
#   dsh web，只读回环入口）。本脚本只设置环境变量让适配器在需要时读取；
#   脚本本身、启动过程都不向真实 DSH 发任何写请求（不发 prompt、
#   不 session.create、不 respond、不审批）。
#
# 启动机制与 scripts/serve.ps1 相同：WMI Win32_Process.Create，
#   不属于任何命令会话树，会话结束不被杀；幂等（已在运行则退出 0）。
#
# 注意：本文件含中文注释，必须以 UTF-8 with BOM 保存——Windows PowerShell 5.1
#   对无 BOM 的 UTF-8 会按本地 ANSI(GBK) 解码，中文注释变成乱码字节后 param()
#   的默认值会在解析中被破坏。
param([string]$Log = "dsh-instance.log")

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$inst = Join-Path $root "dsh-instance"
$logAbs = Join-Path $inst $Log
$entry = Join-Path $root "dist\src\index.js"
$instCfg = Join-Path $inst "config.json"

if (-not (Test-Path $entry)) {
  throw "dist/src/index.js 不存在：请先在项目根目录运行 npm run build"
}
if (-not (Test-Path $instCfg)) {
  throw "dsh-instance/config.json 不存在：请先用项目根 config.json 的 token 生成它（见 ADAPTERS.md）"
}

# 端口经 scripts/read-config.js 读取（与 src/config.ts 同一规则），规避 PowerShell
# 在部分会话上下文下 Get-Content/ConvertFrom-Json 读到空对象的问题。
$port = [int](node (Join-Path $root "scripts\read-config.js") $instCfg port)

function Get-ListenerPid {
  param([int]$Port)
  $line = ((netstat -ano | Select-String ":$Port " | Select-String "LISTENING") | Select-Object -First 1).Line
  if (-not $line) { return $null }
  return ($line -split '\s+')[-1].Trim()
}

function Test-OurService {
  param([int]$Port)
  # 判据：端口有监听者；监听者命令行含我们的入口（排除同端口的其他服务）
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

$cmdLine = "cmd /c title palmdock-dsh && set `"DSH_BASE_URL=http://127.0.0.1:3080`" && cd /d `"$inst`" && node `"$entry`" >> `"$logAbs`" 2>&1"
$m = ([wmiclass]"Win32_Process").Create($cmdLine)
if ($m.ReturnValue -ne 0) {
  throw "WMI 启动失败，ReturnValue=$($m.ReturnValue)"
}
$pidLaunched = $m.ProcessId
Write-Output ("launched independent pid=$pidLaunched (WMI, 不属于命令会话树; DSH_BASE_URL -> 127.0.0.1:3080)")

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
