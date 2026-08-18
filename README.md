# OS-skill · 企业应用模块集锦

面向 SaaS / 企业应用开发的**通用基础设施模块集合**。每个模块都是一套可直接拷贝复用的设计 + 参考实现，目标是新产品按需取走对应模块，通过配置快速接入，而非从零搭建。

## 模块列表

| 模块 | 说明 | 目录 |
|---|---|---|
| 账号与身份体系 | 多租户 RBAC + 飞书/钉钉/企业微信四种登录形态（网页授权 / PC 扫码 / 手机 H5 / 客户端免登）+ 邮箱/手机账号绑定、解绑、合并；含 ER 模型、DDL、Adapter 抽象、时序图、安全清单、接入配置表与钉钉验证 Demo | [modules/auth-identity](modules/auth-identity) |
| 钉钉网页授权机器人-自动跳转客户端 | 给 Agent/AI 应用绑定钉钉机器人：网页 OAuth 授权识别用户身份（unionId/userId）、服务端推送机器人单聊自动建立会话、jumprobot 协议唤起钉钉客户端打开机器人对话窗口；含控制台配置指引、踩坑清单与可直接运行的参考服务实现 | [modules/dingtalk-robot-oauth](modules/dingtalk-robot-oauth) |

> 后续会持续收录其他 SaaS 构建通用模块。

## 仓库结构约定

```
modules/
└── <module-name>/
    ├── SKILL.md     # 供 AI Agent 直接读取的使用说明（集成步骤、红线、验收）
    ├── README.md    # 模块导航与设计索引
    ├── docs/        # 设计文档（ER / DDL / 接口 / 流程 / 安全 / 配置表）
    └── demo/        # 最小可运行验证 Demo（如有）
```

## 使用方式

- **人类开发者**：进入对应模块目录，从 `README.md` 开始，按文档顺序阅读。
- **AI Agent**：直接读取模块目录下的 `SKILL.md`，其中包含完整的集成步骤、设计红线与验收清单。

## 使用约定

- 所有模块设计对技术栈无硬依赖，文档中标注了替换点（ORM / DB / 前端框架）。
- 涉及第三方平台（飞书/钉钉/企微等）的数值与 endpoint 均以官方 OpenAPI 为准，文档内为归一化抽象。
- 凭证类文件（`config.local.json`、`.env` 等）已在 `.gitignore` 中排除，请勿提交任何真实密钥。
