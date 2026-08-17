# -*- coding: utf-8 -*-
"""
登录账户模块 · 钉钉登录最小验证 Demo（纯 stdlib，零依赖）

验证链路（对应 docs/03 + docs/04 的归一化抽象）：
  页面 → 跳转钉钉授权/扫码 → 回调 code
      → exchangeCode(code) → getUserInfo(token) → normalizeProfile(raw)
      → 查 user_identity_links → 命中=登录 / 未命中=自动注册（Demo 简化掉三分支页面）

运行：python server.py   然后浏览器打开 http://localhost:3000
"""
import json
import os
import secrets
import sqlite3
import time
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))

# ---------- 配置 ----------
with open(os.path.join(BASE, "config.local.json"), encoding="utf-8") as f:
    CFG = json.load(f)
CLIENT_ID = CFG["clientId"]
CLIENT_SECRET = CFG["clientSecret"]
REDIRECT_URI = CFG["redirectUri"]
PORT = int(CFG.get("port", 3000))

DB_PATH = os.path.join(BASE, "demo.db")

# state / code 一次性防重放（进程内存版；生产用 Redis，见 docs/07）
STATE_STORE = {}   # state -> 过期时间戳
USED_CODES = set() # 已消费的 code

# ---------- DB：模块核心两表的最小版 ----------
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = db()
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS user_identity_links (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      provider_type TEXT NOT NULL,
      corp_id TEXT NOT NULL DEFAULT '',
      provider_user_key TEXT NOT NULL,
      union_id TEXT,
      profile_json TEXT,
      linked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      unlinked_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_identity_link
      ON user_identity_links(provider_type, corp_id, provider_user_key)
      WHERE unlinked_at IS NULL;
    """)
    conn.commit()
    conn.close()

# ---------- 钉钉 Adapter（对应 docs/03 的 DingTalkAdapter）----------
def http_json(method, url, headers=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())

def build_authorize_url(state):
    q = urllib.parse.urlencode({
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "client_id": CLIENT_ID,
        "scope": "openid",
        "state": state,
        "prompt": "consent",
    })
    return f"https://login.dingtalk.com/oauth2/auth?{q}"

def exchange_code(code):
    # 新版 OAuth2：code → userAccessToken
    r = http_json("POST", "https://api.dingtalk.com/v1.0/oauth2/userAccessToken", body={
        "clientId": CLIENT_ID,
        "clientSecret": CLIENT_SECRET,
        "code": code,
        "grantType": "authorization_code",
    })
    if "accessToken" not in r:
        raise RuntimeError(f"exchangeCode 失败: {r}")
    return r

def get_user_info(access_token):
    return http_json("GET", "https://api.dingtalk.com/v1.0/contact/users/me",
                     headers={"x-acs-dingtalk-access-token": access_token})

def normalize_profile(raw):
    # 个人扫码场景无企业上下文：corpId 为空 → provider_user_key 用 unionId
    return {
        "providerUserId": raw.get("unionId") or raw.get("openId"),
        "unionId": raw.get("unionId"),
        "name": raw.get("nick") or "钉钉用户",
        "email": raw.get("email"),
        "avatar": raw.get("avatarUrl"),
        "corpId": raw.get("corpId") or "",
    }

# ---------- 登录决策（对应 docs/04 状态机尾部，Demo 未命中直接注册）----------
def resolve_login(profile):
    conn = db()
    try:
        link = conn.execute(
            "SELECT * FROM user_identity_links"
            " WHERE provider_type='dingtalk' AND corp_id=? AND provider_user_key=?"
            "   AND unlinked_at IS NULL",
            (profile["corpId"], profile["providerUserId"])).fetchone()
        if link:
            user = conn.execute("SELECT * FROM users WHERE id=?", (link["user_id"],)).fetchone()
            return {"branch": "hit", "user": dict(user), "link_id": link["id"]}
        # 未命中 → 注册新账号（事务：user + link）
        uid, lid = str(uuid.uuid4()), str(uuid.uuid4())
        conn.execute("INSERT INTO users(id, display_name, avatar_url) VALUES(?,?,?)",
                     (uid, profile["name"], profile["avatar"]))
        conn.execute(
            "INSERT INTO user_identity_links"
            "(id, user_id, provider_type, corp_id, provider_user_key, union_id, profile_json)"
            " VALUES(?,?,?,?,?,?,?)",
            (lid, uid, "dingtalk", profile["corpId"], profile["providerUserId"],
             profile["unionId"], json.dumps(profile, ensure_ascii=False)))
        conn.commit()
        user = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        return {"branch": "registered", "user": dict(user), "link_id": lid}
    finally:
        conn.close()

# ---------- 页面 ----------
PAGE_LOGIN = """<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录模块验证</title>
<style>body{font-family:system-ui;max-width:640px;margin:60px auto;padding:0 16px}
a.btn{display:inline-block;padding:12px 24px;background:#1677ff;color:#fff;
border-radius:8px;text-decoration:none}pre{background:#f6f8fa;padding:12px;overflow:auto}</style>
</head><body>
<h2>登录账户模块 · 钉钉验证</h2>
<p>点击下方按钮跳转钉钉授权页（PC 上默认展示二维码，用钉钉 App 扫码）：</p>
<p><a class="btn" href="/auth/dingtalk">使用钉钉登录</a></p>
</body></html>"""

def page_result(title, payload):
    return f"""<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>body{{font-family:system-ui;max-width:640px;margin:60px auto;padding:0 16px}}
pre{{background:#f6f8fa;padding:12px;overflow:auto}}
.ok{{color:#16a34a}}.err{{color:#dc2626}}</style>
</head><body><h2>{title}</h2><pre>{payload}</pre>
<p><a href="/">返回首页</a></p></body></html>"""

# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    def _send(self, html, status=200):
        body = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _redirect(self, url):
        self.send_response(302)
        self.send_header("Location", url)
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/":
            self._send(PAGE_LOGIN)
        elif u.path == "/health":
            self._send("ok")
        elif u.path == "/auth/dingtalk":
            state = secrets.token_urlsafe(24)
            STATE_STORE[state] = time.time() + 600
            self._redirect(build_authorize_url(state))
        elif u.path == "/auth/callback":
            self._callback(urllib.parse.parse_qs(u.query))
        else:
            self._send("404", 404)

    def _callback(self, qs):
        state = (qs.get("state") or [""])[0]
        # 钉钉不同链路回调参数名有 code / authCode 两种，都接住
        code = (qs.get("authCode") or qs.get("code") or [""])[0]

        # 1) state 校验（一次性）
        if not state or STATE_STORE.pop(state, None) is None:
            self._send(page_result("验证失败：state 无效或已过期",
                                   "可能原因：CSRF 重放、授权页停留超过 10 分钟"), 400)
            return
        if not code:
            self._send(page_result("验证失败：无 code", json.dumps(qs, ensure_ascii=False)), 400)
            return
        # 2) code 单次消费
        if code in USED_CODES:
            self._send(page_result("验证失败：code 已被消费", "code 单次性校验生效"), 400)
            return
        USED_CODES.add(code)

        try:
            # 3) code → token → 用户信息 → 归一化
            token_set = exchange_code(code)
            raw = get_user_info(token_set["accessToken"])
            profile = normalize_profile(raw)
            # 4) 查 link：命中=登录 / 未命中=注册
            result = resolve_login(profile)
            payload = {
                "验证结果": "✔ 模块链路正常",
                "分支": "已有身份映射，直接登录" if result["branch"] == "hit"
                        else "首次登录，已自动注册并写入 user_identity_links",
                "归一化profile": profile,
                "本地user": result["user"],
            }
            self._send(page_result("登录成功", json.dumps(payload, ensure_ascii=False, indent=2)))
        except Exception as e:
            self._send(page_result("链路异常", str(e)), 500)

    def log_message(self, fmt, *args):
        print(f"[{time.strftime('%H:%M:%S')}] {fmt % args}")

if __name__ == "__main__":
    init_db()
    print(f"Demo 启动: http://localhost:{PORT}  (回调: {REDIRECT_URI})")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
