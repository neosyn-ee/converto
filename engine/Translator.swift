import Foundation
import Translation

/// Traduzione offline con il framework Translation di macOS.
actor Translator {
    private let session: TranslationSession

    private init(session: TranslationSession) {
        self.session = session
    }

    /// Restituisce nil (dopo aver segnalato il motivo) se la coppia di lingue non è pronta.
    static func make(from source: String, to target: String) async -> Translator? {
        let from = Locale.Language(identifier: source)
        let to = Locale.Language(identifier: target)
        let pair = "\(languageName(source)) → \(languageName(target))"

        switch await LanguageAvailability().status(from: from, to: to) {
        case .installed:
            return Translator(session: TranslationSession(installedSource: from, target: to))
        case .supported:
            Output.error("translation_not_installed",
                         "Lingue di traduzione \(pair) non scaricate. Impostazioni di Sistema → Generali → "
                         + "Lingua e zona → Lingue di traduzione. Intanto mostro solo il testo originale.")
        default:
            Output.error("translation_unsupported",
                         "La traduzione \(pair) non è supportata da macOS. Mostro solo il testo originale.")
        }
        return nil
    }

    func translate(_ text: String) async -> String? {
        try? await session.translate(text).targetText
    }

    private static func languageName(_ code: String) -> String {
        Locale(identifier: "it_IT").localizedString(forLanguageCode: code) ?? code
    }
}
