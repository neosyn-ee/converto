// Filtro dell'eco per "Io + altri" senza cuffie (motore portabile). Stessa logica di
// engine/EchoGate.swift: l'audio del PC fa da riferimento e ogni frammento del microfono che è
// spiegabile come eco delle casse viene silenziato prima del riconoscimento di "Io".
//
// L'audio arriva a blocchi di 100 ms da due catture diverse: i blocchi si analizzano a frammenti
// di 20 ms e il microfono attende un po' di più che su Mac, perché i due flussi non sono allineati.
const SAMPLE_RATE = 16000;
const FRAME = 320; // 20 ms
const ECHO_WINDOW = 0.5; // s di audio riprodotto che possono ancora rientrare nel microfono
const LOOKAHEAD = 0.25; // attesa del microfono: l'audio del PC corrispondente può arrivare dopo
// L'eco "tipica" è il 80° percentile del rapporto microfono/casse mentre le casse suonano; la tua
// voce deve superarla di MARGIN_DB per ONSET_FRAMES frammenti di fila (un picco isolato non basta).
// Valori tarati su call simulate (casse normali, casse forti, stanza riverberante, cuffie):
// eco lasciata passare 0–1,4%, tua voce conservata 98–100%.
const COUPLING_PERCENTILE = 0.8;
const MARGIN_DB = 6;
const ONSET_FRAMES = 2;
const TRACKING_STEP_DB = 0.5;
const HANGOVER = 0.3; // dopo che hai parlato si lascia passare ancora un attimo
const ACTIVE_REFERENCE_DB = -55; // sotto questa energia le casse sono considerate mute

function powerDB(samples, start, end) {
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += samples[i] * samples[i];
  return 10 * Math.log10(sum / Math.max(end - start, 1) + 1e-12);
}

function createEchoGate() {
  let reference = []; // { time, power } per frammento
  const pending = []; // { time, samples } del microfono in attesa
  let couplingDB = 0; // si parte prudenti: eco forte quanto l'audio riprodotto
  let passUntil = 0;
  let above = 0;

  /** Frammenti di un blocco arrivato in `time` (secondi): il blocco copre gli ultimi N campioni. */
  function frames(samples, time) {
    const start = time - samples.length / SAMPLE_RATE;
    const out = [];
    for (let offset = 0; offset < samples.length; offset += FRAME) {
      const end = Math.min(offset + FRAME, samples.length);
      out.push({ offset, end, time: start + end / SAMPLE_RATE });
    }
    return out;
  }

  /** Audio che esce dalle casse (flusso "Altri"). */
  function observeReference(samples, time) {
    for (const frame of frames(samples, time)) {
      reference.push({ time: frame.time, power: powerDB(samples, frame.offset, frame.end) });
    }
    reference = reference.filter((entry) => entry.time >= time - 2 * ECHO_WINDOW);
  }

  /** Audio del microfono: passa a `emit` dopo ~250 ms, con i frammenti di sola eco silenziati. */
  function process(samples, time, emit) {
    pending.push({ time, samples });
    while (pending.length && time - pending[0].time >= LOOKAHEAD) {
      const block = pending.shift();
      for (const frame of frames(block.samples, block.time)) {
        if (isEcho(block.samples, frame)) block.samples.fill(0, frame.offset, frame.end);
      }
      emit(block.samples);
    }
  }

  function isEcho(samples, frame) {
    let referenceDB = -120;
    for (const entry of reference) {
      if (entry.time >= frame.time - ECHO_WINDOW && entry.time <= frame.time + LOOKAHEAD) {
        referenceDB = Math.max(referenceDB, entry.power);
      }
    }
    if (referenceDB <= ACTIVE_REFERENCE_DB) return false; // casse mute: sei tu
    const ratio = powerDB(samples, frame.offset, frame.end) - referenceDB;
    // Stima del percentile: sale di più quando il rapporto è sopra, scende poco quando è sotto.
    couplingDB += ratio > couplingDB
      ? TRACKING_STEP_DB * COUPLING_PERCENTILE
      : -TRACKING_STEP_DB * (1 - COUPLING_PERCENTILE);
    if (ratio > couplingDB + MARGIN_DB) {
      above += 1;
      if (above >= ONSET_FRAMES) {
        passUntil = frame.time + HANGOVER; // stai parlando tu
        return false;
      }
    } else {
      above = 0;
    }
    return frame.time > passUntil;
  }

  return { observeReference, process };
}

module.exports = { createEchoGate };
