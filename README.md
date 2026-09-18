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

## Requisiti

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
