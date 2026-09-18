import AVFoundation
import Foundation
import Speech

/// Motore di Converto: cattura audio → trascrizione (SpeechAnalyzer) → traduzione.
/// Riceve la configurazione da riga di comando e comunica con Electron via JSON su stdout.
///
///   converto-engine --source en-US --target it --input system|mic
///   converto-engine --source en-US --target it --file audio.wav [--realtime]
@main
enum Engine {
    private static var captureSource: AnyObject?
    private static var signalSources: [DispatchSourceSignal] = []

    static func main() async {
        let config = Config.parse()
        exitOnSignal()
        if case .file = config.input {} else {
            exitWhenStdinCloses()
        }
        do {
            try await run(config)
            exit(0)
        } catch let error as EngineError {
            Output.error(error.code, error.message)
            exit(1)
        } catch {
            Output.error("engine_failed", error.localizedDescription)
            exit(1)
        }
    }

    private static func run(_ config: Config) async throws {
        Output.status("preparing", "Preparo il riconoscimento vocale…")

        let sourceLanguage = Locale(identifier: config.source).language.languageCode?.identifier ?? config.source
        let translator = sourceLanguage == config.target
            ? nil
            : await Translator.make(from: sourceLanguage, to: config.target)

        guard SpeechTranscriber.isAvailable else {
            throw EngineError(code: "speech_unavailable", message: "Il riconoscimento vocale non è disponibile su questo Mac.")
        }
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: config.source)) else {
            throw EngineError(code: "speech_unsupported", message: "Lingua \(config.source) non supportata dal riconoscimento vocale.")
        }
        let transcriber = SpeechTranscriber(locale: locale,
                                            transcriptionOptions: [],
                                            reportingOptions: [.volatileResults, .fastResults],
                                            attributeOptions: [])
        // Trascrive solo quando c'è voce: niente testo inventato su musica o rumore, e meno consumi.
        let detector = SpeechDetector(detectionOptions: .init(sensitivityLevel: .medium), reportResults: false)
        let modules: [any SpeechModule] = [detector, transcriber]
        try await installSpeechAssets(for: modules)

        let analyzer = SpeechAnalyzer(modules: modules)
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules) else {
            throw EngineError(code: "speech_unavailable", message: "Nessun formato audio compatibile con il riconoscimento vocale.")
        }
        try await analyzer.prepareToAnalyze(in: format)

        let (inputs, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        let captions = Captions(translator: translator)
        let results = Task { try await captions.consume(transcriber.results) }
        try await analyzer.start(inputSequence: inputs)

        let feeder = AudioFeeder(format: format, continuation: continuation) {
            Task { try? await analyzer.finalize(through: nil) }
        }

        switch config.input {
        case .file(let path):
            try await feed(file: path, into: feeder, realtime: config.realtime)
            continuation.finish()
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            try await results.value
            return
        case .microphone:
            let microphone = MicrophoneCapture(onBuffer: feeder.feed)
            try await microphone.start()
            captureSource = microphone
        case .system:
            try await ensureAudioCapturePermission()
            let tap = SystemAudioTap(onBuffer: feeder.feed)
            try tap.start()
            captureSource = tap
        }

        Output.status("listening", "In ascolto")
        try await results.value
    }

    private static func installSpeechAssets(for modules: [any SpeechModule]) async throws {
        guard await AssetInventory.status(forModules: modules) != .installed,
              let request = try await AssetInventory.assetInstallationRequest(supporting: modules) else { return }
        Output.status("downloading", "Scarico il modello vocale (solo la prima volta)…")
        let observation = request.progress.observe(\.fractionCompleted) { progress, _ in
            Output.emit("progress", ["value": progress.fractionCompleted])
        }
        defer { observation.invalidate() }
        try await request.downloadAndInstall()
    }

    private static func ensureAudioCapturePermission() async throws {
        let denied = EngineError(code: "permission_denied",
                                 message: "Converto non ha il permesso di ascoltare l'audio del Mac.")
        switch AudioCapturePermission.state() {
        case .authorized:
            return
        case .denied:
            throw denied
        case .unknown:
            Output.status("permission", "Consenti a Converto di registrare l'audio del Mac")
            guard await AudioCapturePermission.request() else { throw denied }
        }
    }

    /// Con `realtime` il file viene letto alla velocità di riproduzione, come una call vera.
    private static func feed(file path: String, into feeder: AudioFeeder, realtime: Bool) async throws {
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
        while file.framePosition < file.length {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 4800) else { break }
            try file.read(into: buffer)
            if buffer.frameLength == 0 { break }
            feeder.feed(buffer)
            if realtime {
                try await Task.sleep(for: .seconds(Double(buffer.frameLength) / buffer.format.sampleRate))
            }
        }
    }

    /// Electron chiude il motore con SIGTERM.
    private static func exitOnSignal() {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .global())
            source.setEventHandler { shutdown() }
            source.resume()
            signalSources.append(source)
        }
    }

    /// Se Electron termina in modo anomalo si chiude stdin: il motore non deve restare attivo.
    private static func exitWhenStdinCloses() {
        Thread.detachNewThread {
            while readLine() != nil {}
            shutdown()
        }
    }

    private static func shutdown() {
        (captureSource as? SystemAudioTap)?.stop()
        (captureSource as? MicrophoneCapture)?.stop()
        exit(0)
    }
}

struct Config {
    enum Input {
        case system, microphone, file(String)
    }

    var source = "en-US"
    var target = "it"
    var input = Input.system
    var realtime = false

