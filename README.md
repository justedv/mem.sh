<div align="center">

<h1>mem.sh</h1>

<p><strong>Persistent memory for AI agents.</strong><br>One line to save. One line to recall. Auto-ingest conversations.</p>

[![npm version](https://img.shields.io/npm/v/memshell.svg?style=flat-square)](https://www.npmjs.com/package/memshell)
[![license](https://img.shields.io/npm/l/memshell.svg?style=flat-square)](https://github.com/justedv/mem.sh/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/justedv/mem.sh?style=flat-square)](https://github.com/justedv/mem.sh)

<br>

[Quick Start](#quick-start) · [Auto-Ingest](#auto-ingest) · [OpenClaw Integration](#openclaw-integration) · [SDK](#sdk) · [API Server](#api-server) · [Architecture](#how-it-works)

</div>

---

## Install

```bash
npm i memshell
```

## Why mem.sh?

Agents forget everything between sessions. **mem.sh** gives them a brain.

| | mem.sh | LangChain Memory | Roll your own |
|---|---|---|---|
| **Setup** | `npx memshell set "..."` | 47 dependencies + config | Hours of boilerplate |
| **Auto-ingest** | Built-in | No | You build it |
| **External APIs** | None (optional) | OpenAI key required | Depends |
| **Semantic search** | Built-in TF-IDF | Embedding models | You build it |
| **Storage** | SQLite (local) | Varies | You choose |

## Features

- **Fast** -- TF-IDF vectorization with cosine similarity, instant results
- **Local-first** -- SQLite storage at `~/.mem/mem.db`, no data leaves your machine
- **Semantic** -- Recall by meaning, not exact match
- **Auto-ingest** -- Feed raw conversations, auto-extract key facts via LLM
- **OpenClaw integration** -- Watch session transcripts and auto-learn
- **Zero config** -- `npx` and go. No API keys needed for core features
- **Smart recall** -- Shows source, creation time, and recall frequency

## Quick Start

### CLI

```bash
# Store a memory
npx memshell set "user prefers dark mode"

# Recall semantically
npx memshell recall "what theme does the user like?"
# => user prefers dark mode (score: 0.87)

# List all memories
npx memshell list

# Forget a specific memory
npx memshell forget <id>

# Wipe everything
npx memshell clear
```

## Auto-Ingest

Feed raw conversations and let the LLM extract key facts automatically.

Requires `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` (or configure via `memshell config set apiKey <key>`).

### From a file

```bash
npx memshell ingest conversation.txt
npx memshell ingest chat.jsonl
npx memshell ingest notes.md
```

### From stdin

```bash
echo "User said they prefer dark mode and use vim" | npx memshell ingest --stdin
```

### Watch a directory

```bash
npx memshell ingest --watch ./logs/
```

Watches for new or changed `.txt`, `.md`, `.json`, and `.jsonl` files. Tracks what has been processed to avoid duplicates.

### Via API

```bash
curl -X POST http://localhost:3456/mem/ingest \
  -H "Content-Type: application/json" \
  -d '{"text": "User mentioned they love Rust and prefer dark themes"}'
# => {"extracted": 2, "stored": 2, "duplicates": 0}
```

### How it works

1. Text is split into ~2000-token chunks
2. Each chunk is sent to an LLM (gpt-4o-mini or claude-3-haiku) to extract standalone facts
3. Facts are deduplicated against existing memories (Jaccard similarity > 0.85 = skip)
4. New facts are stored with auto-generated tags and source tracking

## OpenClaw Integration

Automatically learn from your OpenClaw agent conversations:

```bash
# Start watching OpenClaw session transcripts
npx memshell connect openclaw

# Or specify a custom path
npx memshell connect openclaw /path/to/sessions/
```

This watches the OpenClaw sessions directory (`~/.openclaw/agents/main/sessions/` by default), parses JSONL transcripts, and auto-ingests new conversations.

### Daemon mode

Run continuous ingestion in the background:

```bash
# Configure watchers first
npx memshell config set watch.openclaw ~/.openclaw/agents/main/sessions/

# Start the daemon
npx memshell daemon
```

### Configuration

```bash
# Set LLM API key
npx memshell config set apiKey sk-...

# Set model
npx memshell config set model gpt-4o-mini

# View config
npx memshell config get
```

Config is stored at `~/.mem/config.json`.

## SDK

```js
const mem = require('memshell');

// Store
await mem.set('user prefers dark mode');
await mem.set('favorite language is rust', { agent: 'coder-bot' });

// Recall (semantic search) -- now includes source and recall count
const results = await mem.recall('what does the user like?');
// [{ id, text, score, created_at, source, recall_count }]

// List all
const all = await mem.list();

// Delete
await mem.forget(id);

// Clear everything
await mem.clear();
```

## How It Works

mem.sh uses **TF-IDF vectorization** with **cosine similarity** for semantic search. No OpenAI key needed. No external APIs. Everything runs locally.

Memories are stored in `~/.mem/mem.db` (SQLite). Each memory is tokenized and vectorized on write. Queries are vectorized at recall time and ranked by cosine similarity against stored vectors.

Optional: Enable OpenAI embeddings with `--embeddings` flag for higher quality recall (requires `OPENAI_API_KEY`).

## API Server

Run a shared memory server for multiple agents:

```bash
npx memshell serve --port 3456 --key my-secret-key
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/mem` | Store a memory |
| `POST` | `/mem/ingest` | Auto-ingest raw text |
| `GET` | `/mem/recall?q=` | Semantic recall |
| `GET` | `/mem/list` | List all memories |
| `GET` | `/mem/stats` | Memory statistics |
| `GET` | `/mem/export` | Export all memories |
| `POST` | `/mem/import` | Import memories |
| `DELETE` | `/mem/:id` | Delete a memory |
| `DELETE` | `/mem` | Clear all memories |

### Headers

- `X-Mem-Key` -- API key (required if `--key` is set)
- `X-Mem-Agent` -- Agent namespace (optional, isolates memories per agent)

### SDK with API Mode

```js
const mem = require('memshell');

mem.configure({
  api: 'http://localhost:3456',
  key: 'my-secret-key',
  agent: 'my-bot'
});

await mem.set('user prefers dark mode');
const results = await mem.recall('theme preference');
```

## All CLI Commands

```
memshell set <text>              Store a memory
memshell recall <query>          Semantic recall
memshell list                    List all memories
memshell forget <id>             Delete a memory by ID
memshell clear                   Wipe all memories
memshell important <id>          Boost memory importance
memshell ingest <file>           Extract facts from a file
memshell ingest --stdin          Extract facts from piped text
memshell ingest --watch <dir>    Watch directory for new files
memshell connect openclaw        Watch OpenClaw transcripts
memshell daemon                  Run continuous ingestion
memshell config set <key> <val>  Set config value
memshell config get [key]        Show config
memshell stats                   Show memory statistics
memshell export                  Export all memories as JSON
memshell import <file.json>      Import memories from JSON
memshell serve [--port N]        Start API server
```

## License

[ISC](LICENSE)

---

<div align="center">
<sub>Built for agents that need to remember.</sub><br>
<a href="https://www.npmjs.com/package/memshell">npm</a> · <a href="https://github.com/justedv/mem.sh">GitHub</a> · <a href="https://github.com/justedv/mem.sh/issues">Issues</a>
</div>
