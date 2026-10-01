/**
 * AI Search Worker v2.0 — Bervashun / Knockoutforever
 * Cloudflare Worker with Vectorize + Workers AI + D1
 *
 * Routes:
 *   POST /index               — ingest 1-50 docs (admin X-Search-Admin-Key)
 *   DELETE /index/:id         — remove document (admin)
 *   POST /search              — semantic search { query, top_k?, threshold?, category? }
 *   GET  /search?q=           — browser-friendly semantic search
 *   POST /ai/ask              — RAG answer { question, top_k?, category? }
 *   GET  /ai/ask?q=           — browser-friendly RAG
 *   GET  /documents           — list indexed docs (admin)
 *   DELETE /documents         — purge all (admin)
 *   GET  /health              — liveness (unauthenticated)
 *
 * Bindings:
 *   AI           — Workers AI binding
 *   VECTORIZE    — Vectorize index (ai-search-index, 768-dim cosine)
 *   SEARCH_DB    — D1 database (bervashun-audit)
 *   SEARCH_ADMIN_KEY — secret
 */

const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const LLM_MODEL   = '@cf/meta/llama-3.1-8b-instruct';
const EMBED_DIMS  = 768;

// ─────────────────────────────────────────────
// CORS helpers
// ─────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Search-Admin-Key,Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(msg, status = 400) {
  return json({ error: msg, ok: false }, status);
}

// ─────────────────────────────────────────────
// Schema bootstrap (idempotent)
// ─────────────────────────────────────────────
async function ensureSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS search_documents (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      content     TEXT NOT NULL,
      category    TEXT DEFAULT 'general',
      metadata    TEXT DEFAULT '{}',
      indexed_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_search_docs_category ON search_documents(category);
    CREATE INDEX IF NOT EXISTS idx_search_docs_indexed  ON search_documents(indexed_at DESC);
  `);
}

// ─────────────────────────────────────────────
// Auth helpers
// ─────────────────────────────────────────────
function isAdmin(req, env) {
  const key =
    req.headers.get('X-Search-Admin-Key') ||
    (req.headers.get('Authorization') || '').replace(/^Bearer\s+/, '');
  return key === env.SEARCH_ADMIN_KEY;
}

// ─────────────────────────────────────────────
// Embedding helper
// ─────────────────────────────────────────────
async function embed(text, env) {
  const resp = await env.AI.run(EMBED_MODEL, { text: [text] });
  return resp.data[0]; // Float32Array / number[]
}

// ─────────────────────────────────────────────
// Document ID — deterministic from title+content
// ─────────────────────────────────────────────
async function makeDocId(title, content) {
  const raw = title + '::' + content.slice(0, 256);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// ─────────────────────────────────────────────
// Chunk large content
// ─────────────────────────────────────────────
function chunkText(text, maxChars = 1500) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf(' ', end);
      if (boundary > start) end = boundary;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks.filter(Boolean);
}

// ─────────────────────────────────────────────
// HANDLER: POST /index
// ─────────────────────────────────────────────
async function handleIndex(req, env) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);

  let body;
  try { body = await req.json(); } catch { return err('Invalid JSON'); }

  const docs = Array.isArray(body) ? body : body.documents ? body.documents : [body];
  if (!docs.length || docs.length > 50) return err('Provide 1–50 documents');

  await ensureSchema(env.SEARCH_DB);

  const results = [];
  for (const doc of docs) {
    if (!doc.title || !doc.content) {
      results.push({ ok: false, error: 'Missing title or content', doc });
      continue;
    }

    const id = doc.id || (await makeDocId(doc.title, doc.content));
    const category = doc.category || 'general';
    const metadata = doc.metadata || {};
    const chunks = chunkText(doc.content);

    // Upsert into D1
    await env.SEARCH_DB.prepare(
      `INSERT OR REPLACE INTO search_documents (id, title, content, category, metadata, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, doc.title, doc.content, category, JSON.stringify(metadata), Date.now()).run();

    // Embed each chunk and upsert into Vectorize
    const vectors = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = `${doc.title}\n\n${chunks[i]}`;
      const vector = await embed(chunkText, env);
      vectors.push({
        id: chunks.length > 1 ? `${id}_chunk${i}` : id,
        values: Array.from(vector),
        metadata: {
          doc_id: id,
          title: doc.title,
          category,
          chunk_index: i,
          total_chunks: chunks.length,
        },
      });
    }

    await env.VECTORIZE.upsert(vectors);
    results.push({ ok: true, id, title: doc.title, chunks: chunks.length });
  }

  return json({ ok: true, indexed: results.filter(r => r.ok).length, results });
}

