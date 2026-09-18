import AVFoundation
import Foundation
import Speech

/// Motore di Converto: cattura audio → trascrizione (SpeechAnalyzer) → traduzione.
/// Riceve la configurazione da riga di comando e comunica con Electron via JSON su stdout.
/// Ogni messaggio porta il flusso: "others" = audio del Mac, "me" = microfono.
///
///   converto-engine --source en-US --target it|none --input system|mic|both [--mic <UID dispositivo>]
///   converto-engine --source en-US --target it --file audio.wav [--stream me] [--realtime]
///   converto-engine --mic-file io.wav --system-file altri.wav   (prova di "Io + altri", in tempo reale)
@main
enum Engine {
    private static var captureSources: [AnyObject] = []
    private static var signalSources: [DispatchSourceSignal] = []

    static func main() async {
        let config = Config.parse()
        exitOnSignal()
        if !config.input.isFiles {
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
        let transcribeOnly = config.target == Config.noTranslation || config.target == sourceLanguage
        let translator = transcribeOnly ? nil : await Translator.make(from: sourceLanguage, to: config.target)

        guard SpeechTranscriber.isAvailable else {
            throw EngineError(code: "speech_unavailable", message: "Il riconoscimento vocale non è disponibile su questo Mac.")
        }
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: config.source)) else {
            throw EngineError(code: "speech_unsupported", message: "Lingua \(config.source) non supportata dal riconoscimento vocale.")
        }
        try await installSpeechAssets(for: Pipeline.modules(locale: locale))

        var pipelines: [String: Pipeline] = [:]
        for stream in config.input.streams {
            pipelines[stream] = try await Pipeline.make(stream: stream, locale: locale, translator: translator)
        }
        let others = pipelines["others"]
        let me = pipelines["me"]
        // Con entrambi i flussi, l'audio del Mac fa da riferimento per togliere l'eco dal microfono.
        let echoGate = others != nil && me != nil ? EchoGate() : nil
        let onSystemAudio: (AVAudioPCMBuffer) -> Void = { buffer in
            echoGate?.observeReference(buffer)
            others?.feeder.feed(buffer)
        }
        let onMicrophone: (AVAudioPCMBuffer) -> Void = { buffer in
            guard let me else { return }
            if let echoGate {
                echoGate.process(buffer, emit: me.feeder.feed)
            } else {
                me.feeder.feed(buffer)
            }
        }

        switch config.input {
        case .file(let path, _):
            let pipeline = me ?? others!
            try await feed(file: path, realtime: config.realtime, into: pipeline.feeder.feed)
            try await pipeline.finish()
            return
        case .files(let micPath, let systemPath):
            async let system: Void = feed(file: systemPath, realtime: true, into: onSystemAudio)
            async let microphone: Void = feed(file: micPath, realtime: true, into: onMicrophone)
            _ = try await (system, microphone)
            for pipeline in pipelines.values {
                try await pipeline.finish()
            }
            return
        case .system, .microphone, .both:
            if others != nil {
                try await ensureAudioCapturePermission()
                let tap = SystemAudioTap(onBuffer: onSystemAudio)
                try tap.start()
                captureSources.append(tap)
            }
            if me != nil {
                let microphone = MicrophoneCapture(deviceUID: config.microphoneUID, onBuffer: onMicrophone)
                try await microphone.start()
                captureSources.append(microphone)
            }
        }

        Output.status("listening", "In ascolto")
        // Se un flusso si interrompe, il motore esce e Electron lo riavvia.
        try await withThrowingTaskGroup(of: Void.self) { group in
            for pipeline in pipelines.values {
                group.addTask { try await pipeline.results.value }
            }
            try await group.next()
        }
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
    private static func feed(file path: String, realtime: Bool, into feed: (AVAudioPCMBuffer) -> Void) async throws {
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
        while file.framePosition < file.length {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 4800) else { break }
            try file.read(into: buffer)
            if buffer.frameLength == 0 { break }
            feed(buffer)
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
        for source in captureSources {
            (source as? SystemAudioTap)?.stop()
            (source as? MicrophoneCapture)?.stop()
        }
        exit(0)
    }
}

struct Config {
    /// `--target none`: solo trascrizione, senza traduzione.
    static let noTranslation = "none"

    enum Input {
        case system, microphone, both
        case file(String, stream: String)
        case files(microphone: String, system: String)

        var streams: [String] {
            switch self {
            case .system: ["others"]
            case .microphone: ["me"]
            case .both, .files: ["me", "others"]
            case .file(_, let stream): [stream]
            }
        }

        var isFiles: Bool {
            switch self {
            case .file, .files: true
            default: false
            }
        }
    }

    var source = "en-US"
    var target = "it"
    var input = Input.system
    var microphoneUID: String?
    var realtime = false

