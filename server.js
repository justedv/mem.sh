'use strict';

const express = require('express');
const { LocalStore } = require('./src/index');

const app = express();
app.use(express.json());

const storeOpts = {};
if (process.env.MEM_USE_EMBEDDINGS && process.env.OPENAI_API_KEY) {
  storeOpts.openaiKey = process.env.OPENAI_API_KEY;
}
const store = new LocalStore(undefined, storeOpts);
const PORT = process.env.MEM_PORT || 3456;
const AUTH_KEY = process.env.MEM_KEY || '';

// Ensure store is initialized
let initPromise = store.init();

// Auth middleware
app.use('/mem', async (req, res, next) => {
  await initPromise;
  if (AUTH_KEY && req.headers['x-mem-key'] !== AUTH_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  req.agent = req.headers['x-mem-agent'] || 'default';
  next();
});

// Ingest raw text
app.post('/mem/ingest', async (req, res) => {
  const { text, source } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  try {
    const { ingest } = require('./src/ingest');
    const result = await ingest(text, store, { agent: req.agent, source: source || 'api' });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Store a memory
app.post('/mem', async (req, res) => {
  const { text, tags, importance, metadata } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  const result = await store.set(text, { agent: req.agent, tags: tags || '', importance, metadata });
  res.json(result);
});

// Semantic recall
app.get('/mem/recall', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'q parameter is required' });
  const limit = parseInt(req.query.limit) || 10;
  const tags = req.query.tags || '';
  const top = req.query.top ? parseInt(req.query.top) : null;
  const results = await store.recall(q, { agent: req.agent, limit, tags, top });
  res.json(results);
});

// List all
app.get('/mem/list', async (req, res) => {
  const results = await store.list({ agent: req.agent });
  res.json(results);
});

// Stats
app.get('/mem/stats', async (req, res) => {
  const stats = await store.stats({ agent: req.agent });
  res.json(stats);
});

// Export
app.get('/mem/export', async (req, res) => {
  const data = await store.exportAll({ agent: req.query.agent });
  res.json(data);
});

// Import
app.post('/mem/import', async (req, res) => {
  const memories = Array.isArray(req.body) ? req.body : req.body.memories || [];
  const result = await store.importAll(memories);
  res.json(result);
});

// Boost importance
app.post('/mem/:id/important', async (req, res) => {
  const result = await store.important(req.params.id);
  if (!result) return res.status(404).json({ error: 'Memory not found' });
  res.json(result);
});

// Delete by id
app.delete('/mem/:id', async (req, res) => {
  await store.forget(req.params.id);
  res.json({ ok: true, id: req.params.id });
});

// Clear all for agent
app.delete('/mem', async (req, res) => {
  await store.clear({ agent: req.agent });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n  🧠 mem.sh server running on http://localhost:${PORT}`);
  console.log(`  Auth: ${AUTH_KEY ? 'enabled' : 'disabled'}`);
  console.log(`  Embeddings: ${storeOpts.openaiKey ? 'OpenAI' : 'TF-IDF'}`);
  console.log();
});

module.exports = app;
