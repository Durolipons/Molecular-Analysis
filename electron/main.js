const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, dialog, shell } = require('electron');

const APP_HOST = process.env.ELECTRON_APP_HOST || '127.0.0.1';
const APP_PORT = Number(process.env.ELECTRON_APP_PORT || process.env.PORT || 8080);
const APP_URL = `http://${APP_HOST}:${APP_PORT}/`;
const APP_USER_MODEL_ID = 'com.durolipons.molecularanalysis';
const APP_ICON_PATH = path.join(__dirname, '..', 'assets', 'app-icon.png');
const HEALTH_PATH = '/api/health';
const HEALTH_RETRY_DELAY_MS = 300;
const STARTUP_TIMEOUT_MS = 20000;

let mainWindow = null;
let serverProcess = null;
let startedServerProcess = false;
let isQuitting = false;

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

function isAppUrl(targetUrl) {
    try {
        const parsedUrl = new URL(targetUrl);
        const targetPort = parsedUrl.port || '80';
        return parsedUrl.protocol === 'http:'
            && parsedUrl.hostname === APP_HOST
            && targetPort === String(APP_PORT);
    } catch (error) {
        return false;
    }
}

function probeServer() {
    return new Promise(resolve => {
        const request = http.get({
            host: APP_HOST,
            port: APP_PORT,
            path: HEALTH_PATH,
            timeout: 2000
        }, response => {
            response.resume();
            resolve(response.statusCode === 200);
        });

        request.on('error', () => {
            resolve(false);
        });

        request.on('timeout', () => {
            request.destroy();
            resolve(false);
        });
    });
}

function startServerProcess() {
    const projectRoot = path.join(__dirname, '..');
    const serverScriptPath = path.join(projectRoot, 'server.js');

    serverProcess = spawn(process.execPath, [serverScriptPath], {
        cwd: projectRoot,
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            HOST: APP_HOST,
            PORT: String(APP_PORT)
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
    startedServerProcess = true;

    serverProcess.stdout.on('data', data => {
        process.stdout.write(`[desktop/server] ${data}`);
    });

    serverProcess.stderr.on('data', data => {
        process.stderr.write(`[desktop/server] ${data}`);
    });

    serverProcess.on('exit', (code, signal) => {
        serverProcess = null;

        if (!isQuitting) {
            console.error(`Desktop-managed server exited with code ${code} and signal ${signal || 'none'}.`);
        }
    });
}

async function ensureServerReady() {
    if (await probeServer()) {
        return;
    }

    startServerProcess();
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;

    while (Date.now() < deadline) {
        if (await probeServer()) {
            return;
        }

        await sleep(HEALTH_RETRY_DELAY_MS);
    }

    throw new Error(
        `The desktop shell could not reach the local workflow server at ${APP_URL}.`
    );
}

function forwardExternalNavigation(webContents) {
    webContents.setWindowOpenHandler(({ url }) => {
        if (isAppUrl(url)) {
            return { action: 'allow' };
        }

        shell.openExternal(url).catch(error => {
            console.error('Unable to open external URL:', error);
        });
        return { action: 'deny' };
    });

    webContents.on('will-navigate', (event, url) => {
        if (isAppUrl(url)) {
            return;
        }

        event.preventDefault();
        shell.openExternal(url).catch(error => {
            console.error('Unable to open external URL:', error);
        });
    });
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 960,
        minWidth: 1100,
        minHeight: 760,
        autoHideMenuBar: true,
        show: false,
        backgroundColor: '#0f0f1e',
        icon: APP_ICON_PATH,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    forwardExternalNavigation(mainWindow.webContents);

    mainWindow.once('ready-to-show', () => {
        if (mainWindow) {
            mainWindow.show();
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    mainWindow.loadURL(APP_URL).catch(error => {
        console.error('Unable to load desktop application URL:', error);
    });
}

function stopServerProcess() {
    if (!startedServerProcess || !serverProcess || serverProcess.killed) {
        return;
    }

    serverProcess.kill();
}

async function bootstrapDesktopApp() {
    try {
        await ensureServerReady();
        createMainWindow();
    } catch (error) {
        dialog.showErrorBox(
            'Desktop startup failed',
            `${error.message}\n\nCheck that the Node.js dependencies are installed and that port ${APP_PORT} is available.`
        );
        app.quit();
    }
}

if (process.platform === 'win32') {
    app.setAppUserModelId(APP_USER_MODEL_ID);
}

app.whenReady().then(bootstrapDesktopApp);

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
    }
});

app.on('before-quit', () => {
    isQuitting = true;
    stopServerProcess();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});