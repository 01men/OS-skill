# 03 · 统一抽象接口 IdentityProviderAdapter

> 设计目标：登录主流程**只面向本接口编程**，不感知飞书/钉钉/企微差异；新增身份源 = 新增一个 Adapter 实现 + `identity_providers` 插一行配置。
>
> ⚠️ **以官方 OpenAPI 为准，下面是归一化抽象。** 文中 endpoint、字段名、有效期数值来自三家公开文档的常见版本，接入时必须按当前官方文档复核（三家 API 均有改版历史）。

## 接口定义（TypeScript 伪代码）

```typescript
/** 登录场景：四种形态归一为三类 */
type Scene = 'web_qr'   // PC 网页扫码（二维码内嵌在我方登录页）
           | 'h5'       // 手机浏览器 H5 授权页跳转
           | 'in_app';  // 飞书/钉钉/企微客户端内打开（免登，无跳转）

/** 归一化后的自然人档案——全模块只认这个结构 */
interface NormalizedProfile {
  providerUserId: string;  // 平台侧用户唯一键，落到 user_identity_links.provider_user_key
  unionId?: string;        // 跨应用/跨企业同人标识（有则填）
  name: string;
  email?: string;
  phone?: string;
  avatar?: string;
  corpId: string;          // 该用户所属企业标识，落到 user_identity_links.corp_id
}

/** code 换到的令牌包裹——各家的 user_access_token 结构差异被封在这里 */
interface ProviderTokenSet {
  accessToken: string;        // 用于调 getUserInfo
  refreshToken?: string;      // 有的平台给、有的不给
  expiresIn: number;          // 秒
  raw: unknown;               // 原始响应留档（审计/排障）
}

interface IdentityProviderAdapter {
  readonly type: 'feishu' | 'dingtalk' | 'wecom';

  /**
   * 构造授权跳转 URL 或二维码内容。
   * - h5:    返回完整 302 目标 URL
   * - web_qr:返回二维码承载的 URL（前端用官方 JS 组件渲染为二维码，或自绘）
   * - in_app:多数平台不走 URL，走 JS-SDK 取 authCode；此场景可返回 null，
   *          由前端 SDK 直接拿 code 后调 /auth/exchange
   */
  buildAuthorizeUrl(scene: Scene, state: string, redirectUri: string): Promise<string | null>;

  /** code → 平台侧令牌。code 必须单次消费，失败/过期抛 ProviderAuthError */
  exchangeCode(code: string): Promise<ProviderTokenSet>;

  /** 平台令牌 → 平台原始档案（各家结构完全不同） */
  getUserInfo(token: ProviderTokenSet): Promise<unknown>;

  /** 平台原始档案 → 归一化档案。这是三家差异的最终收敛点 */
  normalizeProfile(raw: unknown): NormalizedProfile;
}
```

主流程伪代码（与场景无关的共用尾部）：

```typescript
async function handleCallback(provider: IdentityProviderAdapter, code: string, state: string) {
  verifyState(state);                                // 防 CSRF，见 07
  const tokenSet = await provider.exchangeCode(code);
  const raw      = await provider.getUserInfo(tokenSet);
  const profile  = provider.normalizeProfile(raw);   // → {providerUserId, corpId, ...}

  const link = await db.userIdentityLink.findActive({
    providerType: provider.type, corpId: profile.corpId, key: profile.providerUserId,
  });

  if (link) return issueTokens(link.user);           // 命中 → 登录
  return issuePendingTicket(profile);                // 未命中 → 绑定/注册/拒绝分支，见 04
}
```

## 三家实现与差异点

### 飞书（Feishu / Lark）

