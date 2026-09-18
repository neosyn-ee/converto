// Modelli del motore portabile (Windows): catalogo, percorsi e download al primo avvio.
const fs = require('node:fs');
const path = require('node:path');

const HF = 'https://huggingface.co';
const PARAKEET_REPO = 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';

/** Lingue riconosciute da Parakeet v3 tra quelle offerte dall'interfaccia. */
const SPEECH_LANGUAGES = ['en', 'it', 'fr', 'es', 'de', 'pt'];

const SPEECH_MODELS = [
  {
    dir: 'silero-vad',
    files: [{ name: 'silero_vad.onnx', url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx' }],
  },
  {
    dir: 'parakeet-tdt-0.6b-v3-int8',
    files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']
      .map((name) => ({ name, url: `${HF}/${PARAKEET_REPO}/resolve/main/${name}` })),
  },
];

/** File che transformers.js usa per un modello Opus-MT quantizzato. */
const TRANSLATION_FILES = [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

/**
 * Modelli Opus-MT disponibili in formato ONNX (Xenova su Hugging Face).
 * `prefix` serve ai modelli con più lingue di arrivo (es. >>pt<< per il portoghese).
 */
const TRANSLATION_PAIRS = {
  'en-it': { model: 'Xenova/opus-mt-en-it' },
  'en-fr': { model: 'Xenova/opus-mt-en-fr' },
  'en-es': { model: 'Xenova/opus-mt-en-es' },
  'en-de': { model: 'Xenova/opus-mt-en-de' },
  'en-zh': { model: 'Xenova/opus-mt-en-zh' },
  'en-pt': { model: 'Xenova/opus-mt-en-ROMANCE', prefix: '>>pt<< ' },
  'it-en': { model: 'Xenova/opus-mt-it-en' },
  'it-fr': { model: 'Xenova/opus-mt-it-fr' },
  'it-es': { model: 'Xenova/opus-mt-it-es' },
  'es-it': { model: 'Xenova/opus-mt-es-it' },
  'fr-en': { model: 'Xenova/opus-mt-fr-en' },
  'es-en': { model: 'Xenova/opus-mt-es-en' },
  'de-en': { model: 'Xenova/opus-mt-de-en' },
  'pt-en': { model: 'Xenova/opus-mt-ROMANCE-en' },
};

/** Passaggi di traduzione da `source` a `target`: diretto o passando dall'inglese. null se impossibile. */
function translationRoute(source, target) {
  if (source === target) return [];
  const direct = TRANSLATION_PAIRS[`${source}-${target}`];
  if (direct) return [direct];
  const toEnglish = TRANSLATION_PAIRS[`${source}-en`];
  const fromEnglish = TRANSLATION_PAIRS[`en-${target}`];
  return toEnglish && fromEnglish ? [toEnglish, fromEnglish] : null;
}

function speechModelPaths(modelsDir) {
  const asr = path.join(modelsDir, SPEECH_MODELS[1].dir);
  return {
    vad: path.join(modelsDir, SPEECH_MODELS[0].dir, 'silero_vad.onnx'),
    encoder: path.join(asr, 'encoder.int8.onnx'),
    decoder: path.join(asr, 'decoder.int8.onnx'),
    joiner: path.join(asr, 'joiner.int8.onnx'),
    tokens: path.join(asr, 'tokens.txt'),
  };
}

function missingFiles(modelsDir, route) {
  const files = SPEECH_MODELS.flatMap((model) => model.files.map((file) => ({
    url: file.url,
    target: path.join(modelsDir, model.dir, file.name),
  })));
  for (const { model } of route ?? []) {
    for (const name of TRANSLATION_FILES) {
      files.push({ url: `${HF}/${model}/resolve/main/${name}`, target: path.join(modelsDir, 'hf', model, name) });
    }
  }
  const unique = new Map(files.map((file) => [file.target, file]));
  return [...unique.values()].filter((file) => !fs.existsSync(file.target));
}

/**
 * Scarica i modelli mancanti (riconoscimento vocale e, se serve, traduzione).
 * `fetchImpl`: in Electron `net.fetch`, che usa il proxy di sistema.
 * `onProgress(frazione, byteTotali)` viene chiamato durante il download.
 */
async function ensureModels(modelsDir, route, { fetchImpl = fetch, onProgress = () => {} } = {}) {
  const missing = missingFiles(modelsDir, route);
  if (missing.length) {
    const sizes = await Promise.all(missing.map((file) => contentLength(fetchImpl, file.url)));
    const total = sizes.reduce((sum, size) => sum + size, 0);
    let done = 0;
    onProgress(0, total);
    for (const file of missing) {
      await download(fetchImpl, file.url, file.target, (bytes) => {
        done += bytes;
        onProgress(total ? Math.min(done / total, 1) : 0, total);
      });
    }
  }
  return speechModelPaths(modelsDir);
}

async function contentLength(fetchImpl, url) {
  try {
    const response = await fetchImpl(url, { method: 'HEAD', redirect: 'follow' });
    return Number(response.headers.get('content-length')) || 0;
  } catch {
    return 0;
  }
}

async function download(fetchImpl, url, target, onBytes) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const partial = `${target}.part`;
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download non riuscito (${response.status}): ${url}`);
  }
  const out = fs.createWriteStream(partial);
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onBytes(value.length);
      if (!out.write(value)) await new Promise((resolve) => out.once('drain', resolve));
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  } catch (error) {
    out.destroy();
    fs.rmSync(partial, { force: true });
    throw error;
  }
  fs.renameSync(partial, target);
}

module.exports = { SPEECH_LANGUAGES, ensureModels, translationRoute };
