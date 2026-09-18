'use strict';

const SOURCES = [
  ['en-US', 'Inglese (USA)'],
  ['en-GB', 'Inglese (UK)'],
  ['it-IT', 'Italiano'],
  ['fr-FR', 'Francese'],
  ['es-ES', 'Spagnolo'],
  ['de-DE', 'Tedesco'],
  ['pt-BR', 'Portoghese'],
  ['zh-CN', 'Cinese'],
  ['ja-JP', 'Giapponese'],
];
const TARGETS = [
  ['it', 'Italiano'],
  ['en', 'Inglese'],
  ['fr', 'Francese'],
  ['es', 'Spagnolo'],
  ['de', 'Tedesco'],
  ['pt', 'Portoghese'],
  ['zh', 'Cinese'],
  ['ja', 'Giapponese'],
];
const INPUT_LABELS = { system: 'Audio del Mac', mic: 'Microfono' };
const DEFAULT_SETTINGS = { source: 'en-US', target: 'it', input: 'system', showOriginal: true, scale: 1 };
const MAX_ENTRIES = 400;
const SILENCE_HINT_MS = 8000;
const SCALE_RANGE = [0.8, 1.7];
const LIVE_TAIL = { window: 220, overlay: 110 };

const ERROR_ACTIONS = {
  permission_denied: {
    label: 'Apri Impostazioni',
    pane: 'audioCapture',
    hint: ' Attiva Converto in Privacy e sicurezza → Registrazione schermo e audio di sistema, poi premi di nuovo Avvia.',
  },
  mic_permission_denied: { label: 'Apri Impostazioni', pane: 'microphone' },
  translation_not_installed: { label: 'Scarica le lingue', pane: 'translation' },
};
const NON_FATAL_ERRORS = new Set(['translation_not_installed', 'translation_unsupported']);

const $ = (id) => document.getElementById(id);
const el = {
  body: document.body,
  source: $('source'),
  target: $('target'),
  swap: $('swap'),
  sourceBadge: $('source-badge'),
  sourceName: $('source-name'),
  sourceCaption: $('source-caption'),
  targetBadge: $('target-badge'),
  targetName: $('target-name'),
  segmented: $('segmented'),
  inputs: [...document.querySelectorAll('[data-input]')],
  transcript: $('transcript'),
  entries: $('entries'),
  live: $('live'),
  liveText: $('live-text'),
  empty: $('empty'),
  banner: $('banner'),
  bannerText: $('banner-text'),
  bannerAction: $('banner-action'),
  jump: $('jump'),
  toggle: $('toggle'),
  statusText: $('status-text'),
  statusSub: $('status-sub'),
  origBtn: $('orig-btn'),
};

const settings = loadSettings();
const state = {
  running: false,
  listening: false,
  failed: false,
  live: null,
  lastFinalId: -1,
  lastSoundAt: 0,
  renderQueued: false,
  bannerPane: null,
};

// ---------- Impostazioni ----------

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('settings') || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem('settings', JSON.stringify(settings));
  } catch {
    // le preferenze restano solo per questa sessione
  }
}

function fillSelect(select, options, value) {
  select.replaceChildren(...options.map(([code, name]) => new Option(name, code, false, code === value)));
}

function nameOf(list, code) {
  return list.find(([c]) => c === code)?.[1] ?? code;
}

function describeSetup() {
  const source = nameOf(SOURCES, settings.source).replace(/ \(.*\)/, '');
  return `${INPUT_LABELS[settings.input]} · ${source} → ${nameOf(TARGETS, settings.target)}`;
}

function applySettings() {
  el.source.value = settings.source;
  el.target.value = settings.target;
  const [sourceLanguage, region] = nameOf(SOURCES, settings.source).split(/ \((.*)\)/);
  el.sourceBadge.textContent = settings.source.split('-')[0].toUpperCase();
  el.sourceName.textContent = sourceLanguage;
  el.sourceCaption.textContent = region ? `Parlano in · ${region}` : 'Parlano in';
  el.targetBadge.textContent = settings.target.toUpperCase();
  el.targetName.textContent = nameOf(TARGETS, settings.target);
  el.segmented.dataset.active = settings.input;
  for (const button of el.inputs) {
    button.setAttribute('aria-checked', String(button.dataset.input === settings.input));
  }
  el.body.classList.toggle('show-orig', settings.showOriginal);
  el.origBtn.setAttribute('aria-pressed', String(settings.showOriginal));
  document.documentElement.style.setProperty('--scale', settings.scale);
  if (!state.running && !state.failed) setStatus('Pronto');
  el.statusSub.textContent = describeSetup();
}