```typescript
class FeishuAdapter implements IdentityProviderAdapter {
  type = 'feishu';

  async buildAuthorizeUrl(scene, state, redirectUri) {
    // h5 / PC 跳转：统一一个 authorize 地址，飞书按 UA 自动渲染扫码或授权页
    return `https://accounts.feishu.cn/open-apis/authen/v1/authorize`
         + `?app_id=${cfg.appId}&redirect_uri=${encode(redirectUri)}&state=${state}`;
    // web_qr 场景也可用此 URL 由飞书页面自带扫码；in_app 场景走前端 JS-SDK 取 code
  }

  async exchangeCode(code) {
    // 第一步：app_id + app_secret → app_access_token（应用级，需缓存复用）
    const appToken = await this.cachedAppToken();   // POST /open-apis/auth/v3/app_access_token/internal
    // 第二步：code + app_access_token → user_access_token
    const r = await POST('/open-apis/authen/v1/oidc/access_token', {
      grant_type: 'authorization_code', code,
    }, { Authorization: `Bearer ${appToken}` });
    return { accessToken: r.data.access_token, refreshToken: r.data.refresh_token,
             expiresIn: r.data.expires_in, raw: r.data };
  }

  async getUserInfo(token) {
    return GET('/open-apis/authen/v1/user_info', { Authorization: `Bearer ${token.accessToken}` });
  }

  normalizeProfile(raw): NormalizedProfile {
    return {
      providerUserId: raw.data.open_id,      // ⚠️ open_id 按应用隔离
      unionId:        raw.data.union_id,     // 同开发商多应用间唯一
      name:  raw.data.name,  email: raw.data.email, avatar: raw.data.avatar_url,
      corpId: raw.data.tenant_key,           // 企业标识
    };
  }
}
```

**飞书特有差异**：
- 需要两级 token：`app_access_token`（应用级，有有效期需缓存）→ `user_access_token`。
- `open_id` **按应用隔离**，所以 ER 中唯一键含 `provider_id`（应用配置行）而非仅 type。
- `union_id` 可跨同开发商的多个应用识别同人。
- user_access_token 有 refresh_token，可刷新——如需访问用户更多 API 才用得到，纯登录可以丢弃。

### 钉钉（DingTalk）

```typescript
class DingTalkAdapter implements IdentityProviderAdapter {
  type = 'dingtalk';

  async buildAuthorizeUrl(scene, state, redirectUri) {
    if (scene === 'web_qr') {
      // 扫码登录有独立的 authorize 地址（goto），前端嵌 iframe/二维码
      return `https://login.dingtalk.com/oauth2/auth`
           + `?redirect_uri=${encode(redirectUri)}&response_type=code`
           + `&client_id=${cfg.appKey}&scope=openid&state=${state}&prompt=consent`;
    }
    // h5 / in_app：统一 OAuth2 授权地址，钉钉按环境分流
    return `https://login.dingtalk.com/oauth2/auth?...同上`;
  }

  async exchangeCode(code) {
    // 新版 OAuth2：client_id + client_secret 直接换 user_access_token（无独立 app_token 步骤）
    const r = await POST('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', {
      clientId: cfg.appKey, clientSecret: cfg.appSecret,
      code, grantType: 'authorization_code',
    });
    return { accessToken: r.accessToken, refreshToken: r.refreshToken,
             expiresIn: r.expireIn, raw: r };
  }

  async getUserInfo(token) {
    // GET https://api.dingtalk.com/v1.0/contact/users/me
    // 需要请求头 x-acs-dingtalk-access-token
    return GET('/v1.0/contact/users/me', { 'x-acs-dingtalk-access-token': token.accessToken });
  }

  normalizeProfile(raw): NormalizedProfile {
    return {
      providerUserId: raw.unionId,   // ⚠️ 个人授权场景返回 unionId；企业内部应用场景通常是 userid
      unionId: raw.unionId,
      name: raw.nick, email: raw.email, avatar: raw.avatarUrl,
      corpId: raw.corpId ?? '',      // 个人扫码场景可能无 corpId，属「个人身份」而非企业身份
    };
  }
}
```

**钉钉特有差异**：
- **有两套历史 API**（旧版 sns/getuserinfo_bycode vs 新版 v1.0/oauth2）。**务必用新版并锁定文档版本**。
- 「个人扫码登录」（无企业上下文）与「企业内部应用免登」（有 corpId + userid）是两条链：前者拿 unionId，后者拿 userid。**corpId 可能为空**——此时该 link 属于个人身份，参与租户匹配的逻辑要降级（按 unionId 找组织成员关系）。
- 企业内部免登（in_app）走的是 JSAPI `dd.runtime.permission.requestAuthCode` 拿 code，后端用 `gettoken`（appKey+secret）→ `topapi/v2/user/getuserinfo` 换 userid——与网页 OAuth2 是不同的 code 兑换通道。Adapter 内部按 scene 分流，对外接口不变。

### 企业微信（WeCom / 企业微信）

```typescript
class WeComAdapter implements IdentityProviderAdapter {
  type = 'wecom';

