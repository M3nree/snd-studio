require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_KEY){
  console.error('❌ GEMINI_API_KEY не задан в .env');
  process.exit(1);
}

/* ===== Опциональный прокси (нужен из регионов, заблокированных Google) =====
   Впиши в .env строку вида  HTTPS_PROXY=http://127.0.0.1:7890  (порт свой) */
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
if (PROXY_URL){
  try {
    const { ProxyAgent, setGlobalDispatcher } = require('undici');
    setGlobalDispatcher(new ProxyAgent(PROXY_URL));
    console.log('🌐 Запросы к Gemini идут через прокси:', PROXY_URL);
  } catch (e){
    console.error('⚠️ Не удалось настроить прокси:', e.message);
  }
}

const CORS_ORIGINS = (process.env.CORS_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (CORS_ORIGINS.length === 0) return cb(null, true);
    if (CORS_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed: ' + origin));
  },
}));
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.get('/diag', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.json({
    ok: true,
    serverTime: new Date().toISOString(),
    commit: process.env.RENDER_GIT_COMMIT || 'unknown',
    version: 'v2.0.4'
  });
});

app.get('/version.json', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.json({
    version: 'v2.0.4',
    builtAt: new Date().toISOString(),
    commit: process.env.RENDER_GIT_COMMIT || null
  });
});

app.get('/', (req, res) => {
  const fs = require('fs');
  let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  html = html.replace('</head>', '<meta name="server-time" content="' + new Date().toISOString() + '">\n</head>');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.type('html').send(html);
});

app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, maxAge: 0 }));

/* ===== лимиты: защита общего бесплатного ключа ===== */
const RL_WINDOW_MS = 60 * 1000;   // окно
const RL_MAX_PER_IP = 3;          // генераций в минуту с одного IP
const RL_MAX_TOTAL = 8;           // генераций в минуту на всех
const RL_MAX_CONCURRENT = 3;      // одновременно выполняемых генераций
const RL_DAY_MS = 24 * 60 * 60 * 1000;
const RL_MAX_PER_IP_DAY = 25;     // генераций в сутки с одного IP
const RL_MAX_TOTAL_DAY = 70;      // генераций в сутки на всех (запас от дневной квоты Google)
let rlActive = 0;
const rlHits = new Map();         // ip -> [timestamps за сутки]

function clientIp(req){
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

function geminiRateLimit(req, res, next){
  const now = Date.now();
  if (rlActive >= RL_MAX_CONCURRENT){
    return res.status(429).json({ error: 'Сейчас очень много запросов. Подожди несколько секунд и повтори.', status: 'BUSY' });
  }
  const ip = clientIp(req);
  const mine = (rlHits.get(ip) || []).filter(t => now - t < RL_DAY_MS);
  const mineMin = mine.filter(t => now - t < RL_WINDOW_MS).length;
  let totalMin = 0, totalDay = 0;
  for (const a of rlHits.values()){
    for (const t of a){
      const dt = now - t;
      if (dt < RL_DAY_MS) totalDay++;
      if (dt < RL_WINDOW_MS) totalMin++;
    }
  }
  if (mineMin >= RL_MAX_PER_IP){
    return res.status(429).json({ error: `Лимит: ${RL_MAX_PER_IP} генерации в минуту с одного IP. Подожди немного.`, status: 'RATE_LIMITED' });
  }
  if (totalMin >= RL_MAX_TOTAL){
    return res.status(429).json({ error: 'Сервис перегружен: слишком много генераций в минуту. Повтори чуть позже.', status: 'RATE_LIMITED' });
  }
  if (mine.length >= RL_MAX_PER_IP_DAY){
    return res.status(429).json({ error: `Дневной лимит: ${RL_MAX_PER_IP_DAY} генераций в сутки с одного IP. Возвращайся завтра.`, status: 'DAILY_LIMIT' });
  }
  if (totalDay >= RL_MAX_TOTAL_DAY){
    return res.status(429).json({ error: 'На сегодня бесплатный лимит ИИ исчерпан. Попробуй завтра.', status: 'DAILY_LIMIT' });
  }
  mine.push(now);
  rlHits.set(ip, mine);
  rlActive++;
  let done = false;
  const finish = () => { if (!done){ done = true; rlActive--; } };
  res.on('finish', finish);
  res.on('close', finish);
  next();
}

// раз в 5 минут чистим записи старше суток
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of rlHits){
    const fresh = arr.filter(t => now - t < RL_DAY_MS);
    if (fresh.length) rlHits.set(ip, fresh); else rlHits.delete(ip);
  }
}, 5 * 60 * 1000).unref();

