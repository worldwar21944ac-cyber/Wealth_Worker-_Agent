# AI Search Worker v2.0

Cloudflare Worker powering semantic search + RAG for Bervashun / Knockoutforever.

## Architecture

```
Client ──► ai-search.wwwknockoutforever.com
             │
             ├── Workers AI (@cf/baai/bge-base-en-v1.5)   — 768-dim embeddings
             ├── Vectorize (ai-search-index, cosine)        — vector store
             ├── Workers AI (@cf/meta/llama-3.1-8b-instruct) — RAG LLM
             └── D1 (bervashun-audit)                       — document store
```

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/index` | Admin | Ingest 1–50 documents |
| `DELETE` | `/index/:id` | Admin | Remove a document |
| `POST` | `/search` | Public | Semantic search |
| `GET` | `/search?q=` | Public | Semantic search (browser) |
| `POST` | `/ai/ask` | Public | RAG answer |
| `GET` | `/ai/ask?q=` | Public | RAG answer (browser) |
| `GET` | `/documents` | Admin | List indexed docs |
| `DELETE` | `/documents` | Admin | Purge all docs |
| `GET` | `/health` | Public | Liveness |

## Quick Start

```bash
# Index a document
curl -X POST https://ai-search.wwwknockoutforever.com/index \
  -H "X-Search-Admin-Key: $SEARCH_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Bervashun Banking Overview",
    "content": "Bervashun Trust Capital offers modern banking powered by Unit...",
    "category": "banking"
  }'

# Semantic search
curl "https://ai-search.wwwknockoutforever.com/search?q=how+do+I+open+an+account"

# Ask the AI (RAG)
curl "https://ai-search.wwwknockoutforever.com/ai/ask?q=what+is+Bervashun"
```

## Bindings

| Binding | Type | Details |
|---------|------|---------|
| `AI` | Workers AI | Embeddings + LLM |
| `VECTORIZE` | Vectorize | ai-search-index, 768-dim, cosine |
| `SEARCH_DB` | D1 | bervashun-audit (f2fe6105-...) |
| `SEARCH_ADMIN_KEY` | Secret | GitHub → CF secret |

## GitHub Secrets Required

- `CF_API_TOKEN` — Cloudflare API token with Workers + D1 + Vectorize permissions
- `SEARCH_ADMIN_KEY` — Admin key for protected endpoints (choose your own)
