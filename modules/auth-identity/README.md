# 账号与身份体系模块（Auth & Identity Module）

> AI Agent 请直接读取 [SKILL.md](SKILL.md)（含集成步骤、设计红线与验收清单）。

标准、可复用、插件化的 B2B SaaS 账号与身份体系设计。新 SaaS 产品拷贝本模块，通过配置即可接入 **飞书 / 钉钉 / 企业微信** 的四种登录形态（网页授权 / PC 扫码 / 手机 H5 / 客户端内免登），并支持与已有邮箱/手机账号的绑定、解绑、合并。

## 文档导航（按设计交付顺序）

| 序号 | 文档 | 内容 |
|---|---|---|
| 01 | [docs/01-er-model.md](docs/01-er-model.md) | 数据模型：10 张表的 ER 图（mermaid）、字段、唯一约束、索引理由 |
| 02 | [docs/02-ddl.md](docs/02-ddl.md) | Prisma schema + SQLite 原生 DDL，含部分唯一索引迁移 SQL |
| 03 | [docs/03-identity-provider-adapter.md](docs/03-identity-provider-adapter.md) | IdentityProviderAdapter 统一接口 + 三家实现伪代码与差异点 |
| 04 | [docs/04-login-flows.md](docs/04-login-flows.md) | 三个终端场景时序图 + 命中/未命中三分支状态机 |
| 05 | [docs/05-binding-merge-rules.md](docs/05-binding-merge-rules.md) | 绑定/解绑/合并规则（含人工合并事务、最后身份源保护、管理员后台） |
| 06 | [docs/06-tenant-resolution.md](docs/06-tenant-resolution.md) | JWT claim（tenant_id+role）、网关/中间件/ORM 三层租户隔离 |
| 07 | [docs/07-security-checklist.md](docs/07-security-checklist.md) | 安全与合规清单（可验收条款） |
| 08 | [docs/08-provider-config-table.md](docs/08-provider-config-table.md) | 三家接入配置表：后台字段、scope、回调、token 有效期 |

## 新 SaaS 产品复用步骤

1. **拷模型**：按 02 建表（Prisma migrate 或直接执行 SQLite DDL），注意补 `uq_identity_link` 部分唯一索引。
2. **配身份源**：在 `identity_providers` 插入配置行（字段见 08 第一节），secret 必须走 07 的 envelope 加密。
3. **接 Adapter**：拷贝/实现 03 的 `IdentityProviderAdapter`；登录主流程代码与 provider 无关，无需改动。
4. **接令牌体系**：签发/校验/轮转/吊销逻辑按 06 + 07 第 3 节实现；网关注入 `X-User-Id / X-Tenant-Id`。
5. **接租户隔离**：业务服务启用 06 的 TenantContext 中间件 + ORM scope extension。
6. **接前端**：登录页三场景组件（二维码/跳转/SDK 免登）按 04 时序实现；「绑定/注册/拒绝」页接 pending_ticket。
7. **过安全清单**：07 逐条验收，演练三个攻击脚本（state 重放 / code 重放 / refresh 重放）。

## 技术栈替换点

设计对技术栈无硬依赖，替换时只需关注：

| 假设栈 | 替换为 | 影响 |
|---|---|---|
| NestJS | Python(FastAPI/Django) | 中间件/Guard 换成 middleware/decorator；AsyncLocalStorage 换 contextvars |
| Prisma | TypeORM / GORM | 模型逐字段映射即可；**部分唯一索引必须手写迁移 SQL**（ORM 普遍表达不了） |
| SQLite | Postgres/MySQL | Postgres 直接支持部分索引与 UUID 原生类型，最平滑；MySQL 无部分索引，需用「有效键」冗余列方案 |
| React | Vue | 仅登录页三场景组件，后端无感 |

## 设计红线（不可违反）

- users 表**永远不放角色字段**；角色只挂 organization_members。
- `user_identity_links(provider_id, corp_id, provider_user_key)` 有效行唯一，DB 约束兜底，不允许「先查后插」替代。
- 两个已有数据的 user **禁止自动合并**，必须人工确认 + 事务迁移。
- 解绑最后一个登录方式必须拦截（本人操作）；管理员移除成员除外但需显式确认。
- refresh_token 可轮转、可吊销、只存哈希；access_token ≤30min。
- 所有平台相关数值（有效期/scope/endpoint）**以官方 OpenAPI 为准**，文档中的是归一化抽象基线。
