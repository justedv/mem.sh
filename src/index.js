'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const https = require('https');

// ── TF-IDF Engine ──────────────────────────────────────────────
class TfIdf {
  tokenize(text) {
    return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  }

  tf(tokens) {
    const freq = {};
    for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
    const len = tokens.length || 1;
    for (const t in freq) freq[t] /= len;
    return freq;
  }

  idf(docs) {
    const df = {};
    const n = docs.length || 1;
    for (const doc of docs) {
      const seen = new Set(doc);
      for (const t of seen) df[t] = (df[t] || 0) + 1;
    }
    const idf = {};
    for (const t in df) idf[t] = Math.log((n + 1) / (df[t] + 1)) + 1;
    return idf;
  }

  vectorize(tf, idf) {
    const vec = {};
    for (const t in tf) vec[t] = tf[t] * (idf[t] || Math.log(2));
    return vec;
  }

  cosine(a, b) {
    let dot = 0, magA = 0, magB = 0;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const va = a[k] || 0, vb = b[k] || 0;
      dot += va * vb;
      magA += va * va;
      magB += vb * vb;
    }
    if (!magA || !magB) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }

  rank(query, documents) {
    const qTokens = this.tokenize(query);
    const docTokens = documents.map(d => this.tokenize(d.text));
    const allTokens = [qTokens, ...docTokens];
    const idfScores = this.idf(allTokens);
    const qVec = this.vectorize(this.tf(qTokens), idfScores);
    return documents.map((doc, i) => {
      const dVec = this.vectorize(this.tf(docTokens[i]), idfScores);
      return { ...doc, score: Math.round(this.cosine(qVec, dVec) * 1000) / 1000 };
    }).filter(d => d.score > 0.01).sort((a, b) => b.score - a.score);
  }
}

// ── OpenAI Embeddings ──────────────────────────────────────────
class OpenAIEmbedder {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  async embed(text) {
    const body = JSON.stringify({
      model: 'text-embedding-3-small',
      input: text
    });
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body
    });
    if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
    const data = await res.json();
    return data.data[0].embedding;
  }

  cosine(a, b) {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    if (!magA || !magB) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }
}

// ── SQLite Store (sql.js) ──────────────────────────────────────
class LocalStore {
  constructor(dir, opts = {}) {
    this.dir = dir || path.join(os.homedir(), '.mem');
    this.dbPath = path.join(this.dir, 'mem.db');
    this.tfidf = new TfIdf();
    this._db = null;
    this._SQL = null;
    this._openaiKey = opts.openaiKey || process.env.OPENAI_API_KEY || null;
    this._embedder = this._openaiKey ? new OpenAIEmbedder(this._openaiKey) : null;
  }

  _initDb() {
    if (this._db) return this._db;
    const initSqlJs = require('sql.js');
    // sql.js returns a promise, but we need sync init for backward compat
    // Use the sync factory if available, otherwise we cache
    if (!this._SQL) {
      throw new Error('Must call await store.init() before using the store');
    }
    return this._db;
  }

