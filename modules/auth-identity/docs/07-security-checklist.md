# 07 · 安全与合规清单

> 逐条可落地、可验收。每条给出「措施 + 验收方式」。上线前逐条打勾。

## 1. 凭证与密钥

- [ ] **provider secret 加密落库**：`identity_providers.config_encrypted` 用 envelope 加密——数据密钥（DEK）随机生成、AES-256-GCM 加密配置 JSON，DEK 由主密钥（KEK，存 KMS/环境变量注入）加密后随行存储。验收：DB dump 中任何位置搜不到明文 AppSecret。
- [ ] **密码 Argon2id 哈希**（m=64MB, t=3, p=4 起步），禁止 MD5/SHA1/裸 SHA-256。验收：users 表抽查哈希前缀 `$argon2id$`。
- [ ] **refresh_token 只存 SHA-256 哈希**于 auth_sessions。验收：泄库演练，确认无法用 DB 数据伪造刷新。
- [ ] **JWT 私钥只在身份服务**，其他服务持公钥验签；密钥支持 kid 轮换。验收：网关容器内无私钥文件。

## 2. OAuth 流程防护

- [ ] **state 防 CSRF**：随机 ≥128bit，存 Redis（TTL 10min），绑定发起会话（cookie/sessionId 指纹）；回调时校验存在 + 会话匹配 + **消费即删**（一次性）。验收：重放同一 state 第二次必失败；跨浏览器携带合法 state 必失败。
- [ ] **code 单次消费**：除平台自身单次性外，我方侧 Redis `SET code:{hash} 1 NX EX 600` 兜底，防平台端实现缺陷或中间转发重放。验收：同 code 二次提交返回 400。
- [ ] **redirect_uri 白名单**：`identity_providers` 配置中登记合法回调域，授权请求逐一匹配，拒绝未登记 URI（防开放重定向）。验收：篡改 redirect_uri 到外部域名，请求被拒。
- [ ] **PKCE**：H5/纯前端场景强制 S256；服务端换 code 统一带 PKCE verifier。企微/钉钉部分链路不支持 PKCE 的，以 state+白名单兜底并在配置表标注。

## 3. 令牌生命周期

- [ ] **access_token 15–30min**（默认 20min），过期不续，只能 refresh。
- [ ] **refresh_token 7d，每次使用即轮转**：旧 token 立即作废（generation+1，旧哈希标记 consumed），新 token 下发。验收：连续用同一 refresh_token 两次，第二次 401。
- [ ] **重放检测**：收到「能对上历史某代但非当前代」的 refresh_token → 判定令牌泄露 → **吊销该会话整条链** + 告警 + 审计 event=`revoke` reason=`replay_detected`。这是 RFC 6819 推荐的标准做法。
- [ ] **即时失效触发器**（以下事件 → 吊销该 user 全部或相关会话）：

| 事件 | 吊销范围 | 说明 |
|---|---|---|
| 封禁（user.status=disabled） | 全部会话 | 网关校验 status 双保险 |
| 改密/重置密码 | 全部会话 | 改密后强制重新登录 |
| 解绑身份 | 全部会话（保守）或按 device | 见 05 规则 3 |
| 管理员移除成员 | 该 user 全部会话 | |
| 合并账号 | merged user 全部会话 | |
| 用户主动「退出所有设备」 | 全部会话 | 个人中心功能 |

  验收：改密后旧 refresh_token 立即 401；已签发未过期 access_token 在最坏 30min 内自然死亡（或网关开 sid 吊销检查即时死亡，二选一写进产品安全基线）。

## 4. 审计

- [ ] `login_audit_log` **只追加不更新**，覆盖事件：login_success / login_fail / register / bind / unbind / admin_unbind / merge / token_refresh / revoke。
- [ ] 每条必带：user_id（可空）、org_id、actor_type/actor_id、provider_type、ip、user_agent、created_at、detail_json。
- [ ] 保留期 ≥ 180 天（等保/客户审计常规要求），冷热分离归档。
- [ ] 个人中心向用户展示「我的登录历史」（最近 N 条：时间/IP/设备/方式）。

## 5. 限流与风控

| 接口 | 限流规则（建议起步值） |
|---|---|
| /auth/authorize-url, /auth/qr-session | IP 20 次/min |
| /auth/callback, /auth/exchange | IP 30 次/min；code 错误同 IP 10 次/min 封 10min |
| 密码登录 | 账号 5 次/15min 失败锁定 15min + IP 维度 50 次/h |
| 短信/邮件 OTP 发送 | 同号 1 次/min、5 次/h；同 IP 20 次/h（防短信轰炸） |
| refresh | sid 维度 10 次/min（正常客户端 20min 一次，超限即异常） |

- [ ] **异常登录告警**规则（命中任一 → 通知用户 + 记录）：
  - 异地登录：本次登录 IP 的地理归属与该 user 近 30 天常用归属地不同（市级）；
  - 异常时段 + 新设备指纹组合；
  - 同 IP 短时间尝试多个账号（撞库特征，>10 个账号/h）；
  - refresh_token 重放（见 3，属最高危，直接吊销+告警）。
- [ ] 告警通道可配置（邮件/Webhook），模板内置。

## 6. 传输与存储通用项

- [ ] 全链路 HTTPS；HSTS；回调域名校验证书。
- [ ] Cookie 态令牌（如 H5 场景选 Cookie 存储）：`HttpOnly; Secure; SameSite=Lax`。
- [ ] 审计与 profile 快照中的手机号/邮箱在日志输出层脱敏（`138****1234`）。
- [ ] 错误信息对外不泄露内部状态：「该第三方身份已绑定」可以说，「该 user 的 email 是 x@y.com」不能说。
- [ ] 依赖扫描（npm audit / pip-audit）进 CI；JWT 库锁定算法白名单（禁 `alg=none`，禁 RS/HS 混淆）。

## 上线验收流程建议

1. 本清单逐条过，每条指定负责人签字；
2. 演练三个攻击脚本：state 重放、code 重放、refresh 重放，确认按预期拒绝并告警；
3. 演练「改密 → 旧会话全死」与「封禁 → 全死」两个即时失效场景。
