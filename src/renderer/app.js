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
const NO_TRANSLATION = 'none';
// Lingue supportate dal motore portabile (Windows): Parakeet v3 e i modelli Opus-MT disponibili.
const PORTABLE_SOURCES = ['en-US', 'en-GB', 'it-IT', 'fr-FR', 'es-ES', 'de-DE', 'pt-BR'];
const PORTABLE_TARGETS = ['it', 'en', 'fr', 'es', 'de', 'pt', 'zh'];
const INPUT_LABELS = { system: 'Audio del Mac', mic: 'Microfono', both: 'Io + altri' };
const SPEAKER_LABELS = { me: 'Io', others: 'Altri' };
const STREAMS = ['others', 'me'];
const DEFAULT_SETTINGS = { mode: 'translate', source: 'en-US', target: 'it', input: 'system', showOriginal: true, scale: 1 };
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
  mic_silent: { label: 'Apri Impostazioni', pane: 'microphone' },
  translation_not_installed: { label: 'Scarica le lingue', pane: 'translation' },
};
const NON_FATAL_ERRORS = new Set(['translation_not_installed', 'translation_unsupported', 'mic_silent']);

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
  targetCaption: $('target-caption'),
  segmented: $('segmented'),
  modeTabs: [...document.querySelectorAll('[data-mode]')],
  aiCopy: $('ai-copy'),
  aiCount: $('ai-count'),
  inputs: [...document.querySelectorAll('[data-input]')],
  transcript: $('transcript'),
  entries: $('entries'),
  liveRows: Object.fromEntries(STREAMS.map((stream) => {
    const root = $(`live-${stream}`);
    return [stream, { root, tag: root.querySelector('.live-tag'), text: root.querySelector('.live-text') }];
  })),
  empty: $('empty'),
  banner: $('banner'),
  bannerText: $('banner-text'),
  bannerAction: $('banner-action'),
  jump: $('jump'),
  toggle: $('toggle'),
  statusText: $('status-text'),
  statusSub: $('status-sub'),
  origBtn: $('orig-btn'),
  toast: $('toast'),
  systemLabel: $('system-label'),
  privacyText: $('privacy-text'),
};

const settings = loadSettings();
const platform = { captureInRenderer: false };
let sources = SOURCES;
let targets = TARGETS;
const state = {
  running: false,
  listening: false,
  failed: false,
  mixed: false, // sessione "Io + altri": frasi etichettate con chi parla
  live: { me: null, others: null },
  lastFinalId: { me: -1, others: -1 },
  levels: { me: 0, others: 0 },
  lastSoundAt: 0,
  renderQueued: false,
  bannerPane: null,
  bannerCode: null,
  finals: [],
  toastTimer: 0,
};

// ---------- Impostazioni ----------

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem('settings') || '{}');
  } catch {
    // preferenze predefinite
  }
  if (saved.target === NO_TRANSLATION) {
    // versione precedente: la sola trascrizione era una voce del menu lingue
    saved.mode = 'transcribe';
    saved.target = DEFAULT_SETTINGS.target;
  }
  return { ...DEFAULT_SETTINGS, ...saved };
}

function isTranscribing() {
  return settings.mode === 'transcribe';
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
  const source = nameOf(sources, settings.source).replace(/ \(.*\)/, '');
  if (isTranscribing()) {
    return `${INPUT_LABELS[settings.input]} · Trascrizione in ${source.toLowerCase()}`;
  }
  return `${INPUT_LABELS[settings.input]} · ${source} → ${nameOf(targets, settings.target)}`;
}

function applySettings() {
  el.source.value = settings.source;
  el.target.value = settings.target;
  const [sourceLanguage, region] = nameOf(sources, settings.source).split(/ \((.*)\)/);
  el.sourceBadge.textContent = settings.source.split('-')[0].toUpperCase();
  el.sourceName.textContent = sourceLanguage;
  el.sourceCaption.textContent = region ? `Parlano in · ${region}` : 'Parlano in';
  const transcribing = isTranscribing();
  el.body.classList.toggle('mode-transcribe', transcribing);
  for (const tab of el.modeTabs) {
    tab.setAttribute('aria-selected', String(tab.dataset.mode === settings.mode));
  }
  el.targetBadge.textContent = transcribing ? 'TXT' : settings.target.toUpperCase();
  el.targetName.textContent = transcribing ? 'Testo originale' : nameOf(targets, settings.target);
  el.targetCaption.textContent = transcribing ? 'Ottieni' : 'Traduci in';
  el.target.disabled = transcribing;
  el.swap.disabled = transcribing;
  el.swap.title = transcribing ? '' : 'Inverti lingue';
  el.origBtn.disabled = transcribing;
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
    if (platform.captureInRenderer) audioCapture.stop();
    state.listening = false;
    state.live = { me: null, others: null };
    state.levels = { me: 0, others: 0 };
    setLevel(0);
    queueLive();
    if (!state.failed) setStatus('Pronto');
  }
  el.body.classList.toggle('running', running);
  el.body.classList.toggle('listening', running && state.listening);
  const label = running ? 'Ferma (spazio)' : 'Avvia (spazio)';
  el.toggle.title = label;
  el.toggle.setAttribute('aria-label', label);
}

