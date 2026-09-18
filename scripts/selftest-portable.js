// Prova completa del motore portabile dentro Electron, con un microfono finto che legge un WAV:
// cattura nel renderer → riconoscimento → traduzione → interfaccia → trascrizione su file.
//
//   npx electron scripts/selftest-portable.js audio.wav
//
// Usa una cartella temporanea per impostazioni e trascrizioni; i modelli restano quelli dell'app.
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wav = path.resolve(process.argv.find((arg) => arg.endsWith('.wav')) ?? '');
if (!fs.existsSync(wav)) {
  console.error('Uso: npx electron scripts/selftest-portable.js audio.wav');
  process.exit(1);
}

// Lanciato così Electron si chiama "Electron": i modelli dell'app sono nella cartella di Converto.
const realModels = path.join(app.getPath('appData'), 'Converto', 'models');
if (!fs.existsSync(realModels)) {
  console.error(`Modelli non trovati in ${realModels}: avvia prima l'app o scripts/try-portable-engine.js`);
  process.exit(1);
}
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'converto-selftest-'));
fs.mkdirSync(path.join(sandbox, 'userData'));
fs.symlinkSync(realModels, path.join(sandbox, 'userData', 'models'));
app.setPath('userData', path.join(sandbox, 'userData'));
app.setPath('documents', path.join(sandbox, 'documents'));

process.env.CONVERTO_ENGINE = 'portable';
app.commandLine.appendSwitch('disable-features', 'AudioServiceSandbox'); // per leggere il WAV
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', `${wav}%noloop`);

require('../src/main.js');

const seconds = Number(process.env.SELFTEST_SECONDS ?? 40);
const input = process.env.SELFTEST_INPUT ?? 'mic';
app.on('browser-window-created', (_event, win) => {
  win.webContents.on('console-message', (details) => console.log('[renderer]', details.message));
  win.webContents.once('did-finish-load', async () => {
    await win.webContents.executeJavaScript(`localStorage.setItem('settings', JSON.stringify(
      { mode: 'translate', source: 'en-US', target: 'it', input: '${input}' }))`);
    win.webContents.once('did-finish-load', () => {
      // clic su Avvia come gesto dell'utente
      win.webContents.executeJavaScript("document.getElementById('toggle').click()", true);
      setTimeout(() => report(win), seconds * 1000);
    });
    win.webContents.reload();
  });
});

async function report(win) {
  const ui = await win.webContents.executeJavaScript(`({
    settings: localStorage.getItem('settings'),
    status: document.getElementById('status-text').textContent,
    running: document.body.classList.contains('running'),
    entries: [...document.querySelectorAll('#entries .entry')].map((e) => e.querySelector('.tr').textContent),
    banner: document.getElementById('banner').hidden ? null : document.getElementById('banner-text').textContent,
  })`);
  console.log('\n=== INTERFACCIA ===');
  console.log(JSON.stringify(ui, null, 2));
  const dir = path.join(sandbox, 'documents', 'Converto');
  for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    console.log(`\n=== TRASCRIZIONE ${file} ===\n${fs.readFileSync(path.join(dir, file), 'utf8')}`);
  }
  win.webContents.executeJavaScript("document.getElementById('toggle').click()", true);
  setTimeout(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
    app.quit();
  }, 1000);
}