// ─────────────────────────────────────────────
// HANDLER: DELETE /index/:id
// ─────────────────────────────────────────────
async function handleDeleteDoc(req, env, id) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);
  await ensureSchema(env.SEARCH_DB);

  // Delete from D1
  await env.SEARCH_DB.prepare('DELETE FROM search_documents WHERE id = ?').bind(id).run();

  // Delete all chunks from Vectorize
  try {
    await env.VECTORIZE.deleteByIds([id, ...Array.from({ length: 20 }, (_, i) => `${id}_chunk${i}`)]);
  } catch (_) {/* Vectorize delete is best-effort */}

  return json({ ok: true, deleted: id });
}

// ─────────────────────────────────────────────
// HANDLER: POST /search  or  GET /search?q=
// ─────────────────────────────────────────────
async function handleSearch(req, env) {
  await ensureSchema(env.SEARCH_DB);

  let query, top_k = 10, threshold = 0.5, category;

  if (req.method === 'GET') {
    const url = new URL(req.url);
    query = url.searchParams.get('q') || '';
    top_k = parseInt(url.searchParams.get('top_k') || '10', 10);
    threshold = parseFloat(url.searchParams.get('threshold') || '0.5');
    category = url.searchParams.get('category') || undefined;
  } else {
    let body;
    try { body = await req.json(); } catch { return err('Invalid JSON'); }
    query = body.query || body.q || '';
    top_k = body.top_k || 10;
    threshold = body.threshold ?? 0.5;
    category = body.category;
  }

  if (!query.trim()) return err('Missing query');
  top_k = Math.min(Math.max(top_k, 1), 50);

  const queryVector = await embed(query, env);

  const vectorFilter = category ? { category: { $eq: category } } : undefined;
  const vectorResults = await env.VECTORIZE.query(Array.from(queryVector), {
    topK: top_k * 2, // over-fetch to account for chunk dedup
    returnMetadata: 'indexed',
    filter: vectorFilter,
  });

  // Deduplicate by doc_id, keep best score per doc
  const seen = new Map();
  for (const match of vectorResults.matches || []) {
    if (match.score < threshold) continue;
    const docId = match.metadata?.doc_id || match.id;
    if (!seen.has(docId) || seen.get(docId).score < match.score) {
      seen.set(docId, { score: match.score, meta: match.metadata });
    }
  }

  // Sort by score desc, limit to top_k
  const ranked = [...seen.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, top_k);

  if (!ranked.length) {
    return json({ ok: true, query, results: [], total: 0 });
  }

  // Fetch full docs from D1
  const ids = ranked.map(([id]) => id);
  const placeholders = ids.map(() => '?').join(',');
  const { results: dbRows } = await env.SEARCH_DB.prepare(
    `SELECT id, title, content, category, metadata, indexed_at FROM search_documents WHERE id IN (${placeholders})`
  ).bind(...ids).all();

  const docMap = new Map(dbRows.map(r => [r.id, r]));

  const output = ranked.map(([id, { score }]) => {
    const doc = docMap.get(id) || {};
    return {
      id,
      score: Math.round(score * 1000) / 1000,
      title: doc.title || 'Unknown',
      excerpt: (doc.content || '').slice(0, 300) + ((doc.content || '').length > 300 ? '…' : ''),
      category: doc.category || 'general',
      metadata: JSON.parse(doc.metadata || '{}'),
      indexed_at: doc.indexed_at,
    };
  });

  return json({ ok: true, query, results: output, total: output.length });
}

