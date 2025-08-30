#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const config = require('./config.json');

const BRAVE_PATH = config.BRAVE_PATH;
const REMOTE_DEBUGGING_PORT = config.REMOTE_DEBUGGING_PORT;
const USER_DATA_DIR = config.USER_DATA_DIR;
const MCP_JSON_PATH = config.MCP_JSON_PATH;

function readJsonWithComments(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  // Strip // and /* */ comments (naive but sufficient for config files)
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|\s+)\/\/.*$/gm, '') // line comments
    .trim();
  try {
    return JSON.parse(stripped);
  } catch (e) {
    console.error('Failed to parse JSON at', filePath);
    console.error('First 200 chars after stripping comments:', stripped.slice(0, 200));
    throw e;
  }
}

function isBraveRunning() {
  return new Promise((resolve) => {
    http.get(`http://localhost:${REMOTE_DEBUGGING_PORT}/json/version`, (res) => {
      resolve(res.statusCode === 200);
    }).on('error', () => resolve(false));
  });
}

function launchBrave() {
  return spawn(BRAVE_PATH, [
    '--remote-debugging-port=' + REMOTE_DEBUGGING_PORT,
    '--user-data-dir=' + USER_DATA_DIR
  ], {
    detached: true,
    stdio: 'ignore'
  });
}

function waitForDevTools(timeout = 10000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function check() {
      http.get(`http://localhost:${REMOTE_DEBUGGING_PORT}/json/version`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.webSocketDebuggerUrl) {
              resolve(json.webSocketDebuggerUrl);
              return;
            }
          } catch {}
          if (Date.now() - start > timeout) reject(new Error('Timeout waiting for DevTools'));
          else setTimeout(check, 500);
        });
      }).on('error', () => {
        if (Date.now() - start > timeout) reject(new Error('Timeout waiting for DevTools'));
        else setTimeout(check, 500);
      });
    })();
  });
}

function updateMcpJson(wsUrl) {
  const mcp = readJsonWithComments(MCP_JSON_PATH);
  if (!mcp.servers || !mcp.servers.playwright) throw new Error('No playwright server config found');
  const args = mcp.servers.playwright.args;
  const idx = args.findIndex(a => a.startsWith('--cdp-endpoint='));
  if (idx !== -1) args[idx] = `--cdp-endpoint=${wsUrl}`;
  else args.push(`--cdp-endpoint=${wsUrl}`);
  fs.writeFileSync(MCP_JSON_PATH, JSON.stringify(mcp, null, 2));
  console.log('Updated mcp.json with new --cdp-endpoint');
}

(async () => {
  let running = await isBraveRunning();
  if (!running) {
    console.log('Brave not running, launching...');
    launchBrave();
    // Wait a bit for Brave to start
    await new Promise(r => setTimeout(r, 2000));
  }
  const wsUrl = await waitForDevTools();
  await updateMcpJson(wsUrl);
  console.log('Done.');
  process.exit(0);
})();