  async init() {
    if (this._db) return;
    const initSqlJs = require('sql.js');
    this._SQL = await initSqlJs();
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      const buf = fs.readFileSync(this.dbPath);
      this._db = new this._SQL.Database(buf);
    } catch {
      this._db = new this._SQL.Database();
    }
    this._db.run(`CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      agent TEXT DEFAULT 'default',
      embedding TEXT,
      tags TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      importance REAL DEFAULT 1.0,
      source TEXT DEFAULT 'manual',
      recall_count INTEGER DEFAULT 0
    )`);
    // Migration: add columns if they don't exist (for existing DBs)
    try { this._db.run('ALTER TABLE memories ADD COLUMN source TEXT DEFAULT "manual"'); } catch {}
    try { this._db.run('ALTER TABLE memories ADD COLUMN recall_count INTEGER DEFAULT 0'); } catch {}
    this._save();
  }

  _save() {
    const data = this._db.export();
    const buf = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buf);
  }

  _applyDecay(row) {
    const created = new Date(row.created_at);
    const now = new Date();
    const days = (now - created) / (1000 * 60 * 60 * 24);
    if (days > 30) {
      const decay = (days - 30) * 0.01;
      const decayed = Math.max(0.1, row.importance - decay);
      return decayed;
    }
    return row.importance;
  }

  async set(text, opts = {}) {
    await this.init();
    const agent = opts.agent || 'default';
    const tags = opts.tags || '';
    const importance = opts.importance || 1.0;
    const source = opts.source || 'manual';
    const created_at = new Date().toISOString();

    let embedding = null;
    if (this._embedder) {
      try {
        const emb = await this._embedder.embed(text);
        embedding = JSON.stringify(emb);
      } catch (e) {
        // fallback: no embedding
      }
    }

    this._db.run(
      'INSERT INTO memories (text, agent, embedding, tags, created_at, importance, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [text, agent, embedding, tags, created_at, importance, source]
    );
    const id = this._db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
    this._save();
    return { id, text, agent, tags };
  }

  async recall(query, opts = {}) {
    await this.init();
    const agent = opts.agent || 'default';
    const limit = opts.limit || 10;
    const top = opts.top || null;
    const filterTags = opts.tags ? opts.tags.split(',').map(t => t.trim()) : null;

    const stmt = this._db.exec(
      'SELECT id, text, agent, embedding, tags, created_at, importance, source, recall_count FROM memories WHERE agent = ?',
      [agent]
    );
    if (!stmt.length) return [];

    const cols = stmt[0].columns;
    let rows = stmt[0].values.map(v => {
      const obj = {};
      cols.forEach((c, i) => obj[c] = v[i]);
      return obj;
    });

    // Filter by tags if specified
    if (filterTags) {
      rows = rows.filter(r => {
        const rTags = (r.tags || '').split(',').map(t => t.trim()).filter(Boolean);
        return filterTags.some(ft => rTags.includes(ft));
      });
    }

    let scored;

    // Try OpenAI embeddings first
    if (this._embedder) {
      try {
        const qEmb = await this._embedder.embed(query);
        scored = rows.map(row => {
          let similarity = 0;
          if (row.embedding) {
            const emb = JSON.parse(row.embedding);
            similarity = this._embedder.cosine(qEmb, emb);
          }
          const effectiveImportance = this._applyDecay(row);
          const maxImportance = Math.max(...rows.map(r => this._applyDecay(r)), 1);
          const normImportance = effectiveImportance / maxImportance;
          const finalScore = similarity * 0.7 + normImportance * 0.3;
          return { id: row.id, text: row.text, agent: row.agent, tags: row.tags, created_at: row.created_at, importance: row.importance, score: Math.round(finalScore * 1000) / 1000 };
        }).filter(d => d.score > 0.01).sort((a, b) => b.score - a.score);
      } catch {
        scored = null; // fall through to TF-IDF
      }
    }

    if (!scored) {
      // TF-IDF fallback
      const tfidfResults = this.tfidf.rank(query, rows);
      scored = tfidfResults.map(r => {
        const effectiveImportance = this._applyDecay(r);
        const maxImportance = Math.max(...rows.map(row => this._applyDecay(row)), 1);
        const normImportance = effectiveImportance / maxImportance;
        const similarity = r.score;
        const finalScore = similarity * 0.7 + normImportance * 0.3;
        return { ...r, score: Math.round(finalScore * 1000) / 1000 };
      }).sort((a, b) => b.score - a.score);
    }

    const resultLimit = top || limit;
    const results = scored.slice(0, resultLimit);

    // Bump importance and recall_count for recalled memories
    for (const r of results) {
      this._db.run('UPDATE memories SET importance = importance + 0.1, recall_count = recall_count + 1 WHERE id = ?', [r.id]);
    }
    this._save();

    return results;
  }

  async list(opts = {}) {
    await this.init();
    const agent = opts.agent || 'default';
    const stmt = this._db.exec(
      'SELECT id, text, agent, tags, created_at, importance, source, recall_count FROM memories WHERE agent = ? ORDER BY id DESC',
      [agent]
    );
    if (!stmt.length) return [];
    const cols = stmt[0].columns;
    return stmt[0].values.map(v => {
      const obj = {};
      cols.forEach((c, i) => obj[c] = v[i]);
      obj.importance = this._applyDecay(obj);
      return obj;
    });
  }

  async forget(id) {
    await this.init();
    this._db.run('DELETE FROM memories WHERE id = ?', [Number(id)]);
    const changes = this._db.getRowsModified();
    this._save();
    return { changes };
  }

  async clear(opts = {}) {
    await this.init();
    const agent = opts.agent || 'default';
    this._db.run('DELETE FROM memories WHERE agent = ?', [agent]);
    const changes = this._db.getRowsModified();
    this._save();
    return { changes };
  }

  async important(id, boost = 0.5) {
    await this.init();
    this._db.run('UPDATE memories SET importance = importance + ? WHERE id = ?', [boost, Number(id)]);
    this._save();
    const stmt = this._db.exec('SELECT id, text, importance FROM memories WHERE id = ?', [Number(id)]);
    if (!stmt.length) return null;
    const cols = stmt[0].columns;
    const v = stmt[0].values[0];
    const obj = {};
    cols.forEach((c, i) => obj[c] = v[i]);
    return obj;
  }

  async stats(opts = {}) {
    await this.init();
    const agent = opts.agent || 'default';
    const stmt = this._db.exec(
      `SELECT COUNT(*) as total, MIN(created_at) as oldest, MAX(created_at) as newest, AVG(importance) as avg_importance FROM memories WHERE agent = ?`,
      [agent]
    );
    if (!stmt.length || !stmt[0].values[0][0]) return { total: 0, oldest: null, newest: null, avg_importance: 0 };
    const [total, oldest, newest, avg_importance] = stmt[0].values[0];
    return { total, oldest, newest, avg_importance: Math.round(avg_importance * 100) / 100 };
  }

  async exportAll(opts = {}) {
    await this.init();
    const agent = opts.agent;
    let query = 'SELECT id, text, agent, tags, created_at, importance FROM memories';
    const params = [];
    if (agent) {
      query += ' WHERE agent = ?';
      params.push(agent);
    }
    query += ' ORDER BY id ASC';
    const stmt = this._db.exec(query, params);
    if (!stmt.length) return [];
    const cols = stmt[0].columns;
    return stmt[0].values.map(v => {
      const obj = {};
      cols.forEach((c, i) => obj[c] = v[i]);
      return obj;
    });
  }

  async importAll(memories) {
    await this.init();
    let count = 0;
    for (const m of memories) {
      this._db.run(
        'INSERT INTO memories (text, agent, tags, created_at, importance) VALUES (?, ?, ?, ?, ?)',
        [m.text, m.agent || 'default', m.tags || '', m.created_at || new Date().toISOString(), m.importance || 1.0]
      );
      count++;
    }
    this._save();
    return { imported: count };
  }
}

