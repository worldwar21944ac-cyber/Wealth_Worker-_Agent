/**
 * AI Search Worker v2.0 — Bervashun / KnockoutForever
 * =====================================================
 * Bindings:
 *   AI          — Workers AI (text embeddings + LLM)
 *   VECTORIZE   — Vectorize index (768-dim, cosine)
 *   SEARCH_DB   — D1 (bervashun-audit)
 *   SEARCH_ADMIN_KEY — secret
 *
 * Routes:
 *   POST /index              — ingest 1-50 docs (admin)
 *   DELETE /index/:id        — remove document (admin)
 *   POST /search             — semantic search
 *   GET  /search?q=          — browser semantic search
 *   POST /ai/ask             — RAG answer
 *   GET  /documents          — list indexed docs (admin)
 *   DELETE /documents        — purge all (admin)
 *   GET  /health             — liveness
 */

const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const LLM_MODEL   = '@cf/meta/llama-3.1-8b-instruct';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Search-Admin-Key',
};

// ─── helpers ────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function err(msg, status = 400) {
  return json({ error: msg, timestamp: new Date().toISOString() }, status);
}

function isAdmin(req, env) {
  const h = req.headers.get('X-Search-Admin-Key') || req.headers.get('Authorization')?.replace('Bearer ', '');
  return h === env.SEARCH_ADMIN_KEY;
}

async function ensureSchema(env) {
  await env.SEARCH_DB.exec(`
    CREATE TABLE IF NOT EXISTS search_documents (
      id          TEXT PRIMARY KEY,
      title       TEXT,
      content     TEXT NOT NULL,
      category    TEXT DEFAULT 'general',
      metadata    TEXT DEFAULT '{}',
      vector_id   TEXT,
      indexed_at  TEXT DEFAULT (datetime('now')),
      char_count  INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS search_queries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      query       TEXT NOT NULL,
      top_k       INTEGER DEFAULT 5,
      results     INTEGER DEFAULT 0,
      latency_ms  INTEGER,
      queried_at  TEXT DEFAULT (datetime('now'))
    );
  `);
}

function uid() {
  return crypto.randomUUID();
}

// ─── embedding ──────────────────────────────────────────────────────────────

async function embed(env, texts) {
  const resp = await env.AI.run(EMBED_MODEL, { text: Array.isArray(texts) ? texts : [texts] });
  return resp.data; // array of float32 arrays
}

// ─── routes ─────────────────────────────────────────────────────────────────

