'use strict';

// Cattura audio nel renderer, usata dal motore portabile (Windows): audio del PC in loopback
// oppure microfono, convertito in mono a 16 kHz e inviato al processo principale ogni 100 ms.
// Su macOS non serve: il motore Swift cattura l'audio da solo.
const audioCapture = (() => {
  const SAMPLE_RATE = 16000;
  const CHUNK = 1600;
  let active = null;

  /**
   * Va chiamata dentro il clic dell'utente: getDisplayMedia richiede un gesto recente,
   * quindi la richiesta parte prima di qualsiasi attesa.
   */
  function start(input) {
    stop();
    const request = input === 'mic'
      ? navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      })
      : navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    const session = { stream: null, context: null };
    active = session;
    return request.then((stream) => attach(session, stream));
  }

  async function attach(session, stream) {
    if (active !== session) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    session.stream = stream;
    stream.getVideoTracks().forEach((track) => track.stop()); // dello schermo serve solo l'audio
    if (!stream.getAudioTracks().length) {
      throw Object.assign(new Error('Nessun audio disponibile da catturare.'), { name: 'NoAudioError' });
    }
    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
    session.context = context;
    await context.audioWorklet.addModule('pcm-worklet.js');
    if (active !== session) return;
    const node = new AudioWorkletNode(context, 'pcm-capture', {
      numberOfOutputs: 0, // nessuna uscita: l'audio non viene riprodotto
      processorOptions: { chunkSize: CHUNK },
    });
    node.port.onmessage = (event) => window.converto.sendAudio(event.data);
    context.createMediaStreamSource(stream).connect(node);
  }

  function stop() {
    const session = active;
    active = null;
    session?.stream?.getTracks().forEach((track) => track.stop());
    session?.context?.close().catch(() => {});
  }

  return { start, stop };
})();
