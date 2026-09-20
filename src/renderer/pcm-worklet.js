// Manda alla pagina i campioni del microfono a blocchi (100 ms), mono.
class PcmCapture extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    this.chunk = new Float32Array(processorOptions.chunkSize);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) {
      this.chunk[this.filled] = sample;
      this.filled += 1;
      if (this.filled === this.chunk.length) {
        this.port.postMessage(this.chunk); // postMessage ne manda una copia: il blocco si può riusare
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
