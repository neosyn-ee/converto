import CoreAudio

/// Piccole utilità comuni per le API Core Audio in C.
enum CoreAudioSupport {
    static func address(_ selector: AudioObjectPropertySelector,
                        scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    static func check(_ status: OSStatus, _ step: String) throws {
        guard status == noErr else {
            throw EngineError(code: "capture_failed", message: "Errore Core Audio durante \(step) (codice \(status))")
        }
    }

    /// Dispositivo predefinito di sistema (`kAudioHardwarePropertyDefaultInputDevice` / `…OutputDevice`).
    static func defaultDevice(_ selector: AudioObjectPropertySelector) throws -> AudioObjectID {
        var address = address(selector)
        var deviceID = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID),
                  "la lettura del dispositivo audio")
        guard deviceID != kAudioObjectUnknown else {
            throw EngineError(code: "capture_failed", message: "Nessun dispositivo audio disponibile")
        }
        return deviceID
    }

    static func deviceUID(_ deviceID: AudioObjectID) throws -> String {
        var address = address(kAudioDevicePropertyDeviceUID)
        var uid: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        try check(AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &uid), "la lettura del dispositivo audio")
        guard let uid = uid?.takeRetainedValue() else {
            throw EngineError(code: "capture_failed", message: "Dispositivo audio senza identificativo")
        }
        return uid as String
    }

    /// Dispositivo con l'UID indicato (per scegliere un ingresso diverso da quello di sistema).
    static func device(withUID uid: String) throws -> AudioObjectID {
        var address = address(kAudioHardwarePropertyTranslateUIDToDevice)
        var deviceID = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var cfUID = uid as CFString
        try check(withUnsafeMutablePointer(to: &cfUID) { uidPointer in
            AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address,
                                       UInt32(MemoryLayout<CFString>.size), uidPointer, &size, &deviceID)
        }, "la ricerca del dispositivo \(uid)")
        guard deviceID != kAudioObjectUnknown else {
            throw EngineError(code: "capture_failed", message: "Dispositivo audio \(uid) non trovato")
        }
        return deviceID
    }

    static func nominalSampleRate(_ deviceID: AudioObjectID) throws -> Double {
        var address = address(kAudioDevicePropertyNominalSampleRate)
        var rate = Float64(0)
        var size = UInt32(MemoryLayout<Float64>.size)
        try check(AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &rate), "la lettura della frequenza audio")
        return rate
    }

    /// Esegue `handler` sulla coda indicata quando cambia il dispositivo predefinito.
    static func onDefaultDeviceChange(_ selector: AudioObjectPropertySelector, queue: DispatchQueue,
                                      _ handler: @escaping () -> Void) {
        var address = address(selector)
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, queue) { _, _ in
            handler()
        }
    }
}
