// JF Tráfego - Worker: serve a landing page (assets) e a API do CRM (/api/*).

const STAGES = ['novo', 'contato', 'call_agendada', 'call_realizada', 'proposta', 'followup', 'ganho', 'perdido', 'nutricao'];
const CLASSES = ['A', 'B', 'C', 'N'];
const SESSION_DAYS = 7;
const COOKIE = 'jf_admin';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    nome TEXT, whatsapp TEXT, telefone_digitos TEXT, email TEXT, empresa TEXT, segmento TEXT,
    servico TEXT, faturamento TEXT, investimento TEXT, prazo TEXT, mensagem TEXT, origem TEXT,
    utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_term TEXT, utm_content TEXT,
    gclid TEXT, fbclid TEXT, page TEXT, referrer TEXT, ip TEXT,
    qualificacao TEXT NOT NULL DEFAULT 'N',
    qualificacao_auto TEXT NOT NULL DEFAULT 'N',
    qualificacao_motivo TEXT,
    quente INTEGER NOT NULL DEFAULT 0,
    etapa TEXT NOT NULL DEFAULT 'novo',
    valor REAL,
    call_em TEXT,
    followup_em TEXT,
    motivo_perda TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_leads_tel ON leads(telefone_digitos)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at)`,
  `CREATE TABLE IF NOT EXISTS eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    tipo TEXT NOT NULL,
    texto TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_eventos_lead ON eventos(lead_id)`,
  `CREATE TABLE IF NOT EXISTS login_tentativas (ip TEXT NOT NULL, ts INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS visitas_dia (
    dia TEXT NOT NULL, canal TEXT NOT NULL, campanha TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (dia, canal, campanha)
  )`,
  `CREATE TABLE IF NOT EXISTS investimentos (
    mes TEXT NOT NULL, canal TEXT NOT NULL, valor REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (mes, canal)
  )`
];

let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA.map(s => env.DB.prepare(s))).catch(e => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

// ===== Qualificação =====
// Faixa pelo faturamento mensal: A acima de R$ 100 mil, B de R$ 10 mil a R$ 100 mil, C abaixo de R$ 10 mil.
// Sem faturamento informado, estima pela verba de anúncios.
const FATURAMENTO = {
  'Até R$ 10 mil': 'C',
  'R$ 10 mil a R$ 30 mil': 'B',
  'R$ 30 mil a R$ 100 mil': 'B',
  'R$ 100 mil a R$ 500 mil': 'A',
  'Acima de R$ 500 mil': 'A'
};
const INVESTIMENTO = {
  'Ainda não invisto / quero orientação': 'C',
  'Até R$ 1.000': 'C',
  'R$ 1.000 a R$ 3.000': 'B',
  'R$ 3.000 a R$ 10.000': 'B',
  'Acima de R$ 10.000': 'A'
};

export function qualificar(lead) {
  if (FATURAMENTO[lead.faturamento]) {
    return { classe: FATURAMENTO[lead.faturamento], motivo: 'Faturamento informado: ' + lead.faturamento };
  }
  if (INVESTIMENTO[lead.investimento]) {
    return { classe: INVESTIMENTO[lead.investimento], motivo: 'Estimado pela verba de anúncios: ' + lead.investimento + ' (faturamento não informado)' };
  }
  return { classe: 'N', motivo: 'Sem dados de faturamento ou investimento' };
}

// ===== Canal de origem =====
// Classifica visita/lead em: google_ads, meta_ads, outros_ads, organico, social, referencia, direto.
export function canalDe(d) {
  const src = String(d.utm_source || '').toLowerCase();
  const med = String(d.utm_medium || '').toLowerCase();
  let ref = '';
  try { ref = d.referrer ? new URL(d.referrer).hostname.toLowerCase() : ''; } catch {}
  const pago = /cpc|ppc|paid|ads?$|display|pmax/.test(med);
  if (d.gclid || d.gbraid || d.wbraid || (/google|adwords|gads/.test(src) && (pago || !med))) return 'google_ads';
  if (d.fbclid || (pago && /facebook|instagram|meta|^fb$|^ig$/.test(src))) return 'meta_ads';
  if (/facebook|instagram|meta|^fb$|^ig$/.test(src)) return med ? 'social' : 'meta_ads';
  if (src) return pago ? 'outros_ads' : 'referencia';
  if (/(^|\.)(google|bing|yahoo|duckduckgo|ecosia)\./.test(ref)) return 'organico';
  if (/(^|\.)(facebook|instagram|linkedin|tiktok|youtube|t\.co|twitter|x)\./.test(ref) || /^(l\.)?(facebook|instagram)\.com$/.test(ref)) return 'social';
  if (ref && !/workers\.dev$|jftrafego/.test(ref)) return 'referencia';
  return 'direto';
}
const hojeBR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10); // America/Sao_Paulo (UTC-3)

// ===== Utilidades =====
const now = () => new Date().toISOString();
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const clip = (v, n = 300) => (v == null ? null : String(v).trim().slice(0, n) || null);

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const sessionSecret = env => env.ADMIN_PASSWORD + ':jf-crm-session';

async function isAuthed(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(sessionSecret(env), exp));
}

// ===== Rotas públicas =====
async function criarLead(request, env) {
  let body;
  try { body = JSON.parse(await request.text()); } catch { return json({ error: 'JSON inválido' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'JSON inválido' }, 400);
  if (body.website) return json({ ok: true }); // honeypot

  const ip = request.headers.get('cf-connecting-ip') || '';
  const digits = String(body.whatsapp || '').replace(/\D/g, '');
  if (!clip(body.nome) || digits.length < 10) return json({ error: 'Nome e WhatsApp são obrigatórios' }, 400);

  const recentes = await env.DB.prepare(`SELECT COUNT(*) AS n FROM leads WHERE ip = ? AND created_at > ?`)
    .bind(ip, new Date(Date.now() - 10 * 60e3).toISOString()).first();
  if (recentes && recentes.n >= 10) return json({ error: 'Muitas tentativas' }, 429);

  const lead = {
    nome: clip(body.nome, 120), whatsapp: clip(body.whatsapp, 40), telefone_digitos: digits.slice(-11),
    email: clip(body.email, 160), empresa: clip(body.empresa, 160), segmento: clip(body.segmento, 160),
    servico: clip(body.servico, 120), faturamento: clip(body.faturamento, 80), investimento: clip(body.investimento, 80),
    prazo: clip(body.prazo, 80), mensagem: clip(body.mensagem, 2000), origem: clip(body.origem, 80),
    utm_source: clip(body.utm_source), utm_medium: clip(body.utm_medium), utm_campaign: clip(body.utm_campaign),
    utm_term: clip(body.utm_term), utm_content: clip(body.utm_content), gclid: clip(body.gclid), fbclid: clip(body.fbclid),
    page: clip(body.page, 500), referrer: clip(body.referrer, 500), ip
  };
  const q = qualificar(lead);
  const quente = lead.prazo === 'Imediatamente' ? 1 : 0;
  const ts = now();

  // Mesmo WhatsApp nos últimos 30 dias: atualiza o lead existente em vez de duplicar.
  const existente = await env.DB.prepare(`SELECT * FROM leads WHERE telefone_digitos = ? AND created_at > ? ORDER BY id DESC LIMIT 1`)
    .bind(lead.telefone_digitos, new Date(Date.now() - 30 * 864e5).toISOString()).first();

  if (existente) {
    const merged = {};
    for (const k of Object.keys(lead)) merged[k] = lead[k] ?? existente[k];
    const q2 = qualificar(merged);
    // Só troca a classe se ela ainda era a automática (não foi alterada manualmente).
    const classe = existente.qualificacao === existente.qualificacao_auto ? q2.classe : existente.qualificacao;
    const cols = Object.keys(merged);
    await env.DB.batch([
      env.DB.prepare(`UPDATE leads SET ${cols.map(c => c + ' = ?').join(', ')}, qualificacao = ?, qualificacao_auto = ?, qualificacao_motivo = ?, quente = ?, updated_at = ? WHERE id = ?`)
        .bind(...cols.map(c => merged[c]), classe, q2.classe, q2.motivo, Math.max(quente, existente.quente), ts, existente.id),
      env.DB.prepare(`INSERT INTO eventos (lead_id, created_at, tipo, texto) VALUES (?, ?, 'formulario', ?)`)
        .bind(existente.id, ts, 'Enviou o formulário novamente (' + (lead.origem || 'site') + ')')
    ]);
    return json({ ok: true, id: existente.id, qualificacao: classe });
  }

  const cols = Object.keys(lead);
  const res = await env.DB.prepare(
    `INSERT INTO leads (${cols.join(', ')}, created_at, updated_at, qualificacao, qualificacao_auto, qualificacao_motivo, quente, etapa)
     VALUES (${cols.map(() => '?').join(', ')}, ?, ?, ?, ?, ?, ?, 'novo')`
  ).bind(...cols.map(c => lead[c]), ts, ts, q.classe, q.classe, q.motivo, quente).run();
  const id = res.meta.last_row_id;
  await env.DB.prepare(`INSERT INTO eventos (lead_id, created_at, tipo, texto) VALUES (?, ?, 'criado', ?)`)
    .bind(id, ts, `Lead criado pelo ${lead.origem || 'site'}. Qualificação automática: ${q.classe} (${q.motivo})`).run();
  return json({ ok: true, id, qualificacao: q.classe });
}

async function registrarVisita(request, env) {
  const ua = request.headers.get('user-agent') || '';
  if (!ua || /bot|crawl|spider|slurp|preview|lighthouse|headless|monitor/i.test(ua)) return new Response(null, { status: 204 });
  let d = {};
  try { d = JSON.parse(await request.text()); } catch {}
  const canal = canalDe(d);
  const campanha = clip(d.utm_campaign, 120) || '';
  await env.DB.prepare(`INSERT INTO visitas_dia (dia, canal, campanha, n) VALUES (?, ?, ?, 1)
    ON CONFLICT (dia, canal, campanha) DO UPDATE SET n = n + 1`).bind(hojeBR(), canal, campanha).run();
  return new Response(null, { status: 204 });
}

async function login(request, env) {
  if (!env.ADMIN_PASSWORD) return json({ error: 'Senha do admin não configurada (variável ADMIN_PASSWORD no Cloudflare).' }, 503);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const desde = Date.now() - 15 * 60e3;
  const falhas = await env.DB.prepare(`SELECT COUNT(*) AS n FROM login_tentativas WHERE ip = ? AND ts > ?`).bind(ip, desde).first();
  if (falhas && falhas.n >= 8) return json({ error: 'Muitas tentativas. Aguarde 15 minutos.' }, 429);

  let body = {};
  try { body = await request.json(); } catch {}
  const ok = safeEqual(await hmac('cmp', String(body.senha || '')), await hmac('cmp', env.ADMIN_PASSWORD));
  if (!ok) {
    await env.DB.prepare(`INSERT INTO login_tentativas (ip, ts) VALUES (?, ?)`).bind(ip, Date.now()).run();
    await env.DB.prepare(`DELETE FROM login_tentativas WHERE ts < ?`).bind(desde).run();
    return json({ error: 'Senha incorreta' }, 401);
  }
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  const token = exp + '.' + (await hmac(sessionSecret(env), exp));
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  return json({ ok: true }, 200, {
    'set-cookie': `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly;${secure} SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`
  });
}

// ===== Rotas do admin =====
async function listarLeads(env) {
  const { results } = await env.DB.prepare(`SELECT * FROM leads ORDER BY created_at DESC LIMIT 2000`).all();
  return json({ leads: results });
}

async function detalheLead(env, id) {
  const lead = await env.DB.prepare(`SELECT * FROM leads WHERE id = ?`).bind(id).first();
  if (!lead) return json({ error: 'Lead não encontrado' }, 404);
  const { results } = await env.DB.prepare(`SELECT * FROM eventos WHERE lead_id = ? ORDER BY id DESC`).bind(id).all();
  return json({ lead, eventos: results });
}

const ETAPA_NOME = {
  novo: 'Novo lead', contato: 'Em contato', call_agendada: 'Call agendada', call_realizada: 'Call realizada',
  proposta: 'Proposta enviada', followup: 'Follow-up', ganho: 'Cliente fechado', perdido: 'Perdido', nutricao: 'Nutrição'
};
const EDITAVEIS = ['nome', 'whatsapp', 'email', 'empresa', 'segmento', 'servico', 'faturamento', 'investimento', 'prazo', 'mensagem'];

async function atualizarLead(request, env, id) {
  const lead = await env.DB.prepare(`SELECT * FROM leads WHERE id = ?`).bind(id).first();
  if (!lead) return json({ error: 'Lead não encontrado' }, 404);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSON inválido' }, 400); }

  const sets = [], vals = [], eventos = [];
  const set = (col, val) => { sets.push(col + ' = ?'); vals.push(val); };

  if (body.etapa !== undefined && body.etapa !== lead.etapa) {
    if (!STAGES.includes(body.etapa)) return json({ error: 'Etapa inválida' }, 400);
    set('etapa', body.etapa);
    eventos.push(['etapa', `Etapa: ${ETAPA_NOME[lead.etapa]} → ${ETAPA_NOME[body.etapa]}`]);
  }
  if (body.qualificacao !== undefined && body.qualificacao !== lead.qualificacao) {
    if (!CLASSES.includes(body.qualificacao)) return json({ error: 'Qualificação inválida' }, 400);
    set('qualificacao', body.qualificacao);
    eventos.push(['qualificacao', `Qualificação alterada manualmente: ${lead.qualificacao} → ${body.qualificacao}`]);
  }
  if (body.quente !== undefined) set('quente', body.quente ? 1 : 0);
  if (body.valor !== undefined) set('valor', body.valor === '' || body.valor === null ? null : Number(body.valor) || 0);
  for (const k of ['call_em', 'followup_em']) {
    if (body[k] !== undefined && (body[k] || null) !== lead[k]) {
      set(k, clip(body[k], 40));
      if (body[k]) eventos.push([k, (k === 'call_em' ? 'Call agendada para ' : 'Próximo follow-up em ') + body[k].replace('T', ' ')]);
    }
  }
  if (body.motivo_perda !== undefined) set('motivo_perda', clip(body.motivo_perda, 300));
  for (const k of EDITAVEIS) if (body[k] !== undefined) set(k, clip(body[k], k === 'mensagem' ? 2000 : 160));

  // Recalcula a classe automática se mudou faturamento/investimento.
  if (body.faturamento !== undefined || body.investimento !== undefined) {
    const q = qualificar({ faturamento: body.faturamento ?? lead.faturamento, investimento: body.investimento ?? lead.investimento });
    set('qualificacao_auto', q.classe); set('qualificacao_motivo', q.motivo);
    if (body.qualificacao === undefined && lead.qualificacao === lead.qualificacao_auto && q.classe !== lead.qualificacao) {
      set('qualificacao', q.classe);
      eventos.push(['qualificacao', `Qualificação automática: ${lead.qualificacao} → ${q.classe} (${q.motivo})`]);
    }
  }
  if (body.whatsapp !== undefined) set('telefone_digitos', String(body.whatsapp).replace(/\D/g, '').slice(-11));

  const ts = now();
  const stmts = [];
  if (sets.length) stmts.push(env.DB.prepare(`UPDATE leads SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...vals, ts, id));
  for (const [tipo, texto] of eventos) stmts.push(env.DB.prepare(`INSERT INTO eventos (lead_id, created_at, tipo, texto) VALUES (?, ?, ?, ?)`).bind(id, ts, tipo, texto));
  if (stmts.length) await env.DB.batch(stmts);
  return detalheLead(env, id);
}

