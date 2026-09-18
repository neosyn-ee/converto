// Processo di traduzione: modelli Opus-MT con transformers.js (ONNX Runtime).
// È separato dal riconoscimento perché sherpa-onnx e onnxruntime-node portano versioni diverse
// di ONNX Runtime: su Windows due DLL con lo stesso nome nello stesso processo vanno in conflitto.
const path = require('node:path');
const { connect } = require('./worker-channel');

let steps = [];
let segmenter = null;
let queue = Promise.resolve();

// Una richiesta alla volta, nell'ordine di arrivo.
const send = connect((message) => {
  queue = queue.then(() => handle(message));
});

async function handle(message) {
  try {
    if (message.type === 'init') {
      await init(message);
      send({ type: 'ready' });
    } else if (message.type === 'translate') {
      send({ type: 'translation', id: message.id, text: await translate(message.text) });
    }
  } catch (error) {
    send({ type: 'error', id: message.id, message: error.message });
  }
}

async function init({ modelsDir, route, threads, language }) {
  segmenter = new Intl.Segmenter(language, { granularity: 'sentence' });
  const { pipeline, env } = await import('@huggingface/transformers');
  env.allowRemoteModels = false; // i modelli li scarica il processo principale (proxy di sistema)
  env.localModelPath = path.join(modelsDir, 'hf') + path.sep;
  steps = [];
  for (const step of route) {
    const run = await pipeline('translation', step.model, {
      dtype: 'q8',
      session_options: { intraOpNumThreads: threads },
    });
    steps.push({ run, prefix: step.prefix ?? '' });
  }
}

// Una frase alla volta e in sequenza: con più frasi nello stesso testo Opus-MT a volte ne salta
// una, e tradotte in un unico lotto degenerano in punteggiatura ripetuta.
async function translate(text) {
  const translated = [];
  for (const sentence of splitSentences(text)) {
    let result = sentence;
    for (const step of steps) {
      const [output] = await step.run(step.prefix + result, { max_new_tokens: 256 });
      result = output.translation_text;
    }
    translated.push(result.replace(/([.,!?])\1{3,}/g, '$1'));
  }
  return translated.join(' ');
}

/** Frasi del testo; i frammenti di una sola parola ("Mr.", "Ok.") restano uniti alla frase dopo. */
function splitSentences(text) {
  const sentences = [];
  let carry = '';
  for (const { segment } of segmenter.segment(text)) {
    const sentence = `${carry}${segment}`.trim();
    if (!sentence) continue;
    if (sentence.split(/\s+/).length < 2) {
      carry = `${sentence} `;
      continue;
    }
    sentences.push(sentence);
    carry = '';
  }
  if (carry.trim()) sentences.push(carry.trim());
  return sentences;
}
