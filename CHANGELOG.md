## [2.1.0](https://github.com/iHaiduk/whisperai/compare/v2.0.0...v2.1.0) (2026-09-09)

### Features

* improve GCS upload resilience, type declarations, and AI docs ([c15b27f](https://github.com/iHaiduk/whisperai/commit/c15b27fe3d4cb91ef74dfa0efc77b098ce04d478))

### Bug Fixes

* **ci:** align conventionalcommits preset with semantic-release ([44322d1](https://github.com/iHaiduk/whisperai/commit/44322d1f26beb8e7bf56d2553ac70e62e9b16548))

## 2.0.0 (2026-06-21)

### Breaking changes

- Replace the removed chunked-upload API with WhisperAI's signed GCS resumable-upload flow.
- Replace `upload()` with `startTranscription()` and add the high-level `transcribe()` workflow.
- Move account, authentication, recordings, analytics, and subscription requests to the current v2 routes.
- Update recording, usage, upload metadata, status, and completed-transcription types.

### Features

- Add resumable 16 MiB range uploads with retry, backoff, offset probes, progress reporting, and cancellation.
- Add status polling with configurable timeout and a completed response type.
- Add optional best-effort upload diagnostics and typed upload, timeout, and transcription errors.

## [1.0.1](https://github.com/iHaiduk/whisperai/compare/v1.0.0...v1.0.1) (2026-01-01)

### Bug Fixes

- **client:** update auth handling and cookie management ([08bd38f](https://github.com/iHaiduk/whisperai/commit/08bd38f78ffd1a3d2ad7a54de1cba3869ffd0998))

## 1.0.0 (2025-12-27)

### Features

- initialize whisperai-sdk project with core functionality ([42a4338](https://github.com/iHaiduk/whisperai/commit/42a43382bed9a90e97acb7bfab68d69b89dffecf))
- **scripts:** add script to update README version ([ef8d18d](https://github.com/iHaiduk/whisperai/commit/ef8d18d9cebf9f058fa87c9f177b8626393cada2))
