const {
  app, BrowserWindow, clipboard, desktopCapturer, ipcMain, net, screen, session, shell, utilityProcess,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createNativeEngine } = require('./engines/native');
const { createPortableEngine } = require('./engines/portable');
const { SPEAKER_LABELS, createEchoFilter } = require('./speakers');

const IS_MAC = process.platform === 'darwin';
// Su macOS si usa il motore Swift; altrove (Windows) quello portabile. CONVERTO_ENGINE=portable
// forza il motore portabile anche su Mac, per provarlo.
const USE_PORTABLE_ENGINE = !IS_MAC || process.env.CONVERTO_ENGINE === 'portable';

const TRANSCRIPTS_DIR = path.join(app.getPath('documents'), 'Converto');
const STATE_PATH = path.join(app.getPath('userData'), 'window-state.json');
// Su Windows i modelli (circa 800 MB) vanno in AppData\Local: non devono seguire il profilo roaming.
const MODELS_DIR = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA ?? app.getPath('userData'), 'Converto', 'models')
  : path.join(app.getPath('userData'), 'models');

const SETTINGS_PANES = IS_MAC
  ? {
    audioCapture: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture',
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    translation: 'x-apple.systempreferences:com.apple.Localization-Settings.extension',
  }
  : {
    microphone: 'ms-settings:privacy-microphone',
    sound: 'ms-settings:sound',
  };

const OVERLAY_SIZE = { width: 760, height: 170 };
const NO_TRANSLATION = 'none';
const TITLE_BAR_HEIGHT = 52;

let win = null;
let selfTest = null; // `--self-test`: diagnostica del motore da riga di comando
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

function platformWindowOptions() {
  if (IS_MAC) {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 18 },
      vibrancy: 'under-window',
      visualEffectState: 'active',
      backgroundColor: '#00000000',
    };
  }
  // Windows: barra del titolo nascosta, i pulsanti di sistema restano disegnati sopra l'interfaccia.
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#e8e6f5', height: TITLE_BAR_HEIGHT },
    backgroundColor: '#0b0b12',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
  };
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
    ...platformWindowOptions(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      // l'audio catturato nel renderer deve continuare ad arrivare anche con la finestra in secondo piano
      backgroundThrottling: !engine.capturesInRenderer,
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
    if (IS_MAC) {
      win.setWindowButtonVisibility(false);
      win.setVibrancy('hud');
    }
  } else {
    win.setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true });
    if (IS_MAC) {
      win.setWindowButtonVisibility(true);
      win.setVibrancy('under-window');
    }
    win.setMinimumSize(380, 420);
    if (normalBounds) win.setBounds(normalBounds, true);
  }
  win.webContents.send('overlay', on);
}

function send(message) {
  win?.webContents.send('engine', message);
}

// ---------- Motore ----------

// In modalità "Io + altri" le frasi del microfono passano dal filtro dell'eco.
const echoFilter = createEchoFilter(deliverEngineMessage);

function onEngineMessage(message) {
  if (selfTest) {
    selfTest(message);
    return;
  }
  if (transcript?.mixed) echoFilter.handle(message);
  else deliverEngineMessage(message);
}

function deliverEngineMessage(message) {
  if (message.type === 'final') writeTranscript(message);
  send(message);
}

function onEngineStopped() {
  echoFilter.reset();
  closeTranscript();
  send({ type: 'stopped' });
}

const engine = USE_PORTABLE_ENGINE
  ? createPortableEngine({
    modelsDir: MODELS_DIR,
    fetchImpl: (url, options) => net.fetch(url, options), // usa il proxy di sistema
    fork: (file) => {
      const child = utilityProcess.fork(path.join(__dirname, 'engines', 'portable', file), [], {
        serviceName: `Converto ${file}`,
        stdio: 'pipe',
      });
      child.stderr?.on('data', (data) => console.error(`[${file}]`, data.toString().trim()));
      return {
        post: (message) => child.postMessage(message),
        onMessage: (callback) => child.on('message', callback),
        onExit: (callback) => child.on('exit', callback),
        kill: () => child.kill(),
      };
    },
    onMessage: onEngineMessage,
    onStopped: onEngineStopped,
  })
  : createNativeEngine({
    enginePath: app.isPackaged
      ? path.join(process.resourcesPath, 'bin', 'converto-engine')
      : path.join(__dirname, '..', 'engine', 'build', 'converto-engine'),
    onMessage: onEngineMessage,
    onStopped: onEngineStopped,
  });

