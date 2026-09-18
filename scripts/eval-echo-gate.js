#!/usr/bin/env node
// Misura il filtro dell'eco (src/engines/portable/echo-gate.js, stesse soglie di engine/EchoGate.swift)
// sulle call simulate da scripts/simulate-call.js.
//
//   node scripts/eval-echo-gate.js [cartella]      (predefinita: test-audio/)
//
// Per ogni scenario, a frammenti di 20 ms:
//   eco      frammenti di sola eco che arrivano comunque a "Io" (deve restare ~0%)
//   voce     frammenti in cui parli solo tu che passano (deve restare ~100%)
//   insieme  frammenti in cui parlate insieme che passano (limite noto: con le casse si perdono)
const fs = require('node:fs');
const path = require('node:path');
const { createEchoGate } = require('../src/engines/portable/echo-gate');

const CHUNK = 1600; // blocchi da 100 ms, come arrivano dal renderer
const FRAME = 320;
const dir = path.resolve(process.argv[2] ?? 'test-audio');

function readWav(file) {
  const buffer = fs.readFileSync(path.join(dir, file));
  const data = buffer.subarray(44);
  const samples = new Float32Array(data.length / 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = data.readInt16LE(i * 2) / 32767;
  return samples;
}

function powerDB(samples, start, end) {
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += samples[i] * samples[i];
  return 10 * Math.log10(sum / (end - start) + 1e-12);
}

const percent = (part, total) => `${total ? ((100 * part) / total).toFixed(1) : '–'}%`;
const system = readWav('system.wav');
const scenarios = fs.readdirSync(dir).filter((file) => file.endsWith('-mic.wav')).map((file) => file.slice(0, -8));

for (const scenario of scenarios) {
  const mic = readWav(`${scenario}-mic.wav`);
  const near = readWav(`${scenario}-near.wav`);
  const echo = readWav(`${scenario}-echo.wav`);
  const gate = createEchoGate();
  const output = new Float32Array(mic.length);
  let written = 0;
  for (let offset = 0, block = 1; offset < mic.length; offset += CHUNK, block += 1) {
    const time = block * 0.1;
    gate.observeReference(system.slice(offset, offset + CHUNK), time);
    gate.process(mic.slice(offset, offset + CHUNK), time, (samples) => {
      output.set(samples, written);
      written += samples.length;
    });
  }

  const counts = { echo: [0, 0], near: [0, 0], both: [0, 0] };
  for (let start = 0; start + FRAME <= written; start += FRAME) {
    const nearDB = powerDB(near, start, start + FRAME);
    const echoDB = powerDB(echo, start, start + FRAME);
    const passed = powerDB(output, start, start + FRAME) > -100 ? 1 : 0;
    const kind = nearDB < -60 && echoDB > -45 ? 'echo' : nearDB > -40 && echoDB < -60 ? 'near' : nearDB > -40 && echoDB > -45 ? 'both' : null;
    if (kind) {
      counts[kind][0] += passed;
      counts[kind][1] += 1;
    }
  }
  console.log(`${scenario.padEnd(18)} eco ${percent(...counts.echo).padStart(6)} · voce ${percent(...counts.near).padStart(6)} · insieme ${percent(...counts.both).padStart(6)}`);
}
