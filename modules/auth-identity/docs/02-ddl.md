# 02 · DDL（Prisma schema + SQLite 原生）

> 与 `01-er-model.md` 一一对应。Prisma 为主交付（可迁移到 Postgres/MySQL），SQLite DDL 供嵌入式/演示环境直接使用。
> SQLite 注意：连接后必须 `PRAGMA foreign_keys = ON;`（默认关闭）；时间用 TEXT 存 ISO8601；布尔用 INTEGER 0/1。

## Prisma schema

```prisma
// schema.prisma —— 账号与身份体系模块
generator client { provider = "prisma-client-js" }
datasource db { provider = "sqlite" url = env("DATABASE_URL") }
// 换 Postgres: provider = "postgresql"，下述 TEXT/Boolean/DateTime 语义不变

model User {
  id              String   @id @default(uuid())
  email           String?
  emailVerifiedAt DateTime?
  phone           String?
  phoneVerifiedAt DateTime?
  passwordHash    String?  // Argon2id；纯第三方注册用户可空
  displayName     String
  avatarUrl       String?
  status          String   @default("active") // active|disabled|pending
  lastLoginAt     DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  deletedAt       DateTime?

  memberships  OrganizationMember[]
  identityLinks UserIdentityLink[]
  sessions      AuthSession[]
  auditLogs     LoginAuditLog[]

  @@index([email])
  @@index([phone])
  @@map("users")
}

model Organization {
  id        String   @id @default(uuid())
  name      String
  slug      String   @unique // 子域名/URL 租户解析
  plan      String   @default("free")
  status    String   @default("active") // active|suspended
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  deletedAt DateTime?

  members OrganizationMember[]
  roles   Role[]

  @@map("organizations")
}

model OrganizationMember {
  id       String   @id @default(uuid())
  orgId    String
  userId   String
  roleId   String
  status   String   @default("active") // active|invited|disabled
  joinedAt DateTime @default(now())
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  org  Organization @relation(fields: [orgId], references: [id])
  user User         @relation(fields: [userId], references: [id])
  role Role         @relation(fields: [roleId], references: [id])

  @@unique([orgId, userId])       // 一人一组织一条记录
  @@index([userId])               // 「我加入的组织」
  @@index([orgId, status])        // 成员列表
  @@map("organization_members")
}

model Role {
  id        String   @id @default(uuid())
  orgId     String
  code      String   // owner|admin|member|custom_*
  name      String
  isSystem  Boolean  @default(false) // 系统预置不可删
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  org         Organization         @relation(fields: [orgId], references: [id])
  members     OrganizationMember[]
  permissions RolePermission[]

  @@unique([orgId, code])
  @@map("roles")
}

model Permission {
  id          String @id @default(uuid())
  code        String @unique // resource:action
  description String?

  roles RolePermission[]

  @@map("permissions")
}

model RolePermission {
  roleId       String
  permissionId String

  role       Role       @relation(fields: [roleId], references: [id])
  permission Permission @relation(fields: [permissionId], references: [id])

  @@id([roleId, permissionId])
  @@map("role_permissions")
}

model IdentityProvider {
  id              String   @id @default(uuid())
  type            String   // feishu|dingtalk|wecom|email|phone
  corpId          String   @default("") // 飞书 tenant_key / 钉钉·企微 corpId；内置源为空串
  displayName     String
  configEncrypted String   // envelope 加密的 JSON：appId/appSecret/agentId/...
  enabled         Boolean  @default(true)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  links UserIdentityLink[]

  @@unique([type, corpId]) // 同一企业同一平台只配置一次
  @@index([enabled])
  @@map("identity_providers")
}

model UserIdentityLink {
  id              String    @id @default(uuid())
  userId          String
  providerId      String
  corpId          String    @default("") // 冗余 provider.corpId，参与唯一键
  providerUserKey String    // normalizeProfile 输出：open_id / unionid / userid / email / phone
  unionId         String?   // 跨应用自然人标识
  profileJson     String?   // name/email/avatar 快照
  linkedAt        DateTime  @default(now())
  unlinkedAt      DateTime? // 软解绑
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  user     User             @relation(fields: [userId], references: [id])
  provider IdentityProvider @relation(fields: [providerId], references: [id])

  // 注意：软删场景的唯一约束必须用「部分唯一索引」，Prisma 不支持，
  // 由迁移 SQL 补充（见下方 SQLite DDL 的 uq_identity_link）。
  @@index([userId, unlinkedAt])
  @@index([unionId])
  @@index([providerId, corpId, providerUserKey]) // 查询加速；唯一性见迁移 SQL
  @@map("user_identity_links")
}

model AuthSession {
  id                String    @id @default(uuid())
  userId            String
  orgId             String?   // 签发时的租户上下文
  refreshTokenHash  String    // SHA-256，不存明文
  refreshGeneration Int       @default(0)
  deviceInfo        String?
  ip                String?
  issuedAt          DateTime  @default(now())
  expiresAt         DateTime
  revokedAt         DateTime?
  revokeReason      String?

  user User @relation(fields: [userId], references: [id])

  @@index([userId, revokedAt])
  @@index([refreshTokenHash])
  @@map("auth_sessions")
}

model LoginAuditLog {
  id           String   @id @default(uuid())
  userId       String?  // 登录失败可能无 user
  orgId        String?
  actorType    String   @default("user") // user|admin|system
  actorId      String?  // actorType=admin 时为操作管理员
  event        String   // login_success|login_fail|bind|unbind|merge|token_refresh|revoke|register
  providerType String?
  ip           String?
  userAgent    String?
  detailJson   String?
  createdAt    DateTime @default(now())

  user User? @relation(fields: [userId], references: [id])

  @@index([userId, createdAt])
  @@index([orgId, createdAt])
  @@index([ip, createdAt])
  @@map("login_audit_log")
}
```

