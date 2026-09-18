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
  let sessions = [];
  let notices = [];

  function request(stream) {
    return stream === 'me' ? microphone() : navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  }

  async function microphone() {
    const constraints = { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true };
    const deviceId = await preferredMicrophone();
    return navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { ...constraints, deviceId: { exact: deviceId } } : constraints,
    });
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
   * Restituisce gli avvisi da mostrare; in caso di errore `error.stream` indica il flusso non partito.
   */
  function start(input) {
    stop();
    notices = [];
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
    })).then(() => notices);
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
