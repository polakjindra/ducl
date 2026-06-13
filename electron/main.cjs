'use strict';

const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

let serverProcess;
let mainWindow;
let appQuitting = false;

const SERVER_PORT = 4000;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;

// In dev: project root (where .env lives).
// In packaged: Electron's userData dir (writable, persists across updates).
function getConfigDir() {
  if (app.isPackaged) {
    return app.getPath('userData');
  }
  return path.join(__dirname, '..');
}

function startServer() {
  const isDev = !app.isPackaged;
  const configDir = getConfigDir();

  // Ensure the config dir exists (important on first packaged launch).
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const serverEnv = {
    ...process.env,
    DUCL_CONFIG_DIR: configDir,
  };

  if (isDev) {
    // Reuse the existing dev script so --conditions=node and all flags stay in sync.
    serverProcess = spawn('npm', ['run', 'dev'], {
      cwd: path.join(__dirname, '..'),
      env: serverEnv,
      shell: true,
    });
  } else {
    // Packaged: run compiled dist/server.js via Electron's embedded Node.
    const appDir = path.join(__dirname, '..');
    const serverScript = path.join(appDir, 'dist', 'server.js');
    serverProcess = spawn(process.execPath, [serverScript], {
      cwd: appDir,
      env: { ...serverEnv, ELECTRON_RUN_AS_NODE: '1' },
    });
  }

  serverProcess.stdout.on('data', (data) => process.stdout.write(`[server] ${data}`));
  serverProcess.stderr.on('data', (data) => process.stderr.write(`[server] ${data}`));
  serverProcess.on('exit', (code) => {
    console.log(`[server] exited with code ${code}`);
    serverProcess = null;
    // Only respawn on clean exit (code 0) — that's the /internal/restart signal.
    // Non-zero exits are crashes; don't loop on those.
    if (!appQuitting && code === 0) {
      console.log('[electron] respawning server in 500ms…');
      setTimeout(() => startServer(), 500);
    }
  });
}

function waitForServer(callback, retries = 30) {
  http.get(SERVER_URL, () => {
    callback();
  }).on('error', () => {
    if (retries > 0) {
      setTimeout(() => waitForServer(callback, retries - 1), 500);
    } else {
      console.error('[electron] server did not start in time — opening window anyway');
      callback();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'ducl',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(SERVER_URL);
}

function killServer() {
  appQuitting = true;
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    serverProcess = null;
  }
}

app.whenReady().then(() => {
  startServer();
  waitForServer(createWindow);
});

app.on('window-all-closed', () => {
  killServer();
  app.quit();
});

app.on('before-quit', () => {
  killServer();
});