async function handleIndex(req, env) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);
  await ensureSchema(env);

  let body;
  try { body = await req.json(); } catch { return err('Invalid JSON'); }

  const docs = Array.isArray(body) ? body : body.documents ? body.documents : [body];
  if (!docs.length || docs.length > 50) return err('Provide 1-50 documents');

  // Validate
  for (const d of docs) {
    if (!d.content) return err('Each document needs a content field');
  }

  const results = [];
  const vectors = [];
  const dbRows  = [];

  // Generate embeddings in bulk
  const texts = docs.map(d => `${d.title ? d.title + ': ' : ''}${d.content}`.slice(0, 4096));
  let embeddings;
  try {
    embeddings = await embed(env, texts);
  } catch (e) {
    return err(`Embedding failed: ${e.message}`, 500);
  }

  const now = new Date().toISOString();
  for (let i = 0; i < docs.length; i++) {
    const d   = docs[i];
    const id  = d.id || uid();
    const vid = `doc-${id}`;
    vectors.push({
      id: vid,
      values: Array.from(embeddings[i]),
      metadata: {
        doc_id:   id,
        title:    d.title   || '',
        category: d.category || 'general',
      },
    });
    dbRows.push({ id, title: d.title || '', content: d.content, category: d.category || 'general', metadata: JSON.stringify(d.metadata || {}), vector_id: vid, char_count: d.content.length });
    results.push({ id, vector_id: vid, status: 'indexed' });
  }

  // Upsert into Vectorize
  try {
    await env.VECTORIZE.upsert(vectors);
  } catch (e) {
    return err(`Vectorize upsert failed: ${e.message}`, 500);
  }

  // Persist in D1
  for (const r of dbRows) {
    await env.SEARCH_DB.prepare(
      `INSERT OR REPLACE INTO search_documents (id, title, content, category, metadata, vector_id, indexed_at, char_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(r.id, r.title, r.content, r.category, r.metadata, r.vector_id, now, r.char_count).run();
  }

  return json({ indexed: results.length, documents: results, timestamp: now });
}

async function handleDeleteDoc(req, env, id) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);
  await ensureSchema(env);

  const row = await env.SEARCH_DB.prepare('SELECT vector_id FROM search_documents WHERE id = ?').bind(id).first();
  if (!row) return err('Document not found', 404);

  try { await env.VECTORIZE.deleteByIds([row.vector_id]); } catch {}
  await env.SEARCH_DB.prepare('DELETE FROM search_documents WHERE id = ?').bind(id).run();
  return json({ deleted: id, timestamp: new Date().toISOString() });
}

async function handleSearch(req, env) {
  await ensureSchema(env);
  const t0 = Date.now();

  let query, top_k = 5, threshold = 0.0, category;
  if (req.method === 'GET') {
    const u = new URL(req.url);
    query    = u.searchParams.get('q') || u.searchParams.get('query');
    top_k    = parseInt(u.searchParams.get('top_k') || '5', 10);
    threshold= parseFloat(u.searchParams.get('threshold') || '0');
    category = u.searchParams.get('category');
  } else {
    let body;
    try { body = await req.json(); } catch { return err('Invalid JSON'); }
    query     = body.query;
    top_k     = body.top_k     ?? 5;
    threshold = body.threshold ?? 0.0;
    category  = body.category;
  }

  if (!query || !query.trim()) return err('query is required');
  top_k = Math.min(Math.max(top_k, 1), 20);

  // Embed the query
  let qVec;
  try {
    const emb = await embed(env, query);
    qVec = Array.from(emb[0]);
  } catch (e) {
    return err(`Embedding failed: ${e.message}`, 500);
  }

  // Query Vectorize
  const vFilter  = category ? { category } : undefined;
  let vResults;
  try {
    vResults = await env.VECTORIZE.query(qVec, { topK: top_k * 2, filter: vFilter, returnMetadata: 'all' });
  } catch (e) {
    return err(`Vector query failed: ${e.message}`, 500);
  }

  const matches = (vResults.matches || []).filter(m => m.score >= threshold);

  // Fetch full content from D1
  const results = [];
  for (const m of matches.slice(0, top_k)) {
    const meta = m.metadata || {};
    const row  = await env.SEARCH_DB.prepare(
      'SELECT id, title, content, category, metadata, indexed_at FROM search_documents WHERE id = ?'
    ).bind(meta.doc_id || '').first();

    results.push({
      id:         meta.doc_id,
      title:      meta.title || row?.title || '',
      score:      Math.round(m.score * 10000) / 10000,
      category:   meta.category || row?.category || 'general',
      excerpt:    row ? row.content.slice(0, 300) + (row.content.length > 300 ? '…' : '') : '',
      indexed_at: row?.indexed_at,
    });
  }

  const latency = Date.now() - t0;

  // Log query
  try {
    await env.SEARCH_DB.prepare(
      'INSERT INTO search_queries (query, top_k, results, latency_ms) VALUES (?, ?, ?, ?)'
    ).bind(query, top_k, results.length, latency).run();
  } catch {}

  return json({
    query,
    results,
    count:      results.length,
    latency_ms: latency,
    timestamp:  new Date().toISOString(),
  });
}

async function handleAsk(req, env) {
  await ensureSchema(env);
  const t0 = Date.now();

  let body;
  try { body = await req.json(); } catch { return err('Invalid JSON'); }
  const { question, top_k = 5, category } = body;
  if (!question || !question.trim()) return err('question is required');

  // Semantic search first
  let qVec;
  try {
    const emb = await embed(env, question);
    qVec = Array.from(emb[0]);
  } catch (e) {
    return err(`Embedding failed: ${e.message}`, 500);
  }

  const vFilter = category ? { category } : undefined;
  let vResults;
  try {
    vResults = await env.VECTORIZE.query(qVec, { topK: top_k, filter: vFilter, returnMetadata: 'all' });
  } catch (e) {
    return err(`Vector query failed: ${e.message}`, 500);
  }

  const matches = vResults.matches || [];

  // Fetch full content for context
  const contexts = [];
  for (const m of matches) {
    const meta = m.metadata || {};
    const row  = await env.SEARCH_DB.prepare(
      'SELECT title, content FROM search_documents WHERE id = ?'
    ).bind(meta.doc_id || '').first();
    if (row) {
      contexts.push(`[${row.title || 'Document'}]\n${row.content.slice(0, 1500)}`);
    }
  }

  const ctxText = contexts.length
    ? contexts.join('\n\n---\n\n')
    : 'No relevant documents found in the knowledge base.';

  const systemPrompt = `You are a helpful AI assistant with access to a knowledge base. 
Answer the user's question based on the provided context documents. 
Be accurate, concise, and cite which document your answer comes from when possible.
If the context doesn't contain enough information, say so clearly.`;

  const userPrompt = `Context documents:\n${ctxText}\n\n---\n\nQuestion: ${question}`;

  let answer;
  try {
    const llmResp = await env.AI.run(LLM_MODEL, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      max_tokens: 1024,
      temperature: 0.3,
    });
    answer = llmResp.response || llmResp.result || JSON.stringify(llmResp);
  } catch (e) {
    return err(`LLM inference failed: ${e.message}`, 500);
  }

  const latency = Date.now() - t0;

  // Log as search query
  try {
    await env.SEARCH_DB.prepare(
      'INSERT INTO search_queries (query, top_k, results, latency_ms) VALUES (?, ?, ?, ?)'
    ).bind(question, top_k, matches.length, latency).run();
  } catch {}

  return json({
    question,
    answer,
    sources: matches.map(m => ({
      id:    m.metadata?.doc_id,
      title: m.metadata?.title || '',
      score: Math.round(m.score * 10000) / 10000,
    })),
    latency_ms: latency,
    timestamp:  new Date().toISOString(),
  });
}