async function criarLeadManual(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'JSON inválido' }, 400); }
  if (!clip(body.nome)) return json({ error: 'Informe o nome' }, 400);
  const lead = {};
  for (const k of EDITAVEIS) lead[k] = clip(body[k], k === 'mensagem' ? 2000 : 160);
  lead.origem = clip(body.origem, 80) || 'manual';
  lead.telefone_digitos = String(lead.whatsapp || '').replace(/\D/g, '').slice(-11);
  const q = qualificar(lead);
  const ts = now();
  const cols = Object.keys(lead);
  const res = await env.DB.prepare(
    `INSERT INTO leads (${cols.join(', ')}, created_at, updated_at, qualificacao, qualificacao_auto, qualificacao_motivo, quente, etapa)
     VALUES (${cols.map(() => '?').join(', ')}, ?, ?, ?, ?, ?, ?, 'novo')`
  ).bind(...cols.map(c => lead[c]), ts, ts, q.classe, q.classe, q.motivo, lead.prazo === 'Imediatamente' ? 1 : 0).run();
  const id = res.meta.last_row_id;
  await env.DB.prepare(`INSERT INTO eventos (lead_id, created_at, tipo, texto) VALUES (?, ?, 'criado', ?)`)
    .bind(id, ts, `Lead cadastrado manualmente (${lead.origem}). Qualificação automática: ${q.classe} (${q.motivo})`).run();
  return detalheLead(env, id);
}

