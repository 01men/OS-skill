/**
 * 钉钉 OAuth 授权 + 机器人会话唤起 后端服务
 *
 * 核心链路：
 *  1. 用户点击网页按钮 -> 跳转钉钉授权窗口
 *  2. 授权后钉钉回调 redirect_uri 并携带临时授权码 code
 *  3. 后端用 AppKey/AppSecret 换取「用户 accessToken」
 *  4. 调用 /v1.0/contact/users/me 获取用户唯一标识 unionId（跨应用唯一，推荐作为账号主键）
 *  5. 换取「企业内部应用 accessToken」，把 unionId 转成企业内部 userId
 *  6. 调用 batchSendOTO 给该用户推送机器人消息，钉钉端自动出现"人与机器人"会话
 *  7. 返回 unionId/userId 给前端，前端用 dingtalk:// 协议唤起钉钉打开对话
 */
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const {
  DINGTALK_APP_KEY,
  DINGTALK_APP_SECRET,
  DINGTALK_REDIRECT_URI,
  PORT = 3000,
  ROBOT_WELCOME_MSG = '你好{nick}，请发送您的问题？',
} = process.env;

// 机器人的 chatbotUserId（加密ID，格式如 $:LWCP_v1:$xxx）持久化文件
// 获取方式①：钉钉机器人消息回调返回的 chatbotUserId 字段
// 获取方式②：.env 中 DINGTALK_CHATBOT_USER_ID 手动填写
const CHATBOT_ID_FILE = path.join(__dirname, '..', '.chatbot-user-id');

// 最近一次机器人消息回调的完整内容（内存缓存，用于网页展示/复制 chatbotUserId）
let lastCallbackBody = null;

if (!DINGTALK_APP_KEY || !DINGTALK_APP_SECRET) {
  console.error('[启动失败] 缺少 DINGTALK_APP_KEY 或 DINGTALK_APP_SECRET，请检查 .env 配置');
  process.exit(1);
}

// ============================================================
// 1. 构造钉钉 OAuth 授权跳转链接
// ============================================================
app.get('/api/auth/dingtalk-login', (req, res) => {
  const { state = 'dingtalk_robot_launch' } = req.query;
  const params = new URLSearchParams({
    redirect_uri: DINGTALK_REDIRECT_URI,
    response_type: 'code',
    client_id: DINGTALK_APP_KEY,
    // openid corpid：授权后可同时获得用户身份和被授权组织
    scope: 'openid corpid',
    state,
    prompt: 'consent',
  });
  const authUrl = `https://login.dingtalk.com/oauth2/auth?${params.toString()}`;
  res.json({ authUrl });
});

// ============================================================
// 2. 钉钉授权回调 -> 换取用户 token -> 识别用户唯一标识
// ============================================================
app.get('/api/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) {
    return res.status(400).send('授权失败：未获取到授权码 code');
  }

  try {
    // 2.1 用授权码 code 换取「用户委托访问凭证」userAccessToken
    const tokenRes = await axios.post(
      'https://api.dingtalk.com/v1.0/oauth2/userAccessToken',
      {
        clientId: DINGTALK_APP_KEY,
        clientSecret: DINGTALK_APP_SECRET,
        code,
        grantType: 'authorization_code',
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const userAccessToken = tokenRes.data.accessToken;

    // 2.2 用 userAccessToken 获取当前授权用户信息
    //     unionId 是钉钉体系中跨应用全局唯一的用户标识，推荐作为业务账号主键
    const userRes = await axios.get(
      'https://api.dingtalk.com/v1.0/contact/users/me',
      {
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': userAccessToken,
        },
      }
    );

    const userInfo = userRes.data;
    const unionId = userInfo.unionId; // 用户唯一标识（跨应用唯一）

    console.log('[授权成功] userInfo:', JSON.stringify(userInfo));

    // 2.3 尝试把 unionId 转成企业内部 userId，用于机器人单聊推送
    let userId = null;
    try {
      userId = await unionIdToCorpUserId(unionId);
    } catch (e) {
      console.warn('[unionId 转 userId 失败（不影响授权）]:', e.message);
    }

    // 2.4 授权成功后，自动给用户推送机器人会话消息（带昵称的个性化打招呼）
    let robotPushed = false;
    if (userId) {
      try {
        await pushRobotMessage(userId, userInfo.nick);
        robotPushed = true;
      } catch (e) {
        console.warn('[机器人消息推送失败]:', e.message);
      }
    }

    // 返回给前端数据（前端据此唤起钉钉机器人对话）
    const dingtalkLaunchUrl = buildDingtalkLaunchUrl();
    const session = {
      state,
      unionId,            // 用户唯一标识（推荐作为账号主键）
      userId,             // 企业内部 userId（用于机器人单聊）
      nick: userInfo.nick,
      avatarUrl: userInfo.avatarUrl,
      mobile: userInfo.mobile,
      robotPushed,
      dingtalkLaunchUrl,  // jumprobot 唤起链接（未配置 chatbotUserId 时为 null）
    };

    // 渲染成功页（自动唤起钉钉 + 展示用户唯一标识）
    res.send(renderSuccessPage(session));
  } catch (err) {
    console.error('[授权回调异常]', err?.response?.data || err.message);
    const detail = err?.response?.data ? JSON.stringify(err.response.data) : err.message;
    res.status(500).send(renderErrorPage(detail));
  }
});