function updateSetting(key, value) {
  settings[key] = value;
  saveSettings();
  applySettings();
  if (state.running) start(); // riparte con la nuova configurazione
}

// ---------- Stato e controlli ----------

function setStatus(text, sub = describeSetup()) {
  el.statusText.textContent = text;
  el.statusSub.textContent = sub;
}

function setRunning(running) {
  state.running = running;
  if (!running) {
    state.listening = false;
    state.live = null;
    setLevel(0);
    queueLive();
    if (!state.failed) setStatus('Pronto');
  }
  el.body.classList.toggle('running', running);
  el.body.classList.toggle('listening', running && state.listening);
  el.toggle.title = running ? 'Ferma' : 'Avvia';
}

function start() {
  hideBanner();
  state.failed = false;
  el.body.classList.remove('failed');
  state.live = null;
  state.lastFinalId = -1;
  setRunning(true);
  setStatus('Avvio…');
  window.converto.start({ source: settings.source, target: settings.target, input: settings.input });
}

function stop() {
  window.converto.stop();
}

function setLevel(value) {
  document.documentElement.style.setProperty('--level', value);
  if (value > 0.05) state.lastSoundAt = Date.now();
}

// Suggerisce di controllare l'audio se non arriva nulla per un po'.
setInterval(() => {
  if (!state.listening) return;
  const silent = Date.now() - state.lastSoundAt > SILENCE_HINT_MS;
  el.statusSub.textContent = silent ? 'Nessun audio in riproduzione' : describeSetup();
}, 2000);

// ---------- Trascrizione ----------

function isNearBottom() {
  const t = el.transcript;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 60;
}

function followScroll(wasAtBottom) {
  if (wasAtBottom || el.body.classList.contains('overlay')) {
    el.transcript.scrollTop = el.transcript.scrollHeight;
    el.jump.hidden = true;
  } else {
    el.jump.hidden = false;
  }
}

function paragraph(className, text) {
  const p = document.createElement('p');
  p.className = className;
  p.textContent = text;
  return p;
}

function addEntry({ text, translation }) {
  const wasAtBottom = isNearBottom();
  const item = document.createElement('li');
  item.className = 'entry';
  const time = new Date().toLocaleTimeString('it-IT');
  item.append(paragraph('meta', time), paragraph('tr', translation ?? text));
  if (translation) item.append(paragraph('orig', text));
  el.entries.append(item);
  while (el.entries.childElementCount > MAX_ENTRIES) el.entries.firstElementChild.remove();
  el.empty.hidden = true;
  followScroll(wasAtBottom);
}

function queueLive() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(renderLive);
}

// Mostra solo la coda della frase in corso: la traduzione arriva, una volta sola, a frase chiusa.
function tail(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(-max);
  return `…${cut.slice(cut.indexOf(' ') + 1)}`;
}

function renderLive() {
  state.renderQueued = false;
  const text = state.live?.text;
  const wasAtBottom = isNearBottom();
  el.live.hidden = !text;
  if (text) {
    const max = el.body.classList.contains('overlay') ? LIVE_TAIL.overlay : LIVE_TAIL.window;
    el.liveText.textContent = tail(text, max);
    el.empty.hidden = true;
  }
  followScroll(wasAtBottom);
}

function clearTranscript() {
  el.entries.replaceChildren();
  state.live = null;
  queueLive();
  el.empty.hidden = false;
  el.jump.hidden = true;
}

// ---------- Messaggi ----------

function showBanner(kind, text, action) {
  el.banner.classList.toggle('info', kind === 'info');
  el.bannerText.textContent = text;
  el.bannerAction.hidden = !action;
  if (action) el.bannerAction.textContent = action.label;
  state.bannerPane = action?.pane ?? null;
  el.banner.hidden = false;
  el.transcript.scrollTop = 0;
}

