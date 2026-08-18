# 故障排查（含实测案例）

## 实测踩过的坑

### 1. 企业 accessToken 接口返回 404
- **症状**：成功页「企业内 userId 未匹配」「机器人消息未推送」，服务日志 `[unionId 转 userId 失败]: Request failed with status code 404`。
- **原因**：`https://api.dingtalk.com/v1.0/oauth2/accessToken` 只支持 **POST + JSON body** `{appKey, appSecret}`，用 GET 带 query 参数返回 404。
- **修复**：所有取企业 token 的地方改为 `axios.post(url, {appKey, appSecret}, {headers:{'Content-Type':'application/json'}})`。

### 2. 唤起后打开的是网页/人的聊天窗，而非机器人窗口
- 必须用 `dingtalk://dingtalkclient/action/jumprobot?dingtalkid=<chatbotUserId>`，且 `chatbotUserId`（`$:LWCP_v1:$xxx`）正确、已 urlencode。
- `sendmsg?dingtalk_id=` 是打开「人」的窗口协议，不适用机器人。
- dingtalkid 填 AppKey 无效——加密 ID 无法推导，只能从回调拿。

### 3. 提示「尚未配置机器人的 chatbotUserId」
- 回调链路未通。依次检查：消息接收地址是否填了公网域名 + `/api/dingtalk/webhook`、隧道是否存活（curl 域名验证 200）、是否真的给机器人发过消息。
- 已发过消息但 `/api/chatbot-id` 返回 null：看服务日志有无 `[回调捕获]`；有捕获记录但查不到，检查 `.chatbot-user-id` 文件是否被删、`.env` 的 `DINGTALK_CHATBOT_USER_ID` 是否误填了空格。
- 优先级：`.env` 配置 > 自动捕获文件。

### 4. 刷新授权回调页报「不合法的临时授权码」
- `invalidParameter.authCode.notFound`：code 一次性，已消费。重新从首页走授权即可，正常现象。

### 5. Windows 重启服务报 EADDRINUSE
- 杀 npm 后台任务不会连带杀 node 子进程。`netstat -ano | grep :3000` 找 PID，
  Git Bash 下 `taskkill //F //PID <pid>`。新进程起不来时先确认旧进程已清理。

### 6. 授权窗口打开即失败
- 用了弹窗/iframe：第三方 Cookie 策略拦截。必须整页跳转 `window.location.href`。

## 常见报错速查

| 报错 | 原因 / 解决 |
|------|-----------|
| redirect_uri 不匹配 | 后台「安全设置-重定向URL」与 `.env` 必须逐字一致 |
| `AccessTokenPermissionDenied` | 未申请 `Contact.User.Read`，或授权 scope 缺 `openid` |
| `invalidStaffIdList`（batchSendOTO） | userId 不对：确认用户在企业通讯录内、应用有通讯录权限、unionId→userId 转换成功 |
| unionId→userId 报权限错误 | 后台补通讯录读取权限；并确认取企业 token 用的是 POST（见坑 1） |
| 唤起钉钉无反应 | 未装钉钉客户端 / 未允许网页跳转 / PC 端需钉钉 7.1+ |
| 隧道域名失效 | trycloudflare 重启即换域名，回后台更新消息接收地址 |

## 验证用接口（参考实现自带）

```bash
curl http://localhost:3000/api/chatbot-id
# {"chatbotUserId":"$:LWCP_v1:$...","lastCallback":{...}}  非 null 即捕获成功
# lastCallback 含 senderNick/senderStaffId/text 等，可核对发消息的用户
```
