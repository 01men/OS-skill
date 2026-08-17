# 08 · 飞书 / 钉钉 / 企业微信接入配置表

> ⚠️ **以官方 OpenAPI 为准，下面是归一化抽象。** 所有有效期数值、scope 名称、endpoint 均需在接入时按三家当前开发者后台/文档复核——这些值历史上都变过。表内数值为常见公开版本，用于设计基线。

## 一、后台配置字段（对应 identity_providers.config_encrypted 的 JSON 内容）

| 字段 | 飞书 | 钉钉 | 企业微信 |
|---|---|---|---|
| 应用 ID | `appId`（App ID） | `appKey`（Client ID） | `corpId`（企业 ID）+ `agentId`（应用 ID） |
| 应用密钥 | `appSecret` | `appSecret`（Client Secret） | `corpSecret`（应用 Secret） |
| 企业标识 | 无需单独配置（tenant_key 随回调/用户信息返回） | `corpId`（企业应用场景必填；个人扫码场景可空） | 即 `corpId`，与 appid 同值 |
| 加解密 | `encryptKey` + `verificationToken`（事件订阅才需要，纯登录可省） | `aesKey` + `token`（事件订阅用） | `encodingAESKey` + `token`（回调事件用） |
| 其他 | — | — | 可信任 IP 白名单（后台配置，调 API 的服务器出口 IP） |

落到 `identity_providers` 行示例：

```json
// type=feishu
{"appId":"cli_xxx","appSecret":"xxx"}
// type=dingtalk（企业内部应用）
{"appKey":"dingxxx","appSecret":"xxx","corpId":"dingyyy"}
// type=wecom
{"corpId":"wwxxx","agentId":"1000002","corpSecret":"xxx"}
```

## 二、scope / 权限

| | 飞书 | 钉钉 | 企业微信 |
|---|---|---|---|
| 登录所需最小 scope | 授权页默认即可；取邮箱需开 `contact:user.email:readonly`（应用权限） | `openid`（OAuth2）；取手机号需单独申请权限 | `snsapi_base`（静默拿 userid）/ `snsapi_privateinfo`（授权拿详情） |
| 扫码登录 scope | 授权页自带扫码，无独立 scope | `openid` + `prompt=consent` | 扫码登录独立链路（WwLogin），不区分 snsapi scope |
| 通讯录权限（补全 email/phone） | 需在开发者后台勾选对应数据权限 | 需申请「通讯录只读」等权限 | 应用需有通讯录查看权限，否则 email 为空 |

## 三、回调 / 重定向

| | 飞书 | 钉钉 | 企业微信 |
|---|---|---|---|
| 回调地址登记位置 | 开发者后台 → 应用 → 安全设置「重定向 URL」 | 开发者后台 → 应用「回调域名/重定向 URL」 | 企业微信管理后台 → 应用「授权回调域」（仅域名，路径任意） |
| 回调参数 | `code` + `state` | `authCode`/`code` + `state`（不同链路参数名不同，注意） | `code` + `state` |
| in_app 免登 | JS-SDK `tt.requestAccess` / 网页授权静默 | JSAPI `requestAuthCode`（code 兑换通道与网页不同） | oauth2 `snsapi_base` 静默跳转 |
| PC 扫码组件 | 授权页自带扫码 UI | 独立扫码授权地址（goto 链接）/ 二维码 JS | `WwLogin` 官方 JS SDK 内嵌 iframe 二维码 |

## 四、token / code 有效期（设计基线，务必复核官方文档）

| 项 | 飞书 | 钉钉 | 企业微信 |
|---|---|---|---|
| 授权 code | 一次性，约 5min 有效 | 一次性，短时效 | 一次性，约 5min 有效 |
| 应用/企业级 token | app_access_token 约 2h（需缓存+提前刷新） | 旧版 gettoken 约 2h；新版 OAuth2 无独立 app token | access_token 约 2h（需缓存+集中刷新，**并发重复获取会互相失效**） |
| 用户级 access_token | 约 2h | 约 2h | **无此概念**（code 直接换 userid） |
| 用户级 refresh_token | 有（约 30d，可刷新） | 有（约 30d） | 无 |
| 纯登录场景是否需持久化平台 token | 否，换到 profile 即可丢弃 | 否 | 否 |

> 我方自身的 access_token（15–30min）/ refresh_token（7d 轮转）与上表平台 token **完全独立**，不要因为平台给了 30d refresh 就延长我方令牌寿命。

## 五、接入 Checklist（每家通用）

- [ ] 开发者后台建应用，拿到上表字段 → 加密写入 `identity_providers.config_encrypted`
- [ ] 登记回调域/重定向 URL（与 07 的 redirect_uri 白名单一致）
- [ ] 勾选登录所需 scope/数据权限（至少能拿到 name + avatar，email 尽量）
- [ ] 实现/启用对应 Adapter（见 03），联调三场景：PC 扫码、H5、in_app
- [ ] 验证 normalizeProfile 输出的 corpId 与 providerUserId 组合在唯一键下表现正确
- [ ] 应用级 token 加集中缓存（尤其企微，多实例重复获取会互踢）
- [ ] 联调「未命中 → 绑定/注册」分支与「已绑他人 → 409」分支
