#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const mem = require('../src/index');
const { LocalStore } = require('../src/index');

const args = process.argv.slice(2);
const cmd = args[0];

const HELP = `
  \x1b[1mmem.sh\x1b[0m — persistent memory for AI agents

  \x1b[36mCore Commands:\x1b[0m
    memshell set <text>              Store a memory
    memshell recall <query>          Semantic recall
    memshell list                    List all memories
    memshell forget <id>             Delete a memory by ID
    memshell clear                   Wipe all memories
    memshell important <id>          Boost memory importance

  \x1b[36mAuto-Ingest:\x1b[0m
    memshell ingest <file>           Extract facts from a file
    memshell ingest --stdin          Extract facts from piped text
    memshell ingest --watch <dir>    Watch a directory for new files

  \x1b[36mIntegrations:\x1b[0m
    memshell connect openclaw        Watch OpenClaw session transcripts
    memshell daemon                  Run continuous ingestion daemon

  \x1b[36mManagement:\x1b[0m
    memshell config set <key> <val>  Set config value
    memshell config get [key]        Show config
    memshell stats                   Show memory statistics
    memshell export                  Export all memories as JSON
    memshell import <file.json>      Import memories from JSON
    memshell serve [--port N]        Start API server

  \x1b[36mOptions:\x1b[0m
    --agent <name>          Agent namespace
    --api <url>             Use remote API instead of local
    --key <key>             API key for remote server
    --tags <t1,t2>          Tags (comma-separated)
    --top <N>               Return top N results only
    --embeddings            Enable OpenAI embeddings (needs OPENAI_API_KEY)

  \x1b[36mExamples:\x1b[0m
    memshell set "user prefers dark mode" --tags preferences,ui
    memshell recall "what theme?" --tags preferences --top 3
    echo "User likes vim and dark mode" | memshell ingest --stdin
    memshell connect openclaw
    memshell config set apiKey sk-...
`;

// Parse flags
function flag(name) {
  const i = args.indexOf('--' + name);
  if (i === -1) return null;
  if (i + 1 < args.length && !args[i + 1].startsWith('--')) return args[i + 1];
  return true;
}

function hasFlag(name) {
  return args.includes('--' + name);
}

// Smarter text extraction: skip flag values
function getText() {
  const skip = new Set(['--agent', '--api', '--key', '--tags', '--top', '--port', '--watch']);
  const parts = [];
  let i = 1;
  while (i < args.length) {
    if (skip.has(args[i])) { i += 2; continue; }
    if (args[i] === '--embeddings' || args[i] === '--stdin' || args[i] === '--force') { i++; continue; }
    if (args[i].startsWith('--')) { i++; continue; }
    parts.push(args[i]);
    i++;
  }
  return parts.join(' ').replace(/^["']|["']$/g, '');
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
    // If nothing after 100ms and stdin is a TTY, resolve empty
    if (process.stdin.isTTY) resolve('');
  });
}

