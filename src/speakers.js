// Modalità "Io + altri": etichette di chi parla e rete di sicurezza contro l'eco.
//
// L'eco delle casse viene già tolta dall'audio del microfono prima del riconoscimento (EchoGate).
// Se qualcosa sfugge, la stessa frase arriverebbe due volte, come "Altri" e come "Io": le frasi del
// microfono aspettano un attimo la versione degli altri e vengono scartate se sono quasi identiche.
// Soglie alte apposta, per non scartare risposte tue che riprendono parole degli altri.
const SPEAKER_LABELS = { me: 'Io', others: 'Altri' };

const ECHO_HOLD_MS = 1500;
const ECHO_WINDOW_MS = 15000;
const ECHO_OVERLAP = 0.8;
const SHORT_PHRASE_WORDS = 4;

function wordSet(text) {
  return new Set(text.toLowerCase().split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean));
}

function isSamePhrase(mine, theirs) {
  const common = [...mine].filter((word) => theirs.has(word)).length;
  const smaller = Math.min(mine.size, theirs.size);
  if (smaller === 0) return false;
  if (smaller < SHORT_PHRASE_WORDS) return common === mine.size && mine.size === theirs.size;
  return common / smaller >= ECHO_OVERLAP;
}

/** `deliver(message)` riceve i messaggi del motore, con le frasi-eco sostituite da `discard`. */
function createEchoFilter(deliver) {
  let recent = [];
  let generation = 0;

  function handle(message) {
    if (message.type !== 'final') {
      deliver(message);
    } else if (message.stream === 'others') {
      recent.push({ words: wordSet(message.text), at: Date.now() });
      deliver(message);
    } else {
      const current = generation;
      setTimeout(() => {
        if (current !== generation) return; // sessione nel frattempo fermata o riavviata
        const now = Date.now();
        recent = recent.filter((entry) => now - entry.at < ECHO_WINDOW_MS);
        const mine = wordSet(message.text);
        const echo = recent.some((entry) => isSamePhrase(mine, entry.words));
        deliver(echo ? { type: 'discard', stream: message.stream, id: message.id } : message);
      }, ECHO_HOLD_MS);
    }
  }

  function reset() {
    recent = [];
    generation += 1;
  }

  return { handle, reset };
}

module.exports = { SPEAKER_LABELS, createEchoFilter };
