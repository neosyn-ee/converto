import AVFoundation
import Foundation

/// Microfono inviato da Electron su stdin: campioni float a 32 bit, mono, 16 kHz.
///
/// Serve in "Io + altri": Chromium sa togliere dal microfono l'audio che esce dalle casse
/// (`echoCancellation: 'all'`, riferimento = audio di sistema), Core Audio da solo no. In quella
/// modalità il motore riceve quindi il microfono già ripulito invece di catturarlo da sé.
final class PipedAudio {
    static let sampleRate = 16000.0
    private static let bytesPerSample = MemoryLayout<Float>.size
    /// Quanti byte leggere per volta: 100 ms, come i blocchi inviati da Electron.
    private static let readBytes = 1600 * bytesPerSample

    private let onBuffer: (AVAudioPCMBuffer) -> Void
    private let onEnd: () -> Void
    private let format: AVAudioFormat
    private var stopped = false

    /// `onEnd` viene chiamato quando Electron chiude stdin: il motore non deve restare attivo.
    init?(onBuffer: @escaping (AVAudioPCMBuffer) -> Void, onEnd: @escaping () -> Void) {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Self.sampleRate,
                                         channels: 1, interleaved: false) else { return nil }
        self.format = format
        self.onBuffer = onBuffer
        self.onEnd = onEnd
    }

    func start() {
        let thread = Thread { [self] in read() }
        thread.name = "converto.piped-audio"
        thread.start()
    }

    func stop() {
        stopped = true
    }

    private func read() {
        var pending = Data()
        while !stopped {
            guard let data = try? FileHandle.standardInput.read(upToCount: Self.readBytes),
                  !data.isEmpty else { break } // stdin chiuso: Electron ha finito
            pending.append(data)
            // Un blocco può arrivare spezzato: si passano solo i campioni completi.
            let complete = pending.count - pending.count % Self.bytesPerSample
            guard complete > 0 else { continue }
            emit(pending.prefix(complete))
            pending.removeFirst(complete)
        }
        if !stopped { onEnd() }
    }

    private func emit(_ data: Data) {
        let frames = data.count / Self.bytesPerSample
        guard frames > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { return }
        buffer.frameLength = AVAudioFrameCount(frames)
        let destination = UnsafeMutableRawBufferPointer(start: buffer.floatChannelData![0], count: data.count)
        data.copyBytes(to: destination)
        onBuffer(buffer)
    }
}
