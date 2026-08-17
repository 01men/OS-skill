# 05 · 绑定、解绑与合并规则

> 原则：**数据库唯一约束兜底，业务规则前置拦截，合并永远需要人工确认。**
> 所有规则操作都写 `login_audit_log`（event: bind / unbind / merge / admin_unbind）。

## 规则 1：同一 provider + corp 的 provider_user_key 唯一映射一个 user

落地方式（双保险）：

1. **DB 层**：`uq_identity_link(provider_id, corp_id, provider_user_key) WHERE unlinked_at IS NULL`（见 02）。这是最终防线，任何代码路径都绕不过。
2. **业务层**：写 link 前先查。查到已绑定他人 → 不 INSERT，直接返回结构化错误：

```typescript
class IdentityAlreadyLinkedError extends Error {
  code = 'IDENTITY_ALREADY_LINKED';      // → HTTP 409
  hint = '该第三方身份已绑定其他账号，请登录该账号，或申请人工合并';
}
```

竞态处理：两个请求同时通过业务层查重 → 同时 INSERT → 后写者撞唯一索引 → 捕获 DB 异常转 `IdentityAlreadyLinkedError`。禁止用分布式锁替代约束（锁会漏，约束不会）。

## 规则 2：跨 provider 二次绑定（同一自然人有多个身份源）

场景：用户已用邮箱注册，现在想绑定飞书；或已绑飞书，想再绑企微。

**允许路径**（个人中心发起）：

```typescript
async function bindIdentity(currentUser: User, pendingTicket: PendingTicket) {
  // 前置：必须是已登录态（个人中心内操作），pendingTicket 有效
  assertAuthenticated(currentUser);
  const profile = pendingTicket.profile;

  // 前置：目标第三方身份未绑定任何人
  const existing = await findActiveLink(profile);
  if (existing && existing.userId !== currentUser.id) throw new IdentityAlreadyLinkedError();

  // 写 link（事务），审计 event=bind, actor=user 本人
  await db.tx(async t => {
    await t.userIdentityLink.create({ userId: currentUser.id, ...toLink(profile) });
    await t.loginAuditLog.create({ event: 'bind', userId: currentUser.id, actorType: 'user' });
  });
}
```

**禁止路径——自动合并**：若飞书身份已绑定 user_A，而当前登录的是 user_B，且 A、B 都已有业务数据（membership、文档、订单……），系统**绝不自动合并**。返回 409 并引导人工流程。

**人工合并流程**（唯一允许的合并）：

1. 发起人：user_B 登录态下在 409 页面点「申请合并」，或直接联系管理员/客服。
2. 验证：必须**同时证明对两个账号的控制权**——例如先登录 A 确认一次，再登录 B 确认一次（双向确认），或由企业管理员 + 平台管理员双确认。
3. 确认页面必须展示不可回滚的后果清单：保留哪个 user、另一个 user 将被注销（软删）、哪些资源将迁移。
4. 迁移事务（伪代码）：

```typescript
async function mergeUsers(survivorId: string, mergedId: string, operator: Actor) {
  await db.tx(async t => {
    // 1. 迁移身份链接（先软删旧 link 再挂到 survivor，避免撞部分唯一索引中间态）
    await t.userIdentityLink.updateMany(
      { userId: mergedId }, { userId: survivorId, unlinkedAt: null });

    // 2. 迁移组织成员关系：同一 org 两边都有 → 保留权限高者，删另一条；
    //    只在 merged 侧的 → 改挂 survivor
    await migrateMemberships(t, mergedId, survivorId);

    // 3. 迁移业务资源所有权 —— 由产品侧注册 hook，本模块只定契约
    await runMergeHooks(t, mergedId, survivorId);
    //    例: docs.ownerId、orders.creatorId、approval.initiatorId ...

    // 4. 吊销 merged 用户全部会话，软删 merged 用户
    await t.authSession.updateMany({ userId: mergedId },
      { revokedAt: now(), revokeReason: 'merged' });
    await t.user.update({ id: mergedId }, { deletedAt: now(), status: 'disabled' });

    // 5. 审计：detail_json 记录迁移明细（哪些表、多少行）
    await t.loginAuditLog.create({ event: 'merge', userId: survivorId,
      actorType: operator.type, actorId: operator.id,
      detailJson: { mergedUserId: mergedId, migrated: report } });
  });
}
```

