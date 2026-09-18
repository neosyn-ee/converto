// Motore macOS: processi Swift (Core Audio, SpeechAnalyzer, Translation) che catturano l'audio
// da soli e parlano JSON su stdout, una riga per messaggio.
//
// Ogni flusso ha il suo processo: "others" ascolta l'audio del Mac, "me" il microfono.
// In modalità "Io + altri" girano entrambi e i messaggi vengono etichettati con `stream`.
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const STREAMS_BY_INPUT = { system: ['others'], mic: ['me'], both: ['me', 'others'] };
const INPUT_BY_STREAM = { me: 'mic', others: 'system' };

function createNativeEngine({ enginePath, onMessage, onStopped }) {
  let run = null;

  function start({ source, target, input }) {
    stop();
    const streams = STREAMS_BY_INPUT[input] ?? STREAMS_BY_INPUT.system;
    const current = { streams, procs: [], listening: new Set(), reported: new Set() };
    run = current;
    for (const stream of streams) spawnStream(current, stream, source, target);
  }

  function spawnStream(current, stream, source, target) {
    const proc = spawn(enginePath, ['--source', source, '--target', target, '--input', INPUT_BY_STREAM[stream]], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    current.procs.push(proc);

    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      if (run !== current) return; // righe residue di un motore già fermato o sostituito
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      forward(current, stream, message);
    });
    proc.stderr.on('data', (data) => console.error(`[engine ${stream}]`, data.toString().trim()));
    proc.on('error', (error) => {
      if (run === current) onMessage({ type: 'error', code: 'engine_failed', message: error.message });
    });
    proc.on('exit', () => {
      if (run !== current) return;
      // Se un flusso si ferma (errore, permesso negato) si ferma tutta la sessione.
      stop();
      onStopped();
    });
  }

  function forward(current, stream, message) {
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
    } else {
      onMessage({ ...message, stream });
    }
  }

  function stop() {
    const current = run;
    run = null;
    for (const proc of current?.procs ?? []) proc.kill('SIGTERM');
  }

  return { capturesInRenderer: false, start, stop, pushAudio: () => {} };
}

module.exports = { createNativeEngine };
