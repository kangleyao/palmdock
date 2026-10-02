#Requires -Version 5.1
<#
  掌坞 Android 壳构建脚本（无 Gradle、无公网、纯本地工具链 + JDK）。
  流程：aapt2 compile -> aapt2 link（base.apk + R.java）-> javac -> d8 -> 合并 dex -> zipalign -> apksigner sign
  签名口令只经参数或环境变量传入；首次运行自动生成自签证书（放 .local/，不入版本库），口令落盘到 .local/.keystore-pass（同目录已 gitignore）。
  口令绝不打印、不写入任何被提交的文件。
  用法：
    $env:ANDROID_SDK = "<Android SDK 目录>"; .\build.ps1
    .\build.ps1 -AndroidJar "<SDK>\platforms\android-34\android.jar" -BuildTools "<SDK>\build-tools\34.0.0"
    $AGB_KS_PASS="xxx"; .\build.ps1
    .\build.ps1 -KeyStorePass "xxx"
#>
param(
    [string]$AndroidJar,
    [string]$BuildTools,
    [string]$KeyStorePass,
    [string]$KeyAlias = "agb"
)

# native 工具会把成功信息写到 stderr（keytool 等），Stop 会误终止；改用逐条检查退出码
$ErrorActionPreference = "Continue"
$root = $PSScriptRoot
# ---- Android SDK 路径：参数显式优先，其次环境变量 ANDROID_SDK；都没有则明确报错 ----
if ([string]::IsNullOrEmpty($AndroidJar) -and -not [string]::IsNullOrEmpty($env:ANDROID_SDK)) {
    $AndroidJar = Join-Path $env:ANDROID_SDK "platforms\android-34\android.jar"
}
if ([string]::IsNullOrEmpty($BuildTools) -and -not [string]::IsNullOrEmpty($env:ANDROID_SDK)) {
    $BuildTools = Join-Path $env:ANDROID_SDK "build-tools\34.0.0"
}
if ([string]::IsNullOrEmpty($AndroidJar) -or [string]::IsNullOrEmpty($BuildTools)) {
    Write-Host "未提供 Android SDK 路径，请任选一种方式：" -ForegroundColor Yellow
    Write-Host "  设环境变量：`$env:ANDROID_SDK = '<Android SDK 目录>'" -ForegroundColor Yellow
    Write-Host "  或显式传参：.\build.ps1 -AndroidJar '<SDK>\platforms\android-34\android.jar' -BuildTools '<SDK>\build-tools\34.0.0'" -ForegroundColor Yellow
    throw "缺少 Android SDK 路径（-AndroidJar / -BuildTools / 环境变量 ANDROID_SDK）"
}


$aapt2 = Join-Path $BuildTools "aapt2.exe"
$d8 = Join-Path $BuildTools "d8.bat"
$zipalign = Join-Path $BuildTools "zipalign.exe"
$apksigner = Join-Path $BuildTools "apksigner.bat"
$keystore = Join-Path $root ".local\agb.keystore"
$passFile = Join-Path $root ".local\.keystore-pass"

$srcDir = Join-Path $root "src"
$resDir = Join-Path $root "res"
$buildDir = Join-Path $root "build"
$genDir = Join-Path $buildDir "gen"
$classDir = Join-Path $buildDir "classes"
$dexDir = Join-Path $buildDir "dex"
$distDir = Join-Path $root "dist"

function Check-Tool($p, $name) {
    if (-not (Test-Path $p)) { throw "找不到 $name : $p" }
}

Write-Host "==> 预检工具链"
Check-Tool $AndroidJar "android.jar"
Check-Tool $aapt2 "aapt2"
Check-Tool $d8 "d8"
Check-Tool $zipalign "zipalign"
Check-Tool $apksigner "apksigner"

# ---- 口令：参数 > 环境变量 > .local/.keystore-pass；都没有则随机生成一次 ----
$ksPass = $KeyStorePass
if ([string]::IsNullOrEmpty($ksPass)) { $ksPass = $env:AGB_KS_PASS }
$localDir = Join-Path $root ".local"
if ([string]::IsNullOrEmpty($ksPass)) {
    if (Test-Path $passFile) {
        $ksPass = [System.IO.File]::ReadAllText($passFile).Trim()
    } else {
        # 纯字母数字口令：+ / = 等字符穿过 apksigner.bat 的参数链会被打碎
        $alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".ToCharArray()
        $crypto = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
        $one = New-Object byte[] 1
        $buf = New-Object System.Text.StringBuilder
        while ($buf.Length -lt 40) {
            $crypto.GetBytes($one)
            if ($one[0] -lt 248) { [void]$buf.Append($alphabet[$one[0] % 62]) }
        }
        $ksPass = $buf.ToString()
        New-Item -ItemType Directory -Force -Path $localDir | Out-Null
        [System.IO.File]::WriteAllText($passFile, $ksPass) # 纯 ASCII、无 BOM、无换行
    }
}
if ([string]::IsNullOrEmpty($ksPass)) { throw "口令为空" }

