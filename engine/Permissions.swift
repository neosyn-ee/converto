import Foundation

/// Permesso "Registrazione audio di sistema" (servizio TCC kTCCServiceAudioCapture).
/// Non esiste un'API pubblica per verificarlo: si interroga TCC via dlopen,
/// come fanno le app che usano i Core Audio process tap.
enum AudioCapturePermission {
    enum State { case authorized, denied, unknown }

    private typealias PreflightFn = @convention(c) (CFString, CFDictionary?) -> Int
    private typealias RequestFn = @convention(c) (CFString, CFDictionary?, @escaping @convention(block) (Bool) -> Void) -> Void

    private static let service = "kTCCServiceAudioCapture" as CFString
    private static let tcc = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW)

    static func state() -> State {
        guard let symbol = dlsym(tcc, "TCCAccessPreflight") else { return .unknown }
        switch unsafeBitCast(symbol, to: PreflightFn.self)(service, nil) {
        case 0: return .authorized
        case 1: return .denied
        default: return .unknown
        }
    }

    /// Mostra la richiesta di sistema; restituisce true se l'utente consente.
    static func request() async -> Bool {
        guard let symbol = dlsym(tcc, "TCCAccessRequest") else { return true }
        return await withCheckedContinuation { continuation in
            unsafeBitCast(symbol, to: RequestFn.self)(service, nil) { granted in
                continuation.resume(returning: granted)
            }
        }
    }
}
