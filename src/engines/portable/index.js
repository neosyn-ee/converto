// Motore portabile (Windows): coordina il processo di riconoscimento e quello di traduzione.
// Parla lo stesso protocollo del motore macOS (status, progress, level, partial, final, error),
// così l'interfaccia è identica. L'audio arriva dal renderer tramite pushAudio(flusso, campioni):
// "others" = audio del PC, "me" = microfono (entrambi in modalità "Io + altri").
const os = require('node:os');
const { SPEECH_LANGUAGES, ensureModels, translationRoute } = require('./models');
const { cleanTranscript } = require('./text');
const { createEchoGate } = require('./echo-gate');

const NO_TRANSLATION = 'none';
const LEVEL_INTERVAL_MS = 120;
const BACKLOG_SAMPLES = 30 * 16000; // audio tenuto da parte mentre i modelli si caricano
const LANGUAGE_NAMES = new Intl.DisplayNames(['it'], { type: 'language' });

class EngineFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * `fork(file)` avvia un processo di lavoro e restituisce { post, onMessage, onExit, kill }:
 * in Electron usa utilityProcess, nei test child_process.
 */
function createPortableEngine({ modelsDir, fork, fetchImpl, onMessage, onStopped }) {
  const threads = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));
  let session = null;

  async function start({ source, target, input }) {
    stop();
    const current = {
      // Con entrambi i flussi, l'audio del PC fa da riferimento per togliere l'eco dal microfono.
      echoGate: input === 'both' ? createEchoGate() : null,
      workers: [],
      ready: false,
      backlog: [],
      backlogLength: 0,
      streams: {},
      nextTranslation: 0,
      pendingTranslations: new Map(),
    };
    session = current;
    const alive = () => session === current;

    try {
      const language = source.split('-')[0];
      if (!SPEECH_LANGUAGES.includes(language)) {
        throw new EngineFailure('speech_unsupported',
          `Su questo PC il riconoscimento vocale non supporta ${LANGUAGE_NAMES.of(language)}.`);
      }
      let route = [];
      if (target !== NO_TRANSLATION && target !== language) {
        route = translationRoute(language, target);
        if (!route) {
          onMessage({
            type: 'error',
            code: 'translation_unsupported',
            message: `La traduzione ${LANGUAGE_NAMES.of(language)} → ${LANGUAGE_NAMES.of(target)} non è disponibile su questo PC. Mostro solo il testo originale.`,
          });
          route = [];
        }
      }

      onMessage({ type: 'status', state: 'preparing', message: 'Preparo il riconoscimento vocale…' });
      let announced = false;
      const models = await ensureModels(modelsDir, route, {
        fetchImpl,
        onProgress: (fraction, total) => {
          if (!alive()) return;
          if (!announced) {
            announced = true;
            onMessage({
              type: 'status',
              state: 'downloading',
              message: `Scarico i modelli (${Math.round(total / 1e6)} MB, solo la prima volta)…`,
            });
          }
          onMessage({ type: 'progress', value: fraction });
        },
      });
      if (!alive()) return;

      onMessage({ type: 'status', state: 'preparing', message: 'Carico i modelli…' });
      const asr = await spawn(current, 'asr-worker.js',
        { type: 'init', models, threads },
        (message) => onRecognition(current, message));
      current.asr = asr;
      if (route.length) {
        current.mt = await spawn(current, 'mt-worker.js',
          { type: 'init', modelsDir, route, language, threads: Math.min(threads, 2) },
          (message) => onTranslation(current, message));
      }
      if (!alive()) return;
      current.ready = true;
      // L'audio arrivato durante il caricamento non va perso.
      for (const { stream, samples } of current.backlog) asr.post({ type: 'audio', stream, samples });
      current.backlog = [];
      onMessage({ type: 'status', state: 'listening', message: 'In ascolto' });
    } catch (error) {
      if (!alive()) return;
      stop();
      onMessage({ type: 'error', code: error.code ?? 'engine_failed', message: error.message });
      onStopped();
    }
  }

  /** Avvia un processo e attende che abbia caricato i modelli. */
  function spawn(current, file, init, onReadyMessage) {
    return new Promise((resolve, reject) => {
      const worker = fork(file);
      current.workers.push(worker);
      let ready = false;
      worker.onMessage((message) => {
        if (session !== current) return;
        if (!ready && message.type === 'ready') {
          ready = true;
          resolve(worker);
        } else if (!ready && message.type === 'error') {
          reject(new EngineFailure('engine_failed', message.message));
        } else if (ready) {
          onReadyMessage(message);
        }
      });
      worker.onExit(() => {
        if (session !== current) return;
        const failure = new EngineFailure('engine_failed', 'Il motore di riconoscimento si è interrotto.');
        if (!ready) {
          reject(failure);
          return;
        }
        stop();
        onMessage({ type: 'error', code: failure.code, message: failure.message });
        onStopped();
      });
      worker.post(init);
    });
  }

  /** Stato di un flusso: numero della frase in corso e coda di uscita. */
  function streamState(current, stream) {
    current.streams[stream] ??= { segment: 0, output: Promise.resolve(), level: { peak: 0, last: -1, at: 0 } };
    return current.streams[stream];
  }

  function onRecognition(current, message) {
    const { stream } = message;
    const state = message.stream ? streamState(current, stream) : null;
    if (message.type === 'speech') {
      onMessage({ type: 'partial', stream, id: state.segment, text: '…' });
    } else if (message.type === 'partial') {
      onMessage({ type: 'partial', stream, id: state.segment, text: message.text || '…' });
    } else if (message.type === 'segment') {
      const text = cleanTranscript(message.text);
      if (!text) {
        onMessage({ type: 'partial', stream, id: state.segment, text: '' }); // era rumore: nasconde "sta parlando"
        return;
      }
      const id = state.segment;
      state.segment += 1;
      const translation = current.mt ? requestTranslation(current, text) : Promise.resolve(null);
      // Le frasi di ogni flusso escono nell'ordine in cui sono state dette, anche se una traduzione tarda.
      state.output = state.output
        .then(() => translation)
        .then((translated) => {
          if (session === current) onMessage({ type: 'final', stream, id, text, translation: translated });
        });
    } else if (message.type === 'error') {
      onMessage({ type: 'error', code: 'engine_failed', message: message.message });
    }
  }

  function requestTranslation(current, text) {
    const id = current.nextTranslation;
    current.nextTranslation += 1;
    return new Promise((resolve) => {
      current.pendingTranslations.set(id, resolve);
      current.mt.post({ type: 'translate', id, text });
    });
  }

  function onTranslation(current, message) {
    const resolve = current.pendingTranslations.get(message.id);
    if (!resolve) return;
    current.pendingTranslations.delete(message.id);
    resolve(message.type === 'translation' ? message.text : null);
  }

  function pushAudio(stream, samples) {
    const current = session;
    if (!current) return;
    reportLevel(current, stream, samples);
    const gate = current.echoGate;
    if (!gate) {
      forwardAudio(current, stream, samples);
    } else if (stream === 'others') {
      gate.observeReference(samples, Date.now() / 1000);
      forwardAudio(current, stream, samples);
    } else {
      gate.process(samples, Date.now() / 1000, (filtered) => forwardAudio(current, stream, filtered));
    }
  }

  function forwardAudio(current, stream, samples) {
    if (current.ready) {
      current.asr.post({ type: 'audio', stream, samples });
      return;
    }
    current.backlog.push({ stream, samples });
    current.backlogLength += samples.length;
    while (current.backlogLength > BACKLOG_SAMPLES) {
      current.backlogLength -= current.backlog.shift().samples.length;
    }
  }

  function reportLevel(current, stream, samples) {
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const { level } = streamState(current, stream);
    level.peak = Math.max(level.peak, Math.sqrt(sum / samples.length));
    const now = Date.now();
    if (now - level.at < LEVEL_INTERVAL_MS) return;
    // -60 dB → 0, 0 dB → 1
    const value = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(level.peak, 1e-6)) + 60) / 60));
    if (Math.abs(value - level.last) > 0.02) {
      onMessage({ type: 'level', stream, value: Math.round(value * 100) / 100 });
      level.last = value;
    }
    level.peak = 0;
    level.at = now;
  }

  function stop() {
    const current = session;
    session = null;
    for (const worker of current?.workers ?? []) worker.kill();
  }

  return { capturesInRenderer: true, start, stop, pushAudio };
}

module.exports = { createPortableEngine };
