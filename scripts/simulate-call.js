#!/usr/bin/env node
// Genera call simulate per provare "Io + altri" e il filtro dell'eco (solo macOS: usa `say` e ffmpeg).
//
//   node scripts/simulate-call.js [cartella]      (predefinita: test-audio/)
//
// Due voci si alternano (tu con accento italiano, gli altri madrelingua) con un tratto sovrapposto.
// Per ogni scenario scrive, a 16 kHz mono:
//   system.wav               audio del computer (solo gli altri)
//   <scenario>-mic.wav       microfono: tua voce + eco delle casse + rumore
//   <scenario>-near.wav      solo la tua voce, <scenario>-echo.wav solo l'eco (per misurare il filtro)
//
// Poi:  converto-engine --target none --mic-file <scenario>-mic.wav --system-file system.wav   (Mac)
//       node scripts/try-portable-engine.js system.wav --me <scenario>-mic.wav --target none   (Windows)
//       node scripts/eval-echo-gate.js [cartella]
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SAMPLE_RATE = 16000;
const LENGTH = 26 * SAMPLE_RATE;
const out = path.resolve(process.argv[2] ?? 'test-audio');

// [inizio in secondi, chi parla, voce di `say`, frase]
const TIMELINE = [
  [0.5, 'others', 'Samantha', 'Thanks for joining. Can you give us an update on the Milan plant?'],
  [5.0, 'me', 'Alice', 'Yes, the new line is installed and we started the tests on Monday.'],
  [10.5, 'others', 'Samantha', 'Great. What about the delivery dates for the German customer?'],
  [15.0, 'me', 'Alice', 'We are two weeks late because of the supplier.'],
  [18.5, 'others', 'Samantha', 'Okay, please send me the updated plan by Friday.'],
  [20.5, 'me', 'Alice', 'Sure, I will send it tomorrow morning.'], // si sovrappone agli altri
];

// [voce vicina, riflessioni dell'eco [ritardo s, guadagno], rumore]
const SCENARIOS = {
  normale: [0.8, [[0.06, 0.25], [0.11, 0.12], [0.19, 0.06], [0.29, 0.03]], 0.002],
  'casse-forti': [0.5, [[0.04, 0.5], [0.09, 0.3], [0.15, 0.18], [0.24, 0.1], [0.35, 0.05]], 0.003],
  'stanza-riverbero': [0.7, [[0.05, 0.3], [0.1, 0.25], [0.18, 0.2], [0.3, 0.15], [0.45, 0.1], [0.6, 0.06]], 0.004],
  cuffie: [0.8, [], 0.002],
};

function speak(voice, text) {
  const aiff = path.join(os.tmpdir(), `converto-say-${process.pid}.aiff`);
  execFileSync('say', ['-v', voice, '-o', aiff, text]);
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', aiff, '-f', 'f32le', '-ac', '1', '-ar', String(SAMPLE_RATE), '-'],
    { maxBuffer: 64 * 1024 * 1024 });
  fs.rmSync(aiff, { force: true });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
}

function writeWav(file, samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

// Rumore gaussiano ripetibile.
function noise(amplitude, seed) {
  let state = seed;
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  return () => amplitude * Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
}

fs.mkdirSync(out, { recursive: true });
const system = new Float32Array(LENGTH);
const me = new Float32Array(LENGTH);
for (const [start, who, voice, text] of TIMELINE) {
  const target = who === 'me' ? me : system;
  const offset = Math.round(start * SAMPLE_RATE);
  speak(voice, text).forEach((sample, i) => {
    if (offset + i < LENGTH) target[offset + i] += sample;
  });
}
writeWav(path.join(out, 'system.wav'), system);

Object.entries(SCENARIOS).forEach(([name, [nearGain, reflections, noiseLevel]], index) => {
  const near = me.map((sample) => nearGain * sample);
  const echo = new Float32Array(LENGTH);
  for (const [delay, gain] of reflections) {
    const shift = Math.round(delay * SAMPLE_RATE);
    for (let i = shift; i < LENGTH; i += 1) echo[i] += gain * system[i - shift];
  }
  const hiss = noise(noiseLevel, index + 1);
  writeWav(path.join(out, `${name}-mic.wav`), near.map((sample, i) => sample + echo[i] + hiss()));
  writeWav(path.join(out, `${name}-near.wav`), near);
  writeWav(path.join(out, `${name}-echo.wav`), echo);
});
console.log(`Call simulate in ${out}: ${Object.keys(SCENARIOS).join(', ')}`);