function start() {
  if (platform.captureInRenderer) {
    // Parte subito, dentro il clic: il sistema chiede un gesto dell'utente per catturare l'audio.
    audioCapture.start(settings.input)
      .then((notices) => notices.forEach((notice) => showBanner('info', notice)))
      .catch(onCaptureError);
  }
  hideBanner();
  state.failed = false;
  el.body.classList.remove('failed');
  state.mixed = settings.input === 'both';
  el.body.classList.toggle('mixed', state.mixed);
  state.live = { me: null, others: null };
  state.lastFinalId = { me: -1, others: -1 };
  setRunning(true);
  setStatus('Avvio…');
  window.converto.start({
    source: settings.source,
    target: isTranscribing() ? NO_TRANSLATION : settings.target,
    input: settings.input,
  });
}

function stop() {
  window.converto.stop();
}

function onCaptureError(error) {
  window.converto.stop();
  if (error.stream === 'me' && error.name === 'NotAllowedError') {
    showError({
      code: 'mic_permission_denied',
      message: "Accesso al microfono negato. In Impostazioni → Privacy e sicurezza → Microfono consenti l'accesso alle app desktop.",
    });
  } else if (error.name === 'NotFoundError') {
    showError({ code: 'capture_failed', message: 'Nessun microfono trovato.' });
  } else {
    showError({ code: 'capture_failed', message: `Impossibile catturare l'audio: ${error.message}` });
  }
}

// Con due flussi l'indicatore mostra il più forte dei due.
function setLevel(value, stream = 'others') {
  state.levels[stream] = value;
  const level = Math.max(state.levels.me, state.levels.others);
  document.documentElement.style.setProperty('--level', level);
  if (level > 0.05) state.lastSoundAt = Date.now();
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

function addEntry({ text, translation, stream }) {
  const wasAtBottom = isNearBottom();
  const item = document.createElement('li');
  item.className = 'entry';
  const time = new Date().toLocaleTimeString('it-IT');
  const speaker = state.mixed ? stream : null;
  state.finals.push({ time, text, translation, speaker });
  const main = paragraph('tr', translation ?? text);
  if (speaker) {
    item.classList.add(`speaker-${speaker}`);
    const chip = document.createElement('span');
    chip.className = `speaker speaker-${speaker}`;
    chip.textContent = SPEAKER_LABELS[speaker];
    main.prepend(chip);
  }
  item.append(paragraph('meta', time), main);
  if (translation) item.append(paragraph('orig', text));
  el.entries.append(item);
  while (el.entries.childElementCount > MAX_ENTRIES) el.entries.firstElementChild.remove();
  el.empty.hidden = true;
  updateCopyCount();
  followScroll(wasAtBottom);
}

function updateCopyCount() {
  el.aiCount.textContent = state.finals.length;
  el.aiCopy.disabled = state.finals.length === 0;
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
  const wasAtBottom = isNearBottom();
  const max = el.body.classList.contains('overlay') ? LIVE_TAIL.overlay : LIVE_TAIL.window;
  for (const stream of STREAMS) {
    const row = el.liveRows[stream];
    const text = state.live[stream]?.text;
    row.root.hidden = !text;
    if (!text) continue;
    row.tag.textContent = state.mixed ? SPEAKER_LABELS[stream] : 'Sta parlando';
    row.text.textContent = tail(text, max);
    el.empty.hidden = true;
  }
  followScroll(wasAtBottom);
}

function clearTranscript() {
  el.entries.replaceChildren();
  state.finals = [];
  updateCopyCount();
  state.live = { me: null, others: null };
  queueLive();
  el.empty.hidden = false;
  el.jump.hidden = true;
}

// Testo semplice con orari: in modalità traduzione riporta sia l'originale sia la traduzione.
function transcriptText() {
  return state.finals
    .map(({ time, text, translation, speaker }) => {
      const who = speaker ? `${SPEAKER_LABELS[speaker]}: ` : '';
      return translation ? `[${time}] ${who}${text}\n           → ${translation}` : `[${time}] ${who}${text}`;
    })
    .join('\n');
}

function copyTranscript() {
  if (!state.finals.length) {
    showToast('Ancora niente da copiare');
    return;
  }
  window.converto.copyText(transcriptText());
  const count = state.finals.length;
  showToast(`Copiate ${count} ${count === 1 ? 'frase' : 'frasi'}: incollale nell'AI che preferisci`);
}

function showToast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 2400);
}