要点：合并事务可能很大，业务资源多的产品应把 `runMergeHooks` 拆成「同步迁核心表 + 异步任务迁大表」，并在合并后给 merged user 保留 30 天只读墓碑页（可选）。

## 规则 3：解绑最后一个身份源的保护

**约束：任何时刻，user 必须至少保留一种可用登录方式。**

可用登录方式计数 = 有效第三方 link 数 + （已验证邮箱且有密码？1:0） + （已验证手机？1:0）。

```typescript
async function unbindIdentity(user: User, linkId: string) {
  const link = await findActiveLinkById(linkId);
  if (!link || link.userId !== user.id) throw new NotFoundError();

  const ways = await countLoginMethods(user.id);   // 见上
  if (ways <= 1) {
    throw new LastLoginMethodError(                 // → HTTP 422
      '这是您唯一的登录方式，解绑后将无法登录。请先设置密码或绑定其他账号。');
  }

  await db.tx(async t => {
    await t.userIdentityLink.update({ id: linkId }, { unlinkedAt: now() });  // 软解绑
    // 若解绑的是「当前正在用的登录方式」，吊销对应会话见 07；此处保守吊销该 user 全部会话
    await t.authSession.updateMany({ userId: user.id, revokedAt: null },
      { revokedAt: now(), revokeReason: 'identity_unbound' });
    await t.loginAuditLog.create({ event: 'unbind', userId: user.id, actorType: 'user' });
  });
}
```

注意：email/phone 也是身份源（identity_providers type=email/phone），「改密码」「换绑手机」复用同一计数逻辑，换绑手机本质是 解绑旧 phone link + 绑新 phone link，同样受本规则保护。

## 规则 4：企业管理员后台管理成员身份

**权限**：需要该 org 内角色含 `member:manage` 权限（owner/admin 预置角色默认含）。管理员**只能操作自己 org 的成员**，不能跨 org——校验链：管理员的 JWT tenant_id == 目标成员的 org_id。

能力清单：

| 操作 | 说明 | 审计 |
|---|---|---|
| 查看成员身份列表 | `GET /orgs/{org}/members/{userId}/identities` 返回有效/已解绑 link 及 provider 信息 | 不写（读操作） |
| 解绑成员某身份 | `DELETE /orgs/{org}/members/{userId}/identities/{linkId}` | event=`admin_unbind`, actorType=admin, actorId=管理员 |
| 禁用成员 | 置 member.status=disabled + 吊销该成员会话 | event=`revoke` |

管理员解绑的规则差异：

- 同样受「规则 3」保护？——**不**。管理员解散成员时可以解绑最后一个身份（等于把此人清出体系），但必须**显式确认**（前端二次确认文案），且审计 detail 记录 `lastMethod: true`。业务上这等价于「移除成员」，建议直接提供「移除成员」操作，内部串行执行：解绑全部 link → 删 member 记录 → 吊销会话 → 审计。
- 管理员**不能**代成员绑定（绑定需要本人持第三方授权 code，管理员拿不到）。

## 规则决策速查

| 场景 | 结果 |
|---|---|
| 第三方身份首次出现 | 注册分支或绑定分支，用户自选 |
| 身份已绑他人，当前用户想绑 | 409，禁止自动合并，走人工合并 |
| 两 user 都有数据，确认合并 | 人工确认 + 事务迁移 + merged 软删 |
| 解绑非最后身份源 | 允许，软删，吊销会话 |
| 解绑最后身份源（本人） | 拒绝，引导先加登录方式 |
| 管理员移除成员 | 允许全解绑，显式确认，完整审计 |
