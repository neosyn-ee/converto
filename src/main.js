const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ENGINE_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'bin', 'converto-engine')
  : path.join(__dirname, '..', 'engine', 'build', 'converto-engine');
const TRANSCRIPTS_DIR = path.join(app.getPath('documents'), 'Converto');
const STATE_PATH = path.join(app.getPath('userData'), 'window-state.json');

const SETTINGS_PANES = {
  audioCapture: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  translation: 'x-apple.systempreferences:com.apple.Localization-Settings.extension',
};

const OVERLAY_SIZE = { width: 760, height: 170 };

let win = null;
let engine = null;
let transcript = null;
let overlay = false;
let normalBounds = null;

// ---------- Finestra ----------

function readWindowState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveWindowState() {
  const bounds = overlay ? normalBounds : win?.getBounds();
  if (!bounds) return;
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ bounds }));
  } catch {
    // non essenziale
  }
}

function createWindow() {
  const { bounds } = readWindowState();
  win = new BrowserWindow({
    width: 520,
    height: 720,
    ...bounds,
    minWidth: 380,
    minHeight: 420,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('close', saveWindowState);
  win.on('closed', () => {
    win = null;
  });
}

function setOverlay(on) {
  if (!win || on === overlay) return;
  overlay = on;
  if (on) {
    normalBounds = win.getBounds();
    const { workArea } = screen.getDisplayMatching(normalBounds);
    const width = Math.min(OVERLAY_SIZE.width, workArea.width - 40);
    win.setMinimumSize(360, 110);
    win.setBounds({
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: workArea.y + workArea.height - OVERLAY_SIZE.height - 24,
      width,
      height: OVERLAY_SIZE.height,
    }, true);
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setWindowButtonVisibility(false);
    win.setVibrancy('hud');
  } else {
    win.setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true });
    win.setWindowButtonVisibility(true);
    win.setVibrancy('under-window');
    win.setMinimumSize(380, 420);
    if (normalBounds) win.setBounds(normalBounds, true);
  }
  win.webContents.send('overlay', on);
}

function send(message) {
  win?.webContents.send('engine', message);
}

// ---------- Motore ----------

function startEngine({ source, target, input }) {
  stopEngine();
  const proc = spawn(ENGINE_PATH, ['--source', source, '--target', target, '--input', input], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  engine = proc;
  transcript = { source, target, stream: null };

  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === 'final') writeTranscript(message);
    send(message);
  });
  proc.stderr.on('data', (data) => console.error('[engine]', data.toString().trim()));
  proc.on('error', (error) => send({ type: 'error', code: 'engine_failed', message: error.message }));
  proc.on('exit', () => {
    if (engine !== proc) return; // già sostituito da un nuovo avvio
    engine = null;
    closeTranscript();
    send({ type: 'stopped' });
  });
}

function stopEngine() {
  if (!engine) return;
  const proc = engine;
  engine = null;
  proc.kill('SIGTERM');
  closeTranscript();
  send({ type: 'stopped' });
}

// ---------- Trascrizioni su file ----------

function languageName(code) {
  return new Intl.DisplayNames(['it'], { type: 'language' }).of(code.split('-')[0]) ?? code;
}

function writeTranscript({ text, translation }) {
  if (!transcript) return;
  if (!transcript.stream) {
    fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
    const now = new Date();
    const stamp = now.toLocaleString('sv-SE').slice(0, 16).replace(':', '.');
    const pair = `${languageName(transcript.source)} → ${languageName(transcript.target)}`;
    transcript.stream = fs.createWriteStream(path.join(TRANSCRIPTS_DIR, `${stamp}.md`), { flags: 'a' });
    transcript.stream.write(`# Converto · ${now.toLocaleString('it-IT')} · ${pair}\n\n`);
  }
  const time = new Date().toLocaleTimeString('it-IT');
  const lines = translation ? `**${time}** ${translation}  \n_${text}_\n\n` : `**${time}** ${text}\n\n`;
  transcript.stream.write(lines);
}

function closeTranscript() {
  transcript?.stream?.end();
  transcript = null;
}

// ---------- IPC ----------

ipcMain.on('engine:start', (_event, config) => startEngine(config));
ipcMain.on('engine:stop', () => stopEngine());
ipcMain.on('window:overlay', (_event, on) => setOverlay(Boolean(on)));
ipcMain.on('open:transcripts', () => {
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  shell.openPath(TRANSCRIPTS_DIR);
});
ipcMain.on('open:settings', (_event, pane) => {
  if (SETTINGS_PANES[pane]) shell.openExternal(SETTINGS_PANES[pane]);
});

// ---------- Ciclo di vita ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.whenReady().then(createWindow);
  app.on('activate', () => {
    if (!win) createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', stopEngine);
}
