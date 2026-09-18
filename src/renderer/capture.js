'use strict';

// Cattura audio nel renderer, usata dal motore portabile (Windows): audio del PC in loopback
// ("Altri") e/o microfono ("Io"), convertiti in mono a 16 kHz e inviati al processo principale
// ogni 100 ms con l'etichetta del flusso. Su macOS non serve: il motore Swift cattura da solo.
const audioCapture = (() => {
  const SAMPLE_RATE = 16000;
  const CHUNK = 1600;
  const STREAMS_BY_INPUT = { system: ['others'], mic: ['me'], both: ['me', 'others'] };
  let sessions = [];

  function request(stream) {
    return stream === 'me'
      ? navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      })
      : navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  }

  /**
   * Va chiamata dentro il clic dell'utente: getDisplayMedia richiede un gesto recente,
   * quindi tutte le richieste partono prima di qualsiasi attesa.
   * In caso di errore, `error.stream` indica quale flusso non è partito.
   */
  function start(input) {
    stop();
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
    }));
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
