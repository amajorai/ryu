//! Meeting audio helpers: split one uploaded chunk into the two things Core needs
//! from it.
//!
//! Shadow uploads an **interleaved stereo** 16 kHz WAV (L = mic, R = system). Two
//! consumers want different shapes of it:
//!   - **whisper** wants mono — so we downmix for transcription;
//!   - **diarization** wants the raw recording — so we append the stereo PCM to a
//!     per-meeting file, keeping the channel split (mic is always "you") that makes
//!     "Me vs. everyone-else" a free, reliable speaker label.
//!
//! The GUI-mic path still sends mono; we upmix that to stereo (same signal on both
//! channels) so the persisted file has one consistent 2-channel/16 kHz layout that
//! the finalizer can wrap in a WAV header without bookkeeping.

use std::path::PathBuf;

use anyhow::{Context, Result};

/// The rate every persisted meeting recording is normalized to (whisper's rate).
pub const TARGET_RATE: u32 = 16_000;

/// A decoded WAV: channel count, sample rate, and interleaved i16 samples.
pub struct DecodedWav {
    pub channels: u16,
    pub rate: u32,
    pub samples: Vec<i16>,
}

/// Decode a WAV blob into interleaved i16 samples. Float WAVs are converted to i16.
pub fn decode_wav(bytes: &[u8]) -> Result<DecodedWav> {
    let cursor = std::io::Cursor::new(bytes);
    let reader = hound::WavReader::new(cursor).context("opening WAV chunk")?;
    let spec = reader.spec();
    let samples: Vec<i16> = match spec.sample_format {
        hound::SampleFormat::Int => {
            let mut r = reader;
            r.samples::<i32>()
                .map(|s| s.unwrap_or(0).clamp(i16::MIN as i32, i16::MAX as i32) as i16)
                .collect()
        }
        hound::SampleFormat::Float => {
            let mut r = reader;
            r.samples::<f32>()
                .map(|s| (s.unwrap_or(0.0) * 32767.0).clamp(-32768.0, 32767.0) as i16)
                .collect()
        }
    };
    Ok(DecodedWav {
        channels: spec.channels,
        rate: spec.sample_rate,
        samples,
    })
}

/// Downmix a decoded chunk to a **mono** WAV (same rate) for whisper. A mono input
/// is re-encoded unchanged; a stereo (or N-channel) input is averaged per frame.
pub fn to_mono_wav(decoded: &DecodedWav) -> Result<Vec<u8>> {
    let ch = decoded.channels.max(1) as usize;
    let mono: Vec<i16> = if ch == 1 {
        decoded.samples.clone()
    } else {
        decoded
            .samples
            .chunks(ch)
            .map(|frame| {
                let sum: i32 = frame.iter().map(|&s| s as i32).sum();
                (sum / ch as i32) as i16
            })
            .collect()
    };
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: decoded.rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec)?;
        for &s in &mono {
            writer.write_sample(s)?;
        }
        writer.finalize()?;
    }
    Ok(cursor.into_inner())
}

/// Return the chunk as interleaved **stereo** i16 for persistence. Stereo passes
/// through; mono is duplicated onto both channels; >2 channels are folded to the
/// first two. Only meaningful at [`TARGET_RATE`]; the caller skips persistence for
/// other rates so the per-meeting PCM file stays single-rate.
pub fn to_stereo_i16(decoded: &DecodedWav) -> Vec<i16> {
    let ch = decoded.channels.max(1) as usize;
    match ch {
        1 => {
            let mut out = Vec::with_capacity(decoded.samples.len() * 2);
            for &s in &decoded.samples {
                out.push(s);
                out.push(s);
            }
            out
        }
        2 => decoded.samples.clone(),
        _ => {
            let mut out = Vec::with_capacity((decoded.samples.len() / ch) * 2);
            for frame in decoded.samples.chunks(ch) {
                out.push(frame.first().copied().unwrap_or(0));
                out.push(frame.get(1).copied().unwrap_or(0));
            }
            out
        }
    }
}

/// Linear-resample a decoded clip to [`TARGET_RATE`], preserving channel count.
/// Used by the import path so an arbitrary-rate uploaded file is normalized to the
/// 16 kHz everything downstream (whisper, persistence, diarization) expects. A
/// clip already at the target rate is returned unchanged.
pub fn resample_to_16k(decoded: &DecodedWav) -> DecodedWav {
    if decoded.rate == TARGET_RATE || decoded.samples.is_empty() {
        return DecodedWav {
            channels: decoded.channels,
            rate: TARGET_RATE,
            samples: decoded.samples.clone(),
        };
    }
    let ch = decoded.channels.max(1) as usize;
    let in_frames = decoded.samples.len() / ch;
    let ratio = TARGET_RATE as f64 / decoded.rate as f64;
    let out_frames = ((in_frames as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_frames * ch);
    for i in 0..out_frames {
        let src = i as f64 / ratio;
        let idx = src.floor() as usize;
        let frac = src - idx as f64;
        for c in 0..ch {
            let a = decoded.samples.get(idx * ch + c).copied().unwrap_or(0) as f64;
            let b = decoded
                .samples
                .get((idx + 1) * ch + c)
                .copied()
                .unwrap_or(a as i16) as f64;
            out.push((a + (b - a) * frac).round() as i16);
        }
    }
    DecodedWav {
        channels: decoded.channels,
        rate: TARGET_RATE,
        samples: out,
    }
}

/// Encode interleaved i16 samples as a WAV with the given layout.
pub fn encode_wav(channels: u16, rate: u32, samples: &[i16]) -> Result<Vec<u8>> {
    let spec = hound::WavSpec {
        channels: channels.max(1),
        sample_rate: rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec)?;
        for &s in samples {
            writer.write_sample(s)?;
        }
        writer.finalize()?;
    }
    Ok(cursor.into_inner())
}

