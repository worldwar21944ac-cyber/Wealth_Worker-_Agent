/**
 * AI Search Worker v3.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Cloudflare Worker — zero npm, no bundler needed.
 *
 * Bindings required (set in wrangler.toml or CF dashboard):
 *   AI            → Workers AI (automatic)
 *   VECTORIZE     → ai-search-index (768-dim, cosine)
 *   SEARCH_DB     → D1 database (bervashun-audit)
 *   SEARCH_ADMIN_KEY → Secret (e.g. "search-admin-bervashun-2026")
 *
 * Routes:
 *   GET  /                         → Browser UI
 *   GET  /health                   → Liveness (unauth)
 *   POST /index                    → Ingest 1–50 docs (admin)
 *   DELETE /index/:id              → Remove doc by ID (admin)
 *   POST /search                   → Semantic search { query, top_k?, threshold?, category?, mode? }
 *   GET  /search?q=                → Browser-friendly semantic search
 *   POST /ai/ask                   → RAG: retrieve context + LLM generate
 *   GET  /documents                → List indexed docs (admin, ?limit=&offset=&category=)
 *   DELETE /documents              → Purge ALL docs + vectors (admin)
 *   GET  /stats                    → Index stats (admin)
 *   POST /ai/summarize             → Summarize a document by ID
 *   GET  /api/search               → JSON alias for GET /search (CORS-friendly)
 */

const VERSION = "3.0.0";
const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const LLM_MODEL  = "@cf/meta/llama-3.1-8b-instruct";
const MAX_INGEST  = 50;
const DEFAULT_TOP_K = 8;
const DEFAULT_THRESHOLD = 0.35;

// ─── Helpers ────────────────────────────────────────────────────────────────

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Search-Admin-Key",
      ...extra,
    },
  });

const err = (msg, status = 400) => json({ error: msg, version: VERSION }, status);

const isAdmin = (req, env) => {
  const key = env.SEARCH_ADMIN_KEY || "";
  if (!key) return false;
  const auth = req.headers.get("Authorization") || "";
  const hdr  = req.headers.get("X-Search-Admin-Key") || "";
  return hdr === key || auth === `Bearer ${key}`;
};

const requireAdmin = (req, env) => {
  if (!isAdmin(req, env)) return err("Unauthorized — supply X-Search-Admin-Key or Bearer token", 401);
  return null;
};

const slugify = (str) =>
  str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 64);

