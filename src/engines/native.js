// Motore macOS: processo Swift (Core Audio, SpeechAnalyzer, Translation) che cattura l'audio
// da solo e parla JSON su stdout, una riga per messaggio. Ogni messaggio porta il flusso:
// "others" = audio del Mac, "me" = microfono. In modalità "Io + altri" lo stesso processo segue
// entrambi, così può usare l'audio del Mac per togliere l'eco delle casse dal microfono.
const { spawn } = require('node:child_process');
const readline = require('node:readline');

// Errori per cui riavviare non serve (permessi, lingua non supportata): fermano la sessione.
const FATAL_ERRORS = new Set(['permission_denied', 'mic_permission_denied', 'speech_unsupported', 'speech_unavailable']);
const MAX_RESTARTS_PER_MINUTE = 3;

function createNativeEngine({ enginePath, onMessage, onStopped }) {
  let run = null;

  function start({ source, target, input }) {
    stop();
    const current = { source, target, input, procs: [], reported: new Set(), restarts: [] };
    run = current;
    spawnEngine(current);
  }

  function spawnEngine(current) {
    const proc = spawn(enginePath, ['--source', current.source, '--target', current.target, '--input', current.input], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    current.procs.push(proc);
    let failure = null;

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
      forward(current, message);
    });
    proc.stderr.on('data', (data) => console.error('[engine]', data.toString().trim()));
    proc.on('error', (error) => {
      if (run === current) onMessage({ type: 'error', code: 'engine_failed', message: error.message });
    });
    proc.on('exit', () => {
      if (run !== current) return;
      current.procs = current.procs.filter((other) => other !== proc);
      // Un errore del riconoscimento durante una call lunga non deve chiudere tutto: si riavvia.
      if (!FATAL_ERRORS.has(failure?.code) && canRestart(current)) {
        onMessage({ type: 'notice', message: 'Il riconoscimento si è interrotto ed è ripartito da solo.' });
        spawnEngine(current);
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

  function forward(current, message) {
    if (message.type === 'error' || message.type === 'notice') {
      const key = `${message.type}:${message.code ?? message.message}`;
      if (current.reported.has(key)) return; // lo stesso avviso non si ripete dopo un riavvio
      current.reported.add(key);
    }
    onMessage(message);
  }

  function stop() {
    const current = run;
    run = null;
    for (const proc of current?.procs ?? []) proc.kill('SIGTERM');
  }

  return { start, stop };
}

module.exports = { createNativeEngine };
