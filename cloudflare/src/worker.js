// 今日空间 Cloudflare Worker 后端
// 提供:静态页面 + REST API(账号、待办、专注、便签),数据存 D1。
const SESSION_DAYS = 30; // 会话有效期

// ---------- 密码哈希(PBKDF2) ----------
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newSalt() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function newToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------- 工具 ----------
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

function toTodo(row) {
  return { id: row.id, text: row.text, done: !!row.done, created_at: row.created_at };
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// ---------- 认证 ----------
async function authUser(request, env) {
  const h = request.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  const row = await env.DB.prepare(
    'SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > datetime(\'now\')'
  ).bind(token).first();
  return row || null;
}

async function createSession(env, userId) {
  const token = newToken();
  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime(\'now\', ?))'
  ).bind(token, userId, '+' + SESSION_DAYS + ' days').run();
  return token;
}

// ---------- 路由 ----------
async function handleApi(request, env, url, path) {
  const method = request.method;
  const body = await readBody(request);

  // ---- 账号(无需登录) ----
  if (path === '/api/register' && method === 'POST') {
    const name = String(body?.name || '').trim();
    const pass = String(body?.pass || '');
    if (name.length < 1 || name.length > 24) return err('昵称长度需为 1-24 个字符');
    if (pass.length < 4) return err('密码至少 4 位');
    if (!/^[\u4e00-\u9fa5A-Za-z0-9_-]+$/.test(name)) return err('昵称只能含中文、字母、数字、_ 和 -');
    const existing = await env.DB.prepare('SELECT id FROM users WHERE name = ?').bind(name).first();
    if (existing) return err('这个昵称已被注册', 409);
    const salt = newSalt();
    const passHash = await hashPassword(pass, salt);
    const res = await env.DB.prepare('INSERT INTO users (name, pass_hash, salt) VALUES (?, ?, ?)').bind(name, passHash, salt).run();
    const userId = res.meta.last_row_id;
    const token = await createSession(env, userId);
    return json({ token, user: { id: userId, name } }, 201);
  }

  if (path === '/api/login' && method === 'POST') {
    const name = String(body?.name || '').trim();
    const pass = String(body?.pass || '');
    const row = await env.DB.prepare('SELECT id, name, pass_hash, salt FROM users WHERE name = ?').bind(name).first();
    if (!row) return err('昵称或密码不对', 401);
    const hash = await hashPassword(pass, row.salt);
    if (hash !== row.pass_hash) return err('昵称或密码不对', 401);
    const token = await createSession(env, row.id);
    return json({ token, user: { id: row.id, name: row.name } });
  }

  if (path === '/api/logout' && method === 'POST') {
    const h = request.headers.get('Authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return json({ ok: true });
  }

  // ---- 以下需要登录 ----
  const user = await authUser(request, env);
  if (!user) return err('请先登录', 401);

  if (path === '/api/me' && method === 'GET') {
    return json({ user });
  }

  // ---- 待办 ----
  if (path === '/api/todos' && method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT id, text, done, created_at FROM todos WHERE user_id = ? ORDER BY done ASC, id DESC'
    ).bind(user.id).all();
    return json(rows.results.map(toTodo));
  }

  if (path === '/api/todos' && method === 'POST') {
    const text = String(body?.text || '').trim();
    if (!text) return err('内容不能为空');
    if (text.length > 500) return err('内容过长');
    const res = await env.DB.prepare('INSERT INTO todos (user_id, text) VALUES (?, ?)').bind(user.id, text).run();
    const row = await env.DB.prepare(
      'SELECT id, text, done, created_at FROM todos WHERE id = ?'
    ).bind(res.meta.last_row_id).first();
    return json(toTodo(row), 201);
  }

  const todoMatch = path.match(/^\/api\/todos\/(\d+)$/);
  if (todoMatch && method === 'PATCH') {
    const id = Number(todoMatch[1]);
    const done = body?.done;
    if (typeof done !== 'boolean') return err('缺少 done 字段');
    const res = await env.DB.prepare(
      'UPDATE todos SET done = ?, done_at = CASE WHEN ? THEN datetime(\'now\') ELSE NULL END WHERE id = ? AND user_id = ?'
    ).bind(done ? 1 : 0, done ? 1 : 0, id, user.id).run();
    if (res.meta.changes === 0) return err('待办不存在', 404);
    const row = await env.DB.prepare('SELECT id, text, done, created_at FROM todos WHERE id = ?').bind(id).first();
    return json(toTodo(row));
  }

  if (todoMatch && method === 'DELETE') {
    const id = Number(todoMatch[1]);
    await env.DB.prepare('DELETE FROM todos WHERE id = ? AND user_id = ?').bind(id, user.id).run();
    return json({ ok: true });
  }

  // ---- 专注 ----
  if (path === '/api/focus' && method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT day, minutes, sessions FROM focus_log WHERE user_id = ?'
    ).bind(user.id).all();
    const byDay = {};
    const sessions = {};
    for (const r of rows.results) {
      byDay[r.day] = r.minutes;
      sessions[r.day] = r.sessions;
    }
    return json({ byDay, sessions });
  }

  if (path === '/api/focus' && method === 'POST') {
    const day = String(body?.day || '');
    const minutes = Number(body?.minutes) || 0;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return err('日期格式不对');
    if (minutes <= 0 || minutes % 25 !== 0 || minutes > 500) return err('分钟数必须为正的 25 的倍数');
    await env.DB.prepare(
      'INSERT INTO focus_log (user_id, day, minutes, sessions) VALUES (?, ?, ?, 1) ' +
      'ON CONFLICT(user_id, day) DO UPDATE SET minutes = minutes + excluded.minutes, sessions = sessions + 1'
    ).bind(user.id, day, minutes).run();
    const row = await env.DB.prepare('SELECT minutes, sessions FROM focus_log WHERE user_id = ? AND day = ?')
      .bind(user.id, day).first();
    return json(row, 201);
  }

  // ---- 便签 ----
  if (path === '/api/notes' && method === 'GET') {
    const row = await env.DB.prepare('SELECT content FROM notes WHERE user_id = ?').bind(user.id).first();
    return json({ content: row?.content || '' });
  }

  if (path === '/api/notes' && method === 'PUT') {
    const content = String(body?.content ?? '').slice(0, 20000);
    await env.DB.prepare(
      'INSERT INTO notes (user_id, content, updated_at) VALUES (?, ?, datetime(\'now\')) ' +
      'ON CONFLICT(user_id) DO UPDATE SET content = excluded.content, updated_at = datetime(\'now\')'
    ).bind(user.id, content).run();
    return json({ ok: true });
  }

  return err('接口不存在', 404);
}

// ---------- 入口 ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url, url.pathname);
    }
    // 静态资源(前端页面)
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('今日空间', { status: 200 });
  }
};