// ============================================================
// 3. 用户唯一标识 -> 企业内部 userId
//    企业内部应用中 unionId 与 userId 是一一对应的
// ============================================================
async function unionIdToCorpUserId(unionId) {
  // 3.1 获取企业内部应用 accessToken（该接口只支持 POST）
  const tokenRes = await axios.post(
    'https://api.dingtalk.com/v1.0/oauth2/accessToken',
    {
      appKey: DINGTALK_APP_KEY,
      appSecret: DINGTALK_APP_SECRET,
    },
    { headers: { 'Content-Type': 'application/json' } }
  );
  const appAccessToken = tokenRes.data.accessToken;

  // 3.2 用 unionId 反查企业内部 userId
  const getByUnionIdRes = await axios.post(
    'https://oapi.dingtalk.com/topapi/user/getbyunionid',
    { unionid: unionId },
    {
      params: { access_token: appAccessToken },
      headers: { 'Content-Type': 'application/json' },
    }
  );

  const body = getByUnionIdRes.data;
  if (body.errcode !== 0) {
    throw new Error(`getbyunionid 失败: ${body.errmsg || body.errcode}`);
  }
  return body.result?.userid || null;
}

// ============================================================
// 4. 给用户推送机器人单聊消息（建立"人与机器人"会话 + 主动打招呼）
// ============================================================
async function pushRobotMessage(userId, nick = '') {
  // 4.1 企业内部应用 accessToken（该接口只支持 POST，robotCode 为机器人的 AppKey）
  const tokenRes = await axios.post(
    'https://api.dingtalk.com/v1.0/oauth2/accessToken',
    {
      appKey: DINGTALK_APP_KEY,
      appSecret: DINGTALK_APP_SECRET,
    },
    { headers: { 'Content-Type': 'application/json' } }
  );
  const appAccessToken = tokenRes.data.accessToken;

  // 4.2 个性化打招呼：用识别的用户昵称填充模板 {nick}
  const content = ROBOT_WELCOME_MSG.replace(/\{nick\}/g, nick || '朋友');

  // 4.3 批量发送单聊消息
  await axios.post(
    'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
    {
      robotCode: DINGTALK_APP_KEY,          // 机器人编码 = AppKey
      userIds: [userId],                    // 企业内部 userId
      msgKey: 'sampleText',                 // 文本消息模板
      msgParam: JSON.stringify({ content }),
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': appAccessToken,
      },
    }
  );
  console.log(`[机器人消息已推送] userId=${userId}, content=${content}`);
}