// Stable deterministic ID from content hash
async function contentId(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── D1 Bootstrap ───────────────────────────────────────────────────────────

async function ensureSchema(env) {
  await env.SEARCH_DB.exec(`
    CREATE TABLE IF NOT EXISTS search_documents (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      content     TEXT NOT NULL,
      category    TEXT DEFAULT 'general',
      url         TEXT,
      author      TEXT,
      tags        TEXT,
      metadata    TEXT,
      word_count  INTEGER DEFAULT 0,
      indexed_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sd_category ON search_documents(category);
    CREATE INDEX IF NOT EXISTS idx_sd_indexed  ON search_documents(indexed_at);
  `);
}

// ─── Embedding ──────────────────────────────────────────────────────────────

async function embed(env, text) {
  const result = await env.AI.run(EMBED_MODEL, { text: [text.slice(0, 2048)] });
  return result.data[0];
}

// ─── Search Logic ───────────────────────────────────────────────────────────

async function semanticSearch(env, query, { topK = DEFAULT_TOP_K, threshold = DEFAULT_THRESHOLD, category } = {}) {
  const vector = await embed(env, query);

  const filter = category ? { category: { $eq: category } } : undefined;
  const vRes = await env.VECTORIZE.query(vector, {
    topK: Math.min(topK, 20),
    returnMetadata: "all",
    ...(filter ? { filter } : {}),
  });

  const matches = (vRes.matches || []).filter((m) => m.score >= threshold);

  // Fetch full content from D1 for matched IDs
  if (!matches.length) return [];

  const ids = matches.map((m) => `'${m.id}'`).join(",");
  const { results } = await env.SEARCH_DB.prepare(
    `SELECT id, title, content, category, url, author, tags, metadata, indexed_at FROM search_documents WHERE id IN (${ids})`
  ).all();

  const byId = Object.fromEntries(results.map((r) => [r.id, r]));

  return matches.map((m) => ({
    id:       m.id,
    score:    parseFloat(m.score.toFixed(4)),
    title:    byId[m.id]?.title    ?? m.metadata?.title    ?? "Untitled",
    snippet:  (byId[m.id]?.content ?? "").slice(0, 300) + "…",
    category: byId[m.id]?.category ?? m.metadata?.category ?? "general",
    url:      byId[m.id]?.url      ?? m.metadata?.url      ?? null,
    author:   byId[m.id]?.author   ?? m.metadata?.author   ?? null,
    tags:     byId[m.id]?.tags     ?? null,
    indexed_at: byId[m.id]?.indexed_at ?? null,
  })).filter((r) => byId[r.id]); // only return rows that exist in D1
}

// ─── RAG ────────────────────────────────────────────────────────────────────

async function ragAnswer(env, question, { topK = 5, category } = {}) {
  const results = await semanticSearch(env, question, { topK, category });

  const context = results
    .slice(0, 5)
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}`)
    .join("\n\n");

  if (!context.trim()) {
    return {
      answer: "I couldn't find relevant documents to answer your question. Try indexing some content first.",
      sources: [],
    };
  }

  const messages = [
    {
      role: "system",
      content: `You are an expert AI assistant with access to a curated knowledge base.
Use ONLY the provided context to answer. Be concise, factual, and cite sources by their [N] reference.
If the context doesn't contain enough info, say so clearly. Never fabricate facts.`,
    },
    {
      role: "user",
      content: `Context:\n${context}\n\nQuestion: ${question}`,
    },
  ];

  const llmRes = await env.AI.run(LLM_MODEL, { messages, max_tokens: 512 });

  return {
    answer:  llmRes.response?.trim() ?? "Unable to generate an answer.",
    sources: results.slice(0, 5).map(({ id, title, score, url, category }) => ({ id, title, score, url, category })),
    model:   LLM_MODEL,
    context_docs: results.length,
  };
}

// ─── Browser UI ─────────────────────────────────────────────────────────────

