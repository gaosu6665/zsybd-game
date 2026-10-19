// Vercel Serverless Function：/api/say
// 前端请求 POST /say → vercel.json rewrite → 这里
// 环境变量：COZE_TOKEN（必填）
// 可选：BOT_GANLONG / BOT_XIAOGONG / BOT_LINREN

const https = require('https');

const TOKEN = process.env.COZE_TOKEN || '';
const BOTS = {
  甘龙: process.env.BOT_GANLONG || '7697858049360707618',
  孝公: process.env.BOT_XIAOGONG || '7697854408654635027',
  邻人: process.env.BOT_LINREN || '7697859520399425599',
};

/* ── 简易限流：同 IP 每分钟最多 12 次（模块级，随实例存活） ── */
const HITS = new Map();
const LIMIT = 12, WINDOW = 60 * 1000;
function allow(ip) {
  const now = Date.now();
  const rec = HITS.get(ip);
  if (!rec || now - rec.t > WINDOW) { HITS.set(ip, { t: now, n: 1 }); return true; }
  rec.n++;
  return rec.n <= LIMIT;
}

function api(path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = https.request({
      hostname: 'api.coze.cn',
      path,
      method: data ? 'POST' : 'GET',
      headers: Object.assign(
        { Authorization: 'Bearer ' + TOKEN },
        data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}
      ),
      timeout: 30000,
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('bad json: ' + buf.slice(0, 120))); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 把历史拼成明确指令（实测：不这样写它就不看历史） */
function buildMessage(history, text) {
  const h = Array.isArray(history) ? history.slice(-6) : [];
  if (!h.length) return text;
  const lines = h.map(x => `${x.who}说：${x.text}`).join('\n');
  return [
    '请根据下面的对话记录回答，不要编造记录中没有的内容。',
    '',
    '【对话记录】',
    lines,
    '',
    '【现在对方说】',
    text,
  ].join('\n');
}

async function ask(botId, message, userId) {
  const created = await api('/v3/chat', {
    bot_id: botId,
    user_id: userId || 'guest',
    stream: false,
    auto_save_history: true,
    additional_messages: [{ role: 'user', content: message, content_type: 'text' }],
  });
  if (created.code !== 0) throw new Error('create: ' + (created.msg || created.code));

  const chatId = created.data.id, convId = created.data.conversation_id;
  let done = false;
  for (let i = 0; i < 70; i++) {           /* 最多等 49 秒（Vercel maxDuration 60） */
    await sleep(700);
    const r = await api(`/v3/chat/retrieve?chat_id=${chatId}&conversation_id=${convId}`);
    const st = r.data && r.data.status;
    if (st === 'completed') { done = true; break; }
    if (st === 'failed' || st === 'canceled' || st === 'requires_action') {
      throw new Error('chat ' + st);
    }
  }
  if (!done) throw new Error('ai_timeout');
  const list = await api(`/v3/chat/message/list?chat_id=${chatId}&conversation_id=${convId}`);
  const msgs = (list.data || []).filter(m => m.type === 'answer' && m.role === 'assistant');
  if (!msgs.length) throw new Error('no answer');
  return parseLine(String(msgs[msgs.length - 1].content || ''));
}

/* 去掉括号里的动作描写 */
function sanitize(s) {
  return String(s || '')
    .replace(/[（(][^）)]{0,60}[）)]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* 机器人有时返回 {"line":..,"gloss":..}，有时是纯文本 */
function parseLine(raw) {
  if (!raw) return { line: '', gloss: '' };
  try {
    const o = JSON.parse(raw);
    if (o && o.line) return { line: sanitize(o.line), gloss: sanitize(o.gloss || '') };
  } catch (e) {}
  const parts = raw.split('\n').filter(Boolean);
  return { line: sanitize(parts[0] || raw), gloss: sanitize(parts[1] || '') };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method' });

  if (!TOKEN) return res.status(200).json({ ok: false, error: 'no_token', degraded: true });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!allow(ip)) return res.status(429).json({ ok: false, error: 'rate_limited', degraded: true });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const npc = body.npc;
    const text = String(body.text || '').slice(0, 200);
    if (!BOTS[npc]) return res.status(200).json({ ok: false, error: 'bad_npc', degraded: true });
    if (!text) return res.status(200).json({ ok: false, error: 'empty', degraded: true });

    const msg = buildMessage(body.history, text);
    const t0 = Date.now();
    const out = await ask(BOTS[npc], msg, body.user || 'guest');
    return res.status(200).json({
      ok: true, line: out.line, gloss: out.gloss,
      latency: Date.now() - t0, degraded: false,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e.message || e), degraded: true });
  }
};