async function adicionarNota(request, env, id) {
  let body = {};
  try { body = await request.json(); } catch {}
  const texto = clip(body.texto, 4000);
  if (!texto) return json({ error: 'Nota vazia' }, 400);
  const ts = now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO eventos (lead_id, created_at, tipo, texto) VALUES (?, ?, 'nota', ?)`).bind(id, ts, texto),
    env.DB.prepare(`UPDATE leads SET updated_at = ? WHERE id = ?`).bind(ts, id)
  ]);
  return detalheLead(env, id);
}

async function painel(env, url) {
  const de = url.searchParams.get('de'), ate = url.searchParams.get('ate');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(de || '') || !/^\d{4}-\d{2}-\d{2}$/.test(ate || '')) return json({ error: 'Período inválido' }, 400);
  // created_at é UTC; o dia do lead é calculado em UTC-3 no navegador, então buscamos com 1 dia de folga.
  const ini = new Date(Date.parse(de + 'T00:00:00Z') - 864e5).toISOString();
  const fim = new Date(Date.parse(ate + 'T00:00:00Z') + 2 * 864e5).toISOString();
  const [leads, visitas, inv, ev] = await env.DB.batch([
    env.DB.prepare(`SELECT id, created_at, qualificacao, etapa, valor, utm_source, utm_medium, utm_campaign, gclid, fbclid, referrer, origem
      FROM leads WHERE created_at >= ? AND created_at < ?`).bind(ini, fim),
    env.DB.prepare(`SELECT dia, canal, campanha, n FROM visitas_dia WHERE dia >= ? AND dia <= ?`).bind(de, ate),
    env.DB.prepare(`SELECT mes, canal, valor FROM investimentos ORDER BY mes DESC`),
    env.DB.prepare(`SELECT lead_id, texto FROM eventos WHERE tipo = 'etapa' AND lead_id IN (SELECT id FROM leads WHERE created_at >= ? AND created_at < ?)`).bind(ini, fim)
  ]);
  // Maior etapa já alcançada por lead (a partir do histórico), para o funil.
  const nomeParaId = Object.fromEntries(Object.entries(ETAPA_NOME).map(([k, v]) => [v, k]));
  const alcancou = {};
  for (const e of ev.results) {
    const m = String(e.texto).match(/→ (.+)$/);
    if (m && nomeParaId[m[1]]) (alcancou[e.lead_id] = alcancou[e.lead_id] || []).push(nomeParaId[m[1]]);
  }
  return json({
    leads: leads.results.map(l => ({ id: l.id, created_at: l.created_at, qualificacao: l.qualificacao, etapa: l.etapa, valor: l.valor,
      campanha: l.utm_campaign || '', canal: canalDe(l), etapas: alcancou[l.id] || [] })),
    visitas: visitas.results,
    investimentos: inv.results
  });
}

async function salvarInvestimento(request, env) {
  let b;
  try { b = await request.json(); } catch { return json({ error: 'JSON inválido' }, 400); }
  if (!/^\d{4}-\d{2}$/.test(b.mes || '') || !['google_ads', 'meta_ads', 'outros_ads'].includes(b.canal)) return json({ error: 'Dados inválidos' }, 400);
  const valor = Math.max(0, Number(b.valor) || 0);
  await env.DB.prepare(`INSERT INTO investimentos (mes, canal, valor) VALUES (?, ?, ?) ON CONFLICT (mes, canal) DO UPDATE SET valor = excluded.valor`)
    .bind(b.mes, b.canal, valor).run();
  const { results } = await env.DB.prepare(`SELECT mes, canal, valor FROM investimentos ORDER BY mes DESC`).all();
  return json({ investimentos: results });
}

async function exportarCsv(env) {
  const { results } = await env.DB.prepare(`SELECT * FROM leads ORDER BY created_at DESC`).all();
  const cols = ['id', 'created_at', 'nome', 'whatsapp', 'email', 'empresa', 'segmento', 'servico', 'faturamento', 'investimento',
    'prazo', 'qualificacao', 'etapa', 'valor', 'call_em', 'followup_em', 'motivo_perda', 'origem', 'utm_source', 'utm_medium',
    'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'mensagem'];
  const esc = v => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // evita fórmulas ao abrir no Excel
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const csv = '﻿' + [cols.join(';'), ...results.map(r => cols.map(c => esc(r[c])).join(';'))].join('\r\n');
  return new Response(csv, {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="leads-jftrafego.csv"`, 'cache-control': 'no-store' }
  });
}