// ============================================================
// 5. 构造「打开钉钉机器人聊天窗口」的唤起链接
// ============================================================
/**
 * 打开「人与机器人」聊天窗口，必须使用 jumprobot 协议：
 *   dingtalk://dingtalkclient/action/jumprobot?dingtalkid=<机器人的chatbotUserId>
 * 其中 chatbotUserId 是钉钉给机器人在 IM 系统分配的加密唯一ID（形如 $:LWCP_v1:$xxx），
 * 不能由 AppKey 推导，只能从机器人消息回调中获取或手动配置。
 */
function getChatbotUserId() {
  // 优先级：.env 配置 > 自动捕获文件
  if (process.env.DINGTALK_CHATBOT_USER_ID) {
    return process.env.DINGTALK_CHATBOT_USER_ID.trim();
  }
  try {
    const saved = fs.readFileSync(CHATBOT_ID_FILE, 'utf-8').trim();
    return saved || null;
  } catch {
    return null;
  }
}

function saveChatbotUserId(id) {
  if (!id) return;
  try {
    fs.writeFileSync(CHATBOT_ID_FILE, id, 'utf-8');
    console.log(`[机器人ID已保存] chatbotUserId=${id}`);
  } catch (e) {
    console.warn('[保存 chatbotUserId 失败]', e.message);
  }
}

function buildDingtalkLaunchUrl() {
  const chatbotUserId = getChatbotUserId();
  if (chatbotUserId) {
    // 正确协议：jumprobot 打开机器人聊天窗口
    // dingtalkid 需要 urlencode（ID 含特殊字符）
    return `dingtalk://dingtalkclient/action/jumprobot?dingtalkid=${encodeURIComponent(chatbotUserId)}`;
  }
  // 未配置 chatbotUserId 时无法唤起，返回空标记
  return null;
}

/**
 * 6. 机器人消息回调接口（可选，用于自动捕获 chatbotUserId）
 * 需在钉钉开发者后台配置「消息接收地址」指向本接口。
 * 用户与机器人发一条消息后，回调消息体中的 chatbotUserId 即机器人ID，
 * 本接口自动捕获并保存，后续唤起即可生效。
 */
app.post('/api/dingtalk/webhook', (req, res) => {
  const body = req.body || {};
  // 保存最近一次回调完整内容，供网页查看/复制
  lastCallbackBody = body;
  const chatbotUserId = body.chatbotUserId;
  if (chatbotUserId) {
    saveChatbotUserId(chatbotUserId);
    console.log('[回调捕获] 机器人 chatbotUserId =', chatbotUserId);
    console.log('[回调捕获] 完整消息体已缓存，可在网页查看/复制');
  }
  // 响应格式按文档要求，5秒内返回
  res.json({ msg: 'ok' });
});

/**
 * 7. 查询当前已捕获的 chatbotUserId（供前端展示/复制）
 * 返回：
 *  - chatbotUserId: 已保存的机器人加密ID（.env 配置 > 自动捕获文件）
 *  - lastCallback: 最近一次机器人消息回调的完整内容（含 chatbotUserId、senderNick 等）
 */
app.get('/api/chatbot-id', (req, res) => {
  res.json({
    chatbotUserId: getChatbotUserId(),
    lastCallback: lastCallbackBody,
  });
});