// ─────────────────────────────────────────────
// HANDLER: POST /ai/ask  or  GET /ai/ask?q=
// ─────────────────────────────────────────────
async function handleAsk(req, env) {
  await ensureSchema(env.SEARCH_DB);

  let question, top_k = 5, category;

  if (req.method === 'GET') {
    const url = new URL(req.url);
    question = url.searchParams.get('q') || '';
    top_k = parseInt(url.searchParams.get('top_k') || '5', 10);
    category = url.searchParams.get('category') || undefined;
  } else {
    let body;
    try { body = await req.json(); } catch { return err('Invalid JSON'); }
    question = body.question || body.q || body.query || '';
    top_k = body.top_k || 5;
    category = body.category;
  }

  if (!question.trim()) return err('Missing question');
  top_k = Math.min(Math.max(top_k, 1), 20);

  // Step 1: Semantic search
  const queryVector = await embed(question, env);
  const vectorFilter = category ? { category: { $eq: category } } : undefined;
  const vectorResults = await env.VECTORIZE.query(Array.from(queryVector), {
    topK: top_k * 2,
    returnMetadata: 'indexed',
    filter: vectorFilter,
  });

  // Deduplicate docs
  const seen = new Map();
  for (const match of vectorResults.matches || []) {
    if (match.score < 0.4) continue;
    const docId = match.metadata?.doc_id || match.id;
    if (!seen.has(docId) || seen.get(docId) < match.score) {
      seen.set(docId, match.score);
    }
  }

  const ranked = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, top_k);
  let context = '';
  let sources = [];

  if (ranked.length > 0) {
    const ids = ranked.map(([id]) => id);
    const placeholders = ids.map(() => '?').join(',');
    const { results: dbRows } = await env.SEARCH_DB.prepare(
      `SELECT id, title, content, category FROM search_documents WHERE id IN (${placeholders})`
    ).bind(...ids).all();

    const docMap = new Map(dbRows.map(r => [r.id, r]));
    sources = ranked.map(([id, score]) => {
      const doc = docMap.get(id) || {};
      return { id, title: doc.title || 'Unknown', category: doc.category, score };
    });

    context = ranked
      .map(([id]) => {
        const doc = docMap.get(id);
        if (!doc) return '';
        return `### ${doc.title}\n${doc.content.slice(0, 1200)}`;
      })
      .filter(Boolean)
      .join('\n\n---\n\n');
  }

  // Step 2: Generate answer with LLM
  const systemPrompt = context
    ? `You are a helpful AI assistant for Bervashun / Knockoutforever. Answer the user's question based on the provided context. Be concise, accurate, and cite relevant sections when possible. If the context doesn't contain the answer, say so clearly.`
    : `You are a helpful AI assistant. Answer the user's question to the best of your ability.`;

  const userMessage = context
    ? `Context:\n${context}\n\n---\n\nQuestion: ${question}`
    : question;

  const llmResp = await env.AI.run(LLM_MODEL, {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    max_tokens: 1024,
    temperature: 0.3,
  });

  const answer = llmResp.response || llmResp.result?.response || 'Unable to generate answer.';

  return json({
    ok: true,
    question,
    answer,
    sources,
    context_used: ranked.length > 0,
  });
}

// ─────────────────────────────────────────────
// HANDLER: GET /documents  (admin)
// ─────────────────────────────────────────────
async function handleListDocs(req, env) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);
  await ensureSchema(env.SEARCH_DB);

  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const category = url.searchParams.get('category');

  let stmt;
  if (category) {
    stmt = env.SEARCH_DB.prepare(
      `SELECT id, title, category, LENGTH(content) as content_length, metadata, indexed_at
       FROM search_documents WHERE category = ? ORDER BY indexed_at DESC LIMIT ? OFFSET ?`
    ).bind(category, limit, offset);
  } else {
    stmt = env.SEARCH_DB.prepare(
      `SELECT id, title, category, LENGTH(content) as content_length, metadata, indexed_at
       FROM search_documents ORDER BY indexed_at DESC LIMIT ? OFFSET ?`
    ).bind(limit, offset);
  }

  const { results } = await stmt.all();
  const { results: countRes } = await env.SEARCH_DB.prepare(
    `SELECT COUNT(*) as total FROM search_documents${category ? ' WHERE category = ?' : ''}`
  ).bind(...(category ? [category] : [])).all();

  return json({
    ok: true,
    total: countRes[0]?.total || 0,
    limit,
    offset,
    documents: results.map(r => ({
      ...r,
      metadata: JSON.parse(r.metadata || '{}'),
    })),
  });
}