// ---------- Messaggi ----------

function showBanner(kind, text, action) {
  el.banner.classList.toggle('info', kind === 'info');
  el.bannerText.textContent = text;
  el.bannerAction.hidden = !action;
  if (action) el.bannerAction.textContent = action.label;
  state.bannerPane = action?.pane ?? null;
  state.bannerCode = null;
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
  state.bannerCode = code;
  if (fatal) {
    state.failed = true;
    el.body.classList.add('failed');
    setStatus('Interrotto', 'Leggi il messaggio sopra');
  }
}

window.converto.onEngine((message) => {
  switch (message.type) {
    case 'status':
      if (!state.running) setRunning(true); // il motore è attivo: il pulsante deve poterlo fermare
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
      setLevel(message.value, message.stream);
      break;
    case 'partial': {
      const stream = message.stream ?? 'others';
      if (message.id <= state.lastFinalId[stream]) break;
      state.live[stream] = { id: message.id, text: message.text };
      queueLive();
      break;
    }
    case 'final':
    case 'discard': { // discard: frase del microfono scartata perché eco degli altri
      const stream = message.stream ?? 'others';
      if (message.type === 'final' && state.bannerCode === 'mic_silent') hideBanner(); // l'audio in realtà arriva
      state.lastFinalId[stream] = Math.max(state.lastFinalId[stream], message.id);
      if (state.live[stream] && state.live[stream].id <= message.id) state.live[stream] = null;
      if (message.type === 'final') addEntry(message);
      queueLive();
      break;
    }
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
  const newSource = sources.find(([code]) => code.startsWith(`${settings.target}-`))?.[0];
  if (!newSource || !targets.some(([code]) => code === sourceLanguage)) return;
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

$('copy-btn').addEventListener('click', copyTranscript);
el.aiCopy.addEventListener('click', copyTranscript);
for (const tab of el.modeTabs) {
  tab.addEventListener('click', () => selectMode(tab.dataset.mode));
}

function selectMode(mode) {
  if (mode !== settings.mode) updateSetting('mode', mode);
}
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
  if (event.metaKey && (event.key === '1' || event.key === '2')) {
    event.preventDefault();
    selectMode(event.key === '1' ? 'translate' : 'transcribe');
  } else if (event.key === 'Escape' && el.body.classList.contains('overlay')) {
    window.converto.setOverlay(false);
  } else if (event.code === 'Space' && event.target === document.body) {
    event.preventDefault();
    el.toggle.click();
  }
});

// Differenze tra macOS (motore Swift) e Windows (motore portabile).
function applyPlatform(info) {
  platform.captureInRenderer = info.captureInRenderer;
  el.body.classList.add(`platform-${info.platform}`);
  if (info.platform !== 'darwin') {
    INPUT_LABELS.system = 'Audio del PC';
    el.systemLabel.textContent = 'Audio del PC';
    document.querySelector('[data-input="both"]').title = 'Microfono (Io) e audio del PC (Altri) insieme: per le call';
    el.privacyText.textContent = "Tutto in locale: l'audio non lascia il PC";
  }
  if (info.captureInRenderer) {
    sources = SOURCES.filter(([code]) => PORTABLE_SOURCES.includes(code));
    targets = TARGETS.filter(([code]) => PORTABLE_TARGETS.includes(code));
    if (!PORTABLE_SOURCES.includes(settings.source)) settings.source = DEFAULT_SETTINGS.source;
    if (!PORTABLE_TARGETS.includes(settings.target)) settings.target = DEFAULT_SETTINGS.target;
  }
  fillSelect(el.source, sources, settings.source);
  fillSelect(el.target, targets, settings.target);
  applySettings();
}

fillSelect(el.source, sources, settings.source);
fillSelect(el.target, targets, settings.target);
applySettings();
window.converto.appInfo().then(applyPlatform);
