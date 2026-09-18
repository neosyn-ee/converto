import Accelerate
import AVFoundation

/// Filtro dell'eco per "Io + altri" senza cuffie.
///
/// Il microfono riprende anche la voce degli altri che esce dalle casse. Converto sa esattamente
/// cosa esce dalle casse (l'audio del Mac catturato), quindi per ogni frammento di 20 ms del
/// microfono confronta la sua energia con quella dell'audio riprodotto poco prima: se è spiegabile
/// come eco, il frammento viene silenziato prima del riconoscimento di "Io".
///
/// Quanto rientra l'eco dipende da volume, casse e stanza: il rapporto microfono/casse mentre le
/// casse suonano viene seguito di continuo (80° percentile) e passa come "voce mia" solo ciò che lo
/// supera di un margine per due frammenti di fila. Con le cuffie l'eco non c'è e il rapporto si
/// adatta da solo. Stessa logica e stesse soglie di src/engines/portable/echo-gate.js (Windows),
/// tarate su call simulate: eco lasciata passare 0–1,4%, tua voce conservata 98–100%.
final class EchoGate {
    private static let frameSeconds = 0.02
    /// Secondi di audio riprodotto che possono ancora rientrare nel microfono (ritardo + riverbero).
    private static let echoWindow = 0.5
    /// L'audio del microfono attende un attimo: l'audio del Mac corrispondente può arrivare dopo.
    private static let lookahead = 0.12
    private static let couplingPercentile: Float = 0.8
    /// Quanto la tua voce deve superare l'eco stimata, e per quanti frammenti di fila.
    private static let marginDB: Float = 6
    private static let onsetFrames = 2
    private static let trackingStepDB: Float = 0.5
    /// Dopo che hai parlato si lascia passare ancora un attimo, per non tagliare le fine parola.
    private static let hangover = 0.3
    /// Sotto questa energia le casse sono considerate mute.
    private static let activeReferenceDB: Float = -55

    private let lock = NSLock()
    private var reference: [(time: TimeInterval, powerDB: Float)] = []
    private var referenceFrame = (sum: Float(0), count: 0)
    private var microphoneSamples: [Float] = []
    private var microphoneFormat: AVAudioFormat?
    private var pending: [(time: TimeInterval, frame: AVAudioPCMBuffer)] = []
    private var couplingDB: Float = 0 // si parte prudenti: eco forte quanto l'audio riprodotto
    private var passUntil: TimeInterval = 0
    private var above = 0

    /// Audio che esce dalle casse (flusso "Altri").
    func observeReference(_ buffer: AVAudioPCMBuffer) {
        guard let samples = buffer.floatChannelData?[0] else { return }
        let now = ProcessInfo.processInfo.systemUptime
        let frameLength = Int(buffer.format.sampleRate * Self.frameSeconds)
        let count = Int(buffer.frameLength)
        lock.lock()
        defer { lock.unlock() }
        for index in 0..<count {
            referenceFrame.sum += samples[index] * samples[index]
            referenceFrame.count += 1
            if referenceFrame.count == frameLength {
                let end = now - Double(count - 1 - index) / buffer.format.sampleRate
                reference.append((end, 10 * log10f(referenceFrame.sum / Float(frameLength) + 1e-12)))
                referenceFrame = (0, 0)
            }
        }
        if let firstRecent = reference.firstIndex(where: { $0.time >= now - 2 * Self.echoWindow }), firstRecent > 0 {
            reference.removeFirst(firstRecent)
        }
    }

    /// Audio del microfono (mono): passa a `emit` a frammenti di 20 ms, con ~120 ms di ritardo,
    /// invariato se contiene la tua voce e silenziato se è solo eco degli altri.
    func process(_ buffer: AVAudioPCMBuffer, emit: (AVAudioPCMBuffer) -> Void) {
        guard let samples = buffer.floatChannelData?[0] else { return }
        let now = ProcessInfo.processInfo.systemUptime
        let rate = buffer.format.sampleRate
        let frameLength = Int(rate * Self.frameSeconds)
        var ready: [AVAudioPCMBuffer] = []

        lock.lock()
        microphoneFormat = buffer.format
        microphoneSamples.append(contentsOf: UnsafeBufferPointer(start: samples, count: Int(buffer.frameLength)))
        while microphoneSamples.count >= frameLength,
              let frame = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: AVAudioFrameCount(frameLength)) {
            microphoneSamples.withUnsafeBufferPointer { source in
                frame.floatChannelData![0].update(from: source.baseAddress!, count: frameLength)
            }
            frame.frameLength = AVAudioFrameCount(frameLength)
            microphoneSamples.removeFirst(frameLength)
            pending.append((now - Double(microphoneSamples.count) / rate, frame))
        }
        while let first = pending.first, now - first.time >= Self.lookahead {
            pending.removeFirst()
            if isEcho(first.frame, at: first.time) {
                vDSP_vclr(first.frame.floatChannelData![0], 1, vDSP_Length(first.frame.frameLength))
            }
            ready.append(first.frame)
        }
        lock.unlock()
        ready.forEach(emit)
    }

    /// Da chiamare con il lock preso.
    private func isEcho(_ frame: AVAudioPCMBuffer, at time: TimeInterval) -> Bool {
        let referenceDB = reference.lazy
            .filter { $0.time >= time - Self.echoWindow && $0.time <= time + Self.lookahead }
            .map(\.powerDB).max() ?? -120
        guard referenceDB > Self.activeReferenceDB else { return false } // casse mute: sei tu

        var meanSquare: Float = 0
        vDSP_measqv(frame.floatChannelData![0], 1, &meanSquare, vDSP_Length(frame.frameLength))
        let ratio = 10 * log10f(meanSquare + 1e-12) - referenceDB
        // Stima del percentile: sale di più quando il rapporto è sopra, scende poco quando è sotto.
        couplingDB += ratio > couplingDB
            ? Self.trackingStepDB * Self.couplingPercentile
            : -Self.trackingStepDB * (1 - Self.couplingPercentile)
        if ratio > couplingDB + Self.marginDB {
            above += 1
            if above >= Self.onsetFrames {
                passUntil = time + Self.hangover // stai parlando tu
                return false
            }
        } else {
            above = 0
        }
        return time > passUntil
    }
}
