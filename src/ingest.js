'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── LLM Extraction ────────────────────────────────────────────
async function callLLM(text, config = {}) {
  const anthropicKey = config.anthropicKey || process.env.ANTHROPIC_API_KEY;
  const openaiKey = config.apiKey || config.openaiKey || process.env.OPENAI_API_KEY;
  const model = config.model || 'gpt-4o-mini';

  const systemPrompt = 'Extract key facts, user preferences, decisions, and important context from this conversation. Return as a JSON array of strings, each a standalone fact. Only return the JSON array, nothing else.';

  if (anthropicKey && (model.startsWith('claude') || !openaiKey)) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model.startsWith('claude') ? model : 'claude-3-haiku-20240307',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: text }]
      })
    });
    if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const content = data.content[0].text;
    return JSON.parse(content);
  }

  if (openaiKey) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`
      },
      body: JSON.stringify({
        model: model.startsWith('claude') ? 'gpt-4o-mini' : model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ],
        temperature: 0.3
      })
    });
    if (!res.ok) throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const content = data.choices[0].message.content;
    // Extract JSON array from response
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('LLM did not return a valid JSON array');
    return JSON.parse(match[0]);
  }

  throw new Error('No API key found. Set OPENAI_API_KEY or ANTHROPIC_API_KEY, or run: memshell config set apiKey <key>');
}

// ── Chunking ───────────────────────────────────────────────────
function chunkText(text, maxTokens = 2000) {
  // Rough estimate: 1 token ≈ 4 chars
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return [text];

  const chunks = [];
  const lines = text.split('\n');
  let current = '';

  for (const line of lines) {
    if ((current + '\n' + line).length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// ── Similarity (simple word overlap for dedup) ─────────────────
function wordSet(text) {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean));
}

function jaccardSimilarity(a, b) {
  const setA = wordSet(a);
  const setB = wordSet(b);
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Main Ingest Function ──────────────────────────────────────
async function ingest(text, store, opts = {}) {
  const config = loadConfig();
  const mergedConfig = { ...config, ...opts };
  const source = opts.source || 'auto-ingest';
  const agent = opts.agent || 'default';

  const chunks = chunkText(text);
  let totalExtracted = 0;
  let totalStored = 0;
  let totalDuplicates = 0;

  // Get existing memories for dedup
  const existing = await store.list({ agent });
  const existingTexts = existing.map(m => m.text);

  for (const chunk of chunks) {
    if (chunk.trim().length < 20) continue; // skip tiny chunks

    let facts;
    try {
      facts = await callLLM(chunk, mergedConfig);
    } catch (e) {
      console.error(`  Warning: LLM extraction failed for chunk: ${e.message}`);
      continue;
    }

    if (!Array.isArray(facts)) continue;
    totalExtracted += facts.length;

    for (const fact of facts) {
      if (typeof fact !== 'string' || fact.trim().length < 5) continue;

      // Dedup check
      let isDuplicate = false;
      for (const existing of existingTexts) {
        if (jaccardSimilarity(fact, existing) > 0.85) {
          isDuplicate = true;
          break;
        }
      }

      if (isDuplicate) {
        totalDuplicates++;
        continue;
      }

      // Auto-generate tags from fact
      const tags = [source, 'auto'].join(',');
      await store.set(fact, { agent, tags, source });
      existingTexts.push(fact); // prevent self-duplication within batch
      totalStored++;
    }
  }

  return { extracted: totalExtracted, stored: totalStored, duplicates: totalDuplicates };
}

// ── JSONL Parser (OpenClaw format) ─────────────────────────────
function parseJSONL(content) {
  const lines = content.split('\n').filter(l => l.trim());
  const messages = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.role && obj.content) {
        if (obj.role === 'user' || obj.role === 'assistant') {
          const text = typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content);
          messages.push(`${obj.role}: ${text}`);
        }
      }
    } catch {
      // skip invalid lines
    }
  }

  return messages.join('\n');
}

// ── Config Management ──────────────────────────────────────────
function configPath() {
  return path.join(os.homedir(), '.mem', 'config.json');
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  const dir = path.dirname(configPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

function setConfigValue(key, value) {
  const config = loadConfig();
  // Support dotted keys like watch.openclaw
  const parts = key.split('.');
  let obj = config;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
    obj = obj[parts[i]];
  }
  obj[parts[parts.length - 1]] = value;
  saveConfig(config);
  return config;
}

// ── Processed Tracker ──────────────────────────────────────────
function processedPath() {
  return path.join(os.homedir(), '.mem', 'processed.json');
}

function loadProcessed() {
  try {
    return JSON.parse(fs.readFileSync(processedPath(), 'utf8'));
  } catch {
    return { files: {} };
  }
}

function saveProcessed(data) {
  const dir = path.dirname(processedPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(processedPath(), JSON.stringify(data, null, 2));
}

function markProcessed(filePath, mtime) {
  const data = loadProcessed();
  data.files[filePath] = { mtime: mtime || Date.now(), processedAt: new Date().toISOString() };
  saveProcessed(data);
}

function isProcessed(filePath, mtime) {
  const data = loadProcessed();
  const entry = data.files[filePath];
  if (!entry) return false;
  if (mtime && entry.mtime < mtime) return false; // file was modified
  return true;
}

// ── File Ingestion ─────────────────────────────────────────────
async function ingestFile(filePath, store, opts = {}) {
  const absPath = path.resolve(filePath);
  const stat = fs.statSync(absPath);
  const mtime = stat.mtimeMs;

  if (!opts.force && isProcessed(absPath, mtime)) {
    return { skipped: true, file: absPath };
  }

  const content = fs.readFileSync(absPath, 'utf8');
  let text;

  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.jsonl') {
    text = parseJSONL(content);
  } else if (ext === '.json') {
    try {
      const data = JSON.parse(content);
      if (Array.isArray(data)) {
        text = data.map(d => typeof d === 'string' ? d : JSON.stringify(d)).join('\n');
      } else {
        text = JSON.stringify(data);
      }
    } catch {
      text = content;
    }
  } else {
    text = content;
  }

  if (!text || text.trim().length < 20) {
    return { skipped: true, file: absPath, reason: 'too short' };
  }

  const source = opts.source || `file:${path.basename(absPath)}`;
  const result = await ingest(text, store, { ...opts, source });
  markProcessed(absPath, mtime);
  return { ...result, file: absPath };
}

// ── Directory Watcher (polling) ────────────────────────────────
function watchDirectory(dir, store, opts = {}) {
  const interval = opts.interval || 10000;
  const absDir = path.resolve(dir);

  console.log(`  Watching: ${absDir} (every ${interval / 1000}s)`);

  async function scan() {
    try {
      const files = fs.readdirSync(absDir).filter(f => {
        const ext = path.extname(f).toLowerCase();
        return ['.txt', '.md', '.json', '.jsonl'].includes(ext);
      });

      for (const file of files) {
        const filePath = path.join(absDir, file);
        try {
          const result = await ingestFile(filePath, store, opts);
          if (!result.skipped) {
            console.log(`  Ingested: ${file} (${result.extracted} extracted, ${result.stored} stored, ${result.duplicates} duplicates)`);
          }
        } catch (e) {
          console.error(`  Error processing ${file}: ${e.message}`);
        }
      }
    } catch (e) {
      console.error(`  Watch error: ${e.message}`);
    }
  }

  scan(); // initial scan
  return setInterval(scan, interval);
}

// ── OpenClaw Connector ─────────────────────────────────────────
function defaultOpenClawPath() {
  return path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions');
}

function watchOpenClaw(sessionsPath, store, opts = {}) {
  const dir = sessionsPath || defaultOpenClawPath();
  console.log(`  Connecting to OpenClaw sessions: ${dir}`);
  return watchDirectory(dir, store, { ...opts, source: 'openclaw' });
}

module.exports = {
  ingest,
  ingestFile,
  callLLM,
  chunkText,
  jaccardSimilarity,
  parseJSONL,
  loadConfig,
  saveConfig,
  setConfigValue,
  watchDirectory,
  watchOpenClaw,
  defaultOpenClawPath,
  loadProcessed,
  isProcessed,
  markProcessed
};
