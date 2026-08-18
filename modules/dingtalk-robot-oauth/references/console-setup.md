# 钉钉开发者后台配置（实测版）

入口：https://open-dev.dingtalk.com （需管理员或开发者账号登录）

## 1. 创建应用

1. **应用开发 → 企业内部开发 → 创建应用**，选择「机器人」类型。
2. 记录「凭证与基础信息」中的 **AppKey / AppSecret**（AppKey 同时是 robotCode）。
3. 上传机器人头像、设置名称（钉钉客户端里搜这个名字找到机器人）。

## 2. 申请权限（权限管理）

| 权限 | 用途 |
|------|------|
| `Contact.User.Read`（获取用户信息） | OAuth 后调 `/contact/users/me` 拿 unionId/nick |
| 企业内机器人发送消息权限（机器人类） | `batchSendOTO` 推单聊 |
| 通讯录读取相关权限 | `topapi/user/getbyunionid` 换 userId（若报权限错误在此补） |

注意：授权 scope 必须含 `openid`，否则用户信息接口报 `AccessTokenPermissionDenied`。

## 3. 安全设置 → 重定向URL

- 填 OAuth 回调地址，**必须与 `.env` 的 `DINGTALK_REDIRECT_URI` 逐字一致**（协议/域名/端口/路径全对）。
- 本地开发 `http://localhost:3000/api/auth/callback` 实测可通过，不需要内网穿透。

## 4. 开发配置 → 消息推送（捕获 chatbotUserId 的关键）

1. 消息接收模式选 **HTTP 模式**。
2. 消息接收地址填公网可达的 webhook：`https://<公网域名>/api/dingtalk/webhook`。
3. 本地开发先起隧道（见下节），把隧道域名填进去。
4. 保存后在钉钉客户端搜机器人名，发一条消息触发回调，服务端自动捕获 `chatbotUserId` 存入 `.chatbot-user-id` 文件。

## 5. 版本发布

企业内部应用搜索不到机器人时：**版本管理与发布 → 创建版本并发布**，发布后企业内可见。

## 6. 内网穿透（webhook 公网可达）

推荐 cloudflared（免注册免登录）：

```bash
# Windows：下载 cloudflared-windows-amd64.exe 后
./cloudflared.exe tunnel --url http://localhost:3000
# 输出形如 https://enabling-together-wholesale-derived.trycloudflare.com
# 用 curl -s -o /dev/null -w "%{http_code}" <域名>/ 验证返回 200
```

- trycloudflare 免费域名**每次重启都会变**，变了要回后台更新消息接收地址。
- chatbotUserId 捕获一次即落盘持久化，之后唤起不再依赖隧道（只有持续接收消息才需要）。
- 备选：ngrok（需注册拿 token）、frp（需自备服务器）。