function startEngine(config) {
  // Un nuovo avvio sostituisce il motore senza segnalare "fermo": l'interfaccia resta in ascolto.
  engine.stop();
  echoFilter.reset();
  closeTranscript();
  transcript = { source: config.source, target: config.target, mixed: config.input === 'both', stream: null };
  engine.start(config);
}

function stopEngine() {
  engine.stop();
  onEngineStopped();
}

/** Audio del PC in loopback per il renderer (motore portabile): Windows lo cattura senza driver. */
function allowSystemAudioCapture() {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
      .catch(() => callback({}));
  });
}

// ---------- Trascrizioni su file ----------

function languageName(code) {
  return new Intl.DisplayNames(['it'], { type: 'language' }).of(code.split('-')[0]) ?? code;
}

function writeTranscript({ text, translation, stream }) {
  if (!transcript) return;
  if (!transcript.stream) {
    fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
    const now = new Date();
    const stamp = now.toLocaleString('sv-SE').slice(0, 16).replace(':', '.');
    const pair = transcript.target === NO_TRANSLATION
      ? `Trascrizione in ${languageName(transcript.source)}`
      : `${languageName(transcript.source)} → ${languageName(transcript.target)}`;
    transcript.stream = fs.createWriteStream(path.join(TRANSCRIPTS_DIR, `${stamp}.md`), { flags: 'a' });
    transcript.stream.write(`# Converto · ${now.toLocaleString('it-IT')} · ${pair}\n\n`);
  }
  const time = new Date().toLocaleTimeString('it-IT');
  const speaker = transcript.mixed ? `**${SPEAKER_LABELS[stream]}:** ` : '';
  const lines = translation
    ? `**${time}** ${speaker}${translation}  \n_${text}_\n\n`
    : `**${time}** ${speaker}${text}\n\n`;
  transcript.stream.write(lines);
}

function closeTranscript() {
  transcript?.stream?.end();
  transcript = null;
}

// ---------- IPC ----------

ipcMain.handle('app:info', () => ({
  platform: process.platform,
  captureInRenderer: engine.capturesInRenderer,
}));
ipcMain.on('engine:start', (_event, config) => startEngine(config));
ipcMain.on('engine:stop', () => stopEngine());
ipcMain.on('audio:chunk', (_event, stream, samples) => engine.pushAudio(stream, samples));
ipcMain.on('window:overlay', (_event, on) => setOverlay(Boolean(on)));
ipcMain.on('open:transcripts', () => {
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  shell.openPath(TRANSCRIPTS_DIR);
});
ipcMain.on('clipboard:write', (_event, text) => clipboard.writeText(String(text)));
ipcMain.on('open:settings', (_event, pane) => {
  if (SETTINGS_PANES[pane]) shell.openExternal(SETTINGS_PANES[pane]);
});

// ---------- Diagnostica ----------

/**
 * `Converto --self-test`: scarica (se servono) e carica i modelli, poi esce con 0 se il motore
 * è pronto e 1 in caso di errore. Utile per verificare un'installazione senza interfaccia.
 */
function runSelfTest() {
  // Le app grafiche su Windows spesso non mostrano l'output nel terminale: l'esito va anche su file.
  const logPath = path.join(app.getPath('userData'), 'self-test.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, '');
  const log = (line) => {
    console.log(line);
    fs.appendFileSync(logPath, `${line}\n`);
  };
  const finish = (code) => {
    log(`Registro: ${logPath}`);
    engine.stop();
    app.exit(code);
  };

  log(`Converto ${app.getVersion()} · ${process.platform}-${process.arch} · motore ${USE_PORTABLE_ENGINE ? 'portabile' : 'Swift'}`);
  log(`Modelli: ${MODELS_DIR}`);
  let lastProgress = -1;
  selfTest = (message) => {
    if (message.type === 'progress') {
      const percent = Math.floor(message.value * 100);
      if (percent >= lastProgress + 10) {
        lastProgress = percent;
        log(`  download ${percent}%`);
      }
    } else if (message.type === 'status') {
      log(`  ${message.message}`);
      if (message.state === 'listening') {
        log('OK: motore pronto');
        finish(0);
      }
    } else if (message.type === 'error') {
      log(`ERRORE ${message.code}: ${message.message}`);
      if (message.code !== 'translation_unsupported') finish(1);
    }
  };
  engine.start({ source: 'en-US', target: 'it', input: 'system' });
}

// ---------- Ciclo di vita ----------

if (process.argv.includes('--self-test')) {
  app.whenReady().then(runSelfTest);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.whenReady().then(() => {
    if (engine.capturesInRenderer) allowSystemAudioCapture();
    createWindow();
  });
  app.on('activate', () => {
    if (!win) createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => engine.stop());
}
