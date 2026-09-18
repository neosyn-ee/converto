// Processo di riconoscimento vocale: rilevatore di voce Silero + Parakeet v3 (sherpa-onnx).
//
// Riceve audio mono a 16 kHz. Mentre qualcuno parla, ogni ~1,5 s decodifica l'audio accumulato:
// se contiene una frase conclusa e ormai stabile (seguita da altre parole) la pubblica subito e
// taglia quell'audio, così le frasi arrivano una alla volta e non vengono riscritte.
// Alla pausa pubblica quello che resta.
const sherpa = require('sherpa-onnx-node');
const { connect } = require('./worker-channel');

const SAMPLE_RATE = 16000;
const VAD_WINDOW = 512;
const DECODE_EVERY = 1.5 * SAMPLE_RATE;
const MIN_DECODE = 1.0 * SAMPLE_RATE;
const PRE_ROLL = 0.6 * SAMPLE_RATE;      // audio tenuto prima che il rilevatore scatti
const CUT_MARGIN = 0.08;                 // secondi lasciati prima della parola successiva al taglio
const WORDS_AFTER_BREAK = 3;             // parole che devono seguire una frase perché sia stabile
const CLAUSE_BREAK_LENGTH = 200;         // periodi senza punto: oltre si chiude alla virgola…
const FORCED_BREAK_LENGTH = 280;         // …e oltre a un confine di parola

let vad = null;
let recognizer = null;
let pending = new Float32Array(0);
let preRoll = new Float32Array(0);
let speech = null;                       // { chunks, length, sinceDecode } mentre qualcuno parla

const send = connect((message) => {
  try {
    if (message.type === 'init') init(message);
    else if (message.type === 'audio') accept(message.samples);
    else if (message.type === 'flush') flush();
  } catch (error) {
    send({ type: 'error', message: error.message });
  }
});

function init({ models, threads }) {
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: models.encoder, decoder: models.decoder, joiner: models.joiner },
      tokens: models.tokens,
      numThreads: threads,
      provider: 'cpu',
      modelType: 'nemo_transducer',
      debug: 0,
    },
  });
  // Il rilevatore serve solo a sapere se c'è voce: i tratti di parlato li gestiamo qui.
  vad = new sherpa.Vad({
    sileroVad: {
      model: models.vad,
      threshold: 0.5,
      minSpeechDuration: 0.25,
      minSilenceDuration: 0.5,
      maxSpeechDuration: 30,
      windowSize: VAD_WINDOW,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    debug: 0,
  }, 30);
  send({ type: 'ready' });
}

function accept(samples) {
  if (!vad) return;
  const audio = concat(pending, samples);
  let offset = 0;
  for (; offset + VAD_WINDOW <= audio.length; offset += VAD_WINDOW) {
    processWindow(audio.slice(offset, offset + VAD_WINDOW));
  }
  pending = audio.slice(offset);
}

function processWindow(window) {
  vad.acceptWaveform(window);
  while (!vad.isEmpty()) vad.pop();

  if (vad.isDetected()) {
    if (!speech) {
      speech = { chunks: [preRoll], length: preRoll.length, sinceDecode: 0 };
      send({ type: 'speech' });
    }
    speech.chunks.push(window);
    speech.length += window.length;
    speech.sinceDecode += window.length;
    if (speech.sinceDecode >= DECODE_EVERY && speech.length >= MIN_DECODE) {
      speech.sinceDecode = 0;
      publishStableSentences();
    }
  } else {
    if (speech) finishSpeech();
    preRoll = concat(preRoll, window).slice(-PRE_ROLL);
  }
}

/** Decodifica il parlato in corso e pubblica le frasi già concluse. */
function publishStableSentences() {
  const audio = concat(...speech.chunks);
  const result = decode(audio);
  const cut = breakIndex(result.tokens);
  if (cut > 0) {
    send({ type: 'segment', text: joinTokens(result.tokens.slice(0, cut)) });
    const cutSample = Math.max(0, Math.floor((result.timestamps[cut] - CUT_MARGIN) * SAMPLE_RATE));
    const rest = audio.slice(cutSample);
    speech.chunks = [rest];
    speech.length = rest.length;
  } else {
    speech.chunks = [audio];
  }
  send({ type: 'partial', text: joinTokens(result.tokens.slice(Math.max(cut, 0))) });
}

function finishSpeech() {
  const result = decode(concat(...speech.chunks));
  speech = null;
  send({ type: 'segment', text: result.text.trim() });
}

/** Indice (escluso) fino a cui i token formano frasi concluse e stabili; -1 se non ce ne sono. */
function breakIndex(tokens) {
  const wordStarts = tokens.map((token) => token.startsWith(' '));
  const wordsAfter = (index) => wordStarts.slice(index + 1).filter(Boolean).length;
  const endsWith = (index, marks) => marks.includes(tokens[index].trim().slice(-1))
    && (wordStarts[index + 1] ?? false); // "10.5" non chiude una frase

  let sentence = -1;
  let clause = -1;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (wordsAfter(index) < WORDS_AFTER_BREAK) break;
    if (endsWith(index, '.?!')) sentence = index;
    else if (endsWith(index, ',;:')) clause = index;
  }
  const length = tokens.join('').length;
  if (sentence >= 0) return sentence + 1;
  if (length > CLAUSE_BREAK_LENGTH && clause >= 0) return clause + 1;
  if (length > FORCED_BREAK_LENGTH) {
    const starts = wordStarts.flatMap((isStart, index) => (isStart ? [index] : []));
    return starts.length > WORDS_AFTER_BREAK ? starts[starts.length - WORDS_AFTER_BREAK] : -1;
  }
  return -1;
}

function decode(samples) {
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  recognizer.decode(stream);
  return recognizer.getResult(stream);
}

function joinTokens(tokens) {
  return tokens.join('').trim();
}

function concat(...arrays) {
  const out = new Float32Array(arrays.reduce((sum, array) => sum + array.length, 0));
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.length;
  }
  return out;
}

/** Chiude il parlato in corso (usato a fine file nei test). */
function flush() {
  if (speech) finishSpeech();
  send({ type: 'flushed' });
}
