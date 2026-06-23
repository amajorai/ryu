//! Meeting recorder — device-local audio capture for the meeting-notes feature.
//!
//! Granola-style meeting notes need **both** sides of a call: your microphone
//! AND the system audio (the other participants, played through your speakers).
//! cpal's WASAPI backend captures system audio transparently when you build an
//! *input* stream on an *output* (render) device — that is loopback capture. So
//! this recorder runs two cpal input streams:
//!   - the default **input** device (microphone), and
//!   - the default **output** device (system loopback — Windows only; elsewhere
//!     it degrades to mic-only).
//!
//! Both are downmixed to mono, accumulated, and every [`CHUNK_SECS`] a background
//! task resamples each to 16 kHz, mixes them, encodes a WAV, and POSTs it to
//! Core's `POST /api/meetings/:id/chunk`. Core owns everything downstream
//! (transcription, notes); this is pure device-local plumbing — the "sensor"
//! half of the Core-vs-sensor split.
//!
//! Lifecycle is a process-global (mirroring `server.rs`'s capture-control flags)
//! so the `/meeting/start` + `/meeting/stop` HTTP handlers reach it without
//! threading new fields through `AppState`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::Stream;

/// How often a mixed WAV chunk is cut and uploaded. ~20 s balances transcription
/// latency (notes feel live) against per-request overhead.
const CHUNK_SECS: u64 = 20;

/// The 16 kHz mono target whisper/parakeet expect.
const TARGET_RATE: u32 = 16_000;

/// One source's rolling mono sample buffer plus the rate it was captured at.
struct SourceBuffer {
    samples: Mutex<Vec<f32>>,
    rate: u32,
}

impl SourceBuffer {
    fn new(rate: u32) -> Arc<Self> {
        Arc::new(Self {
            samples: Mutex::new(Vec::new()),
            rate,
        })
    }

    fn drain(&self) -> (Vec<f32>, u32) {
        let mut guard = self.samples.lock().unwrap_or_else(|e| e.into_inner());
        (std::mem::take(&mut *guard), self.rate)
    }
}

/// An active meeting recording: the live cpal streams (kept alive so capture
/// continues) and the running flag the uploader task watches.
pub struct MeetingRecorder {
    meeting_id: String,
    _mic_stream: Option<Stream>,
    _loopback_stream: Option<Stream>,
    running: Arc<AtomicBool>,
}

// cpal `Stream` holds a non-Send callback. We only ever touch the streams from
// the handler thread (build on start, drop on stop) and never send them across
// threads, so this is sound — same justification as `PlatformAudioCapture`.
unsafe impl Send for MeetingRecorder {}
unsafe impl Sync for MeetingRecorder {}

static RECORDER: OnceLock<Mutex<Option<MeetingRecorder>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<MeetingRecorder>> {
    RECORDER.get_or_init(|| Mutex::new(None))
}

/// Whether a meeting is currently being recorded.
pub fn is_recording() -> bool {
    slot().lock().map(|g| g.is_some()).unwrap_or(false)
}

/// The id of the meeting currently recording, if any.
pub fn current_meeting_id() -> Option<String> {
    slot()
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|r| r.meeting_id.clone()))
}

