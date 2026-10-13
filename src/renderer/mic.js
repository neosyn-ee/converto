'use strict';

// Microfono di "Io + altri" catturato da Electron invece che dal motore: solo Chromium sa togliere
// dal microfono l'audio che esce dalle casse (`echoCancellation: 'all'`, con l'audio di sistema
// come riferimento). I campioni vanno al motore del flusso "Io" (float 32 bit, mono, 16 kHz).
//
// Serve macOS 14.2+ (o Windows 11) e il permesso di registrare l'audio del Mac: senza quel
// permesso Chromium non ha il riferimento e manda silenzio assoluto invece del microfono, quindi
// si controlla che arrivi davvero del suono prima di fidarsi.
const micCapture = (() => {
  const SAMPLE_RATE = 16000;
  const CHUNK = 1600; // 100 ms
  const SOUND_TIMEOUT_MS = 1200;
  const SOUND_POLL_MS = 100;
  // Un microfono che non si apre entro questo tempo non risponde: lo cattura il motore.
  const OPEN_TIMEOUT_MS = 5000;
  // Microfoni di auricolari Bluetooth: aprirli mette le cuffie in modalità chiamata (mono, più
  // forte e meno nitido). Come fa il motore, si usa allora il microfono integrato del Mac.
  const BLUETOOTH_HINT = /hands-?free|vivavoce|headset|auricolare|bluetooth|airpods|buds|\bbt\b/i;
  // Su macOS Chromium aggiunge al nome il collegamento: "MacBook Pro Microphone (Built-in)".
  // Non basta il primo microfono non Bluetooth: prima di quello del Mac possono esserci il
  // microfono dell'iPhone (Continuity, si apre solo se il telefono risponde) o dispositivi
  // virtuali muti come BlackHole.
  const BUILT_IN = /\(Built-in\)$/;

  let session = null;

  /** Il microfono integrato se il predefinito è un auricolare Bluetooth; null = quello predefinito. */
  async function preferredMicrophone() {
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
    const byDefault = inputs.find((device) => device.deviceId === 'default');
    if (!byDefault || !BLUETOOTH_HINT.test(byDefault.label)) return null;
    return inputs.find((device) => device.deviceId !== 'default' && BUILT_IN.test(device.label))?.deviceId ?? null;
  }

  /** getUserMedia senza aspettare per sempre un microfono che non risponde. */
  function openMicrophone(audio) {
    return new Promise((resolve, reject) => {
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        reject(new Error('Il microfono non risponde'));
      }, OPEN_TIMEOUT_MS);
      navigator.mediaDevices.getUserMedia({ audio }).then((media) => {
        clearTimeout(timer);
        if (late) media.getTracks().forEach((track) => track.stop()); // arrivato tardi: nessuno lo usa
        else resolve(media);
      }, (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  /** Avvia la cattura; false se l'eco non si può togliere e il microfono lo deve prendere il motore. */
  async function start() {
    stop();
    const audio = {
      echoCancellation: { exact: 'all' },
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    };
    const deviceId = await preferredMicrophone().catch(() => null);
    if (deviceId) audio.deviceId = { exact: deviceId };

    let media;
    try {
      media = await openMicrophone(audio);
    } catch {
      return false; // niente 'all' (macOS più vecchio, Windows 10), microfono negato o che non risponde
    }
    const current = { media, context: new AudioContext({ sampleRate: SAMPLE_RATE }), sounded: false };
    session = current;
    try {
      await current.context.audioWorklet.addModule('pcm-worklet.js');
      if (session !== current) return false; // fermato nel frattempo
      const node = new AudioWorkletNode(current.context, 'pcm-capture', {
        numberOfOutputs: 0, // nessuna uscita: il microfono non va riprodotto
        processorOptions: { chunkSize: CHUNK },
      });
      node.port.onmessage = ({ data }) => {
        if (session !== current) return;
        if (!current.sounded && data.some((sample) => sample !== 0)) current.sounded = true;
        window.converto.sendMicAudio(data.buffer);
      };
      current.context.createMediaStreamSource(media).connect(node);
    } catch {
      stop();
      return false;
    }
    return waitForSound(current);
  }

  /** Senza riferimento Chromium manda zeri: se non arriva nulla in un attimo, si rinuncia. */
  function waitForSound(current) {
    const deadline = Date.now() + SOUND_TIMEOUT_MS;
    return new Promise((resolve) => {
      const check = () => {
        if (session !== current) return resolve(false);
        if (current.sounded) return resolve(true);
        if (Date.now() >= deadline) {
          stop();
          return resolve(false);
        }
        setTimeout(check, SOUND_POLL_MS);
      };
      check();
    });
  }

  function stop() {
    const previous = session;
    session = null;
    previous?.media.getTracks().forEach((track) => track.stop());
    previous?.context.close().catch(() => {});
  }

  return { start, stop };
})();
