# 跨网接入：Cloudflare Tunnel（固定域名）

**状态：本文件是配置说明与安全前提，不是实际配置。** 本文档仅为说明，未创建隧道、未修改任何
Cloudflare 账号/路由/防火墙，也未运行 cloudflared。真实跨网测试待用户方便时完成（见文末"验收步骤"）。

## 为什么选固定域名隧道

- 底座只监听本机/局域网，**不自己实现穿透、中继，也不要求 VPS**。
- Cloudflare Tunnel（cloudflared）在电脑上以**出站**方式连到 Cloudflare 边缘，电脑不需要公网 IP、
  不需要在防火墙开放入站端口；用户持有固定的子域名（如 `my-base.example.com`）。
- 手机只用浏览器，不需要装任何客户端（Tailscale 方案要求两端装客户端，用户已选择不采用）。

## 两条独立的安全层（务必都配）

1. **TLS 层（Cloudflare 提供）**：手机到 Cloudflare 边缘是 HTTPS。
   本地局域网明文模式（`bind=lan`）的“token 与数据在链路明文”这一限制在隧道模式下被 TLS 解决。
2. **应用鉴权层（底座自己）**：**隧道不豁免底座的 token 鉴权。** 每个请求仍须带
   `Authorization: Bearer <token>`（token 存自 `config.json` 或 `BASE_TOKEN`）。
   即使隧道域名泄露，没有 token 依然只能收到 401。

可选第三层：Cloudflare Access（零信任），给域名再加邮箱/SSO 校验；手机访问时先过 Access 再到底座。
这是用户侧的 Cloudflare 账户配置，与底座代码无关，本文不替用户操作。

## 配置流程（用户在电脑上操作，全部命令仅供参考，以官方文档为准）

1. 安装 cloudflared（官方下载页）并 `cloudflared login` 授权固定域名。
2. 创建隧道：`cloudflared tunnel create palmdock`（记下隧道 ID 与凭据文件路径）。
3. 写配置文件 `~/.cloudflared/config.yml`：

   ```yaml
   tunnel: <隧道ID>
   credentials-file: /path/to/<隧道ID>.json
   ingress:
     - hostname: my-base.example.com
       service: http://127.0.0.1:8787
     - service: http_status:404
   ```

   底座默认端口 8787（`config.json` 的 `port`），保持 `bind=loopback` 即可——
   cloudflared 本机访问回环足够，**不需要**设 `bind=lan`。
4. 绑定 DNS：`cloudflared tunnel route dns palmdock my-base.example.com`。
5. 启动隧道：`cloudflared tunnel run palmdock`（可注册为系统服务保持常驻）。
6. 手机浏览器打开 `https://my-base.example.com`，在配对卡填访问口令（即底座 token）。

## 凭据与责任边界

| 事项 | 谁负责 |
|---|---|
| Cloudflare 账户、隧道凭据、DNS 记录、Access 策略 | **用户**（底座不生成、不托管） |
| 底座 token（config.json / BASE_TOKEN） | **用户**（`npm run token` 生成；不复用其他用途的密钥） |
| HTTPS 证书 | Cloudflare 边缘自动 |
| 底座应用层鉴权与任务数据 | 底座（已实现） |

## 连接失败处理（不编造诊断）

浏览器拿到的错误只有“连接失败”，**无法**区分 DNS 解析失败、TLS 握手失败、隧道未运行、
服务未启动等具体原因。底座前端因此统一提示并给出排查清单（`public/app.js` 的 `NETWORK_HINTS`）：

- 电脑上服务是否在运行（`npm start`，看到 `[info] 服务已启动`）
- 隧道是否在运行（`cloudflared tunnel run`）
- 域名/端口是否正确
- 手机是否有网络
- 若提示 401：token 是否正确（服务可达但未授权是**可以**与“不可达”区分的——前端 `GET /api/health` 判定可达性）

**不要**向用户报告“DNS 失败”之类无法确认的细节；让用户按清单排查。

## 未实测事项

- 未安装或运行 cloudflared，未创建隧道，未改 DNS/防火墙。
- 真实手机 + 隧道端到端未测试；上述流程为标准用法，实际配置以 Cloudflare 官方文档为准。
- 隧道模式下的延迟与断线行为未测（底座前端有重试与提示，但未实测频率）。

## 待用户回来后的最小验收步骤

1. 电脑：`npm run build && npm start`（确认 `[info] 服务已启动：http://127.0.0.1:8787`）。
2. 配置隧道并启动 cloudflared。
3. 手机：`https://<你的域名>`，填 token；提交一次文本统计与一次目录清单任务。
4. 观察：状态流转、进度消息、结果展示；杀掉服务再启动，验证遗留任务标记为“中断（结果未知）”且不重跑。
5. 手机端断开 Wi-Fi 再连，验证连接横幅出现/消失且任务内容不丢。