/// Start recording `meeting_id`, uploading mixed 16 kHz WAV chunks to `ingest_url`
/// (Core's `/api/meetings/:id/chunk`). Replaces any in-progress recording.
///
/// Mic capture is required; loopback (system audio) is best-effort — on platforms
/// where building an input stream on the output device isn't loopback, the meeting
/// records mic-only with a logged warning.
pub fn start(meeting_id: String, ingest_url: String) -> anyhow::Result<()> {
    stop(); // tear down any prior recording first

    let host = cpal::default_host();
    let running = Arc::new(AtomicBool::new(true));

    // --- microphone (required) ---------------------------------------------
    let mic_device = host
        .default_input_device()
        .ok_or_else(|| anyhow::anyhow!("no microphone input device available"))?;
    let mic_cfg = mic_device
        .default_input_config()
        .map_err(|e| anyhow::anyhow!("no default input config: {e}"))?;
    let mic_buf = SourceBuffer::new(mic_cfg.sample_rate().0);
    let mic_stream = build_capture_stream(&mic_device, &mic_cfg, Arc::clone(&mic_buf))
        .map_err(|e| anyhow::anyhow!("failed to start microphone capture: {e}"))?;
    mic_stream
        .play()
        .map_err(|e| anyhow::anyhow!("failed to play microphone stream: {e}"))?;

    // --- system loopback (best-effort) -------------------------------------
    let (loopback_stream, loopback_buf) = match build_loopback(&host) {
        Ok((stream, buf)) => {
            tracing::info!("meeting recorder: system-audio loopback active");
            (Some(stream), Some(buf))
        }
        Err(e) => {
            tracing::warn!(
                "meeting recorder: loopback capture unavailable ({e}); recording microphone only"
            );
            (None, None)
        }
    };

    // --- chunk uploader -----------------------------------------------------
    let task_running = Arc::clone(&running);
    let client = reqwest::Client::new();
    let mid = meeting_id.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(CHUNK_SECS));
        ticker.tick().await; // the first tick fires immediately; skip it
        while task_running.load(Ordering::Relaxed) {
            ticker.tick().await;
            if !task_running.load(Ordering::Relaxed) {
                break;
            }
            let (mic_samples, mic_rate) = mic_buf.drain();
            let (loop_samples, loop_rate) = match &loopback_buf {
                Some(b) => b.drain(),
                None => (Vec::new(), TARGET_RATE),
            };
            if mic_samples.is_empty() && loop_samples.is_empty() {
                continue;
            }
            let mixed = mix_to_16k(&mic_samples, mic_rate, &loop_samples, loop_rate);
            let wav = match encode_wav_16k_mono(&mixed) {
                Ok(w) => w,
                Err(e) => {
                    tracing::warn!("meeting recorder: WAV encode failed: {e}");
                    continue;
                }
            };
            upload_chunk(&client, &ingest_url, wav, &mid).await;
        }
        tracing::info!("meeting recorder: uploader task for {mid} stopped");
    });

    let recorder = MeetingRecorder {
        meeting_id,
        _mic_stream: Some(mic_stream),
        _loopback_stream: loopback_stream,
        running,
    };
    if let Ok(mut guard) = slot().lock() {
        *guard = Some(recorder);
    }
    Ok(())
}

/// Stop the current recording (if any), tearing down streams + the uploader task.
pub fn stop() {
    if let Ok(mut guard) = slot().lock() {
        if let Some(rec) = guard.take() {
            rec.running.store(false, Ordering::Relaxed);
            tracing::info!("meeting recorder: stopped {}", rec.meeting_id);
            // Streams drop here, halting capture.
        }
    }
}

/// Build a loopback capture on the default output device (Windows: WASAPI
/// loopback). Returns the stream (already playing) + its buffer.
fn build_loopback(host: &cpal::Host) -> anyhow::Result<(Stream, Arc<SourceBuffer>)> {
    let out_device = host
        .default_output_device()
        .ok_or_else(|| anyhow::anyhow!("no default output device"))?;
    // For a render device, cpal derives the loopback format from the output
    // config; building an *input* stream on it enables loopback.
    let out_cfg = out_device
        .default_output_config()
        .map_err(|e| anyhow::anyhow!("no default output config: {e}"))?;
    let buf = SourceBuffer::new(out_cfg.sample_rate().0);
    let stream = build_capture_stream(&out_device, &out_cfg, Arc::clone(&buf))?;
    stream.play()?;
    Ok((stream, buf))
}

/// Build an input (capture) stream on `device` that downmixes every frame to mono
/// and appends it to `buf`. Works for both a capture device (mic) and a render
/// device (loopback).
fn build_capture_stream(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    buf: Arc<SourceBuffer>,
) -> anyhow::Result<Stream> {
    let channels = config.channels().max(1) as usize;
    let stream = device
        .build_input_stream(
            &config.clone().into(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if let Ok(mut samples) = buf.samples.lock() {
                    // Downmix interleaved frames to mono (average the channels).
                    for frame in data.chunks(channels) {
                        let sum: f32 = frame.iter().copied().sum();
                        samples.push(sum / channels as f32);
                    }
                }
            },
            |e| tracing::warn!("meeting recorder: stream error: {e}"),
            None,
        )
        .map_err(|e| anyhow::anyhow!("build_input_stream: {e}"))?;
    Ok(stream)
}

