#!/usr/bin/env node
// Prova il motore portabile (quello usato su Windows) su un file WAV, senza Electron.
//
//   node scripts/try-portable-engine.js audio.wav [--source en-US] [--target it|none] [--fast]
//
// I modelli vengono scaricati (o riusati) nella stessa cartella dell'app.
const { fork } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const sherpa = require('sherpa-onnx-node');
const { createPortableEngine } = require('../src/engines/portable');

const SAMPLE_RATE = 16000;
const CHUNK = 1600; // 100 ms

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const file = args.find((arg) => arg.endsWith('.wav'));
if (!file) {
  console.error('Uso: node scripts/try-portable-engine.js audio.wav [--source en-US] [--target it|none] [--fast]');
  process.exit(1);
}

const modelsDir = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA, 'Converto', 'models')
  : path.join(os.homedir(), 'Library', 'Application Support', 'Converto', 'models');

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`;

const engine = createPortableEngine({
  modelsDir,
  fork: (worker) => {
    const child = fork(path.join(__dirname, '..', 'src', 'engines', 'portable', worker), [], { serialization: 'advanced' });
    return {
      post: (message) => child.send(message),
      onMessage: (callback) => child.on('message', callback),
      onExit: (callback) => child.on('exit', callback),
      kill: () => child.kill(),
    };
  },
  onMessage: (message) => {
    if (message.type === 'level' || message.type === 'partial') return;
    if (message.type === 'progress') {
      process.stdout.write(`\r${elapsed()}  download ${Math.round(message.value * 100)}%   `);
      return;
    }
    if (message.type === 'final') {
      console.log(`${elapsed()}  ${message.text}${message.translation ? `\n         → ${message.translation}` : ''}`);
      return;
    }
    console.log(`${elapsed()}  [${message.type}] ${message.state ?? message.code ?? ''} ${message.message ?? ''}`);
    if (message.state === 'listening') play();
  },
  onStopped: () => process.exit(1),
});

engine.start({ source: option('--source', 'en-US'), target: option('--target', 'it') });

async function play() {
  const wave = sherpa.readWave(file);
  const samples = resample(wave.samples, wave.sampleRate);
  const padded = new Float32Array(samples.length + SAMPLE_RATE * 2); // 2 s di silenzio finale chiudono l'ultima frase
  padded.set(samples);
  const realtime = !args.includes('--fast');
  for (let offset = 0; offset < padded.length; offset += CHUNK) {
    engine.pushAudio(padded.slice(offset, offset + CHUNK));
    if (realtime) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  setTimeout(() => {
    engine.stop();
    process.exit(0);
  }, 4000);
}

function resample(samples, rate) {
  if (rate === SAMPLE_RATE) return samples;
  const ratio = rate / SAMPLE_RATE;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const next = Math.min(index + 1, samples.length - 1);
    out[i] = samples[index] + (samples[next] - samples[index]) * (position - index);
  }
  return out;
}