    static func parse() -> Config {
        var config = Config()
        var arguments = CommandLine.arguments.dropFirst().makeIterator()
        while let argument = arguments.next() {
            switch argument {
            case "--source": config.source = arguments.next() ?? config.source
            case "--target": config.target = arguments.next() ?? config.target
            case "--input": config.input = arguments.next() == "mic" ? .microphone : .system
            case "--file": config.input = .file(arguments.next() ?? "")
            case "--realtime": config.realtime = true
            default: break
            }
        }
        return config
    }
}

/// Trasforma i risultati del riconoscimento in eventi per l'interfaccia:
/// `partial` (testo originale ancora in corso) e `final` (frase chiusa, tradotta una sola volta).
///
/// Il riconoscimento chiude un risultato solo alle pause di chi parla. Per non far aspettare
/// (né rileggere la stessa frase in più versioni), appena il testo provvisorio contiene una frase
/// conclusa e ormai stabile la si pubblica subito; quando arriva il risultato definitivo si
/// pubblica solo la parte non ancora mostrata.
actor Captions {
    /// Parole che devono seguire una frase perché la si consideri stabile.
    private static let wordsAfterBreak = 3
    /// Periodi senza punto fermo: oltre questa lunghezza si chiude alla virgola…
    private static let clauseBreakLength = 200
    /// …e oltre questa a un confine di parola.
    private static let forcedBreakLength = 280
    private static let anchorLength = 3

    private let translator: Translator?
    private var segment = 0
    /// Parole del risultato corrente già pubblicate e le ultime di esse, per ritrovare il punto di ripresa.
    private var publishedWords = 0
    private var anchor: [String] = []

    init(translator: Translator?) {
        self.translator = translator
    }

    func consume<Results: AsyncSequence>(_ results: Results) async throws where Results.Element == SpeechTranscriber.Result {
        for try await result in results {
            let text = TextCleaner.clean(String(result.text.characters)) ?? ""
            let words = text.split(whereSeparator: \.isWhitespace).map(String.init)
            var pending = Array(words[resumeIndex(in: words)...])

            if result.isFinal {
                publishedWords = 0
                anchor = []
                await publish(pending)
                continue
            }

            if let cut = Self.breakIndex(in: pending) {
                await publish(Array(pending[..<cut]))
                publishedWords = words.count - (pending.count - cut)
                anchor = Array(pending[..<cut].suffix(Self.anchorLength)).map(TextCleaner.normalized)
                pending.removeFirst(cut)
            }
            if !pending.isEmpty {
                Output.emit("partial", ["id": segment, "text": pending.joined(separator: " ")])
            }
        }
    }

    private func publish(_ words: [String]) async {
        guard let text = TextCleaner.clean(words.joined(separator: " ")) else { return }
        let translation = await translator?.translate(text)
        Output.emit("final", ["id": segment, "text": text, "translation": translation ?? NSNull()])
        segment += 1
    }

    /// Posizione da cui riprendere nel testo del risultato corrente, dopo la parte già pubblicata.
    /// Il riconoscimento può ritoccare le parole precedenti: ci si allinea sulle ultime pubblicate.
    private func resumeIndex(in words: [String]) -> Int {
        guard publishedWords > 0 else { return 0 }
        let normalized = words.map(TextCleaner.normalized)
        var best: Int?
        if !anchor.isEmpty, normalized.count >= anchor.count {
            for start in 0...(normalized.count - anchor.count) where Array(normalized[start..<start + anchor.count]) == anchor {
                let end = start + anchor.count
                if best.map({ abs($0 - publishedWords) > abs(end - publishedWords) }) ?? true {
                    best = end
                }
            }
        }
        return min(best ?? publishedWords, words.count)
    }

    /// Indice (escluso) fino a cui il testo provvisorio contiene frasi concluse e stabili.
    private static func breakIndex(in words: [String]) -> Int? {
        func lastIndex(endingWith marks: String) -> Int? {
            guard words.count > wordsAfterBreak else { return nil }
            return words[..<(words.count - wordsAfterBreak)].lastIndex { word in
                word.last.map { marks.contains($0) } ?? false
            }
        }
        let length = words.reduce(0) { $0 + $1.count + 1 }
        if let sentence = lastIndex(endingWith: ".?!") {
            return sentence + 1
        }
        if length > clauseBreakLength, let clause = lastIndex(endingWith: ",;:") {
            return clause + 1
        }
        if length > forcedBreakLength {
            return words.count - wordsAfterBreak - 1
        }
        return nil
    }
}

/// Ripulisce ciò che il riconoscimento produce su musica, applausi o rumore.
enum TextCleaner {
    private static let minRepeatedRun = 4

    static func clean(_ raw: String) -> String? {
        let text = raw.replacingOccurrences(of: #"[.,]{4,}"#, with: "…", options: .regularExpression)
        let tokens = text.split(whereSeparator: \.isWhitespace).map(String.init)
            .filter { $0.contains(where: { $0.isLetter || $0.isNumber }) }

        // "yeah, yeah, yeah, yeah…": una parola ripetuta a raffica non è parlato reale
        var kept: [String] = []
        var index = 0
        while index < tokens.count {
            let key = normalized(tokens[index])
            var next = index + 1
            while next < tokens.count, normalized(tokens[next]) == key {
                next += 1
            }
            if next - index < minRepeatedRun {
                kept.append(contentsOf: tokens[index..<next])
            }
            index = next
        }

        let cleaned = kept.joined(separator: " ")
        return cleaned.filter(\.isLetter).count >= 2 ? cleaned : nil
    }

    static func normalized(_ token: String) -> String {
        token.lowercased().filter { $0.isLetter || $0.isNumber }
    }
}
