// Modalità "Io + altri": etichette di chi parla e filtro dell'eco.
//
// Con le casse invece delle cuffie, il microfono riprende anche la voce degli altri: la stessa
// frase arriverebbe due volte, una come "Altri" e una come "Io". Le frasi del microfono aspettano
// quindi un attimo la versione degli altri e vengono scartate se sono per lo più parole loro.
// Si confrontano anche con il testo degli altri ancora in corso: con rumore di fondo nella call il
// microfono chiude spesso la frase-eco prima che gli altri chiudano la loro.
const SPEAKER_LABELS = { me: 'Io', others: 'Altri' };

const ECHO_HOLD_MS = 1500;
const ECHO_WINDOW_MS = 15000;
const ECHO_OVERLAP = 0.6;
const SHORT_PHRASE_WORDS = 4;
// L'eco di una frase breve arriva dal microfono 2–4 s dopo che le sue parole sono comparse nel testo
// degli altri; una tua risposta breve ("Grazie", "Sì") arriva dopo la fine della loro frase, più tardi.
const SHORT_ECHO_WINDOW_MS = 5000;

function wordSet(text) {
  return new Set(text.toLowerCase().split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean));
}

/** `deliver(message)` riceve i messaggi del motore, con le frasi-eco sostituite da `discard`. */
function createEchoFilter(deliver, { now = Date.now } = {}) {
  // Frasi degli altri, concluse o in corso: per ogni parola l'istante in cui è comparsa la prima volta.
  // Si tengono tutte le parole viste nei risultati provvisori: il riconoscimento a volte toglie la
  // prima parola ("Grazie.") dalla frase definitiva, ma il microfono l'ha sentita lo stesso.
  let phrases = new Map(); // id → { seen: Map<parola, istante>, at }
  let generation = 0;

  function remember(id, text) {
    const entry = phrases.get(id) ?? { seen: new Map(), at: now() };
    for (const word of wordSet(text)) {
      if (!entry.seen.has(word)) entry.seen.set(word, now());
    }
    entry.at = now();
    phrases.set(id, entry);
  }

  // La quota si calcola sulle mie parole: una frase mia che riprende due parole degli altri resta mia.
  function isEcho(mine, arrivedAt) {
    const short = mine.size < SHORT_PHRASE_WORDS;
    for (const { seen } of phrases.values()) {
      if (short) {
        if ([...mine].every((word) => seen.has(word) && arrivedAt - seen.get(word) <= SHORT_ECHO_WINDOW_MS)) return true;
      } else {
        const common = [...mine].filter((word) => seen.has(word)).length;
        if (common / mine.size >= ECHO_OVERLAP) return true;
      }
    }
    return false;
  }

  function handle(message) {
    if (message.stream === 'others' && (message.type === 'partial' || message.type === 'final')) {
      remember(message.id, message.text);
      deliver(message);
    } else if (message.type !== 'final') {
      deliver(message);
    } else {
      const current = generation;
      const arrivedAt = now();
      setTimeout(() => {
        if (current !== generation) return; // sessione nel frattempo fermata o riavviata
        for (const [id, entry] of phrases) {
          if (now() - entry.at >= ECHO_WINDOW_MS) phrases.delete(id);
        }
        const echo = isEcho(wordSet(message.text), arrivedAt);
        deliver(echo ? { type: 'discard', stream: message.stream, id: message.id } : message);
      }, ECHO_HOLD_MS);
    }
  }

  function reset() {
    phrases = new Map();
    generation += 1;
  }

  return { handle, reset };
}

module.exports = { SPEAKER_LABELS, createEchoFilter };
