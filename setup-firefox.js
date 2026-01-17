#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const config = require('./config.json');

// Firefox-specific configuration
const FIREFOX_PATH = config.FIREFOX_PATH || "/Applications/Firefox.app/Contents/MacOS/firefox";
const REMOTE_DEBUGGING_PORT = config.FIREFOX_DEBUGGING_PORT || 9224; // Different port to avoid conflicts
const PROFILE_DIR = path.join(require('os').homedir(), 'Library/Application Support/Firefox/Profiles/playwright');
// Use Cursor path if AGENT is "cursor", otherwise use VS Code path
const MCP_JSON_PATH = config.AGENT === 'cursor' ? config.MCP_JSON_PATH_CURSOR : config.MCP_JSON_PATH;

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

function isFirefoxRunning() {
  return new Promise((resolve) => {
    // Firefox uses a different endpoint structure
    http.get(`http://localhost:${REMOTE_DEBUGGING_PORT}/json/version`, (res) => {
      resolve(res.statusCode === 200);
    }).on('error', () => resolve(false));
  });
}

function createFirefoxProfile() {
  if (!fs.existsSync(PROFILE_DIR)) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    
    // Create user.js with required preferences
    const prefs = `
// Enable remote debugging
user_pref("devtools.debugger.remote-enabled", true);
user_pref("devtools.chrome.enabled", true);
user_pref("devtools.debugger.remote-port", ${REMOTE_DEBUGGING_PORT});
user_pref("devtools.debugger.force-local", false);
user_pref("devtools.debugger.prompt-connection", false);

// Disable various Firefox features for automation
user_pref("browser.startup.homepage", "about:blank");
user_pref("startup.homepage_welcome_url", "");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("browser.startup.firstrunSkipsHomepage", true);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.rights.3.shown", true);
user_pref("browser.tabs.warnOnClose", false);
user_pref("browser.tabs.warnOnCloseOtherTabs", false);
user_pref("browser.tabs.warnOnOpen", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
`;
    fs.writeFileSync(path.join(PROFILE_DIR, 'user.js'), prefs);
  }
}

function launchFirefox() {
  createFirefoxProfile();
  
  return spawn(FIREFOX_PATH, [
    '--profile', PROFILE_DIR,
    '--remote-debugging-port=' + REMOTE_DEBUGGING_PORT,
    '--headless', // Remove this if you want to see the browser
    '--no-remote',
    '--new-instance'
  ], {
    detached: true,
    stdio: 'ignore'
  });
}

function waitForDevTools(timeout = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function check() {
      // Firefox debugging endpoint is different from Chrome
      http.get(`http://localhost:${REMOTE_DEBUGGING_PORT}/json/list`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const tabs = JSON.parse(data);
            if (tabs && tabs.length > 0 && tabs[0].webSocketDebuggerUrl) {
              resolve(tabs[0].webSocketDebuggerUrl);
              return;
            }
          } catch {}
          if (Date.now() - start > timeout) reject(new Error('Timeout waiting for Firefox DevTools'));
          else setTimeout(check, 1000);
        });
      }).on('error', () => {
        if (Date.now() - start > timeout) reject(new Error('Timeout waiting for Firefox DevTools'));
        else setTimeout(check, 1000);
      });
    })();
  });
}

function updateMcpJson(wsUrl) {
  const mcp = readJsonWithComments(MCP_JSON_PATH);
  // Handle both old format (servers.playwright) and new format (mcpServers.Playwright)
  let playwrightConfig = null;
  if (mcp.mcpServers && mcp.mcpServers.Playwright) {
    playwrightConfig = mcp.mcpServers.Playwright;
  } else if (mcp.servers && mcp.servers.playwright) {
    playwrightConfig = mcp.servers.playwright;
  } else if (mcp.servers && mcp.servers.Playwright) {
    playwrightConfig = mcp.servers.Playwright;
  }
  
  if (!playwrightConfig) throw new Error('No Playwright server config found in mcp.json');
  
  // Handle command as string (new format) or args array (old format)
  if (typeof playwrightConfig.command === 'string') {
    // Update the --cdp-endpoint in the command string
    const command = playwrightConfig.command;
    const cdpRegex = /--cdp-endpoint=[^\s]+/;
    if (cdpRegex.test(command)) {
      playwrightConfig.command = command.replace(cdpRegex, `--cdp-endpoint=${wsUrl}`);
    } else {
      playwrightConfig.command = `${command} --cdp-endpoint=${wsUrl}`;
    }
  } else if (Array.isArray(playwrightConfig.args)) {
    // Old format with args array
    const idx = playwrightConfig.args.findIndex(a => a.startsWith('--cdp-endpoint='));
    if (idx !== -1) playwrightConfig.args[idx] = `--cdp-endpoint=${wsUrl}`;
    else playwrightConfig.args.push(`--cdp-endpoint=${wsUrl}`);
  }
  
  // Note: Firefox uses WebDriver protocol, not Chrome DevTools Protocol
  // You may need to adjust your MCP server configuration for Firefox
  console.log('Warning: Firefox uses WebDriver protocol, not CDP. You may need to adjust your MCP server configuration.');
  
  fs.writeFileSync(MCP_JSON_PATH, JSON.stringify(mcp, null, 2));
  console.log('Updated mcp.json with new --cdp-endpoint for Firefox');
}

(async () => {
  try {
    let running = await isFirefoxRunning();
    if (!running) {
      console.log('Firefox not running, launching...');
      launchFirefox();
      // Wait longer for Firefox to start as it's typically slower
      await new Promise(r => setTimeout(r, 5000));
    }
    const wsUrl = await waitForDevTools();
    await updateMcpJson(wsUrl);
    console.log('Firefox setup complete.');
    console.log('Note: Firefox uses WebDriver protocol. Ensure your MCP server supports it.');
    process.exit(0);
  } catch (error) {
    console.error('Error setting up Firefox:', error.message);
    console.error('Firefox may require additional configuration for remote debugging.');
    process.exit(1);
  }
})();