// ── API Client ─────────────────────────────────────────────────
class ApiClient {
  constructor(opts) {
    this.base = opts.api.replace(/\/$/, '');
    this.key = opts.key || '';
    this.agent = opts.agent || 'default';
  }

  _req(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.base + urlPath);
      const mod = url.protocol === 'https:' ? https : http;
      const headers = { 'Content-Type': 'application/json' };
      if (this.key) headers['X-Mem-Key'] = this.key;
      headers['X-Mem-Agent'] = this.agent;
      const req = mod.request(url, { method, headers }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch { resolve(d); }
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async init() {} // no-op for API client
  set(text, opts = {}) { return this._req('POST', '/mem', { text, tags: opts.tags, importance: opts.importance, metadata: opts.metadata }); }
  recall(query, opts = {}) {
    let url = `/mem/recall?q=${encodeURIComponent(query)}&limit=${opts.limit || 10}`;
    if (opts.tags) url += `&tags=${encodeURIComponent(opts.tags)}`;
    if (opts.top) url += `&top=${opts.top}`;
    return this._req('GET', url);
  }
  list() { return this._req('GET', '/mem/list'); }
  forget(id) { return this._req('DELETE', `/mem/${id}`); }
  clear() { return this._req('DELETE', '/mem?confirm=true'); }
  important(id) { return this._req('POST', `/mem/${id}/important`); }
  stats() { return this._req('GET', '/mem/stats'); }
  exportAll() { return this._req('GET', '/mem/export'); }
  importAll(memories) { return this._req('POST', '/mem/import', memories); }
}

// ── Exports ────────────────────────────────────────────────────
let _config = {};
let _store = null;

function getStore() {
  if (!_store) {
    _store = _config.api
      ? new ApiClient(_config)
      : new LocalStore(_config.dir, { openaiKey: _config.openaiKey });
  }
  return _store;
}

module.exports = {
  configure(opts) { _config = opts; _store = null; },
  async set(text, opts) { const s = getStore(); await s.init(); return s.set(text, opts); },
  async recall(query, opts) { const s = getStore(); await s.init(); return s.recall(query, opts); },
  async list(opts) { const s = getStore(); await s.init(); return s.list(opts); },
  async forget(id) { const s = getStore(); await s.init(); return s.forget(id); },
  async clear(opts) { const s = getStore(); await s.init(); return s.clear(opts); },
  async important(id, boost) { const s = getStore(); await s.init(); return s.important(id, boost); },
  async stats(opts) { const s = getStore(); await s.init(); return s.stats(opts); },
  async exportAll(opts) { const s = getStore(); await s.init(); return s.exportAll(opts); },
  async importAll(memories) { const s = getStore(); await s.init(); return s.importAll(memories); },
  TfIdf,
  LocalStore,
  ApiClient
};
