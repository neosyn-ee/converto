import Foundation

/// Protocollo verso Electron: un oggetto JSON per riga su stdout.
enum Output {
    private static let lock = NSLock()

    static func emit(_ type: String, _ fields: [String: Any] = [:]) {
        var payload = fields
        payload["type"] = type
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(data + Data([0x0A]))
    }

    static func status(_ state: String, _ message: String) {
        emit("status", ["state": state, "message": message])
    }

    static func error(_ code: String, _ message: String) {
        emit("error", ["code": code, "message": message])
    }
}

struct EngineError: LocalizedError {
    let code: String
    let message: String

    var errorDescription: String? { message }
}
