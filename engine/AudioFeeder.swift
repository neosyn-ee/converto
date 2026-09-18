import Accelerate
import AVFoundation
import Speech

/// Porta l'audio catturato nel formato dell'analizzatore, ne misura il livello
/// e smette di alimentarlo durante i silenzi lunghi per non consumare risorse.
final class AudioFeeder {
    private static let silenceRMS: Float = 0.002
    private static let pauseAfterSeconds = 1.2
    private static let levelInterval = 0.12

    private let format: AVAudioFormat
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private let onPause: () -> Void
    private var converter: AVAudioConverter?
    private var silentSeconds = 0.0
    private var paused = false
    /// C'è stato suono dall'ultima chiusura di frase? Senza, chiedere di chiudere fa fallire il riconoscimento.
    private var soundSinceLastPause = false
    private var levelPeak: Float = 0
    private var lastLevel: Float = -1
    private var lastLevelAt = Date.distantPast

    /// `onPause` viene chiamato quando inizia un silenzio: serve a chiudere subito la frase in corso.
    init(format: AVAudioFormat, continuation: AsyncStream<AnalyzerInput>.Continuation, onPause: @escaping () -> Void) {
        self.format = format
        self.continuation = continuation
        self.onPause = onPause
    }

    func feed(_ buffer: AVAudioPCMBuffer) {
        guard buffer.frameLength > 0 else { return }
        let rms = Self.rms(buffer)
        reportLevel(rms)

        if rms < Self.silenceRMS {
            silentSeconds += Double(buffer.frameLength) / buffer.format.sampleRate
            if silentSeconds >= Self.pauseAfterSeconds {
                if !paused {
                    paused = true
                    if soundSinceLastPause {
                        soundSinceLastPause = false
                        onPause()
                    }
                }
                return
            }
        } else {
            silentSeconds = 0
            paused = false
            soundSinceLastPause = true
        }

        // Il buffer del tap è valido solo durante la callback: la conversione ne produce una copia.
        if let converted = convert(buffer) {
            continuation.yield(AnalyzerInput(buffer: converted))
        }
    }

    private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if converter?.inputFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: format)
            converter?.downmix = true
        }
        guard let converter else { return nil }

        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }

        var supplied = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        return error == nil && output.frameLength > 0 ? output : nil
    }

    private func reportLevel(_ rms: Float) {
        levelPeak = max(levelPeak, rms)
        let now = Date()
        guard now.timeIntervalSince(lastLevelAt) >= Self.levelInterval else { return }

        // -60 dB → 0, 0 dB → 1
        let level = max(0, min(1, (20 * log10(max(levelPeak, 1e-6)) + 60) / 60))
        if abs(level - lastLevel) > 0.02 {
            Output.emit("level", ["value": (level * 100).rounded() / 100])
            lastLevel = level
        }
        levelPeak = 0
        lastLevelAt = now
    }

    private static func rms(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let samples = buffer.floatChannelData?[0] else { return 1 }
        var meanSquare: Float = 0
        vDSP_measqv(samples, 1, &meanSquare, vDSP_Length(buffer.frameLength))
        return sqrtf(meanSquare)
    }
}
