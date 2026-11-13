<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="128" alt="Wolfbud icon" />
</p>

<h1 align="center">Wolfbud</h1>

<p align="center">
  Speech-to-text and text-to-speech, one hotkey away.
</p>

---

Wolfbud is a macOS menubar app that gives you **speech-to-text** and **text-to-speech** from anywhere on your Mac. It uses the [ElevenLabs](https://elevenlabs.io) Scribe v3 Live model for transcription, through your own API key.

- **Speech-to-Text** — Press **⌘ Shift Space** to start recording, speak, then press **⌘ Shift Space** again to stop. The transcript is pasted directly into the active app using the ElevenLabs Scribe v3 Live API. As you speak, names, tools, file names, sections and other key terms are highlighted inline and collected as chips, and those annotations are kept in your history.
- **Text-to-Speech** — Copy any text to your clipboard and have it read aloud using ElevenLabs voices.

<p align="center">
  <img src="docs/screenshot.png" width="600" alt="Wolfbud overlay showing live transcription while a YouTube video plays" />
</p>

- Floating overlay shows live transcription as you speak
- Automatically ducks system volume while recording
- Runs silently in the menu bar, always one shortcut away
- Requires an [ElevenLabs API key](https://elevenlabs.io/app/settings/api-keys)

> [!NOTE]
> **Not affiliated with ElevenLabs.** Wolfbud is an independent, personal side project. It is **not** affiliated with, endorsed by, or sponsored by ElevenLabs. It simply calls the ElevenLabs Scribe v3 Live model using an API key you provide. "ElevenLabs" and "Scribe" are trademarks of ElevenLabs.

## Install from Releases

1. Go to the [Releases](../../releases) page and download the latest `.dmg`
2. Open the `.dmg`, drag **Wolfbud** to your Applications folder
3. Launch the app and enter your ElevenLabs API key when prompted
4. Grant **Accessibility** and **Microphone** permissions if macOS asks

## Build Locally

**Prerequisites:** [Rust](https://rustup.rs), [Node.js](https://nodejs.org), [pnpm](https://pnpm.io)

```bash
git clone https://github.com/leopiney/wolfbud
cd wolfbud
pnpm install
pnpm tauri build
```

The `.dmg` will be at `src-tauri/target/release/bundle/dmg/`.

For development with hot-reload:

```bash
pnpm tauri dev
```

## Related

[Epicenter](https://github.com/EpicenterHQ/epicenter) — a more fully-featured ElevenLabs dictation app with more configuration options, if you need something beyond what Wolfbud offers.

## Contributing

Commits must follow the [Conventional Commits](https://www.conventionalcommits.org) format — this is enforced by a commit-msg hook and drives automatic versioning:

| Prefix                       | Example                        | Version bump          |
| ---------------------------- | ------------------------------ | --------------------- |
| `feat:`                      | `feat: add paste on stop`      | minor `0.1.0 → 0.2.0` |
| `fix:`                       | `fix: restore volume on crash` | patch `0.1.0 → 0.1.1` |
| `feat!:`                     | `feat!: redesign overlay API`  | major `0.1.0 → 1.0.0` |
| `chore:` `docs:` `refactor:` | `chore: update deps`           | no bump               |

When a versioned commit is merged to `main`, a Release PR is opened automatically. Merging it tags the release and triggers the macOS build.

## License

[MIT](LICENSE) © Leonardo Piñeyro
