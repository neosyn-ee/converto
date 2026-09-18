// Ripulisce ciò che il riconoscimento produce su musica, applausi o rumore.
// Stessa logica di TextCleaner nel motore macOS.
const MIN_REPEATED_RUN = 4;

const normalize = (token) => token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Restituisce il testo ripulito, oppure null se non resta parlato reale. */
function cleanTranscript(raw) {
  const tokens = raw
    .replace(/[.,]{4,}/g, '…')
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token));

  // "yeah, yeah, yeah, yeah…": una parola ripetuta a raffica non è parlato reale
  const kept = [];
  for (let index = 0; index < tokens.length;) {
    const key = normalize(tokens[index]);
    let next = index + 1;
    while (next < tokens.length && normalize(tokens[next]) === key) next += 1;
    if (next - index < MIN_REPEATED_RUN) kept.push(...tokens.slice(index, next));
    index = next;
  }

  const cleaned = kept.join(' ');
  return (cleaned.match(/\p{L}/gu) ?? []).length >= 2 ? cleaned : null;
}

module.exports = { cleanTranscript };