/* ================== Gemini: стабильный вызов ================== */
/* Google иногда отдаёт 503 "high demand" — лечится повторами и
   перебором моделей. Список проверен 2026-10: все отвечают 200. */
const GEMINI_MODELS = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
];
const RETRYABLE_STATUS = new Set([429, 500, 503]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function isRetryable(r, data){
  if (r && RETRYABLE_STATUS.has(r.status)) return true;
  // ошибка локации возникает, когда VPN-нода моргает — следующая попытка уже на восстановленной ноде
  if (r && r.status === 400 && /location is not supported/i.test(String(data?.error?.message || ''))) return true;
  return false;
}

async function callGemini(model, body){
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    }
  );
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch(e){ data = { raw: text }; }
  return { r, data, model };
}

function extractText(data){
  const parts = data?.candidates?.[0]?.content?.parts || [];
  // пропускаем "мысли" модели (p.thought === true), берём только чистый текст
  return parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
}

/* Перебирает модели x2 попытки; 503/429/5xx и пустой ответ -> следующий заход */
async function generateWithFallback(body){
  let last = null;
  for (const model of GEMINI_MODELS){
    for (let attempt = 1; attempt <= 2; attempt++){
      try {
        last = await callGemini(model, body);
      } catch (e){
        last = { r: null, data: { error: { message: e.cause?.message || e.message, status: 'FETCH_FAIL' } }, model };
        await sleep(1000);
        continue;
      }
      if (!last.r.ok){
        if (!isRetryable(last.r, last.data)) return last; // 400/401/403 — повтор бессмыслен
        console.warn(`⚠️ ${model} -> ${last.r.status} ${last.data?.error?.message || ''} (попытка ${attempt})`);
      } else if (extractText(last.data)){
        return last; // успех
      } else {
        console.warn(`⚠️ ${model} -> 200, но пустой текст (${last.data?.candidates?.[0]?.finishReason})`);
      }
      await sleep(attempt * 1500);
    }
  }
  return last;
}

/* ================== PROXY к Gemini ================== */
app.post('/api/gemini', geminiRateLimit, async (req, res) => {
  try {
    const { prompt, system, temperature, contents } = req.body || {};
    let turnList;
    if (Array.isArray(contents) && contents.length){
      // мульти-turn чат: [{role:'user'|'model', parts:[{text}]}]
      turnList = contents.filter(c => c && (c.role === 'user' || c.role === 'model') &&
        Array.isArray(c.parts) && c.parts.length && c.parts.every(p => typeof p.text === 'string'));
      if (!turnList.length){
        return res.status(400).json({ error: 'contents: нужны элементы вида {role:"user"|"model", parts:[{text:"..."}]}' });
      }
    } else if (typeof prompt === 'string' && prompt.trim()){
      turnList = [{ role: 'user', parts: [{ text: prompt }] }];
    } else {
      return res.status(400).json({ error: 'Поле "prompt" или "contents" обязательно' });
    }

    const body = {
      contents: turnList,
      generationConfig: {
        temperature: typeof temperature === 'number' ? temperature : 1.1,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 16384,
        responseMimeType: 'application/json',
      },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    const { r, data, model } = await generateWithFallback(body);

    if (!r || !r.ok){
      if (r) console.error('Gemini error', r.status, data);
      return res.status(r?.status || 500).json({
        error: data?.error?.message || `Gemini ${r?.status || 'network error'}`,
        code: data?.error?.code,
        status: data?.error?.status,
      });
    }

    console.log(`✅ Gemini (${model}) ok`);
    const candidate = data.candidates?.[0];
    const content = extractText(data);
    res.json({
      text: content,
      finishReason: candidate?.finishReason,
      usage: data.usageMetadata,
    });
  } catch (e){
    console.error('Proxy error:', e);
    res.status(500).json({ error: e.message });
  }
});

/* ================== Проверка ключа ================== */
app.get('/api/health', async (req, res) => {
  try {
    const { r, data, model } = await generateWithFallback({
      contents: [{ parts: [{ text: 'Ответь: OK' }] }],
    });
    if (!r || !r.ok){
      return res.status(r?.status || 500).json({
        ok: false,
        error: data?.error?.message || 'Gemini error',
        status: data?.error?.status,
      });
    }
    res.json({ ok: true, model, reply: extractText(data) });
  } catch (e){
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ SND Studio: http://localhost:${PORT}`);
  console.log(`   Проверка ключа: http://localhost:${PORT}/api/health`);
});
