---
name: auth-identity
description: 账号与身份体系模块。当需要为 SaaS/企业应用实现「用户体系 + 多租户组织 + RBAC + 第三方登录（飞书/钉钉/企业微信的网页授权、PC扫码、手机H5、客户端免登）+ 邮箱/手机账号绑定解绑合并 + JWT 会话与租户隔离」时使用本模块。提供完整 ER 模型、DDL、Provider Adapter 抽象、登录时序、安全清单与接入配置表，可直接拷贝集成。
---

# auth-identity · 账号与身份体系模块

## 适用场景

新建 SaaS 产品需要账号体系，或现有产品需要接入飞书/钉钉/企业微信登录、做多租户隔离、做第三方身份绑定合并时，使用本模块。**不要重新设计**，按本文步骤集成。

## 模块文件索引

所有设计文档在 `docs/` 下，集成前先通读 01、03、04：

| 文件 | 内容 | 何时读 |
|---|---|---|
| `docs/01-er-model.md` | 10 张表 ER 图、字段、唯一约束、索引理由 | 建表前必读 |
| `docs/02-ddl.md` | Prisma schema + SQLite 原生 DDL | 直接执行/迁移 |
| `docs/03-identity-provider-adapter.md` | IdentityProviderAdapter 接口 + 三家实现伪代码 | 接登录前必读 |
| `docs/04-login-flows.md` | PC扫码/H5/客户端免登三场景时序 + 状态机 | 写登录流程前必读 |
| `docs/05-binding-merge-rules.md` | 绑定/解绑/合并规则与事务伪代码 | 实现个人中心前读 |
| `docs/06-tenant-resolution.md` | JWT claim 结构与三层租户隔离 | 接网关/中间件前读 |
| `docs/07-security-checklist.md` | 安全合规验收清单 | 上线前逐条过 |
| `docs/08-provider-config-table.md` | 三家后台字段/scope/回调/token 有效期 | 申请平台应用时读 |
| `demo/server.py` | 钉钉登录最小可运行 Demo（Python stdlib 零依赖） | 验证链路时参考 |

## 集成步骤（7 步）

1. **建表**：按 `docs/02-ddl.md` 执行 DDL（或 Prisma migrate）。注意：`user_identity_links` 的核心唯一约束是**部分唯一索引** `uq_identity_link(provider_id, corp_id, provider_user_key) WHERE unlinked_at IS NULL`，ORM 声明式语法表达不了，必须手写迁移 SQL。
2. **配置身份源**：向 `identity_providers` 表插入配置行（字段格式见 `docs/08-provider-config-table.md` 第一节）。secret 必须 envelope 加密后写入 `config_encrypted`，禁止明文。
3. **实现 Adapter**：按 `docs/03` 实现对应平台的 `IdentityProviderAdapter`（`buildAuthorizeUrl / exchangeCode / getUserInfo / normalizeProfile`）。登录主流程与平台无关，只需面向接口编程。平台数值一律以官方 OpenAPI 当前文档为准。
4. **令牌体系**：access_token 15–30min（RS256/ES256，私钥只在身份服务），refresh_token 7d 轮转、只存 SHA-256 哈希、重放即吊销整链。细节按 `docs/06` + `docs/07` 第 3 节。
5. **租户隔离**：网关注入 `X-User-Id / X-Tenant-Id`（剥掉客户端自传的同名头）；业务中间件构造 TenantContext；ORM 层强制注入 `org_id` scope。三层都要做，不允许只信网关。
6. **前端三场景**：按 `docs/04` 时序实现登录页（PC 二维码 / H5 跳转 / 客户端 SDK 免登），未命中身份时凭 pending_ticket 走「绑定已有账号 / 注册新账号 / 拒绝」三分支页面。
7. **验收**：`docs/07-security-checklist.md` 逐条打勾，并演练三个攻击脚本：state 重放、code 重放、refresh_token 重放，确认按预期拒绝并告警。

## 设计红线（违反即集成错误）

- `users` 表**永远不放角色字段**；角色只挂 `organization_members.role_id`，不存在全局角色。
- 同一 `(provider_id, corp_id, provider_user_key)` 只能映射一个 user，靠 DB 唯一约束兜底，**禁止用「先 SELECT 再 INSERT」替代约束**。
- 两个已有业务数据的 user **禁止自动合并**；必须人工确认 + 事务迁移 membership/资源（流程见 `docs/05`）。
- 解绑用户最后一个可用登录方式必须拦截并引导先补登录方式（管理员移除成员除外，需显式确认 + 审计）。
- 封禁、改密、解绑、合并、管理员移除成员 → 必须即时吊销对应 `auth_sessions`。
- 所有第三方平台的有效期/scope/endpoint 数值，**以官方 OpenAPI 为准**；模块文档中的值是归一化抽象基线。

## 快速验证（钉钉 Demo）

```bash
cd demo
cp config.local.json  # 需自行创建，格式：{"clientId","clientSecret","redirectUri","port"}
python server.py      # 打开 http://localhost:3000 扫码验证
```

前置：钉钉开发者后台为该应用登记 `redirectUri`（如 `http://localhost:3000/auth/callback`）。成功标志：页面显示归一化 profile 并写明走了「命中登录」还是「首次注册」分支；二次扫码应走命中分支。

## 技术栈替换

设计无栈依赖。ORM 换成 TypeORM/GORM 时逐字段映射即可，但部分唯一索引仍需手写迁移；SQLite 换 Postgres 最平滑（原生支持部分索引与 UUID）；MySQL 无部分索引，需改用「有效键冗余列」方案（解绑时置空该列）。