function hideBanner() {
  el.banner.hidden = true;
}

function showError({ code, message }) {
  const action = ERROR_ACTIONS[code];
  const fatal = !NON_FATAL_ERRORS.has(code);
  showBanner(fatal ? 'error' : 'info', message + (action?.hint ?? ''), action);
  if (fatal) {
    state.failed = true;
    el.body.classList.add('failed');
    setStatus('Interrotto', 'Leggi il messaggio sopra');
  }
}

window.converto.onEngine((message) => {
  switch (message.type) {
    case 'status':
      if (message.state === 'listening') {
        state.listening = true;
        state.lastSoundAt = Date.now();
        el.body.classList.add('listening');
        setStatus('In ascolto');
      } else {
        setStatus(message.message);
      }
      if (message.state === 'permission') {
        showBanner('info', 'macOS ti chiede il permesso di registrare l\'audio del Mac: serve per ascoltare video e call. L\'audio non lascia il computer.');
      }
      break;
    case 'progress':
      setStatus(`Scarico il modello vocale… ${Math.round(message.value * 100)}%`);
      break;
    case 'level':
      setLevel(message.value);
      break;
    case 'partial':
      if (message.id <= state.lastFinalId) break;
      state.live = { id: message.id, text: message.text };
      queueLive();
      break;
    case 'final':
      state.lastFinalId = message.id;
      state.live = null;
      addEntry(message);
      queueLive();
      break;
    case 'notice':
      showBanner('info', message.message);
      break;
    case 'error':
      showError(message);
      break;
    case 'stopped':
      setRunning(false);
      break;
  }
});

window.converto.onOverlay((on) => {
  el.body.classList.toggle('overlay', on);
  queueLive();
  followScroll(true);
});

// ---------- Eventi interfaccia ----------

el.toggle.addEventListener('click', () => (state.running ? stop() : start()));
el.source.addEventListener('change', () => updateSetting('source', el.source.value));
el.target.addEventListener('change', () => updateSetting('target', el.target.value));
for (const button of el.inputs) {
  button.addEventListener('click', () => {
    if (button.dataset.input !== settings.input) updateSetting('input', button.dataset.input);
  });
}

el.swap.addEventListener('click', () => {
  const sourceLanguage = settings.source.split('-')[0];
  const newSource = SOURCES.find(([code]) => code.startsWith(`${settings.target}-`))?.[0];
  if (!newSource || !TARGETS.some(([code]) => code === sourceLanguage)) return;
  settings.source = newSource;
  updateSetting('target', sourceLanguage);
});

$('font-down').addEventListener('click', () => updateScale(-0.1));
$('font-up').addEventListener('click', () => updateScale(0.1));
function updateScale(delta) {
  const [min, max] = SCALE_RANGE;
  settings.scale = Math.round(Math.min(max, Math.max(min, settings.scale + delta)) * 10) / 10;
  saveSettings();
  applySettings();
}

el.origBtn.addEventListener('click', () => {
  settings.showOriginal = !settings.showOriginal;
  saveSettings();
  applySettings();
});

$('folder-btn').addEventListener('click', () => window.converto.openTranscripts());
$('clear-btn').addEventListener('click', clearTranscript);
$('overlay-btn').addEventListener('click', () => window.converto.setOverlay(true));
$('exit-overlay').addEventListener('click', () => window.converto.setOverlay(false));
$('banner-close').addEventListener('click', hideBanner);
el.bannerAction.addEventListener('click', () => {
  if (state.bannerPane) window.converto.openSettings(state.bannerPane);
});

el.jump.addEventListener('click', () => followScroll(true));
el.transcript.addEventListener('scroll', () => {
  if (isNearBottom()) el.jump.hidden = true;
}, { passive: true });

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && el.body.classList.contains('overlay')) {
    window.converto.setOverlay(false);
  } else if (event.code === 'Space' && event.target === document.body) {
    event.preventDefault();
    el.toggle.click();
  }
});

fillSelect(el.source, SOURCES, settings.source);
fillSelect(el.target, TARGETS, settings.target);
applySettings();
