# 04 · 终端场景时序与登录状态机

> 三个场景的前段各不相同，**尾部完全共用**：`code → 服务端换身份 → 查 user_identity_links → 命中登录 / 未命中三分支`。
> pending_ticket：未命中时签发的短期（10min）一次性凭证，只承载归一化 profile，**不是登录态**，用于走完「绑定/注册」流程后换取正式 token。

## 场景一：PC 网页扫码

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户(PC浏览器)
    participant FE as 我方前端(登录页)
    participant BE as 我方后端
    participant P as 身份平台(飞书/钉钉/企微)
    participant M as 用户手机(App)

    U->>FE: 打开登录页(未登录)
    FE->>BE: POST /auth/qr-session 申请扫码会话
    BE->>BE: 生成 qr_session_id + state，存 Redis(TTL 5min)
    BE-->>FE: {qr_session_id, authorizeUrl}
    FE->>FE: 渲染二维码(官方JS组件或自绘authorizeUrl)
    FE->>BE: 轮询/long-poll: GET /auth/qr-session/{id} (携带qr_session_id)

    U->>M: 用飞书/钉钉/企微 App 扫码
    M->>P: 确认授权
    P-->>M: 生成 code
    M->>BE: 跳转/回调 redirect_uri?code=..&state=.. (App内打开我方回调页)
    BE->>BE: verifyState(state) → 定位 qr_session
    Note over BE: —— 共用尾部，见下 ——
    BE-->>M: 手机端展示「扫码成功，请回 PC 继续」
    BE-->>FE: 轮询返回 {status: pending_bind | logged_in, ticket | tokens}
    FE->>FE: 命中→存token进入应用；未命中→跳「绑定/注册」页(携 pending_ticket)
```

要点：
- 二维码有两种渲染方式（平台 JS 组件内嵌 vs 自绘授权 URL 二维码），对后端无差别，后端只认回调 code。
- 轮询建议 long-poll（30s 超时）或 WebSocket；纯短轮询给 `/auth/qr-session` 加限流。
- qr_session 五状态：`waiting → scanned(可选) → confirmed | expired | consumed`，code 兑换成功后置 consumed，防重放。

## 场景二：手机 H5 授权页

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户(手机浏览器)
    participant FE as 我方H5前端
    participant BE as 我方后端
    participant P as 身份平台授权页

    U->>FE: 打开 H5 应用(未登录)
    FE->>BE: GET /auth/authorize-url?provider=feishu&scene=h5
    BE->>BE: 生成 state 存 Redis(TTL 10min, 绑定入口会话)
    BE-->>FE: authorizeUrl
    FE->>P: 302 跳转 authorizeUrl
    U->>P: 授权页点「同意」(已在App登录态下可能静默通过)
    P-->>U: 302 回 redirect_uri?code=..&state=..
    U->>BE: GET /auth/callback?code=..&state=..
    BE->>BE: verifyState(state)
    Note over BE,P: —— 共用尾部：exchangeCode → getUserInfo → normalizeProfile → 查 link ——
    alt 命中 user_identity_links
        BE-->>FE: 302 回 H5 首页，Set-Cookie/回参带 tokens
    else 未命中
        BE-->>FE: 302 到 /onboarding?ticket=pending_ticket
        FE->>U: 展示「绑定已有账号 / 注册新账号 / 拒绝」
    end
```

要点：H5 与 PC 跳转授权本质同一链路，只是入口在移动端；state 必须绑定发起会话（cookie/sessionId），回调时校验，防登录 CSRF。

## 场景三：客户端内打开链接（免登）

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户(App内)
    participant FE as 我方前端(App Webview)
    participant SDK as 平台JS-SDK
    participant BE as 我方后端
    participant P as 平台服务端

    U->>FE: 在飞书/钉钉/企微内打开应用链接(未登录)
    FE->>SDK: 初始化(需企业签名: corpId+agentId+timestamp+sign)
    SDK->>P: 校验签名
    FE->>SDK: requestAuthCode() 请求免登授权码
    SDK-->>FE: authCode (无用户交互，静默)
    FE->>BE: POST /auth/exchange {provider, scene:in_app, code: authCode}
    Note over BE,P: —— 共用尾部：exchangeCode → 查 link ——
    alt 命中
        BE-->>FE: {access_token, refresh_token, user, tenant}
    else 未命中
        BE-->>FE: {pending_ticket} → 前端走绑定/注册页
    end
```

要点：
- 免登场景**无跳转、无二维码**，前端 JS-SDK 直接拿 authCode——`buildAuthorizeUrl` 在此场景返回 null，前端走 SDK 路径。
- 钉钉 in_app 的 code 兑换通道与网页 OAuth2 **不同**（见 03 差异表），Adapter 内部按 scene 分流。
- SDK 签名所需 secret 绝不进前端，由后端 `/auth/js-signature` 按需签发。

## 共用尾部：身份决策状态机

```mermaid
stateDiagram-v2
    [*] --> Anonymous : 未登录
    Anonymous --> CodeReceived : 三种场景任一拿到 code
    CodeReceived --> IdentityResolved : exchangeCode+getUserInfo+normalizeProfile
    IdentityResolved --> LookupLink : 查 user_identity_links(provider, corp_id, provider_user_key)

    LookupLink --> Authenticated : 命中有效 link
    LookupLink --> PendingChoice : 未命中 → 签发 pending_ticket(10min 一次性)

    Authenticated --> SessionIssued : 签发 access(15-30min)+refresh(7d), 建 auth_sessions, 写审计
    SessionIssued --> [*]

    PendingChoice --> BindExisting : 选择「绑定已有账号」
    PendingChoice --> RegisterNew  : 选择「注册新账号」
    PendingChoice --> Rejected     : 选择「拒绝」或 ticket 过期

    BindExisting --> VerifyCredential : 输入邮箱/手机+密码 或 OTP 验证
    VerifyCredential --> ConflictCheck : 凭证通过
    ConflictCheck --> LinkCreated : 该第三方身份未被他人绑定 → 写 link(事务内)
    ConflictCheck --> BindConflict : 已被绑定 → 409, 提示人工合并入口
    LinkCreated --> Authenticated

    RegisterNew --> UserCreated : 创建 user(+默认组织/加入邀请组织) + 写 link(同一事务)
    UserCreated --> Authenticated

    BindConflict --> [*] : 走人工合并流程(见 05)
    Rejected --> [*] : 写审计 login_reject, 不放行
```

### 状态机落地规则

1. **命中即登录**：`LookupLink → Authenticated` 之间要做两项校验——user.status 必须 active；若 link 所在 corp 配置了「仅组织成员可登录」，校验该 user 在对应 org 有 active member 记录。
2. **pending_ticket 是一次性的**：绑定或注册任一完成后即作废；TTL 10min；承载内容仅为归一化 profile + provider 三元组，签 JWT（短密钥，独立密钥对，与正式 token 密钥分离）。
3. **LinkCreated / UserCreated 必须在单事务内完成**：建 link 撞唯一约束（并发同身份）时整个事务回滚，转 BindConflict。
4. **每个终态都写 login_audit_log**：成功、失败、拒绝、冲突各一条，字段见 01。
5. **「拒绝」分支不是删数据**：只是不发令牌。用户的第三方授权关系在平台侧，我方不主动调平台解绑 API（平台差异大且无必要）。
