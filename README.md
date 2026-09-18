# Converto

Sottotitoli tradotti in tempo reale dall'audio del Mac (video, call) o dal microfono.
Tutto in locale: nessun servizio esterno, nessun audio lascia il computer.

## Come funziona

| Fase | Tecnologia | Perché |
|---|---|---|
| Cattura audio | Core Audio process tap (`engine/SystemAudioTap.swift`) | Ascolta l'uscita del Mac senza BlackHole né dispositivi a uscita multipla: le cuffie restano quelle di sistema, con il loro volume |
| Trascrizione | `SpeechAnalyzer` / `SpeechTranscriber` di macOS 26 | Streaming sul Neural Engine: pochi MB di RAM e CPU quasi nulla |
| Traduzione | framework `Translation` di macOS | Offline, stessi pacchetti lingua di Impostazioni di Sistema |
| Interfaccia | Electron + HTML/CSS/JS senza framework | Leggera; il motore Swift è un processo separato che parla JSON su stdout |

Il motore smette di alimentare il riconoscimento durante i silenzi e chiude la frase in corso, così a riposo non consuma.

La traduzione arriva **una sola volta per frase**: appena una frase è conclusa e stabile viene pubblicata e tradotta, senza versioni provvisorie da rileggere. Un rilevatore di voce (`SpeechDetector`) evita di trascrivere musica e rumore, e un filtro scarta ciò che il riconoscimento inventa (solo punteggiatura, parole ripetute a raffica).

## Windows (branch `windows`, in sviluppo)

Su Windows le API Apple non esistono: al posto del motore Swift c'è un **motore portabile** in JavaScript (`src/engines/portable/`).

| Fase | Tecnologia |
|---|---|
| Cattura audio | Nel renderer: audio del PC in loopback (WASAPI, via `getDisplayMedia`) o microfono, portato a 16 kHz da un AudioWorklet |
| Rilevamento voce | Silero VAD |
| Trascrizione | NVIDIA Parakeet v3 (sherpa-onnx), 25 lingue europee. Ogni ~1,5 s decodifica il parlato in corso e pubblica le frasi già concluse |
| Traduzione | Opus-MT (transformers.js), frase per frase; passa dall'inglese se manca il modello diretto |

Riconoscimento e traduzione girano in due `utilityProcess` separati: le due librerie portano versioni diverse di ONNX Runtime, che nello stesso processo andrebbero in conflitto.
Al primo avvio l'app scarica i modelli (circa 800 MB per inglese → italiano) in `%LOCALAPPDATA%\Converto\models`.

**Installer:** a ogni push sul branch `windows` il workflow *Installer Windows* crea `Converto-Setup-<versione>.exe` (GitHub → Actions → ultima esecuzione → Artifacts). L'app non è firmata: al primo avvio SmartScreen chiede conferma (*Ulteriori informazioni → Esegui comunque*).

**Sviluppo su Windows:** Node 20+, poi `npm install`, `npm start`, `npm run dist:win`.

**Prove senza Windows** (anche su Mac):

```bash
npm run try:portable -- audio.wav --target it        # solo motore, da file
npx electron scripts/selftest-portable.js audio.wav  # app completa con microfono finto
CONVERTO_ENGINE=portable npm start                   # app su Mac con il motore portabile
```

## Requisiti (macOS)

- macOS 26 su Apple Silicon, Xcode (per `swiftc`)
- Node 20+
- Pacchetti di traduzione scaricati: Impostazioni di Sistema → Generali → Lingua e zona → Lingue di traduzione

## Comandi

```bash
npm install
npm start              # sviluppo (la cattura dell'audio di sistema funziona solo dall'app installata)
npm run dist           # crea dist/Converto-<versione>-arm64.dmg
npm run install-app    # crea il DMG e installa in /Applications
npm run build:icon     # rigenera build/icon.icns
```

Il motore si può provare da solo:

```bash
engine/build/converto-engine --source en-US --target it --file prova.wav
```

## Permessi

Al primo avvio macOS chiede di consentire la **registrazione dell'audio di sistema**. Se l'hai negato:
Impostazioni di Sistema → Privacy e sicurezza → Registrazione schermo e audio di sistema → Converto.
L'app è firmata ad-hoc: dopo ogni nuova build macOS può chiedere di nuovo il permesso.

## Trascrizioni

Ogni sessione viene salvata in `~/Documents/Converto/` come file Markdown.