/// Split a 16 kHz decoded clip into `window_secs`-long WAV windows, each tagged
/// with its offset from the start in ms. Used by import to feed a whole file
/// through the same chunk-ingest pipeline as a live recording.
pub fn window_wavs(decoded: &DecodedWav, window_secs: usize) -> Vec<(i64, Vec<u8>)> {
    let ch = decoded.channels.max(1) as usize;
    let frames_per_window = window_secs * TARGET_RATE as usize;
    let samples_per_window = frames_per_window * ch;
    let mut out = Vec::new();
    let mut frame0 = 0usize;
    for window in decoded.samples.chunks(samples_per_window) {
        if let Ok(wav) = encode_wav(decoded.channels, TARGET_RATE, window) {
            let offset_ms = (frame0 as i64) * 1000 / TARGET_RATE as i64;
            out.push((offset_ms, wav));
        }
        frame0 += window.len() / ch;
    }
    out
}

/// The append-only raw stereo PCM file backing a meeting's diarization audio.
pub fn pcm_path(meeting_id: &str) -> PathBuf {
    crate::data_dir()
        .join("meetings")
        .join(format!("{meeting_id}.pcm"))
}

/// Append interleaved stereo i16 samples to the meeting's PCM file (best-effort;
/// diarization is opt-in, so a persistence failure must not fail ingest).
pub fn append_pcm(meeting_id: &str, stereo: &[i16]) -> Result<()> {
    use std::io::Write;
    let path = pcm_path(meeting_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("opening pcm file {}", path.display()))?;
    let mut bytes = Vec::with_capacity(stereo.len() * 2);
    for &s in stereo {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    f.write_all(&bytes)?;
    Ok(())
}

/// Wrap a meeting's accumulated stereo PCM as an in-memory WAV (16 kHz / 2ch) for
/// the diarization sidecar. `None` if no audio was persisted.
pub fn read_pcm_as_wav(meeting_id: &str) -> Result<Option<Vec<u8>>> {
    let path = pcm_path(meeting_id);
    let raw = match std::fs::read(&path) {
        Ok(b) if !b.is_empty() => b,
        _ => return Ok(None),
    };
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: TARGET_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec)?;
        for pair in raw.chunks_exact(2) {
            writer.write_sample(i16::from_le_bytes([pair[0], pair[1]]))?;
        }
        writer.finalize()?;
    }
    Ok(Some(cursor.into_inner()))
}

/// Remove a meeting's persisted audio (called on delete; best-effort).
pub fn remove_pcm(meeting_id: &str) {
    let _ = std::fs::remove_file(pcm_path(meeting_id));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stereo_wav(frames: &[(i16, i16)]) -> Vec<u8> {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: TARGET_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
        {
            let mut w = hound::WavWriter::new(&mut cursor, spec).unwrap();
            for &(l, r) in frames {
                w.write_sample(l).unwrap();
                w.write_sample(r).unwrap();
            }
            w.finalize().unwrap();
        }
        cursor.into_inner()
    }

    #[test]
    fn decode_roundtrips_stereo() {
        let wav = stereo_wav(&[(100, -100), (200, -200)]);
        let d = decode_wav(&wav).unwrap();
        assert_eq!(d.channels, 2);
        assert_eq!(d.rate, TARGET_RATE);
        assert_eq!(d.samples, vec![100, -100, 200, -200]);
    }

    #[test]
    fn downmix_averages_channels() {
        let wav = stereo_wav(&[(100, 200), (0, 0)]);
        let d = decode_wav(&wav).unwrap();
        let mono = decode_wav(&to_mono_wav(&d).unwrap()).unwrap();
        assert_eq!(mono.channels, 1);
        assert_eq!(mono.samples, vec![150, 0]); // (100+200)/2, (0+0)/2
    }

    #[test]
    fn to_stereo_passes_through_and_upmixes() {
        let stereo = DecodedWav {
            channels: 2,
            rate: TARGET_RATE,
            samples: vec![1, 2, 3, 4],
        };
        assert_eq!(to_stereo_i16(&stereo), vec![1, 2, 3, 4]);
        let mono = DecodedWav {
            channels: 1,
            rate: TARGET_RATE,
            samples: vec![5, 6],
        };
        assert_eq!(to_stereo_i16(&mono), vec![5, 5, 6, 6]);
    }
}