async function handleListDocuments(req, env) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);
  await ensureSchema(env);
  const u      = new URL(req.url);
  const page   = parseInt(u.searchParams.get('page') || '1', 10);
  const limit  = Math.min(parseInt(u.searchParams.get('limit') || '50', 10), 200);
  const offset = (page - 1) * limit;

  const rows  = await env.SEARCH_DB.prepare(
    'SELECT id, title, category, char_count, indexed_at FROM search_documents ORDER BY indexed_at DESC LIMIT ? OFFSET ?'
  ).bind(limit, offset).all();
  const total = await env.SEARCH_DB.prepare('SELECT COUNT(*) as n FROM search_documents').first();

  return json({ documents: rows.results, total: total?.n ?? 0, page, limit });
}

async function handlePurge(req, env) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);
  await ensureSchema(env);

  // Get all vector IDs to delete from Vectorize
  const rows = await env.SEARCH_DB.prepare('SELECT vector_id FROM search_documents').all();
  const vids = (rows.results || []).map(r => r.vector_id).filter(Boolean);
  if (vids.length) {
    try { await env.VECTORIZE.deleteByIds(vids); } catch {}
  }

  await env.SEARCH_DB.exec('DELETE FROM search_documents; DELETE FROM search_queries;');
  return json({ purged: vids.length, timestamp: new Date().toISOString() });
}

async function handleHealth(req, env) {
  let dbOk = false;
  try {
    await env.SEARCH_DB.prepare('SELECT 1').first();
    dbOk = true;
  } catch {}

  let vectorizeOk = false;
  try {
    // cheap describe call
    const desc = await env.VECTORIZE.describe();
    vectorizeOk = !!desc;
  } catch {}

  return json({
    status:       'ok',
    version:      '2.0.0',
    service:      'ai-search',
    components: {
      d1:        dbOk        ? 'healthy' : 'degraded',
      vectorize: vectorizeOk ? 'healthy' : 'degraded',
      workers_ai: 'unknown', // only testable on actual embed call
    },
    timestamp: new Date().toISOString(),
  });
}

// ─── router ─────────────────────────────────────────────────────────────────

export default {
  async fetch(req, env, ctx) {
    const url    = new URL(req.url);
    const path   = url.pathname;
    const method = req.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // POST /index
    if (method === 'POST' && path === '/index') return handleIndex(req, env);

    // DELETE /index/:id
    if (method === 'DELETE' && path.startsWith('/index/')) {
      const id = path.replace('/index/', '');
      return handleDeleteDoc(req, env, id);
    }

    // POST /search  or  GET /search?q=
    if (path === '/search' && (method === 'GET' || method === 'POST')) return handleSearch(req, env);

    // POST /ai/ask
    if (method === 'POST' && path === '/ai/ask') return handleAsk(req, env);

    // GET /documents
    if (method === 'GET' && path === '/documents') return handleListDocuments(req, env);

    // DELETE /documents  (purge all)
    if (method === 'DELETE' && path === '/documents') return handlePurge(req, env);

    // GET /health
    if (method === 'GET' && path === '/health') return handleHealth(req, env);

    // 404
    return json({
      error:    'Not Found',
      routes: [
        'GET  /health',
        'POST /index',
        'DELETE /index/:id',
        'POST /search',
        'GET  /search?q=<query>',
        'POST /ai/ask',
        'GET  /documents   (admin)',
        'DELETE /documents  (admin, purge all)',
      ],
    }, 404);
  },
};