# ---- 证书（只此一次） ----
if (-not (Test-Path $keystore)) {
    Write-Host "==> 生成自签证书（.local/agb.keystore）"
    New-Item -ItemType Directory -Force -Path $localDir | Out-Null
    & keytool -genkeypair -alias $KeyAlias -keyalg RSA -keysize 2048 -validity 3650 `
        -keystore $keystore -storepass $ksPass -keypass $ksPass `
        -dname "CN=AI Base Shell, O=palmdock-shell, C=CN" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "keytool 生成证书失败" }
}

# ---- 清理 ----
Write-Host "==> 清理中间产物"
if (Test-Path $buildDir) { Remove-Item $buildDir -Recurse -Force }
if (Test-Path $distDir) { Remove-Item $distDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $genDir | Out-Null
New-Item -ItemType Directory -Force -Path $classDir | Out-Null
New-Item -ItemType Directory -Force -Path $dexDir | Out-Null
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

# ---- 1. aapt2 compile ----
$resZip = Join-Path $buildDir "res.zip"
Write-Host "==> aapt2 compile"
& $aapt2 compile --dir $resDir -o $resZip
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile 失败" }

# ---- 2. aapt2 link ----
$baseApk = Join-Path $buildDir "base.apk"
$manifest = Join-Path $root "AndroidManifest.xml"
Write-Host "==> aapt2 link"
& $aapt2 link --manifest $manifest -I $AndroidJar --java $genDir `
    --min-sdk-version 24 --target-sdk-version 34 -o $baseApk $resZip
if ($LASTEXITCODE -ne 0) { throw "aapt2 link 失败" }

# ---- 3. javac ----
Write-Host "==> javac"
$rjava = Get-ChildItem -Path $genDir -Recurse -Filter "R.java" | Select-Object -First 1
if ($rjava -eq $null) { throw "未生成 R.java" }
$srcFiles = @($rjava.FullName)
$srcFiles += Get-ChildItem -Path $srcDir -Recurse -Filter "*.java" | ForEach-Object { $_.FullName }
& javac --release 11 -implicit:none -encoding UTF-8 -classpath $AndroidJar -d $classDir $srcFiles
if ($LASTEXITCODE -ne 0) { throw "javac 失败" }

# ---- 4. d8 ----
$dexFile = Join-Path $dexDir "classes.dex"
Write-Host "==> d8"
$classFiles = Get-ChildItem -Path $classDir -Recurse -Filter "*.class" | ForEach-Object { $_.FullName }
& $d8 --release --min-api 24 --lib $AndroidJar --output $dexDir $classFiles
if ($LASTEXITCODE -ne 0) { throw "d8 失败" }
if (-not (Test-Path $dexFile)) { throw "未生成 classes.dex" }

# ---- 5. 合并 dex 进 base.apk ----
$mergedApk = Join-Path $buildDir "merged.apk"
Write-Host "==> 合并 dex"
Copy-Item $baseApk $mergedApk -Force
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$fs = [System.IO.File]::Open($mergedApk, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite)
try {
    $zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Update)
    try {
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $dexFile, "classes.dex", [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    } finally {
        $zip.Dispose()
    }
} finally {
    $fs.Dispose()
}

# 校验 dex 确实进入了 apk
$hasDex = $false
$probe = [System.IO.File]::OpenRead($mergedApk)
try {
    $zipR = New-Object System.IO.Compression.ZipArchive($probe, [System.IO.Compression.ZipArchiveMode]::Read)
    try {
        for ($e = 0; $e -lt $zipR.Entries.Count; $e++) {
            if ($zipR.Entries[$e].FullName -eq "classes.dex") { $hasDex = $true; break }
        }
    } finally { $zipR.Dispose() }
} finally { $probe.Dispose() }
if (-not $hasDex) { throw "classes.dex 未合并进 APK" }

# ---- 6. zipalign ----
$alignedApk = Join-Path $buildDir "aligned.apk"
Write-Host "==> zipalign"
& $zipalign -f 4 $mergedApk $alignedApk
if ($LASTEXITCODE -ne 0) { throw "zipalign 失败" }

# ---- 7. apksigner sign ----
$finalApk = Join-Path $distDir "palmdock-shell.apk"
Write-Host "==> apksigner sign"
& $apksigner sign --ks $keystore --ks-key-alias $KeyAlias `
    --ks-pass "pass:$ksPass" --key-pass "pass:$ksPass" `
    --out $finalApk $alignedApk
if ($LASTEXITCODE -ne 0) { throw "apksigner sign 失败" }

# ---- 8. 校验与信息 ----
Write-Host "==> apksigner verify --print-certs"
& $apksigner verify --print-certs $finalApk
if ($LASTEXITCODE -ne 0) { throw "apksigner verify 失败（签名未通过）" }

Write-Host "==> aapt2 dump badging"
& $aapt2 dump badging $finalApk

$info = Get-Item $finalApk
$hash = (Get-FileHash $finalApk -Algorithm SHA256).Hash
Write-Host "==> 完成"
Write-Host ("APK: " + $info.FullName)
Write-Host ("bytes: " + $info.Length)
Write-Host ("SHA256: " + $hash)
Write-Host "exit 0"