// ─────────────────────────────────────────────
// HANDLER: DELETE /documents  (admin purge-all)
// ─────────────────────────────────────────────
async function handlePurgeDocs(req, env) {
  if (!isAdmin(req, env)) return err('Unauthorized', 401);
  await ensureSchema(env.SEARCH_DB);
  await env.SEARCH_DB.prepare('DELETE FROM search_documents').run();
  // Vectorize doesn't have a bulk-delete endpoint; docs will become stale (orphaned)
  return json({ ok: true, message: 'All documents purged from D1. Vectorize vectors are stale until re-indexed.' });
}

// ─────────────────────────────────────────────
// HANDLER: GET /health
// ─────────────────────────────────────────────
async function handleHealth(env) {
  let dbOk = false;
  let docCount = 0;
  try {
    await ensureSchema(env.SEARCH_DB);
    const { results } = await env.SEARCH_DB.prepare('SELECT COUNT(*) as c FROM search_documents').all();
    docCount = results[0]?.c || 0;
    dbOk = true;
  } catch (_) {}

  return json({
    ok: true,
    status: 'healthy',
    version: '2.0',
    service: 'ai-search',
    worker: 'ai-search',
    db: dbOk ? 'connected' : 'error',
    documents_indexed: docCount,
    models: {
      embedding: EMBED_MODEL,
      llm: LLM_MODEL,
      dimensions: EMBED_DIMS,
    },
    ts: new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────
// MAIN FETCH HANDLER
// ─────────────────────────────────────────────
export default {
  async fetch(request, env) {
    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    const method = request.method;

    try {
      // Health
      if (path === '/health' && method === 'GET') return handleHealth(env);

      // Indexing
      if (path === '/index' && method === 'POST') return handleIndex(request, env);

      // Delete single doc
      const delMatch = path.match(/^\/index\/(.+)$/);
      if (delMatch && method === 'DELETE') return handleDeleteDoc(request, env, delMatch[1]);

      // Search
      if (path === '/search' && (method === 'GET' || method === 'POST')) return handleSearch(request, env);

      // AI ask / RAG
      if (path === '/ai/ask' && (method === 'GET' || method === 'POST')) return handleAsk(request, env);

      // List documents (admin)
      if (path === '/documents' && method === 'GET') return handleListDocs(request, env);

      // Purge all (admin)
      if (path === '/documents' && method === 'DELETE') return handlePurgeDocs(request, env);

      // Root — mini API reference
      if (path === '/' || path === '') {
        return json({
          service: 'AI Search',
          version: '2.0',
          endpoints: {
            'POST /index': 'Ingest documents (admin)',
            'DELETE /index/:id': 'Remove a document (admin)',
            'POST /search': 'Semantic search { query, top_k?, threshold?, category? }',
            'GET /search?q=': 'Semantic search (browser)',
            'POST /ai/ask': 'RAG answer { question, top_k?, category? }',
            'GET /ai/ask?q=': 'RAG answer (browser)',
            'GET /documents': 'List indexed docs (admin)',
            'DELETE /documents': 'Purge all docs (admin)',
            'GET /health': 'Liveness check',
          },
        });
      }

      return err('Not found', 404);
    } catch (e) {
      console.error('ai-search error:', e);
      return err('Internal server error: ' + (e?.message || 'unknown'), 500);
    }
  },
};
