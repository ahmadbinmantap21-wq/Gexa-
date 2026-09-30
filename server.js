require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
const API_KEY = process.env.OPENAI_API_KEY;

app.use(express.json({ limit: '256kb' }));
app.use(express.static(__dirname));

// Usage-based limit (bukan batas jumlah chat).
// Pesan panjang menghabiskan lebih banyak usage.
// Setelah usage mencapai batas, cooldown otomatis 2–5 jam.
const USAGE_LIMIT = 100000;
const usageUsers = new Map();

function getUsageState(ip) {
  const now = Date.now();
  let state = usageUsers.get(ip);

  if (!state) {
    state = { used: 0, resetAt: 0 };
    usageUsers.set(ip, state);
  }

  if (state.resetAt && now >= state.resetAt) {
    state.used = 0;
    state.resetAt = 0;
  }

  return state;
}

function usageLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const state = getUsageState(ip);

  if (state.resetAt) {
    const minutes = Math.ceil((state.resetAt - Date.now()) / 60000);
    return res.status(429).json({
      error: `Batas penggunaan tercapai. Coba lagi sekitar ${minutes} menit lagi.`,
      resetAt: new Date(state.resetAt).toISOString()
    });
  }

  if (state.used >= USAGE_LIMIT) {
    const cooldownHours = 2 + Math.floor(Math.random() * 4);
    state.resetAt = Date.now() + cooldownHours * 60 * 60 * 1000;

    return res.status(429).json({
      error: `Batas penggunaan tercapai. Reset sekitar ${cooldownHours} jam lagi.`,
      resetAt: new Date(state.resetAt).toISOString()
    });
  }

  req.usageState = state;
  next();
}

app.get('/health', (req, res) => res.json({ ok: true, model: MODEL }));

app.post('/chat', usageLimit, async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY belum diatur di .env' });

  const { system = '', messages = [] } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Pesan tidak valid.' });
  }

  const safeMessages = messages.slice(-20).map(m => ({
    role: m?.role === 'assistant' ? 'assistant' : 'user',
    content: String(m?.content || '').slice(0, 20000)
  }));

  try {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        instructions: String(system).slice(0, 30000),
        input: safeMessages
      })
    });

    const data = await r.json();
    if (!r.ok) {
      console.error('OpenAI error:', data);
      return res.status(r.status).json({ error: data?.error?.message || 'OpenAI API error' });
    }

    // Hitung pemakaian berdasarkan token aktual dari Responses API.
    const usedTokens = Number(data?.usage?.total_tokens || 0);
    req.usageState.used += usedTokens;

    const reply = data.output_text || (data.output || [])
      .flatMap(x => x.content || [])
      .filter(x => x.type === 'output_text')
      .map(x => x.text)
      .join('');

    return res.json({ reply: reply || 'Tidak ada jawaban dari model.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server gagal menghubungi OpenAI.' });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'gexa.html')));

app.listen(PORT, () => {
  console.log(`Gexa berjalan di http://localhost:${PORT}`);
  console.log(`Model: ${MODEL}`);
});