const HTML_UI = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AI Search — Bervashun</title>
<style>
  :root {
    --bg:#0a0a0f; --surface:#13131a; --border:#1e1e2e; --accent:#7c3aed;
    --accent2:#06b6d4; --text:#e2e8f0; --muted:#64748b; --radius:12px;
    --glow:0 0 24px rgba(124,58,237,.35);
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;min-height:100vh}
  header{background:linear-gradient(135deg,#1a0533 0%,#0d1f3c 100%);border-bottom:1px solid var(--border);padding:20px 32px;display:flex;align-items:center;gap:16px}
  .logo{width:40px;height:40px;background:linear-gradient(135deg,var(--accent),var(--accent2));border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;box-shadow:var(--glow)}
  header h1{font-size:1.4rem;font-weight:700;background:linear-gradient(90deg,#a78bfa,#67e8f9);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  header small{color:var(--muted);font-size:.75rem;margin-left:auto}
  .container{max-width:900px;margin:0 auto;padding:40px 24px}
  .search-box{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:6px 8px;display:flex;gap:8px;box-shadow:var(--glow);margin-bottom:24px}
  .search-box input{flex:1;background:transparent;border:none;outline:none;color:var(--text);font-size:1rem;padding:10px 12px}
  .search-box input::placeholder{color:var(--muted)}
  .btn{padding:10px 20px;border:none;border-radius:8px;cursor:pointer;font-size:.875rem;font-weight:600;transition:.2s}
  .btn-primary{background:linear-gradient(135deg,var(--accent),#5b21b6);color:#fff}
  .btn-primary:hover{filter:brightness(1.15)}
  .btn-secondary{background:var(--border);color:var(--text)}
  .btn-danger{background:#7f1d1d;color:#fca5a5}
  .controls{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:28px;align-items:center}
  select,input[type=number]{background:var(--surface);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:8px;font-size:.875rem;outline:none}
  .tabs{display:flex;gap:2px;margin-bottom:28px;background:var(--surface);border-radius:10px;padding:4px;border:1px solid var(--border)}
  .tab{flex:1;padding:8px 16px;border:none;background:transparent;color:var(--muted);border-radius:8px;cursor:pointer;font-size:.875rem;font-weight:500;transition:.2s;text-align:center}
  .tab.active{background:var(--accent);color:#fff}
  .panel{display:none}.panel.active{display:block}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:14px;transition:.2s}
  .card:hover{border-color:var(--accent);box-shadow:0 0 16px rgba(124,58,237,.2)}
  .card-title{font-size:1rem;font-weight:600;margin-bottom:6px;color:#c4b5fd}
  .card-meta{font-size:.75rem;color:var(--muted);margin-bottom:10px;display:flex;gap:12px;flex-wrap:wrap}
  .badge{background:rgba(124,58,237,.2);color:#a78bfa;padding:2px 8px;border-radius:20px;font-size:.7rem}
  .score-bar{height:4px;background:var(--border);border-radius:2px;margin-top:10px;overflow:hidden}
  .score-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));transition:.5s}
  .snippet{font-size:.875rem;color:#94a3b8;line-height:1.6}
  .ai-box{background:linear-gradient(135deg,#1a0533,#0d1f3c);border:1px solid #4c1d95;border-radius:var(--radius);padding:24px;margin-bottom:24px}
  .ai-label{font-size:.75rem;font-weight:700;color:#7c3aed;letter-spacing:.1em;text-transform:uppercase;margin-bottom:10px;display:flex;align-items:center;gap:6px}
  .ai-answer{font-size:.95rem;line-height:1.75;white-space:pre-wrap}
  .sources{margin-top:14px}
  .source-chip{display:inline-flex;align-items:center;gap:6px;background:rgba(6,182,212,.1);border:1px solid rgba(6,182,212,.2);color:#67e8f9;border-radius:20px;padding:3px 10px;font-size:.75rem;margin:2px;text-decoration:none}
  .empty{text-align:center;color:var(--muted);padding:60px 0}
  .empty svg{margin-bottom:12px;opacity:.4}
  textarea{width:100%;background:var(--surface);border:1px solid var(--border);color:var(--text);padding:14px;border-radius:10px;font-size:.875rem;resize:vertical;outline:none;font-family:inherit;line-height:1.6}
  textarea::placeholder{color:var(--muted)}
  .ingest-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
  @media(max-width:600px){.ingest-row{grid-template-columns:1fr}}
  .progress{display:none;margin-top:12px;font-size:.875rem;color:var(--accent2)}
  .stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:24px}
  .stat-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:18px;text-align:center}
  .stat-val{font-size:2rem;font-weight:700;background:linear-gradient(90deg,#a78bfa,#67e8f9);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .stat-lbl{font-size:.75rem;color:var(--muted);margin-top:4px}
  .spinner{display:inline-block;width:16px;height:16px;border:2px solid rgba(124,58,237,.3);border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite;vertical-align:middle}
  @keyframes spin{to{transform:rotate(360deg)}}
  input[type=text],input[type=url]{background:var(--surface);border:1px solid var(--border);color:var(--text);padding:10px 12px;border-radius:8px;font-size:.875rem;width:100%;outline:none}
  label{display:block;font-size:.8rem;color:var(--muted);margin-bottom:4px;margin-top:10px}
  .doc-list-item{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border)}
  .doc-del{background:transparent;border:1px solid #7f1d1d;color:#fca5a5;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:.75rem}
</style>
</head>
<body>
<header>
  <div class="logo">🔍</div>
  <div>
    <h1>AI Search</h1>
    <div style="font-size:.75rem;color:#94a3b8">Powered by Workers AI · Vectorize · D1</div>
  </div>
  <small>v3.0 · Bervashun</small>
</header>

<div class="container">
  <!-- Search Bar -->
  <div class="search-box">
    <input id="q" type="text" placeholder="Ask anything or enter search terms…" autocomplete="off"/>
    <button class="btn btn-secondary" onclick="doSearch()" style="background:var(--border)">Search</button>
    <button class="btn btn-primary" onclick="doAsk()">✨ AI Answer</button>
  </div>

  <!-- Controls -->
  <div class="controls">
    <div>
      <label style="display:inline;margin:0;margin-right:6px">Category:</label>
      <select id="cat">
        <option value="">All</option>
        <option value="general">General</option>
        <option value="legal">Legal</option>
        <option value="finance">Finance</option>
        <option value="kyc">KYC / Compliance</option>
        <option value="banking">Banking</option>
        <option value="tech">Technology</option>
        <option value="docs">Documentation</option>
      </select>
    </div>
    <div>
      <label style="display:inline;margin:0;margin-right:6px">Results:</label>
      <select id="topk">
        <option value="5">5</option>
        <option value="8" selected>8</option>
        <option value="12">12</option>
        <option value="20">20</option>
      </select>
    </div>
    <div>
      <label style="display:inline;margin:0;margin-right:6px">Min Score:</label>
      <input type="number" id="thresh" value="0.35" min="0" max="1" step="0.05" style="width:80px"/>
    </div>
  </div>

  <!-- Tabs -->
  <div class="tabs">
    <button class="tab active" onclick="showTab('results')">Results</button>
    <button class="tab" onclick="showTab('ingest')">➕ Ingest</button>
    <button class="tab" onclick="showTab('manage');loadDocs()">📄 Documents</button>
    <button class="tab" onclick="showTab('stats');loadStats()">📊 Stats</button>
  </div>

  <!-- Results Panel -->
  <div id="panel-results" class="panel active">
    <div id="ai-result" style="display:none" class="ai-box">
      <div class="ai-label">⚡ AI Answer <span id="ai-spinner" class="spinner" style="display:none"></span></div>
      <div id="ai-text" class="ai-answer"></div>
      <div class="sources" id="ai-sources"></div>
    </div>
    <div id="results-list">
      <div class="empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <p>Enter a query above and press Search or Ask AI</p>
      </div>
    </div>
  </div>

  <!-- Ingest Panel -->
  <div id="panel-ingest" class="panel">
    <div class="card">
      <div class="card-title">Index a Document</div>
      <label>Admin Key (required)</label>
      <input type="text" id="admin-key" placeholder="search-admin-bervashun-2026"/>
      <div class="ingest-row">
        <div>
          <label>Title *</label>
          <input type="text" id="doc-title" placeholder="Document title"/>
        </div>
        <div>
          <label>Category</label>
          <select id="doc-cat" style="width:100%;padding:10px 12px;background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:8px">
            <option value="general">General</option>
            <option value="legal">Legal</option>
            <option value="finance">Finance</option>
            <option value="kyc">KYC / Compliance</option>
            <option value="banking">Banking</option>
            <option value="tech">Technology</option>
            <option value="docs">Documentation</option>
          </select>
        </div>
      </div>
      <div class="ingest-row">
        <div>
          <label>URL (optional)</label>
          <input type="url" id="doc-url" placeholder="https://…"/>
        </div>
        <div>
          <label>Author (optional)</label>
          <input type="text" id="doc-author" placeholder="Author name"/>
        </div>
      </div>
      <label>Tags (comma-separated, optional)</label>
      <input type="text" id="doc-tags" placeholder="compliance, aml, kyc"/>
      <label>Content *</label>
      <textarea id="doc-content" rows="8" placeholder="Paste the document content here…"></textarea>
      <div style="display:flex;gap:10px;margin-top:14px">
        <button class="btn btn-primary" onclick="ingestDoc()" style="flex:1">Index Document</button>
        <button class="btn btn-secondary" onclick="clearIngest()">Clear</button>
      </div>
      <div class="progress" id="ingest-progress">⏳ Embedding and indexing…</div>
    </div>

    <div class="card">
      <div class="card-title">Batch Ingest (JSON)</div>
      <p style="font-size:.8rem;color:var(--muted);margin-bottom:10px">POST an array of <code style="background:#1e1e2e;padding:2px 6px;border-radius:4px">{title, content, category?, url?, author?, tags?}</code> objects</p>
      <textarea id="batch-json" rows="8" placeholder='[{"title":"Doc 1","content":"…","category":"tech"},{"title":"Doc 2","content":"…"}]'></textarea>
      <button class="btn btn-primary" style="margin-top:10px;width:100%" onclick="batchIngest()">Batch Index</button>
    </div>
  </div>

  <!-- Manage Panel -->
  <div id="panel-manage" class="panel">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <div class="card-title">Indexed Documents</div>
      <button class="btn btn-danger" onclick="purgeAll()">🗑 Purge All</button>
    </div>
    <div id="doc-list"><div class="empty"><p>Loading…</p></div></div>
  </div>

  <!-- Stats Panel -->
  <div id="panel-stats" class="panel">
    <div class="stat-grid" id="stat-grid"><div class="empty"><p>Loading stats…</p></div></div>
    <div id="stat-details"></div>
  </div>
</div>

<script>
const API = "";
let adminKey = () => document.getElementById("admin-key")?.value || localStorage.getItem("searchAdminKey") || "";

function showTab(name) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  event.target.classList.add("active");
  document.getElementById("panel-" + name).classList.add("active");
}

async function doSearch() {
  const q = document.getElementById("q").value.trim();
  if (!q) return;
  const topK = +document.getElementById("topk").value;
  const threshold = +document.getElementById("thresh").value;
  const category = document.getElementById("cat").value;
  showTab2("results");
  document.getElementById("ai-result").style.display = "none";
  document.getElementById("results-list").innerHTML = '<div class="empty"><span class="spinner"></span> Searching…</div>';
  const res = await fetch(API + "/search", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({query:q, top_k:topK, threshold, category: category||undefined})
  });
  const data = await res.json();
  renderResults(data.results || []);
}

async function doAsk() {
  const q = document.getElementById("q").value.trim();
  if (!q) return;
  const topK = +document.getElementById("topk").value;
  const category = document.getElementById("cat").value;
  showTab2("results");
  document.getElementById("ai-result").style.display = "block";
  document.getElementById("ai-text").textContent = "";
  document.getElementById("ai-sources").innerHTML = "";
  document.getElementById("ai-spinner").style.display = "inline-block";
  document.getElementById("results-list").innerHTML = '<div class="empty"><span class="spinner"></span> Retrieving context…</div>';
  const res = await fetch(API + "/ai/ask", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({question:q, top_k:topK, category: category||undefined})
  });
  const data = await res.json();
  document.getElementById("ai-spinner").style.display = "none";
  document.getElementById("ai-text").textContent = data.answer || "No answer generated.";
  if (data.sources?.length) {
    document.getElementById("ai-sources").innerHTML = "<div style='font-size:.75rem;color:var(--muted);margin-bottom:6px'>Sources:</div>" +
      data.sources.map(s => `<a class='source-chip' href='${s.url||"#"}' target='_blank'>[${(s.score*100).toFixed(0)}%] ${s.title}</a>`).join("");
  }
  renderResults(data.sources || []);
}

function renderResults(results) {
  if (!results.length) {
    document.getElementById("results-list").innerHTML = '<div class="empty"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg><p>No results found. Try a different query or lower the threshold.</p></div>';
    return;
  }
  document.getElementById("results-list").innerHTML = results.map((r,i) => `
    <div class="card">
      <div class="card-title">${i+1}. ${esc(r.title)}</div>
      <div class="card-meta">
        <span class="badge">${esc(r.category||"general")}</span>
        <span>Score: ${(r.score*100).toFixed(1)}%</span>
        ${r.author ? '<span>by '+esc(r.author)+'</span>' : ''}
        ${r.url ? '<a href="'+esc(r.url)+'" target="_blank" style="color:#67e8f9;font-size:.75rem">🔗 Source</a>' : ''}
      </div>
      <div class="snippet">${esc(r.snippet||"")}</div>
      <div class="score-bar"><div class="score-fill" style="width:${(r.score*100).toFixed(1)}%"></div></div>
    </div>
  `).join("");
}

async function ingestDoc() {
  const key = document.getElementById("admin-key").value;
  if (key) localStorage.setItem("searchAdminKey", key);
  const title   = document.getElementById("doc-title").value.trim();
  const content = document.getElementById("doc-content").value.trim();
  if (!title || !content) { alert("Title and content are required."); return; }
  const prog = document.getElementById("ingest-progress");
  prog.style.display = "block";
  const res = await fetch(API + "/index", {
    method:"POST",
    headers:{"Content-Type":"application/json","X-Search-Admin-Key":key},
    body: JSON.stringify([{
      title, content,
      category: document.getElementById("doc-cat").value,
      url: document.getElementById("doc-url").value||undefined,
      author: document.getElementById("doc-author").value||undefined,
      tags: document.getElementById("doc-tags").value||undefined,
    }])
  });
  const data = await res.json();
  prog.style.display = "none";
  if (data.indexed) { alert("✅ Indexed: " + data.indexed + " document(s)"); clearIngest(); }
  else alert("Error: " + (data.error || JSON.stringify(data)));
}

async function batchIngest() {
  const key = document.getElementById("admin-key").value;
  if (key) localStorage.setItem("searchAdminKey", key);
  let docs;
  try { docs = JSON.parse(document.getElementById("batch-json").value); }
  catch(e) { alert("Invalid JSON: " + e.message); return; }
  const res = await fetch(API + "/index", {
    method:"POST",
    headers:{"Content-Type":"application/json","X-Search-Admin-Key":key},
    body: JSON.stringify(docs)
  });
  const data = await res.json();
  if (data.indexed) alert("✅ Batch indexed: " + data.indexed + " docs | " + (data.errors?.length||0) + " errors");
  else alert("Error: " + (data.error || JSON.stringify(data)));
}

function clearIngest() {
  ["doc-title","doc-content","doc-url","doc-author","doc-tags","batch-json"].forEach(id => { document.getElementById(id).value = ""; });
}

async function loadDocs() {
  const key = adminKey();
  const res = await fetch(API + "/documents?limit=50", { headers:{"X-Search-Admin-Key":key} });
  const data = await res.json();
  const docs = data.documents || [];
  document.getElementById("doc-list").innerHTML = docs.length
    ? docs.map(d => `
        <div class="doc-list-item">
          <div style="flex:1">
            <div style="font-weight:600">${esc(d.title)}</div>
            <div style="font-size:.75rem;color:var(--muted)">${esc(d.category)} · ${d.word_count||0} words · ${d.indexed_at?.slice(0,10)||""}</div>
          </div>
          <button class="doc-del" onclick="deleteDoc('${d.id}')">Delete</button>
        </div>`).join("")
    : '<div class="empty"><p>No documents indexed yet.</p></div>';
}

async function deleteDoc(id) {
  if (!confirm("Delete this document?")) return;
  const key = adminKey();
  await fetch(API + "/index/" + id, { method:"DELETE", headers:{"X-Search-Admin-Key":key} });
  loadDocs();
}

async function purgeAll() {
  if (!confirm("Purge ALL documents and vectors? This cannot be undone.")) return;
  const key = adminKey();
  const res = await fetch(API + "/documents", { method:"DELETE", headers:{"X-Search-Admin-Key":key} });
  const data = await res.json();
  alert("Purged: " + (data.deleted || 0) + " documents");
  loadDocs();
}

async function loadStats() {
  const key = adminKey();
  const res = await fetch(API + "/stats", { headers:{"X-Search-Admin-Key":key} });
  const data = await res.json();
  document.getElementById("stat-grid").innerHTML = [
    ["Total Docs",   data.total_documents ?? "—"],
    ["Categories",   data.categories ?? "—"],
    ["Total Words",  data.total_words ?? "—"],
    ["Version",      data.version ?? VERSION],
  ].map(([l,v]) => `<div class="stat-card"><div class="stat-val">${v}</div><div class="stat-lbl">${l}</div></div>`).join("");
  document.getElementById("stat-details").innerHTML = data.by_category
    ? "<div class='card'><div class='card-title'>By Category</div>" +
      Object.entries(data.by_category).map(([k,c]) => `<div class='doc-list-item'><span>${k}</span><span class='badge'>${c} docs</span></div>`).join("") + "</div>"
    : "";
}

function showTab2(name) {
  document.querySelectorAll(".tab").forEach((t,i) => { if(i===0) t.classList.add("active"); else t.classList.remove("active"); });
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  document.getElementById("panel-" + name).classList.add("active");
}

function esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

document.getElementById("q").addEventListener("keydown", e => { if(e.key==="Enter") { e.shiftKey ? doAsk() : doSearch(); } });
</script>
</body>
</html>`;

// ─── Route Handler ───────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    const method = request.method.toUpperCase();

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Search-Admin-Key",
        },
      });
    }

    // Ensure D1 schema on every cold start (idempotent)
    try { await ensureSchema(env); } catch (_) {}

    // ── GET / (Browser UI) ─────────────────────────────────────────────────
    if (method === "GET" && path === "/") {
      return new Response(HTML_UI, { headers: { "Content-Type": "text/html;charset=utf-8" } });
    }

    // ── GET /health ────────────────────────────────────────────────────────
    if (method === "GET" && path === "/health") {
      return json({ status: "ok", version: VERSION, service: "ai-search", timestamp: new Date().toISOString() });
    }

    // ── POST /index ─────────────────────────────────────────────────────────
    if (method === "POST" && path === "/index") {
      const deny = requireAdmin(request, env);
      if (deny) return deny;

      let docs;
      try { docs = await request.json(); } catch { return err("Invalid JSON body"); }
      if (!Array.isArray(docs)) docs = [docs];
      if (docs.length === 0) return err("No documents provided");
      if (docs.length > MAX_INGEST) return err(`Max ${MAX_INGEST} documents per request`);

      const indexed = [];
      const errors  = [];

      for (const doc of docs) {
        try {
          if (!doc.title?.trim()) throw new Error("Missing title");
          if (!doc.content?.trim()) throw new Error("Missing content");

          const id      = doc.id ?? await contentId(doc.title + doc.content);
          const vector  = await embed(env, doc.title + " " + doc.content);
          const words   = doc.content.split(/\s+/).length;

          // Upsert into D1
          await env.SEARCH_DB.prepare(`
            INSERT INTO search_documents (id, title, content, category, url, author, tags, metadata, word_count, updated_at)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              title=?2, content=?3, category=?4, url=?5, author=?6, tags=?7, metadata=?8, word_count=?9, updated_at=datetime('now')
          `).bind(
            id, doc.title.trim(), doc.content.trim(),
            doc.category || "general",
            doc.url || null, doc.author || null,
            typeof doc.tags === "string" ? doc.tags : (doc.tags?.join(",") || null),
            doc.metadata ? JSON.stringify(doc.metadata) : null,
            words
          ).run();

          // Upsert into Vectorize
          await env.VECTORIZE.upsert([{
            id,
            values: vector,
            metadata: {
              title:    doc.title.trim(),
              category: doc.category || "general",
              url:      doc.url || "",
            },
          }]);

          indexed.push({ id, title: doc.title.trim() });
        } catch (e) {
          errors.push({ title: doc.title, error: e.message });
        }
      }

      return json({ indexed: indexed.length, documents: indexed, errors, version: VERSION });
    }

    // ── DELETE /index/:id ───────────────────────────────────────────────────
    if (method === "DELETE" && path.startsWith("/index/")) {
      const deny = requireAdmin(request, env);
      if (deny) return deny;

      const id = path.split("/")[2];
      if (!id) return err("Missing document ID");

      await env.SEARCH_DB.prepare("DELETE FROM search_documents WHERE id=?").bind(id).run();
      try { await env.VECTORIZE.deleteByIds([id]); } catch (_) {}
      return json({ deleted: id, version: VERSION });
    }

    // ── POST /search  ─── or ── GET /search?q= or GET /api/search?q= ───────
    const isSearchPath = path === "/search" || path === "/api/search";
    if (isSearchPath && (method === "POST" || method === "GET")) {
      let query, topK, threshold, category;

      if (method === "GET") {
        query     = url.searchParams.get("q") || "";
        topK      = parseInt(url.searchParams.get("top_k") || "8", 10);
        threshold = parseFloat(url.searchParams.get("threshold") || "0.35");
        category  = url.searchParams.get("category") || undefined;
      } else {
        let body = {};
        try { body = await request.json(); } catch { return err("Invalid JSON body"); }
        query     = body.query || body.q || "";
        topK      = body.top_k ?? DEFAULT_TOP_K;
        threshold = body.threshold ?? DEFAULT_THRESHOLD;
        category  = body.category;
      }

      if (!query.trim()) return err("query is required");

      const results = await semanticSearch(env, query, { topK, threshold, category });
      return json({ query, results, count: results.length, version: VERSION });
    }

    // ── POST /ai/ask ────────────────────────────────────────────────────────
    if (method === "POST" && path === "/ai/ask") {
      let body = {};
      try { body = await request.json(); } catch { return err("Invalid JSON body"); }
      const question = body.question || body.q || "";
      if (!question.trim()) return err("question is required");

      const result = await ragAnswer(env, question, {
        topK:     body.top_k ?? 5,
        category: body.category,
      });
      return json({ question, ...result, version: VERSION });
    }

    // ── POST /ai/summarize ──────────────────────────────────────────────────
    if (method === "POST" && path === "/ai/summarize") {
      let body = {};
      try { body = await request.json(); } catch { return err("Invalid JSON body"); }
      const id = body.id;
      if (!id) return err("id is required");
      const row = await env.SEARCH_DB.prepare("SELECT * FROM search_documents WHERE id=?").bind(id).first();
      if (!row) return err("Document not found", 404);

      const messages = [
        { role: "system", content: "Summarize the following document concisely in 3-5 sentences. Extract key facts." },
        { role: "user",   content: `Title: ${row.title}\n\n${row.content.slice(0, 3000)}` },
      ];
      const llm = await env.AI.run(LLM_MODEL, { messages, max_tokens: 256 });
      return json({ id, title: row.title, summary: llm.response?.trim(), model: LLM_MODEL, version: VERSION });
    }

    // ── GET /documents ──────────────────────────────────────────────────────
    if (method === "GET" && path === "/documents") {
      const deny = requireAdmin(request, env);
      if (deny) return deny;

      const limit    = parseInt(url.searchParams.get("limit") || "50", 10);
      const offset   = parseInt(url.searchParams.get("offset") || "0", 10);
      const catFilter = url.searchParams.get("category");

      const query = catFilter
        ? env.SEARCH_DB.prepare("SELECT id,title,category,url,author,tags,word_count,indexed_at FROM search_documents WHERE category=? ORDER BY indexed_at DESC LIMIT ? OFFSET ?").bind(catFilter, limit, offset)
        : env.SEARCH_DB.prepare("SELECT id,title,category,url,author,tags,word_count,indexed_at FROM search_documents ORDER BY indexed_at DESC LIMIT ? OFFSET ?").bind(limit, offset);

      const { results } = await query.all();
      const total = await env.SEARCH_DB.prepare("SELECT COUNT(*) AS n FROM search_documents" + (catFilter ? " WHERE category=?" : ""))
        .bind(...(catFilter ? [catFilter] : [])).first();

      return json({ documents: results, count: results.length, total: total?.n ?? 0, limit, offset, version: VERSION });
    }

    // ── DELETE /documents ───────────────────────────────────────────────────
    if (method === "DELETE" && path === "/documents") {
      const deny = requireAdmin(request, env);
      if (deny) return deny;

      const { results } = await env.SEARCH_DB.prepare("SELECT id FROM search_documents").all();
      const ids = results.map((r) => r.id);

      if (ids.length) {
        await env.SEARCH_DB.prepare("DELETE FROM search_documents").run();
        try { await env.VECTORIZE.deleteByIds(ids); } catch (_) {}
      }
      return json({ deleted: ids.length, version: VERSION });
    }

    // ── GET /stats ───────────────────────────────────────────────────────────
    if (method === "GET" && path === "/stats") {
      const deny = requireAdmin(request, env);
      if (deny) return deny;

      const total = await env.SEARCH_DB.prepare("SELECT COUNT(*) AS n, SUM(word_count) AS w FROM search_documents").first();
      const cats  = await env.SEARCH_DB.prepare("SELECT category, COUNT(*) AS n FROM search_documents GROUP BY category").all();
      const byCat = Object.fromEntries((cats.results || []).map((r) => [r.category, r.n]));

      return json({
        total_documents: total?.n ?? 0,
        total_words:     total?.w ?? 0,
        categories:      Object.keys(byCat).length,
        by_category:     byCat,
        version:         VERSION,
        models: { embedding: EMBED_MODEL, llm: LLM_MODEL },
      });
    }

    return err("Not found", 404);
  },
};
