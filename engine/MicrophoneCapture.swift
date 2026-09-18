import AVFoundation
import CoreAudio

/// Cattura dal microfono leggendo direttamente il dispositivo di ingresso.
///
/// Non usa AVAudioEngine: quello unisce ingresso e uscita di sistema in un dispositivo aggregato
/// e, con uscite come i dispositivi a uscita multipla, il microfono arriva mescolato ad altri
/// canali o muto. Qui si prende sempre e solo il primo canale del dispositivo di ingresso.
final class MicrophoneCapture {
    /// Dopo quanto segnalare un microfono che invia solo silenzio assoluto (di solito: permesso negato).
    private static let silentCheckSeconds = 6.0

    private let onBuffer: (AVAudioPCMBuffer) -> Void
    private let deviceUID: String?
    private let ioQueue = DispatchQueue(label: "converto.mic.io", qos: .userInitiated)
    private let controlQueue = DispatchQueue(label: "converto.mic.control")
    private var deviceID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var observingInput = false

    /// `deviceUID` nil = microfono predefinito di sistema (e lo segue se cambia).
    init(deviceUID: String? = nil, onBuffer: @escaping (AVAudioPCMBuffer) -> Void) {
        self.deviceUID = deviceUID
        self.onBuffer = onBuffer
    }

    func start() async throws {
        guard await AVCaptureDevice.requestAccess(for: .audio) else {
            throw EngineError(code: "mic_permission_denied",
                              message: "Accesso al microfono negato. Impostazioni di Sistema → Privacy e sicurezza → Microfono → Converto.")
        }
        try controlQueue.sync { try startDevice() }
        if deviceUID == nil, !observingInput {
            observingInput = true
            CoreAudioSupport.onDefaultDeviceChange(kAudioHardwarePropertyDefaultInputDevice, queue: controlQueue) { [weak self] in
                guard let self else { return }
                stopDevice()
                do {
                    try startDevice()
                    Output.emit("notice", ["message": "Microfono cambiato: ascolto riavviato"])
                } catch {
                    Output.error("capture_failed", error.localizedDescription)
                }
            }
        }
    }

    func stop() {
        controlQueue.sync { stopDevice() }
    }

    private func startDevice() throws {
        deviceID = try deviceUID.map(CoreAudioSupport.device(withUID:))
            ?? CoreAudioSupport.defaultDevice(kAudioHardwarePropertyDefaultInputDevice)
        let sampleRate = try CoreAudioSupport.nominalSampleRate(deviceID)
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false) else {
            throw EngineError(code: "capture_failed", message: "Formato del microfono non supportato")
        }

        let onBuffer = self.onBuffer
        let silentCheckFrames = Int(sampleRate * Self.silentCheckSeconds)
        var framesSeen = 0
        var heardSomething = false

        try CoreAudioSupport.check(AudioDeviceCreateIOProcIDWithBlock(&procID, deviceID, ioQueue) { _, input, _, _, _ in
            // Primo buffer = primo flusso di ingresso, Float32 interleaved: si tiene solo il canale 0.
            let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
            guard let first = buffers.first, let data = first.mData else { return }
            let channels = Int(max(first.mNumberChannels, 1))
            let frames = Int(first.mDataByteSize) / (MemoryLayout<Float>.size * channels)
            guard frames > 0,
                  let mono = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
                  let output = mono.floatChannelData?[0] else { return }

            let samples = data.assumingMemoryBound(to: Float.self)
            for frame in 0..<frames {
                output[frame] = samples[frame * channels]
            }
            mono.frameLength = AVAudioFrameCount(frames)

            if !heardSomething, framesSeen < silentCheckFrames {
                heardSomething = (0..<frames).contains { output[$0] != 0 }
                framesSeen += frames
                if !heardSomething, framesSeen >= silentCheckFrames {
                    Output.error("mic_silent",
                                 "Il microfono non invia audio. Controlla che Converto sia attivo in Impostazioni di Sistema → Privacy e sicurezza → Microfono.")
                }
            }
            onBuffer(mono)
        }, "l'avvio del microfono")
        try CoreAudioSupport.check(AudioDeviceStart(deviceID, procID), "l'avvio del microfono")
    }

    private func stopDevice() {
        guard deviceID != kAudioObjectUnknown else { return }
        AudioDeviceStop(deviceID, procID)
        if let procID {
            AudioDeviceDestroyIOProcID(deviceID, procID)
        }
        procID = nil
        deviceID = kAudioObjectUnknown
    }
}