// ============================================================
// 6. 页面渲染（内联，避免额外模板依赖）
// ============================================================
function renderSuccessPage(session) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>授权成功 - 正在唤起钉钉机器人</title>
<style>
  body { font-family: -apple-system, "Microsoft YaHei", sans-serif; background:#f5f6fa; display:flex; justify-content:center; align-items:center; min-height:100vh; margin:0; }
  .card { background:#fff; border-radius:16px; padding:40px 48px; box-shadow:0 8px 30px rgba(0,0,0,.08); max-width:520px; width:90%; text-align:center; }
  .badge { display:inline-block; background:#e8f5ff; color:#1587ff; font-size:13px; padding:4px 12px; border-radius:20px; margin-bottom:16px; }
  .avatar { width:72px; height:72px; border-radius:50%; object-fit:cover; background:#eee; margin:8px auto 12px; display:block; }
  h1 { font-size:20px; margin:8px 0 4px; color:#222; }
  .nick { color:#888; font-size:14px; }
  .info { background:#f8f9fc; border-radius:10px; padding:16px 20px; margin:20px 0; text-align:left; font-size:13px; }
  .info div { display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px dashed #e3e6ee; }
  .info div:last-child { border-bottom:none; }
  .info .label { color:#999; }
  .info .value { color:#333; font-weight:600; word-break:break-all; min-width:0; margin-left:16px; }
  .btn { display:inline-block; background:#1587ff; color:#fff; border:none; border-radius:8px; padding:12px 28px; font-size:15px; cursor:pointer; text-decoration:none; margin-top:8px; }
  .btn:hover { background:#0f6ed6; }
  .tip { color:#999; font-size:12px; margin-top:16px; line-height:1.6; }
  .status { font-size:13px; margin-top:12px; }
  .ok { color:#00b578; }
  .warn { color:#ff8800; }
</style>
</head>
<body>
  <div class="card">
    <div class="badge">钉钉授权成功</div>
    <img class="avatar" src="${session.avatarUrl || ''}" onerror="this.style.display='none'">
    <h1>${session.nick || '钉钉用户'}</h1>
    <div class="nick">正在唤起钉钉机器人对话...</div>
    <div class="info">
      <div><span class="label">用户唯一标识 (unionId)</span><span class="value">${session.unionId || '-'}</span></div>
      <div><span class="label">企业内 userId</span><span class="value">${session.userId || session.userId === null ? (session.userId || '未匹配') : '-'}</span></div>
      <div><span class="label">机器人消息</span><span class="status ${session.robotPushed ? 'ok' : 'warn'}">${session.robotPushed ? '已推送 ✓' : '未推送（检查权限/userId）'}</span></div>
    </div>
    <button class="btn" onclick="launchDingtalk()">打开钉钉机器人对话</button>
    <div class="tip" id="launchTip">若未自动唤起，请点击上方按钮。首次使用需在钉钉中允许"返回网页"跳转。</div>
  </div>
  <script>
    const LAUNCH_URL = ${JSON.stringify(session.dingtalkLaunchUrl)};
    function launchDingtalk() {
      if (!LAUNCH_URL) return;
      window.location.href = LAUNCH_URL;
    }
    if (LAUNCH_URL) {
      // 自动唤起
      setTimeout(launchDingtalk, 800);
    } else {
      document.getElementById('launchTip').textContent =
        '⚠️ 尚未配置机器人的 chatbotUserId，无法唤起对话框。' +
        '请先在钉钉开发者后台配置消息接收地址为 /api/dingtalk/webhook，' +
        '然后给机器人发一条消息以自动捕获，或在 .env 填写 DINGTALK_CHATBOT_USER_ID。';
    }
  </script>
</body>
</html>`;
}

function renderErrorPage(detail) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>授权失败</title>
<style>body{font-family:-apple-system,"Microsoft YaHei",sans-serif;background:#f5f6fa;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}.card{background:#fff;border-radius:16px;padding:40px 48px;box-shadow:0 8px 30px rgba(0,0,0,.08);max-width:520px;width:90%;text-align:center}h1{color:#e5484d;font-size:20px}.detail{background:#fff7f7;border-radius:10px;padding:14px;margin:16px 0;color:#c0392b;font-size:12px;word-break:break-all;text-align:left}.btn{display:inline-block;background:#1587ff;color:#fff;border-radius:8px;padding:10px 24px;text-decoration:none;font-size:14px}</style>
</head>
<body><div class="card"><h1>授权失败</h1><div class="detail">${detail}</div><a class="btn" href="/">返回重试</a></div></body></html>`;
}

// ============================================================
// 静态资源（前端页面）
// ============================================================
app.use(express.static('public'));

app.listen(PORT, () => {
  console.log(`✅ 钉钉机器人唤起服务已启动，请访问 http://localhost:${PORT}`);
  console.log(`   授权回调地址: ${DINGTALK_REDIRECT_URI}`);
});