async function main() {
  const agent = flag('agent') || 'default';
  const api = flag('api');
  const key = flag('key');
  const tags = flag('tags') || '';
  const top = flag('top') ? parseInt(flag('top')) : null;
  const useEmbeddings = hasFlag('embeddings');

  const configOpts = { agent };
  if (api) { configOpts.api = api; configOpts.key = key; }
  if (useEmbeddings) { configOpts.openaiKey = process.env.OPENAI_API_KEY; }

  mem.configure(configOpts);

  const opts = { agent, tags, top };

  switch (cmd) {
    case 'set': case 's': case 'save': case 'remember': {
      const text = getText();
      if (!text) return console.log('Usage: memshell set <text>');
      const r = await mem.set(text, { ...opts, tags });
      console.log(`\x1b[32m+\x1b[0m Stored (id: \x1b[1m${r.id}\x1b[0m)${tags ? ` [tags: ${tags}]` : ''}`);
      break;
    }
    case 'recall': case 'r': case 'search': case 'q': {
      const query = getText();
      if (!query) return console.log('Usage: memshell recall <query>');
      const results = await mem.recall(query, opts);
      if (!results.length) return console.log('\x1b[33mNo memories found.\x1b[0m');
      for (const r of results) {
        const tagStr = r.tags ? ` \x1b[35m[${r.tags}]\x1b[0m` : '';
        const srcStr = r.source && r.source !== 'manual' ? ` \x1b[2m(src: ${r.source})\x1b[0m` : '';
        const recallStr = r.recall_count ? ` \x1b[2m(recalled ${r.recall_count}x)\x1b[0m` : '';
        console.log(`  \x1b[36m[${r.id}]\x1b[0m ${r.text} \x1b[33m(score: ${r.score})\x1b[0m${tagStr}${srcStr}${recallStr}`);
      }
      break;
    }
    case 'list': case 'ls': case 'l': {
      const all = await mem.list(opts);
      if (!all.length) return console.log('\x1b[33mNo memories stored.\x1b[0m');
      for (const r of all) {
        const tagStr = r.tags ? ` \x1b[35m[${r.tags}]\x1b[0m` : '';
        const imp = r.importance !== 1.0 ? ` \x1b[33m*${r.importance.toFixed(1)}\x1b[0m` : '';
        const srcStr = r.source && r.source !== 'manual' ? ` \x1b[2m[${r.source}]\x1b[0m` : '';
        console.log(`  \x1b[36m[${r.id}]\x1b[0m ${r.text}${tagStr}${imp}${srcStr}  \x1b[2m(${r.created_at})\x1b[0m`);
      }
      console.log(`\n  \x1b[1m${all.length}\x1b[0m memor${all.length === 1 ? 'y' : 'ies'}`);
      break;
    }
    case 'forget': case 'delete': case 'rm': {
      const id = args[1];
      if (!id) return console.log('Usage: memshell forget <id>');
      await mem.forget(id);
      console.log(`\x1b[32m+\x1b[0m Forgotten (id: ${id})`);
      break;
    }
    case 'clear': case 'wipe': case 'reset': {
      await mem.clear(opts);
      console.log('\x1b[32m+\x1b[0m All memories cleared');
      break;
    }
    case 'important': case 'boost': {
      const id = args[1];
      if (!id) return console.log('Usage: memshell important <id>');
      const r = await mem.important(Number(id));
      if (!r) return console.log('\x1b[31mMemory not found.\x1b[0m');
      console.log(`\x1b[32m+\x1b[0m Boosted memory ${r.id} -> importance: \x1b[1m${r.importance.toFixed(1)}\x1b[0m`);
      break;
    }
    case 'stats': {
      const s = await mem.stats(opts);
      console.log(`\n  \x1b[1mMemory Stats\x1b[0m`);
      console.log(`  Total:          \x1b[36m${s.total}\x1b[0m`);
      console.log(`  Oldest:         ${s.oldest || 'n/a'}`);
      console.log(`  Newest:         ${s.newest || 'n/a'}`);
      console.log(`  Avg importance: \x1b[33m${s.avg_importance}\x1b[0m\n`);
      break;
    }
    case 'export': {
      const data = await mem.exportAll(opts);
      console.log(JSON.stringify(data, null, 2));
      break;
    }
    case 'import': {
      const file = args[1];
      if (!file) return console.log('Usage: memshell import <file.json>');
      const raw = fs.readFileSync(path.resolve(file), 'utf8');
      const data = JSON.parse(raw);
      const r = await mem.importAll(Array.isArray(data) ? data : data.memories || []);
      console.log(`\x1b[32m+\x1b[0m Imported ${r.imported} memories`);
      break;
    }
    case 'ingest': {
      const { ingestFile, ingest: ingestText } = require('../src/ingest');
      const store = new LocalStore(undefined, useEmbeddings ? { openaiKey: process.env.OPENAI_API_KEY } : {});
      await store.init();

      if (hasFlag('stdin')) {
        const text = await readStdin();
        if (!text.trim()) return console.log('No input received via stdin.');
        console.log('  Extracting facts from stdin...');
        const result = await ingestText(text, store, { agent });
        console.log(`\x1b[32m+\x1b[0m Extracted: ${result.extracted}, Stored: ${result.stored}, Duplicates: ${result.duplicates}`);
      } else if (hasFlag('watch')) {
        const dir = flag('watch');
        if (!dir || dir === true) return console.log('Usage: memshell ingest --watch <directory>');
        const { watchDirectory } = require('../src/ingest');
        console.log('  Starting directory watcher (Ctrl+C to stop)...');
        watchDirectory(dir, store, { agent });
        // Keep process alive
        process.on('SIGINT', () => { console.log('\n  Stopped.'); process.exit(0); });
      } else {
        const file = getText();
        if (!file) return console.log('Usage: memshell ingest <file> | --stdin | --watch <dir>');
        console.log(`  Ingesting: ${file}`);
        const result = await ingestFile(file, store, { agent, force: hasFlag('force') });
        if (result.skipped) {
          console.log(`  Skipped: ${result.file} (already processed, use --force to re-ingest)`);
        } else {
          console.log(`\x1b[32m+\x1b[0m Extracted: ${result.extracted}, Stored: ${result.stored}, Duplicates: ${result.duplicates}`);
        }
      }
      break;
    }
    case 'connect': {
      const target = args[1];
      if (target !== 'openclaw') return console.log('Usage: memshell connect openclaw');

      const { watchOpenClaw, defaultOpenClawPath, setConfigValue } = require('../src/ingest');
      const store = new LocalStore(undefined, useEmbeddings ? { openaiKey: process.env.OPENAI_API_KEY } : {});
      await store.init();

      const sessionsPath = args[2] || defaultOpenClawPath();
      setConfigValue('watch.openclaw', sessionsPath);
      console.log(`  OpenClaw integration configured.`);
      console.log(`  Sessions path: ${sessionsPath}`);
      console.log('  Watching for new transcripts (Ctrl+C to stop)...\n');
      watchOpenClaw(sessionsPath, store, { agent });
      process.on('SIGINT', () => { console.log('\n  Stopped.'); process.exit(0); });
      break;
    }
    case 'daemon': {
      const { loadConfig, watchDirectory, watchOpenClaw } = require('../src/ingest');
      const store = new LocalStore(undefined, useEmbeddings ? { openaiKey: process.env.OPENAI_API_KEY } : {});
      await store.init();

      const config = loadConfig();
      const watchers = config.watch || {};
      let activeWatchers = 0;

      console.log('  \x1b[1mmem.sh daemon\x1b[0m starting...\n');

      if (watchers.openclaw) {
        watchOpenClaw(watchers.openclaw, store, { agent });
        activeWatchers++;
      }

      // Support array of dir watchers
      if (Array.isArray(watchers.dirs)) {
        for (const dir of watchers.dirs) {
          watchDirectory(typeof dir === 'string' ? dir : dir.path, store, { agent });
          activeWatchers++;
        }
      } else if (watchers.dir) {
        watchDirectory(watchers.dir, store, { agent });
        activeWatchers++;
      }

      if (activeWatchers === 0) {
        console.log('  No watchers configured. Use:');
        console.log('    memshell config set watch.openclaw ~/.openclaw/agents/main/sessions/');
        console.log('    memshell config set watch.dir /path/to/watch');
        process.exit(1);
      }

      console.log(`\n  ${activeWatchers} watcher(s) active. Ctrl+C to stop.\n`);
      process.on('SIGINT', () => { console.log('\n  Daemon stopped.'); process.exit(0); });
      break;
    }
    case 'config': {
      const { loadConfig, setConfigValue } = require('../src/ingest');
      const subCmd = args[1];

      if (subCmd === 'set') {
        const configKey = args[2];
        const configVal = args.slice(3).join(' ');
        if (!configKey || !configVal) return console.log('Usage: memshell config set <key> <value>');
        const result = setConfigValue(configKey, configVal);
        console.log(`\x1b[32m+\x1b[0m Set ${configKey} = ${configVal}`);
      } else if (subCmd === 'get') {
        const config = loadConfig();
        const configKey = args[2];
        if (configKey) {
          const parts = configKey.split('.');
          let val = config;
          for (const p of parts) val = val?.[p];
          console.log(val !== undefined ? JSON.stringify(val, null, 2) : 'Not set');
        } else {
          console.log(JSON.stringify(config, null, 2));
        }
      } else {
        const config = loadConfig();
        console.log(JSON.stringify(config, null, 2));
      }
      break;
    }
    case 'serve': case 'server': {
      const port = flag('port') || 3456;
      const authKey = flag('key') || process.env.MEM_KEY || '';
      process.env.MEM_PORT = port;
      if (authKey) process.env.MEM_KEY = authKey;
      if (useEmbeddings) process.env.MEM_USE_EMBEDDINGS = '1';
      require('../server');
      break;
    }
    default:
      console.log(HELP);
  }
}

main().catch(e => { console.error('\x1b[31mError:\x1b[0m', e.message); process.exit(1); });
