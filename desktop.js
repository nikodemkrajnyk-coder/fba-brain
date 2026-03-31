const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { fork } = require('child_process');

let mainWindow;
let tray;
let server;

const PORT = 3000;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 800,
    minWidth: 380,
    minHeight: 600,
    title: 'FBA Brain',
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Wait for server to be ready then load
  setTimeout(() => {
    mainWindow.loadURL(`http://localhost:${PORT}`);
  }, 2000);

  mainWindow.on('close', (e) => {
    // Minimize to tray instead of closing
    e.preventDefault();
    mainWindow.hide();
  });
}

function createTray() {
  // Create a simple tray icon
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);

  const menu = Menu.buildFromTemplate([
    { label: '🧠 Open FBA Brain', click: () => mainWindow.show() },
    { type: 'separator' },
    { label: '📧 Gmail: checking every 2 min', enabled: false },
    { label: '🔍 Scanner: every 6 hours', enabled: false },
    { label: '📦 Stock check: daily 8am', enabled: false },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        if (server) server.kill();
        app.exit(0);
      },
    },
  ]);

  tray.setToolTip('FBA Brain — Running');
  tray.setContextMenu(menu);
  tray.on('click', () => mainWindow.show());
}

function startServer() {
  server = fork(path.join(__dirname, 'server.js'), [], {
    env: { ...process.env, PORT: PORT.toString() },
    silent: true,
  });

  server.stdout.on('data', (data) => console.log(`[Server] ${data}`));
  server.stderr.on('data', (data) => console.error(`[Server] ${data}`));

  server.on('exit', (code) => {
    console.log(`Server exited with code ${code}`);
    // Auto-restart
    setTimeout(startServer, 3000);
  });
}

app.whenReady().then(() => {
  startServer();
  createWindow();
  createTray();
});

app.on('window-all-closed', (e) => {
  // Keep running in tray
  e.preventDefault();
});

app.on('before-quit', () => {
  if (server) server.kill();
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});