/// Resample both sources to 16 kHz and mix them (sum + clamp). The mix length is
/// the longer of the two so neither side is truncated.
fn mix_to_16k(mic: &[f32], mic_rate: u32, loopback: &[f32], loop_rate: u32) -> Vec<f32> {
    let mic16 = resample_to_16k(mic, mic_rate);
    let loop16 = resample_to_16k(loopback, loop_rate);
    let len = mic16.len().max(loop16.len());
    let mut out = Vec::with_capacity(len);
    for i in 0..len {
        let a = mic16.get(i).copied().unwrap_or(0.0);
        let b = loop16.get(i).copied().unwrap_or(0.0);
        out.push((a + b).clamp(-1.0, 1.0));
    }
    out
}

/// Linear-interpolation resample of mono `input` from `src_rate` to 16 kHz.
fn resample_to_16k(input: &[f32], src_rate: u32) -> Vec<f32> {
    if input.is_empty() || src_rate == TARGET_RATE {
        return input.to_vec();
    }
    let ratio = TARGET_RATE as f64 / src_rate as f64;
    let out_len = ((input.len() as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = i as f64 / ratio;
        let idx = src_pos.floor() as usize;
        let frac = (src_pos - idx as f64) as f32;
        let a = input.get(idx).copied().unwrap_or(0.0);
        let b = input.get(idx + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
}

/// Encode mono f32 samples as a 16 kHz / 16-bit PCM WAV in memory.
fn encode_wav_16k_mono(samples: &[f32]) -> anyhow::Result<Vec<u8>> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: TARGET_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec)?;
        for &s in samples {
            let pcm = (s * 32767.0).clamp(-32768.0, 32767.0) as i16;
            writer.write_sample(pcm)?;
        }
        writer.finalize()?;
    }
    Ok(cursor.into_inner())
}

/// POST one WAV chunk to Core's meeting ingest endpoint (best-effort).
async fn upload_chunk(client: &reqwest::Client, ingest_url: &str, wav: Vec<u8>, meeting_id: &str) {
    let part = match reqwest::multipart::Part::bytes(wav)
        .file_name("chunk.wav")
        .mime_str("audio/wav")
    {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("meeting recorder: building upload part failed: {e}");
            return;
        }
    };
    let form = reqwest::multipart::Form::new().part("file", part);
    match client.post(ingest_url).multipart(form).send().await {
        Ok(resp) if resp.status().is_success() => {}
        Ok(resp) => tracing::warn!(
            "meeting recorder: chunk upload for {meeting_id} returned {}",
            resp.status()
        ),
        Err(e) => tracing::warn!("meeting recorder: chunk upload for {meeting_id} failed: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resample_identity_at_target_rate() {
        let input = vec![0.1, 0.2, 0.3];
        assert_eq!(resample_to_16k(&input, TARGET_RATE), input);
    }

    #[test]
    fn resample_halves_length_from_32k() {
        let input = vec![0.0f32; 320];
        let out = resample_to_16k(&input, 32_000);
        assert_eq!(out.len(), 160);
    }

    #[test]
    fn mix_uses_longer_length_and_sums() {
        let mic = vec![0.5f32, 0.5];
        let loopback = vec![0.5f32];
        let mixed = mix_to_16k(&mic, TARGET_RATE, &loopback, TARGET_RATE);
        assert_eq!(mixed.len(), 2);
        assert!((mixed[0] - 1.0).abs() < 1e-6); // 0.5 + 0.5
        assert!((mixed[1] - 0.5).abs() < 1e-6); // mic only
    }

    #[test]
    fn encode_wav_has_riff_header() {
        let wav = encode_wav_16k_mono(&[0.0, 0.1, -0.1]).unwrap();
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
    }
}