    static func parse() -> Config {
        var config = Config()
        var file: String?
        var fileStream = "others"
        var micFile: String?
        var systemFile: String?
        var arguments = CommandLine.arguments.dropFirst().makeIterator()
        while let argument = arguments.next() {
            switch argument {
            case "--source": config.source = arguments.next() ?? config.source
            case "--target": config.target = arguments.next() ?? config.target
            case "--input":
                switch arguments.next() {
                case "mic": config.input = .microphone
                case "both": config.input = .both
                default: config.input = .system
                }
            case "--file": file = arguments.next()
            case "--stream": fileStream = arguments.next() ?? fileStream
            case "--mic-file": micFile = arguments.next()
            case "--system-file": systemFile = arguments.next()
            case "--realtime": config.realtime = true
            case "--mic": config.microphoneUID = arguments.next()
            default: break
            }
        }
        if let micFile, let systemFile {
            config.input = .files(microphone: micFile, system: systemFile)
        } else if let file {
            config.input = .file(file, stream: fileStream)
        }
        return config
    }
}

/// Riconoscimento (e traduzione) di un flusso audio: analizzatore, sottotitoli e alimentazione.
final class Pipeline {
    let feeder: AudioFeeder
    let results: Task<Void, Error>
    private let analyzer: SpeechAnalyzer
    private let captions: Captions
    private let continuation: AsyncStream<AnalyzerInput>.Continuation

    private init(feeder: AudioFeeder, results: Task<Void, Error>, analyzer: SpeechAnalyzer, captions: Captions,
                 continuation: AsyncStream<AnalyzerInput>.Continuation) {
        self.feeder = feeder
        self.results = results
        self.analyzer = analyzer
        self.captions = captions
        self.continuation = continuation
    }

    static func modules(locale: Locale) -> [any SpeechModule] {
        let transcriber = SpeechTranscriber(locale: locale,
                                            transcriptionOptions: [],
                                            reportingOptions: [.volatileResults, .fastResults],
                                            attributeOptions: [])
        // Trascrive solo quando c'è voce: niente testo inventato su musica o rumore, e meno consumi.
        let detector = SpeechDetector(detectionOptions: .init(sensitivityLevel: .medium), reportResults: false)
        return [detector, transcriber]
    }

    static func make(stream: String, locale: Locale, translator: Translator?) async throws -> Pipeline {
        let modules = modules(locale: locale)
        let transcriber = modules.compactMap { $0 as? SpeechTranscriber }[0]
        let analyzer = SpeechAnalyzer(modules: modules)
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules) else {
            throw EngineError(code: "speech_unavailable", message: "Nessun formato audio compatibile con il riconoscimento vocale.")
        }
        try await analyzer.prepareToAnalyze(in: format)

        let (inputs, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        let captions = Captions(stream: stream, translator: translator)
        let results = Task { try await captions.consume(transcriber.results) }
        try await analyzer.start(inputSequence: inputs)

        // Alla pausa si chiude subito la frase in corso, ma solo se ce n'è una: chiedere di chiudere
        // quando è arrivato solo rumore fa rifiutare la sessione al riconoscimento (RecogRejected).
        let feeder = AudioFeeder(stream: stream, format: format, continuation: continuation) {
            Task {
                if await captions.hasVolatileResult {
                    try? await analyzer.finalize(through: nil)
                }
            }
        }
        return Pipeline(feeder: feeder, results: results, analyzer: analyzer, captions: captions, continuation: continuation)
    }

    /// Fine dell'audio (file): chiude l'ultima frase e attende gli ultimi risultati.
    func finish() async throws {
        continuation.finish()
        if await captions.hasVolatileResult {
            try await analyzer.finalizeAndFinishThroughEndOfInput()
        } else {
            await analyzer.cancelAndFinishNow() // niente parlato da chiudere
        }
        do {
            try await results.value
        } catch is CancellationError {}
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

    private let stream: String
    private let translator: Translator?
    private var segment = 0
    /// Parole del risultato corrente già pubblicate e le ultime di esse, per ritrovare il punto di ripresa.
    private var publishedWords = 0
    private var anchor: [String] = []
    /// C'è un risultato provvisorio non ancora chiuso dal riconoscimento?
    private(set) var hasVolatileResult = false

    init(stream: String, translator: Translator?) {
        self.stream = stream
        self.translator = translator
    }

    func consume<Results: AsyncSequence>(_ results: Results) async throws where Results.Element == SpeechTranscriber.Result {
        for try await result in results {
            let text = TextCleaner.clean(String(result.text.characters)) ?? ""
            let words = text.split(whereSeparator: \.isWhitespace).map(String.init)
            var pending = Array(words[resumeIndex(in: words)...])

            hasVolatileResult = !result.isFinal
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
                Output.emit("partial", ["stream": stream, "id": segment, "text": pending.joined(separator: " ")])
            }
        }
    }

    private func publish(_ words: [String]) async {
        guard let text = TextCleaner.clean(words.joined(separator: " ")) else { return }
        let translation = await translator?.translate(text)
        Output.emit("final", ["stream": stream, "id": segment, "text": text, "translation": translation ?? NSNull()])
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
