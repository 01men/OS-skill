---
name: dingtalk-robot-oauth
description: 给 Agent/AI 应用绑定钉钉机器人：网页 OAuth 授权识别用户身份（unionId/userId）、服务端推送机器人单聊自动建立会话、用 jumprobot 协议唤起钉钉客户端打开机器人对话窗口。Use when 用户提到 接入/绑定钉钉机器人、给应用加"打开钉钉机器人对话"按钮、钉钉授权登录/识别用户、唤起钉钉客户端、jumprobot、chatbotUserId 获取、batchSendOTO、unionId/userId/openId 区分，或要从网页跳转进钉钉机器人会话。含端到端实测踩坑清单与可直接运行的参考服务实现。
---

# 钉钉机器人跳转授权（端到端实测方案）

一套已完整验证的链路，用于给 Agent/AI 应用做「钉钉身份绑定 + 一键唤起机器人对话」：

```
网页按钮 → 钉钉授权窗口 → code 换 token → 识别 unionId
        → 转企业 userId → 推送机器人单聊（自动建会话+打招呼）
        → 前端 dingtalk://jumprobot 唤起钉钉打开机器人聊天窗口
```

参考实现（Express + axios，3 个依赖，已实测跑通）在 `assets/server-template/`，
可直接复制部署，也可按本文件的 API 规范集成进用户自己的服务。

## 用户身份三层标识（先讲清楚，避免选错主键）

| 标识 | 作用域 | 跨应用唯一 | 用途 |
|------|--------|:---:|------|
| openId | 单应用内 | 否 | 仅当前应用内区分用户 |
| userId | 单企业内 | 否 | 企业通讯录 ID，机器人单聊推送必须用它 |
| **unionId** | 钉钉全局 | **是** | **账号主键**，绑定身份优先落库它 |

## 实施 checklist（按序执行）

1. **准备应用**：开发者后台建「企业内部开发 → 机器人」应用，拿 AppKey/AppSecret。
   逐步操作见 `references/console-setup.md`（含权限申请清单）。
2. **部署服务**：复制 `assets/server-template/`，`npm install`，复制 `.env.example` 为 `.env` 填入凭证。
3. **配置回调**：后台「安全设置 → 重定向URL」填 OAuth 回调地址（本地开发 `http://localhost:3000/api/auth/callback` 实测可用），与 `.env` 的 `DINGTALK_REDIRECT_URI` 逐字一致。
4. **打通 webhook**：机器人消息回调必须公网可达。本地用内网穿透：
   ```bash
   cloudflared tunnel --url http://localhost:3000   # 免登录，输出 https://xxx.trycloudflare.com
   ```
   后台「开发配置 → 消息推送 → HTTP 模式」消息接收地址填 `<公网域名>/api/dingtalk/webhook`。
5. **捕获 chatbotUserId**：在钉钉里搜机器人名，给它发一条消息。服务自动从回调体捕获并持久化到 `.chatbot-user-id`。
   验证：`curl http://localhost:3000/api/chatbot-id`，`chatbotUserId` 非 null 即成功（前端页面有调试面板可直接复制）。
6. **端到端验证**：访问首页 → 点授权 → 成功页应显示 userId 已匹配、机器人消息已推送，且自动唤起钉钉打开机器人窗口，机器人发送了带用户昵称的欢迎消息。

## 核心 API 规范（实测要点标注 ⚠️）

| 步骤 | 接口 | 要点 |
|------|------|------|
| 授权跳转 | `GET https://login.dingtalk.com/oauth2/auth` | 浏览器整页跳转（`window.location.href`）；`scope=openid corpid`、`prompt=consent` |
| 换用户 token | `POST /v1.0/oauth2/userAccessToken` | body `{clientId, clientSecret, code, grantType:'authorization_code'}`；⚠️ code 只能用一次 |
| 用户信息 | `GET /v1.0/contact/users/me` | header `x-acs-dingtalk-access-token` = 用户 token；返回 unionId/openId/nick/mobile |
| 企业 token | `POST /v1.0/oauth2/accessToken` | ⚠️ **只支持 POST + JSON body**，用 GET 会返回 404（本项目实测踩坑） |
| unionId→userId | `POST https://oapi.dingtalk.com/topapi/user/getbyunionid` | query `access_token`=企业 token，body `{unionid}` |
| 推送单聊 | `POST /v1.0/robot/oToMessages/batchSend` | header `x-acs-dingtalk-access-token`=企业 token；`robotCode`=AppKey，`userIds=[userId]`，`msgKey=sampleText`，`msgParam`=JSON 字符串 |
| 唤起机器人窗口 | `dingtalk://dingtalkclient/action/jumprobot?dingtalkid=<chatbotUserId>` | ⚠️ 参数必须 urlencode（ID 含 `$:` 特殊字符）；前端 800ms 延迟自动跳转 + 保留手动按钮 |

## 五个关键坑（都实测踩过，先读再写代码）

1. **企业 accessToken 接口仅 POST**。症状：userId「未匹配」、机器人消息「未推送」，日志出现 404。
   `unionIdToCorpUserId` 和 `pushRobotMessage` 里取 token 都必须 `axios.post` + JSON body。
2. **jumprobot 的 dingtalkid 是机器人的 chatbotUserId**（形如 `$:LWCP_v1:$xxx` 的加密 ID），
   不是 AppKey，无法推导，只能从机器人消息回调获取。也不能用 `sendmsg?dingtalk_id=`（那是打开「人」的聊天窗口）。
3. **OAuth 回调与 webhook 的公网要求不同**：redirect_uri 用 localhost 实测可通过（钉钉允许），
   但消息接收地址必须公网可达，本地开发必须内网穿透。trycloudflare 域名重启会变，变了要回后台更新地址；
   chatbotUserId 一旦捕获落盘就不再依赖隧道。
4. **授权窗口必须整页跳转**，用弹窗/iframe 会被浏览器第三方 Cookie 策略拦截导致授权失败。
5. **Windows 进程残留**：杀掉 npm 后台任务不会杀 node 子进程，端口被占（EADDRINUSE）时
   `netstat -ano | grep :3000` 找 PID，`taskkill //F //PID <pid>`（Git Bash 下双斜杠）。

其余报错（权限不足、redirect 不匹配、invalidStaffIdList、非法授权码等）查 `references/troubleshooting.md`。

## 资源导航

- `assets/server-template/` — 已验证的完整参考实现：OAuth 回调、身份识别、机器人推送、
  webhook 捕获、jumprobot 唤起、成功/失败页渲染、前端授权页（含 chatbotUserId 调试面板）。
- `references/console-setup.md` — 开发者后台逐步配置 + 权限申请 + 内网穿透操作细节。
- `references/troubleshooting.md` — 故障排查表与实测错误案例。

## 安全底线

- AppSecret 只放 `.env`，绝不进代码仓库；生产环境用 HTTPS、校验 `state` 防 CSRF。
- unionId 作账号主键落库，userId 做映射缓存（员工换企业会变）。
