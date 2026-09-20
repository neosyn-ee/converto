// Motore macOS: processi Swift (Core Audio, SpeechAnalyzer, Translation) che catturano l'audio
// da soli e parlano JSON su stdout, una riga per messaggio.
//
// Ogni flusso ha il suo processo: "others" ascolta l'audio del Mac, "me" il microfono.
// In modalità "Io + altri" girano entrambi e i messaggi vengono etichettati con `stream`.
//
// Con `micFromApp` il microfono non lo cattura il motore ma Electron, che sa toglierne l'eco delle
// casse, e arriva al processo di "me" su stdin (float 32 bit, mono, 16 kHz).
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const STREAMS_BY_INPUT = { system: ['others'], mic: ['me'], both: ['me', 'others'] };
const INPUT_BY_STREAM = { me: 'mic', others: 'system' };
// Errori per cui riavviare non serve (permessi, lingua non supportata): fermano la sessione.
const FATAL_ERRORS = new Set(['permission_denied', 'mic_permission_denied', 'speech_unsupported', 'speech_unavailable']);
const MAX_RESTARTS_PER_MINUTE = 3;

function createNativeEngine({ enginePath, onMessage, onStopped }) {
  let run = null;

  function start({ source, target, input, micFromApp = false }) {
    stop();
    const streams = STREAMS_BY_INPUT[input] ?? STREAMS_BY_INPUT.system;
    const current = {
      streams, source, target, micFromApp,
      procs: [], micProc: null, listening: new Set(), reported: new Set(), restarts: [], lastId: {},
    };
    run = current;
    for (const stream of streams) spawnStream(current, stream);
  }

  function spawnStream(current, stream) {
    const engineInput = stream === 'me' && current.micFromApp ? 'stdin' : INPUT_BY_STREAM[stream];
    const proc = spawn(enginePath, ['--source', current.source, '--target', current.target, '--input', engineInput], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    current.procs.push(proc);
    if (stream === 'me') {
      current.micProc = proc;
      proc.stdin.on('error', () => {}); // il motore può chiudere prima di noi: non è un problema dell'app
    }
    let failure = null;
    // Un motore riavviato numera le frasi di nuovo da 0: si prosegue dall'ultimo numero visto,
    // altrimenti l'interfaccia scarterebbe le frasi nuove come già concluse.
    const idBase = (current.lastId[stream] ?? -1) + 1;

    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      if (run !== current) return; // righe residue di un motore già fermato o sostituito
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.type === 'error' && !isWarning(message)) {
        failure = message; // si decide all'uscita del processo se riavviare o fermare tutto
        return;
      }
      forward(current, stream, message, idBase);
    });
    proc.stderr.on('data', (data) => console.error(`[engine ${stream}]`, data.toString().trim()));
    proc.on('error', (error) => {
      if (run === current) onMessage({ type: 'error', code: 'engine_failed', message: error.message });
    });
    proc.on('exit', () => {
      if (run !== current) return;
      current.procs = current.procs.filter((other) => other !== proc);
      // Un errore del riconoscimento durante una call lunga non deve chiudere tutto: si riavvia il flusso.
      if (!FATAL_ERRORS.has(failure?.code) && canRestart(current)) {
        onMessage({ type: 'notice', message: 'Il riconoscimento si è interrotto ed è ripartito da solo.' });
        spawnStream(current, stream);
        return;
      }
      if (failure) onMessage(failure);
      stop();
      onStopped();
    });
  }

  function canRestart(current) {
    const now = Date.now();
    current.restarts = current.restarts.filter((at) => now - at < 60_000);
    if (current.restarts.length >= MAX_RESTARTS_PER_MINUTE) return false;
    current.restarts.push(now);
    return true;
  }

  /** Avvisi che non fermano il motore (es. lingue di traduzione non scaricate). */
  function isWarning(message) {
    return message.code === 'translation_not_installed' || message.code === 'translation_unsupported' || message.code === 'mic_silent';
  }

  function forward(current, stream, message, idBase) {
    if (message.type === 'status') {
      if (message.state === 'listening') {
        current.listening.add(stream);
        if (current.listening.size < current.streams.length) return; // "In ascolto" quando tutti sono pronti
      }
      onMessage(message);
    } else if (message.type === 'error' || message.type === 'notice') {
      const key = `${message.type}:${message.code ?? message.message}`;
      if (current.reported.has(key)) return; // lo stesso avviso arriva da entrambi i flussi
      current.reported.add(key);
      onMessage(message);
    } else if (typeof message.id === 'number') {
      const id = idBase + message.id;
      current.lastId[stream] = Math.max(current.lastId[stream] ?? -1, id);
      onMessage({ ...message, id, stream });
    } else {
      onMessage({ ...message, stream });
    }
  }

  /** Blocchi del microfono catturato da Electron: vanno al processo del flusso "Io". */
  function sendMicAudio(chunk) {
    const proc = run?.micProc;
    if (run?.micFromApp && proc?.stdin?.writable) proc.stdin.write(Buffer.from(chunk));
  }

  function stop() {
    const current = run;
    run = null;
    for (const proc of current?.procs ?? []) proc.kill('SIGTERM');
  }

  return { capturesInRenderer: false, start, stop, pushAudio: () => {}, sendMicAudio };
}

module.exports = { createNativeEngine };
