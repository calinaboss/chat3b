async function runNeonSql(databaseUrl, sql, params = []) {
  if (!databaseUrl) throw new Error('Database URL non configurato');
  const dbUrl = new URL(databaseUrl);
  const endpoint = `https://${dbUrl.host}/sql`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 9000);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Neon-Connection-String': databaseUrl
      },
      body: JSON.stringify({ query: sql, params }),
      signal: controller.signal
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Database error (${res.status}): ${errText.slice(0, 160)}`);
    }

    const data = await res.json();
    if (data && Array.isArray(data.rows)) return data.rows;
    if (Array.isArray(data) && data[0] && Array.isArray(data[0].rows)) return data[0].rows;
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

async function sha256(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 
         request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 
         '127.0.0.1';
}

function cleanUsername(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const validRegex = /^[\p{L}0-9_.\- ]{2,24}$/u;
  if (!validRegex.test(trimmed)) return null;
  return trimmed.replace(/\s+/g, ' ');
}

function cleanMessage(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 800) return null;
  return trimmed.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
}

async function verifyTurnstile(token, secretKey, clientIp) {
  if (!secretKey) return true;
  if (!token) return false;
  try {
    const formData = new FormData();
    formData.append('secret', secretKey);
    formData.append('response', token);
    formData.append('remoteip', clientIp);

    const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      body: formData,
      method: 'POST'
    });
    const outcome = await result.json();
    return outcome.success === true;
  } catch {
    return false;
  }
}

let tablesChecked = false;
async function ensureTables(databaseUrl) {
  if (tablesChecked) return;
  const queries = [
    `CREATE TABLE IF NOT EXISTS chat3b_messages (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(50) NOT NULL,
      message TEXT NOT NULL,
      sender_token_hash VARCHAR(64) NOT NULL,
      ip_hash VARCHAR(64) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      is_deleted BOOLEAN DEFAULT FALSE
    );`,
    `CREATE INDEX IF NOT EXISTS idx_chat3b_messages_id ON chat3b_messages (id DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_chat3b_messages_created ON chat3b_messages (created_at DESC);`,
    `CREATE TABLE IF NOT EXISTS chat3b_presence (
      username VARCHAR(50) PRIMARY KEY,
      last_seen TIMESTAMPTZ DEFAULT NOW()
    );`,
    `CREATE TABLE IF NOT EXISTS chat3b_rate_limits (
      key_hash VARCHAR(64) PRIMARY KEY,
      last_action TIMESTAMPTZ DEFAULT NOW(),
      action_count INT DEFAULT 1
    );`
  ];

  for (const q of queries) {
    await runNeonSql(databaseUrl, q);
  }
  tablesChecked = true;
}

export async function onRequestGet(context) {
  try {
    const { env, request } = context;
    const dbUrl = env.DATABASE_URL;
    if (!dbUrl) {
      return new Response(JSON.stringify({ error: 'Configurazione mancante.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    await ensureTables(dbUrl);

    const url = new URL(request.url);
    const sinceId = parseInt(url.searchParams.get('since_id') || '0', 10);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10), 1), 100);

    const senderToken = request.headers.get('X-Sender-Token') || url.searchParams.get('token') || '';
    const senderTokenHash = senderToken ? await sha256((env.APP_SECRET || 'salt3b_chat_irigem_') + senderToken) : null;

    let rows;
    if (sinceId > 0) {
      rows = await runNeonSql(
        dbUrl,
        `SELECT id, username, message, created_at, sender_token_hash, is_deleted
         FROM chat3b_messages
         WHERE id > $1 AND is_deleted = FALSE
         ORDER BY id ASC
         LIMIT $2`,
        [sinceId, limit]
      );
    } else {
      const descRows = await runNeonSql(
        dbUrl,
        `SELECT id, username, message, created_at, sender_token_hash, is_deleted
         FROM chat3b_messages
         WHERE is_deleted = FALSE
         ORDER BY id DESC
         LIMIT $1`,
        [limit]
      );
      rows = descRows.reverse();
    }

    const safeMessages = rows.map(r => ({
      id: Number(r.id),
      username: r.username,
      message: r.message,
      created_at: r.created_at,
      is_mine: Boolean(senderTokenHash && r.sender_token_hash === senderTokenHash)
    }));

    return new Response(JSON.stringify({ success: true, messages: safeMessages }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Errore caricamento messaggi.', detail: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

export async function onRequestPost(context) {
  try {
    const { env, request } = context;
    const dbUrl = env.DATABASE_URL;
    if (!dbUrl) {
      return new Response(JSON.stringify({ error: 'Configurazione mancante.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    await ensureTables(dbUrl);

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Formato richiesta non valido.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { username: rawUser, message: rawMsg, honeypot, turnstile_token } = body || {};

    if (honeypot && String(honeypot).trim().length > 0) {
      return new Response(JSON.stringify({ error: 'Accesso negato.' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const clientIp = getClientIp(request);

    if (env.TURNSTILE_SECRET_KEY) {
      const isTurnstileOk = await verifyTurnstile(turnstile_token, env.TURNSTILE_SECRET_KEY, clientIp);
      if (!isTurnstileOk) {
        return new Response(JSON.stringify({ error: 'Verifica anti-robot fallita.' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    const salt = env.APP_SECRET || 'salt3b_chat_irigem_';
    const ipHash = await sha256(salt + ':' + clientIp);
    const rateLimitKey = await sha256(ipHash + ':rl');

    const rlRows = await runNeonSql(
      dbUrl,
      `SELECT last_action, action_count FROM chat3b_rate_limits WHERE key_hash = $1`,
      [rateLimitKey]
    );

    const now = Date.now();
    if (rlRows.length > 0) {
      const lastAction = new Date(rlRows[0].last_action).getTime();
      const diffSec = (now - lastAction) / 1000;
      let count = Number(rlRows[0].action_count || 1);

      if (diffSec < 1.2) {
        return new Response(JSON.stringify({ error: 'Attendi un istante tra un invio e l altro.' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (diffSec > 60) {
        count = 1;
      } else {
        count += 1;
        if (count > 25) {
          return new Response(JSON.stringify({ error: 'Limite raggiunto. Attendi 1 minuto.' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      await runNeonSql(
        dbUrl,
        `UPDATE chat3b_rate_limits SET last_action = NOW(), action_count = $1 WHERE key_hash = $2`,
        [count, rateLimitKey]
      );
    } else {
      await runNeonSql(
        dbUrl,
        `INSERT INTO chat3b_rate_limits (key_hash, last_action, action_count)
         VALUES ($1, NOW(), 1)
         ON CONFLICT (key_hash) DO UPDATE SET last_action = NOW(), action_count = 1`,
        [rateLimitKey]
      );
    }

    const cleanUser = cleanUsername(rawUser);
    if (!cleanUser) {
      return new Response(JSON.stringify({ error: 'Nome non valido (2-24 caratteri).' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const cleanMsgText = cleanMessage(rawMsg);
    if (!cleanMsgText) {
      return new Response(JSON.stringify({ error: 'Messaggio vuoto o troppo lungo.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const senderToken = request.headers.get('X-Sender-Token') || body.sender_token || Math.random().toString(36);
    const senderTokenHash = await sha256(salt + senderToken);

    const insertRes = await runNeonSql(
      dbUrl,
      `INSERT INTO chat3b_messages (username, message, sender_token_hash, ip_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, message, created_at`,
      [cleanUser, cleanMsgText, senderTokenHash, ipHash]
    );

    const newMsg = insertRes[0];

    return new Response(JSON.stringify({
      success: true,
      message: {
        id: Number(newMsg.id),
        username: newMsg.username,
        message: newMsg.message,
        created_at: newMsg.created_at,
        is_mine: true
      }
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Errore invio messaggio.', detail: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

export async function onRequestDelete(context) {
  try {
    const { env, request } = context;
    const dbUrl = env.DATABASE_URL;
    if (!dbUrl) {
      return new Response(JSON.stringify({ error: 'Configurazione mancante.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const url = new URL(request.url);
    const msgId = parseInt(url.searchParams.get('id') || '0', 10);
    const senderToken = request.headers.get('X-Sender-Token') || '';

    if (!msgId || !senderToken) {
      return new Response(JSON.stringify({ error: 'Parametri mancanti.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const salt = env.APP_SECRET || 'salt3b_chat_irigem_';
    const senderTokenHash = await sha256(salt + senderToken);

    const updateRes = await runNeonSql(
      dbUrl,
      `UPDATE chat3b_messages
       SET is_deleted = TRUE
       WHERE id = $1 
         AND sender_token_hash = $2
         AND created_at > NOW() - INTERVAL '60 minutes'
       RETURNING id`,
      [msgId, senderTokenHash]
    );

    if (updateRes.length === 0) {
      return new Response(JSON.stringify({ error: 'Impossibile eliminare.' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ success: true, deleted_id: msgId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Errore eliminazione.', detail: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
