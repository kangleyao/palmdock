# 掌坞 Android 壳（palmdock-shell）

让「掌坞」的提醒真正送到手机：一个全屏 WebView（就是原来的手机页面）+ 一个前台看护服务。页面切后台/锁屏时 SSE 会断、HTTP 明文又拿不到系统通知权限——这个壳用原生前台服务每 15 秒轮询公开 API，状态变化时用系统通知把它们推给你。

## 它是什么 / 不是什么

- **它只是一个新客户端**：只用服务端现有的公开 API（`Authorization: Bearer <token>`、`GET /api/sessions?limit=20`、`GET /api/sessions/:id`、页面路由 `/session.html?id=`），**公共层一个字节没动**。
- 不是新适配器、不开新接口、不改服务端。
- 口令来自页面配对后写入 localStorage 的 `agb_token`，壳只读取出（`evaluateJavascript("localStorage.getItem('agb_token')")`），存进应用私有 SharedPreferences。口令不进日志、不显示（设置页只显示「已配对 / 未配对」）。

## 结构

```
android-shell/
  AndroidManifest.xml         包名 com.agant.shell / minSdk 24 / targetSdk 34 / cleartext
  src/com/agant/shell/
    MainActivity.java         全屏 WebView；返回键走网页历史；配对后读 token 启动看护；通知深链
    SettingsActivity.java     设置一屏：服务器地址 / 测试通知 / 通知权限 / 电池优化 / 开机自启 / 配对状态
    WatchService.java         前台服务（START_STICKY、静默常驻通知、唤醒锁、onTaskRemoved 自启）
    SessionPoller.java        轮询 + 基线检测 + 去重 + 通知组装
    BootReceiver.java         开机按开关恢复看护
    ShellPrefs.java           私有偏好（地址/口令/开关/状态/已通知集合）
    PageClient.java           页面事件代理（只读 localStorage）
  res/                        strings / 设置页布局 / 通知小图标 / 启动图标
  tools/icon-gen.js           启动图标生成（纯 Node，无第三方依赖）
  build.ps1                   构建脚本（见下）
  .gitignore                  build/ dist/ .local/ 不入版本库
```

## 打包

要求：JDK 21（keytool/javac）+ Android SDK 的构建工具（已指定固定路径，可在 `build.ps1` 参数里改）。

```powershell
cd android-shell
.\build.ps1
```

流程（全部本地、无 Gradle、无公网、无新增依赖）：
`aapt2 compile → aapt2 link（base.apk + R.java）→ javac --release 11 → d8 → 合并 classes.dex → zipalign → apksigner sign → verify`

输出：`android-shell/dist/palmdock-shell.apk`。

签名：首次运行自动用 keytool 生成自签证书（RSA 2048，10 年）放 `.local/agb.keystore`；口令随机生成（纯字母数字）存 `.local/.keystore-pass``.local/ 已 gitignore，永不打印、不写进被提交的文件。也可用 `-KeyStorePass` 参数或 `$AGB_KS_PASS` 环境变量传入自己的口令。

### 一个工具链坑（已绕过）

本机 build-tools 34.0.0 的 d8（8.2.2-dev）对**匿名内部类**必崩（NPE `String.length()`，最小复现：一个匿名 Runnable）。所以本项目的 Java 源码不用匿名内部类：
- 页面事件 → `PageClient`（命名类，单独文件）；
- 轮询循环 → 方法引用（`this::onWatchTick`，编译为 invokedynamic，没有额外 class 文件）；
- 命名嵌套类（如 `SessionPoller.Sess`）与 lambda 正常。

## 装到手机

- **数据线**：`adb install -r dist/palmdock-shell.apk`（手机需开 USB 调试）。
- **浏览器下载**：把 apk 传到手机可访问的地方（微信/网盘/U 盘）点击安装；首次安装需在系统设置允许「安装未知来源应用」。
- 装好后图标名为「掌坞」。

## 首次配置

1. 首次打开若未填服务器地址，App 会直接进入「设置」；在「服务器地址」填电脑跑服务的局域网地址（如 `http://192.168.x.x:8812`；手机与电脑须在同一 Wi-Fi）。
2. 回主界面，像以前一样完成页面**配对**（输入口令）。
3. 配对成功后壳自动启动看护服务（设置页显示「已配对」）。
4. Android 13+ 在设置里点「请求通知权限」，并按需点「忽略电池优化」、开「开机自启」。

## 提醒规则

- 看护服务每 15 秒拉取会话列表；**首次拉取只建基线，绝不把历史当新消息播一遍**。
- 之后仅当某会话 `lastTurnStatus` 从进行中（pending/streaming/awaiting_answer/answered）变为：
  - `succeeded` → 「AI 完成了」（正文取详情里 `result` 的 `summary → message → text → assistantText`，截 120 字）；
  - `failed` → 「AI 出错了」；
  - `awaiting_answer` → 「AI 在等你回答」。
- 同一 `(sessionId, lastTurnAt, status)` 只通知一次（持久化集合，重启不重播）。
- 网络失败 / 401 不误报，只记日志并在设置页显示「看护状态：连接异常」。
- 通知标题 = 该会话首轮消息前 20 字；点击通知直接打开该会话页。

## 已知限制

- **未在真机验证**（ utmost：本机无 Android 设备；仅做了构建、签名校验、badging/xmltree 核对与服务端 API 只读冒烟）。装上后的实际提醒表现需要你在真机上确认。
- 必须与电脑**在同一 Wi-Fi**：壳直接连局域网地址；**不做公网推送/穿透**。
- 后台稳定依赖系统不杀进程：**建议加电池白名单**（设置里有按钮）；`onTaskRemoved`/`START_STICKY` 只是尽力自启，国产 ROM 的后台管理可能仍杀。
- 明文 HTTP：`usesCleartextTraffic` 是因为服务端是 HTTP；系统通知/前台服务在明文下可用，但流量不加密——仅限可信局域网。
- 15 秒轮询间隔是体验与电量的折中；前台服务常驻一条静默通知（「正在盯着 AI 的进度」），Ongoing 不可划掉（Android 前台服务机制）。
- 图标只有 mdpi 一档（48×48），高密度屏会放大；启动器无自适应图标。
- 卸载残留：除系统通知外无外部存储写入；卸载即清理私有数据，无残留目录。
- 检测的是**轮询时刻观测到的状态变化**：两次轮询之间完成又重开（例如 15 秒内 pending→succeeded→新一轮 pending）可能被漏报；新出现的会话（没观测到进行过程）不通知（保守策略）。