  async buildAuthorizeUrl(scene, state, redirectUri) {
    if (scene === 'web_qr') {
      // 企微扫码有两种：独立 QR 页面跳转 / WwLogin JS SDK 内嵌二维码
      // 内嵌 SDK 需要前端加载官方 JS 并传入 appid+agentid，URL 仅是配置载体
      return `https://login.work.weixin.qq.com/wwlogin/sso/login`
           + `?login_type=CorpApp&appid=${cfg.corpId}&agentid=${cfg.agentId}`
           + `&redirect_uri=${encode(redirectUri)}&state=${state}`;
    }
    // h5 / in_app：标准 oauth2 链接，appid 就是企业 corpId
    return `https://open.weixin.qq.com/connect/oauth2/authorize`
         + `?appid=${cfg.corpId}&redirect_uri=${encode(redirectUri)}`
         + `&response_type=code&scope=snsapi_privateinfo&agentid=${cfg.agentId}`
         + `&state=${state}#wechat_redirect`;
  }

  async exchangeCode(code) {
    // 第一步：corpid + corpsecret → access_token（企业级，需缓存复用）
    const corpToken = await this.cachedCorpToken(); // GET /cgi-bin/gettoken?corpid=..&corpsecret=..
    // 第二步：code + 企业 access_token → 成员身份
    const r = await GET(`/cgi-bin/auth/getuserinfo?access_token=${corpToken}&code=${code}`);
    // 响应: { userid } 成员 / { openid } 外部联系人 / { errcode } 失败
    if (!r.userid) throw new ProviderAuthError('非企业成员或外部联系人', r);
    return { accessToken: corpToken, expiresIn: 0, raw: r }; // 企微无「用户级 token」概念
  }

  async getUserInfo(token) {
    // snsapi_privateinfo scope 下用 code 换到的票据再取详情；否则用 userid 查通讯录
    const userid = (token.raw as any).userid;
    return GET(`/cgi-bin/user/get?access_token=${token.accessToken}&userid=${userid}`);
  }

  normalizeProfile(raw): NormalizedProfile {
    return {
      providerUserId: raw.userid,   // ⚠️ 仅企业内唯一，必须配 corpId 使用
      unionId: undefined,           // 企微无跨企业 unionid（除非绑定微信开放平台）
      name: raw.name, email: raw.email ?? raw.biz_mail, avatar: raw.avatar,
      corpId: cfg.corpId,           // corpId 不随用户返回，来自自身配置
    };
  }
}
```

**企微特有差异**：
- **没有「用户级 access_token」**：code 直接换出 userid，后续调接口用的是企业级 token。ProviderTokenSet 对企微是「空壳」，expire 语义不适用。
- `userid` **仅企业内唯一** → ER 唯一键含 corp_id 的最直接动因。
- scope 分级：`snsapi_base`（静默，只拿 userid）/ `snsapi_privateinfo`（手动授权，拿详情）。扫码登录还能拿到登录临时票据换取用户信息，链路与 oauth2 不同。
- 成员敏感字段（邮箱、手机）需要应用有对应通讯录权限，否则 `email` 为空 → 归一化层必须容忍空值。

## 差异汇总表（归一化抽象 vs 现实）

| 维度 | 飞书 | 钉钉 | 企微 |
|---|---|---|---|
| 应用级 token | app_access_token，需先取 | 无独立步骤（client 凭证随请求） | 企业 access_token，需先取 |
| code → 身份 | 2 步（app token → user token） | 1 步（OAuth2 直接换） | 2 步（企业 token → userid） |
| 用户唯一键 | open_id（按应用隔离） | unionId / userid（按场景区分） | userid（按企业隔离） |
| 跨应用同人 | union_id | unionId | 无（除非绑微信开放平台） |
| 用户级 refresh | 有 | 有 | 无此概念 |
| 扫码实现 | 授权页自带扫码 | 独立 goto 地址/二维码组件 | WwLogin JS SDK 内嵌 |
| in_app 免登 code 通道 | 同网页 code | **不同通道**（JSAPI authCode） | 同网页 oauth2 code |

> 再次强调：**以官方 OpenAPI 为准，上面是归一化抽象。** 落地前逐项核对当前文档版本。

## 扩展新身份源（如 Google / OIDC）

实现同一接口即可。若标准 OIDC 源变多，可再抽一层 `OidcAdapter` 基类封装 discovery + JWKS 校验，飞书式两级 token 与子类钩子差异留在子类。**在只有三家时不要提前抽象这层**。
