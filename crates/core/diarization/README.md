# ryu-diarization

Model-neutral speaker diarization primitive for Ryu. It owns the typed request,
the normalized timestamped-speaker-turn contract, validation, and an authenticated
HTTP client for a local diarization runtime. Model implementations stay behind
that contract, so consumers do not depend on pyannote, NeMo, or Transformers APIs.

## Interface

`DiarizationClient::diarize(wav, request)` sends a WAV file and one
`DiarizationModel` (`pyannote` or `nemotron`) to the configured local runtime and
returns normalized `SpeakerTurn { start, end, speaker }` values. Times are seconds;
intervals are half-open. The client sends the Ryu sidecar bearer token, waits up to
ten minutes, and rejects malformed or unbounded responses.

The crate has no dependency on `apps/core`. Hosts provide the runtime URL and
sidecar token at construction. App-specific transcript assignment and participant
labels belong to the consuming app.
