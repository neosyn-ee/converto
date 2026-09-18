// AudioWorklet: riceve l'audio già a 16 kHz, lo porta in mono e lo invia a blocchi di 100 ms.
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = options.processorOptions.chunkSize;
    this.buffer = new Float32Array(this.size);
    this.filled = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (channels?.length) {
      const frames = channels[0].length;
      for (let frame = 0; frame < frames; frame += 1) {
        let sum = 0;
        for (const channel of channels) sum += channel[frame];
        this.buffer[this.filled] = sum / channels.length;
        this.filled += 1;
        if (this.filled === this.size) {
          this.port.postMessage(this.buffer, [this.buffer.buffer]);
          this.buffer = new Float32Array(this.size);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
