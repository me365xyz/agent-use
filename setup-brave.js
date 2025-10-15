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
  const agent = config.AGENT || 'vscode';
  
  let playwrightConfig;
  
  if (agent === 'cursor') {
    // Cursor format: mcpServers.Playwright
    if (!mcp.mcpServers) {
      mcp.mcpServers = {};
    }
    if (!mcp.mcpServers.Playwright) {
      mcp.mcpServers.Playwright = {
        command: "npx @playwright/mcp@latest"
      };
    }
    playwrightConfig = mcp.mcpServers.Playwright;
    
    // For Cursor, we need to update the command to include --cdp-endpoint
    if (!playwrightConfig.command) {
      playwrightConfig.command = "npx @playwright/mcp@latest";
    }
    
    // Parse existing command and update/add --cdp-endpoint
    const commandParts = playwrightConfig.command.split(' ');
    const cdpIndex = commandParts.findIndex(part => part.startsWith('--cdp-endpoint='));
    
    if (cdpIndex !== -1) {
      commandParts[cdpIndex] = `--cdp-endpoint=${wsUrl}`;
    } else {
      commandParts.push(`--cdp-endpoint=${wsUrl}`);
    }
    
    playwrightConfig.command = commandParts.join(' ');
    
  } else {
    // VS Code format: servers.playwright
    if (!mcp.servers) {
      mcp.servers = {};
    }
    if (!mcp.servers.playwright) {
      mcp.servers.playwright = {
        command: "npx",
        args: ["@playwright/mcp@latest"]
      };
    }
    playwrightConfig = mcp.servers.playwright;
    
    if (!playwrightConfig.args) playwrightConfig.args = [];
    const args = playwrightConfig.args;
    const idx = args.findIndex(a => a.startsWith('--cdp-endpoint='));
    if (idx !== -1) args[idx] = `--cdp-endpoint=${wsUrl}`;
    else args.push(`--cdp-endpoint=${wsUrl}`);
  }
  
  fs.writeFileSync(MCP_JSON_PATH, JSON.stringify(mcp, null, 2));
  console.log(`Updated mcp.json with new --cdp-endpoint for Brave (${agent} format)`);
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
