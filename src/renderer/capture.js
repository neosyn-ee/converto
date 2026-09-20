'use strict';

// Cattura audio nel renderer, usata dal motore portabile (Windows): audio del PC in loopback
// ("Altri") e/o microfono ("Io"), convertiti in mono a 16 kHz e inviati al processo principale
// ogni 100 ms con l'etichetta del flusso. Su macOS non serve: il motore Swift cattura da solo.
const audioCapture = (() => {
  const SAMPLE_RATE = 16000;
  const CHUNK = 1600;
  const STREAMS_BY_INPUT = { system: ['others'], mic: ['me'], both: ['me', 'others'] };
  // Microfoni di auricolari Bluetooth: aprirli fa passare le cuffie in modalità "vivavoce"
  // (audio mono, più forte e meno nitido). Windows non dice il tipo di collegamento: si guarda il nome.
  const BLUETOOTH_HINT = /hands-?free|vivavoce|headset|auricolare|bluetooth|airpods|buds|\bbt\b/i;
  const PROBE_TIMEOUT_MS = 1200;
  const PROBE_POLL_MS = 100;
  let sessions = [];
  let notices = [];
  let echoCancelled = false;

  function request(stream) {
    return stream === 'me' ? microphone() : navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  }

  async function microphone() {
    const deviceId = await preferredMicrophone();
    echoCancelled = await echoCancellationWorks(deviceId);
    const constraints = { channelCount: 1, noiseSuppression: true, autoGainControl: true };
    if (deviceId) constraints.deviceId = { exact: deviceId };
    return navigator.mediaDevices.getUserMedia({
      audio: { ...constraints, echoCancellation: echoCancelled ? { exact: 'all' } : false },
    });
  }

  /**
   * Chromium toglie dal microfono l'audio che esce dalle casse solo con `echoCancellation: 'all'`,
   * che usa come riferimento l'audio di sistema: serve Windows 11 (o macOS 14.2+). Se il permesso
   * di registrare l'audio di sistema manca la cattura non fallisce, manda silenzio assoluto: si
   * prova quindi su un microfono di scorta prima di usarlo davvero.
   */
  async function echoCancellationWorks(deviceId) {
    const audio = { channelCount: 1, echoCancellation: { exact: 'all' }, noiseSuppression: false, autoGainControl: false };
    if (deviceId) audio.deviceId = { exact: deviceId };
    let media;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio });
    } catch {
      return false; // niente 'all' (Windows 10, macOS più vecchio) o microfono negato
    }
    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
    try {
      const analyser = context.createAnalyser();
      context.createMediaStreamSource(media).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const deadline = Date.now() + PROBE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, PROBE_POLL_MS));
        analyser.getFloatTimeDomainData(samples);
        if (samples.some((sample) => sample !== 0)) return true;
      }
      return false;
    } finally {
      media.getTracks().forEach((track) => track.stop());
      await context.close().catch(() => {});
    }
  }

  /** Un microfono non Bluetooth se il predefinito è un auricolare; null = quello predefinito. */
  async function preferredMicrophone() {
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
    const byDefault = inputs.find((device) => device.deviceId === 'default');
    if (!byDefault || !BLUETOOTH_HINT.test(byDefault.label)) return null;
    const alternative = inputs.find((device) => !['default', 'communications'].includes(device.deviceId)
      && device.label && !BLUETOOTH_HINT.test(device.label));
    if (!alternative) return null;
    notices.push(`Uso «${alternative.label}» invece del microfono Bluetooth: così in cuffia l'audio resta in alta qualità.`);
    return alternative.deviceId;
  }

  /**
   * Va chiamata dentro il clic dell'utente: getDisplayMedia richiede un gesto recente,
   * quindi tutte le richieste partono prima di qualsiasi attesa.
   * Restituisce gli avvisi da mostrare e se l'eco delle casse è stata tolta dal microfono; in caso
   * di errore `error.stream` indica il flusso non partito.
   */
  function start(input) {
    stop();
    notices = [];
    echoCancelled = false;
    const streams = STREAMS_BY_INPUT[input] ?? STREAMS_BY_INPUT.system;
    return Promise.all(streams.map((stream) => {
      const session = { stream, media: null, context: null };
      sessions.push(session);
      return request(stream)
        .then((media) => attach(session, media))
        .catch((error) => {
          error.stream = stream;
          throw error;
        });
    })).then(() => ({ notices, echoCancelled }));
  }

  async function attach(session, media) {
    if (!sessions.includes(session)) {
      media.getTracks().forEach((track) => track.stop());
      return;
    }
    session.media = media;
    media.getVideoTracks().forEach((track) => track.stop()); // dello schermo serve solo l'audio
    if (!media.getAudioTracks().length) {
      throw Object.assign(new Error('Nessun audio disponibile da catturare.'), { name: 'NoAudioError' });
    }
    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
    session.context = context;
    await context.audioWorklet.addModule('pcm-worklet.js');
    if (!sessions.includes(session)) return;
    const node = new AudioWorkletNode(context, 'pcm-capture', {
      numberOfOutputs: 0, // nessuna uscita: l'audio non viene riprodotto
      processorOptions: { chunkSize: CHUNK },
    });
    node.port.onmessage = (event) => window.converto.sendAudio(session.stream, event.data);
    context.createMediaStreamSource(media).connect(node);
  }

  function stop() {
    const previous = sessions;
    sessions = [];
    for (const session of previous) {
      session.media?.getTracks().forEach((track) => track.stop());
      session.context?.close().catch(() => {});
    }
  }

  return { start, stop };
})();
