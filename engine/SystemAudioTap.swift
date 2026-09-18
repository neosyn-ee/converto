import AVFoundation
import CoreAudio

/// Cattura l'audio in uscita dal Mac con un Core Audio process tap.
/// Non cambia il dispositivo di uscita: le cuffie restano quelle di sistema, con il loro volume.
final class SystemAudioTap {
    private let onBuffer: (AVAudioPCMBuffer) -> Void
    private let ioQueue = DispatchQueue(label: "converto.tap.io", qos: .userInitiated)
    private let controlQueue = DispatchQueue(label: "converto.tap.control")
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var observingOutput = false

    init(onBuffer: @escaping (AVAudioPCMBuffer) -> Void) {
        self.onBuffer = onBuffer
    }

    func start() throws {
        try controlQueue.sync { try createTap() }
        if !observingOutput {
            observeOutputDeviceChanges()
            observingOutput = true
        }
    }

    func stop() {
        controlQueue.sync { destroyTap() }
    }

    private func createTap() throws {
        let description = CATapDescription(monoGlobalTapButExcludeProcesses: [])
        description.uuid = UUID()
        description.name = "Converto"
        description.isPrivate = true
        description.muteBehavior = .unmuted
        try CoreAudioSupport.check(AudioHardwareCreateProcessTap(description, &tapID), "la creazione del tap audio")

        var streamDescription = try tapStreamDescription()
        guard let format = AVAudioFormat(streamDescription: &streamDescription) else {
            throw EngineError(code: "capture_failed", message: "Formato audio del tap non supportato")
        }

        let outputUID = try CoreAudioSupport.deviceUID(CoreAudioSupport.defaultDevice(kAudioHardwarePropertyDefaultOutputDevice))
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Converto",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: description.uuid.uuidString,
            ]],
        ]
        try CoreAudioSupport.check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID),
                                   "la creazione del dispositivo di cattura")

        let onBuffer = self.onBuffer
        try CoreAudioSupport.check(AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, ioQueue) { _, input, _, _, _ in
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: input, deallocator: nil) else { return }
            onBuffer(buffer)
        }, "l'avvio della cattura")
        try CoreAudioSupport.check(AudioDeviceStart(aggregateID, procID), "l'avvio della cattura")
    }

    private func destroyTap() {
        if aggregateID != kAudioObjectUnknown {
            AudioDeviceStop(aggregateID, procID)
            if let procID {
                AudioDeviceDestroyIOProcID(aggregateID, procID)
            }
            AudioHardwareDestroyAggregateDevice(aggregateID)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
        }
        procID = nil
        aggregateID = kAudioObjectUnknown
        tapID = kAudioObjectUnknown
    }

    /// Cuffie scollegate, AirPods collegate, ecc.: il tap va ricreato sul nuovo dispositivo.
    private func observeOutputDeviceChanges() {
        CoreAudioSupport.onDefaultDeviceChange(kAudioHardwarePropertyDefaultOutputDevice, queue: controlQueue) { [weak self] in
            guard let self else { return }
            destroyTap()
            do {
                try createTap()
                Output.emit("notice", ["message": "Uscita audio cambiata: cattura riavviata"])
            } catch {
                Output.error("capture_failed", error.localizedDescription)
            }
        }
    }

    private func tapStreamDescription() throws -> AudioStreamBasicDescription {
        var address = CoreAudioSupport.address(kAudioTapPropertyFormat)
        var description = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try CoreAudioSupport.check(AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &description),
                                   "la lettura del formato audio")
        return description
    }
}
