// Motore macOS: processo Swift (Core Audio, SpeechAnalyzer, Translation) che cattura l'audio
// da solo e parla JSON su stdout, una riga per messaggio.
const { spawn } = require('node:child_process');
const readline = require('node:readline');

function createNativeEngine({ enginePath, onMessage, onStopped }) {
  let proc = null;

  function start({ source, target, input }) {
    stop();
    const current = spawn(enginePath, ['--source', source, '--target', target, '--input', input], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc = current;

    readline.createInterface({ input: current.stdout }).on('line', (line) => {
      if (proc !== current) return; // righe residue di un motore già fermato o sostituito
      try {
        onMessage(JSON.parse(line));
      } catch {
        // riga non JSON: ignorata
      }
    });
    current.stderr.on('data', (data) => console.error('[engine]', data.toString().trim()));
    current.on('error', (error) => onMessage({ type: 'error', code: 'engine_failed', message: error.message }));
    current.on('exit', () => {
      if (proc !== current) return;
      proc = null;
      onStopped();
    });
  }

  function stop() {
    if (!proc) return;
    const current = proc;
    proc = null;
    current.kill('SIGTERM');
  }

  return { capturesInRenderer: false, start, stop, pushAudio: () => {} };
}

module.exports = { createNativeEngine };