### 迁移时补充的部分唯一索引（Prisma 表达不了，写进 migration SQL）

```sql
-- 软解绑兼容的唯一约束：有效绑定期间 (provider, corp, key) 唯一
CREATE UNIQUE INDEX uq_identity_link
  ON user_identity_links(provider_id, corp_id, provider_user_key)
  WHERE unlinked_at IS NULL;
```

## SQLite 原生 DDL（等价物，可直接 `sqlite3 app.db < schema.sql`）

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT,
  email_verified_at TEXT,
  phone             TEXT,
  phone_verified_at TEXT,
  password_hash     TEXT,
  display_name      TEXT NOT NULL,
  avatar_url        TEXT,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','disabled','pending')),
  last_login_at     TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at        TEXT
);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_phone ON users(phone);

CREATE TABLE organizations (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  plan       TEXT NOT NULL DEFAULT 'free',
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);

CREATE TABLE roles (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id),
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  is_system  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, code)
);

CREATE TABLE organization_members (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organizations(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  role_id    TEXT NOT NULL REFERENCES roles(id),
  status     TEXT NOT NULL DEFAULT 'active'
             CHECK (status IN ('active','invited','disabled')),
  joined_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (org_id, user_id)
);
CREATE INDEX idx_members_user   ON organization_members(user_id);
CREATE INDEX idx_members_org    ON organization_members(org_id, status);

CREATE TABLE permissions (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE role_permissions (
  role_id       TEXT NOT NULL REFERENCES roles(id),
  permission_id TEXT NOT NULL REFERENCES permissions(id),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE identity_providers (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL
                   CHECK (type IN ('feishu','dingtalk','wecom','email','phone')),
  corp_id          TEXT NOT NULL DEFAULT '',
  display_name     TEXT NOT NULL,
  config_encrypted TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (type, corp_id)
);
CREATE INDEX idx_providers_enabled ON identity_providers(enabled);

CREATE TABLE user_identity_links (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  provider_id       TEXT NOT NULL REFERENCES identity_providers(id),
  corp_id           TEXT NOT NULL DEFAULT '',
  provider_user_key TEXT NOT NULL,
  union_id          TEXT,
  profile_json      TEXT,
  linked_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unlinked_at       TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- 核心唯一约束（部分索引，兼容软解绑后重复绑定）
CREATE UNIQUE INDEX uq_identity_link
  ON user_identity_links(provider_id, corp_id, provider_user_key)
  WHERE unlinked_at IS NULL;
CREATE INDEX idx_links_user  ON user_identity_links(user_id) WHERE unlinked_at IS NULL;
CREATE INDEX idx_links_union ON user_identity_links(union_id);

CREATE TABLE auth_sessions (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id),
  org_id             TEXT,
  refresh_token_hash TEXT NOT NULL,
  refresh_generation INTEGER NOT NULL DEFAULT 0,
  device_info        TEXT,
  ip                 TEXT,
  issued_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at         TEXT NOT NULL,
  revoked_at         TEXT,
  revoke_reason      TEXT
);
CREATE INDEX idx_sessions_user ON auth_sessions(user_id, revoked_at);
CREATE INDEX idx_sessions_hash ON auth_sessions(refresh_token_hash);

CREATE TABLE login_audit_log (
  id            TEXT PRIMARY KEY,
  user_id       TEXT REFERENCES users(id),
  org_id        TEXT,
  actor_type    TEXT NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','admin','system')),
  actor_id      TEXT,
  event         TEXT NOT NULL,
  provider_type TEXT,
  ip            TEXT,
  user_agent    TEXT,
  detail_json   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_user ON login_audit_log(user_id, created_at);
CREATE INDEX idx_audit_org  ON login_audit_log(org_id, created_at);
CREATE INDEX idx_audit_ip   ON login_audit_log(ip, created_at);
```

## 换库/换 ORM 的注意事项

- **Postgres**：部分唯一索引语法相同；`TEXT` 可换 `UUID` 原生类型 + `TIMESTAMPTZ`。
- **TypeORM / GORM**：按上表逐字段映射即可，唯一要记住的是 `uq_identity_link` 部分索引必须手写迁移，ORM 声明式语法普遍表达不了 `WHERE unlinked_at IS NULL`。
- **并发首次登录**：依赖 `uq_identity_link` 让第二个并发 INSERT 抛唯一冲突，应用层捕获后转为「该第三方身份已被绑定」错误。**不要**用「先 SELECT 再 INSERT」代替约束，竞态挡不住。