async function api(request, env, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  await ensureSchema(env);

  if (path === '/api/leads' && method === 'POST') return criarLead(request, env);
  if (path === '/api/visita' && method === 'POST') return registrarVisita(request, env);
  if (path === '/api/login' && method === 'POST') return login(request, env);
  if (path === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
  }

  if (!path.startsWith('/api/admin')) return json({ error: 'Não encontrado' }, 404);
  if (!(await isAuthed(request, env))) return json({ error: 'Não autorizado' }, 401);
  // Escritas do admin só via JSON (bloqueia formulários de outros sites).
  if (method !== 'GET' && method !== 'DELETE' && !(request.headers.get('content-type') || '').includes('application/json')) {
    return json({ error: 'Content-Type inválido' }, 415);
  }

  if (path === '/api/admin/me') return json({ ok: true });
  if (path === '/api/admin/leads' && method === 'GET') return listarLeads(env);
  if (path === '/api/admin/leads' && method === 'POST') return criarLeadManual(request, env);
  if (path === '/api/admin/leads.csv' && method === 'GET') return exportarCsv(env);
  if (path === '/api/admin/painel' && method === 'GET') return painel(env, url);
  if (path === '/api/admin/investimentos' && method === 'PUT') return salvarInvestimento(request, env);

  const m = path.match(/^\/api\/admin\/leads\/(\d+)(\/notas)?$/);
  if (m) {
    const id = Number(m[1]);
    if (m[2] && method === 'POST') return adicionarNota(request, env, id);
    if (!m[2] && method === 'GET') return detalheLead(env, id);
    if (!m[2] && method === 'PATCH') return atualizarLead(request, env, id);
    if (!m[2] && method === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM eventos WHERE lead_id = ?`).bind(id),
        env.DB.prepare(`DELETE FROM leads WHERE id = ?`).bind(id)
      ]);
      return json({ ok: true });
    }
  }
  return json({ error: 'Não encontrado' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await api(request, env, url); }
      catch (e) { console.error(e); return json({ error: 'Erro interno' }, 500); }
    }
    const res = await env.ASSETS.fetch(request);
    if (url.pathname.startsWith('/admin')) {
      const h = new Headers(res.headers);
      h.set('x-robots-tag', 'noindex, nofollow');
      h.set('cache-control', 'no-store');
      return new Response(res.body, { status: res.status, headers: h });
    }
    return res;
  }
};
