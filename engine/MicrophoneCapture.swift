import AVFoundation

/// Cattura dal microfono predefinito, per le conversazioni dal vivo.
final class MicrophoneCapture {
    private let engine = AVAudioEngine()
    private let onBuffer: (AVAudioPCMBuffer) -> Void

    init(onBuffer: @escaping (AVAudioPCMBuffer) -> Void) {
        self.onBuffer = onBuffer
    }

    func start() async throws {
        guard await AVCaptureDevice.requestAccess(for: .audio) else {
            throw EngineError(code: "mic_permission_denied",
                              message: "Accesso al microfono negato. Impostazioni di Sistema → Privacy e sicurezza → Microfono.")
        }
        let input = engine.inputNode
        let onBuffer = self.onBuffer
        input.installTap(onBus: 0, bufferSize: 4096, format: input.outputFormat(forBus: 0)) { buffer, _ in
            onBuffer(buffer)
        }
        try engine.start()
    }

    func stop() {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
    }
}
