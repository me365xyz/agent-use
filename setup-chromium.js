#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const config = require('./config.json');

// Chromium-specific configuration
const CHROMIUM_PATH = config.CHROMIUM_PATH || "/Applications/Chromium.app/Contents/MacOS/Chromium";
const REMOTE_DEBUGGING_PORT = config.CHROMIUM_DEBUGGING_PORT || 9223; // Different port to avoid conflicts
const USER_DATA_DIR = path.join(require('os').homedir(), 'Library/Application Support/Chromium');
const MCP_JSON_PATH = config.MCP_JSON_PATH;

function readJsonWithComments(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s+)\/\/.*$/gm, '')
    .trim();
  try {
    return JSON.parse(stripped);
  } catch (e) {
    console.error('Failed to parse JSON at', filePath);
    console.error('First 200 chars after stripping comments:', stripped.slice(0, 200));
    throw e;
  }
}

function isChromiumRunning() {
  return new Promise((resolve) => {
    http.get(`http://localhost:${REMOTE_DEBUGGING_PORT}/json/version`, (res) => {
      resolve(res.statusCode === 200);
    }).on('error', () => resolve(false));
  });
}

function launchChromium() {
  return spawn(CHROMIUM_PATH, [
    '--remote-debugging-port=' + REMOTE_DEBUGGING_PORT,
    '--user-data-dir=' + USER_DATA_DIR,
    '--no-first-run',
    '--no-default-browser-check'
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
  console.log('Updated mcp.json with new --cdp-endpoint for Chromium');
}

(async () => {
  try {
    let running = await isChromiumRunning();
    if (!running) {
      console.log('Chromium not running, launching...');
      launchChromium();
      // Wait a bit for Chromium to start
      await new Promise(r => setTimeout(r, 3000));
    }
    const wsUrl = await waitForDevTools();
    await updateMcpJson(wsUrl);
    console.log('Chromium setup complete.');
    process.exit(0);
  } catch (error) {
    console.error('Error setting up Chromium:', error.message);
    process.exit(1);
  }
})();
