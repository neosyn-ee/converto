import Accelerate
import AVFoundation

/// Filtro dell'eco per "Io + altri" senza cuffie.
///
/// Il microfono riprende anche la voce degli altri che esce dalle casse. Converto sa esattamente
/// cosa esce dalle casse (l'audio del Mac catturato), quindi per ogni frammento del microfono
/// confronta la sua energia con quella dell'audio riprodotto poco prima: se è spiegabile come eco,
/// il frammento viene silenziato prima del riconoscimento di "Io".
///
/// Quanto rientra l'eco dipende da volume, casse e stanza: il rapporto microfono/casse viene seguito
/// di continuo (la sua mediana mentre le casse suonano) e passa come "voce mia" solo ciò che lo
/// supera di un margine. Con le cuffie l'eco non c'è e il rapporto si adatta da solo.
final class EchoGate {
    /// Secondi di audio riprodotto che possono ancora rientrare nel microfono (ritardo + riverbero).
    private static let echoWindow = 0.5
    /// L'audio del microfono attende un attimo: l'audio del Mac corrispondente può arrivare dopo.
    private static let lookahead = 0.12
    /// Quanto la tua voce deve superare l'eco stimata per passare.
    private static let marginDB: Float = 8
    private static let trackingStepDB: Float = 0.25
    /// Dopo che hai parlato si lascia passare ancora un attimo, per non tagliare le fine parola.
    private static let hangover = 0.3
    /// Sotto questa energia le casse sono considerate mute.
    private static let activeReferenceDB: Float = -55

    private let lock = NSLock()
    private var reference: [(time: TimeInterval, powerDB: Float)] = []
    private var pending: [(time: TimeInterval, buffer: AVAudioPCMBuffer)] = []
    private var couplingDB: Float = 0 // si parte prudenti: eco forte quanto l'audio riprodotto
    private var passUntil: TimeInterval = 0

    /// Audio che esce dalle casse (flusso "Altri").
    func observeReference(_ buffer: AVAudioPCMBuffer) {
        let now = ProcessInfo.processInfo.systemUptime
        let power = Self.powerDB(buffer)
        lock.lock()
        defer { lock.unlock() }
        reference.append((now, power))
        if let firstRecent = reference.firstIndex(where: { $0.time >= now - 2 * Self.echoWindow }), firstRecent > 0 {
            reference.removeFirst(firstRecent)
        }
    }

    /// Audio del microfono: passa a `emit` (con ~120 ms di ritardo) invariato se contiene la tua voce,
    /// silenziato se è solo eco degli altri.
    func process(_ buffer: AVAudioPCMBuffer, emit: (AVAudioPCMBuffer) -> Void) {
        let now = ProcessInfo.processInfo.systemUptime
        var ready: [AVAudioPCMBuffer] = []
        lock.lock()
        pending.append((now, buffer))
        while let first = pending.first, now - first.time >= Self.lookahead {
            pending.removeFirst()
            if isEcho(first.buffer, at: first.time) {
                Self.silence(first.buffer)
            }
            ready.append(first.buffer)
        }
        lock.unlock()
        ready.forEach(emit)
    }

    /// Da chiamare con il lock preso.
    private func isEcho(_ buffer: AVAudioPCMBuffer, at time: TimeInterval) -> Bool {
        let referenceDB = reference.lazy
            .filter { $0.time >= time - Self.echoWindow && $0.time <= time + Self.lookahead }
            .map(\.powerDB).max() ?? -120
        guard referenceDB > Self.activeReferenceDB else { return false } // casse mute: sei tu
        let ratio = Self.powerDB(buffer) - referenceDB
        couplingDB += ratio > couplingDB ? Self.trackingStepDB : -Self.trackingStepDB
        if ratio > couplingDB + Self.marginDB {
            passUntil = time + Self.hangover // stai parlando tu
            return false
        }
        return time > passUntil
    }

    private static func silence(_ buffer: AVAudioPCMBuffer) {
        guard let channels = buffer.floatChannelData else { return }
        for channel in 0..<Int(buffer.format.channelCount) {
            vDSP_vclr(channels[channel], 1, vDSP_Length(buffer.frameLength))
        }
    }

    private static func powerDB(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return -120 }
        var meanSquare: Float = 0
        vDSP_measqv(samples, 1, &meanSquare, vDSP_Length(buffer.frameLength))
        return 10 * log10f(meanSquare + 1e-12)
    }
}
