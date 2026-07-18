//! Audio bridging for the hardware session: Opus <-> PCM and PCM <-> WAV.
//!
//! The rest of Core speaks WAV/PCM (whisper transcribe, OuteTTS synth), while the
//! device link speaks Opus (PROTOCOL.md §2):
//!   - **Uplink** mic: Opus, mono, 16 kHz, 60 ms frames (960 samples/frame).
//!   - **Downlink** TTS: Opus, mono, 24 kHz, 60 ms frames (1440 samples/frame).
//!
//! This module owns the codec edges so [`super::session`] only ever deals in
//! decoded PCM / WAV bytes. Opus runs through `audiopus` (which vendors libopus
//! via `audiopus_sys`, so no system libopus is required); WAV read/write runs
//! through `hound`.

use anyhow::{Context, Result};
use opus::{Application, Channels, Decoder as OpusDecoder, Encoder as OpusEncoder};

/// Mic uplink sample rate (Hz).
pub const UPLINK_RATE: u32 = 16_000;
/// TTS downlink sample rate (Hz).
pub const DOWNLINK_RATE: u32 = 24_000;
/// Frame duration in milliseconds (both directions).
pub const FRAME_MS: u32 = 60;

/// Samples per 60 ms downlink frame at 24 kHz (`24000 * 60 / 1000`).
const DOWNLINK_FRAME_SAMPLES: usize = (DOWNLINK_RATE as usize * FRAME_MS as usize) / 1000;
/// A decoded uplink Opus packet never exceeds 120 ms of 16 kHz mono audio; size
/// the scratch buffer for that worst case so any conformant frame fits.
const UPLINK_DECODE_CAP: usize = (UPLINK_RATE as usize * 120) / 1000;

/// Opus decoder for the 16 kHz mono mic uplink. One per session (Opus decoder
/// state is stateful across frames).
pub struct UplinkDecoder {
    decoder: OpusDecoder,
}

impl UplinkDecoder {
    pub fn new() -> Result<Self> {
        let decoder = OpusDecoder::new(UPLINK_RATE, Channels::Mono)
            .context("creating 16 kHz Opus decoder")?;
        Ok(Self { decoder })
    }

    /// Decode one uplink Opus packet to 16 kHz mono PCM (i16) samples.
    pub fn decode(&mut self, packet: &[u8]) -> Result<Vec<i16>> {
        let mut out = vec![0i16; UPLINK_DECODE_CAP];
        let decoded = self
            .decoder
            .decode(packet, &mut out[..], false)
            .context("decoding uplink Opus packet")?;
        out.truncate(decoded);
        Ok(out)
    }
}

/// Opus encoder for the 24 kHz mono TTS downlink. One per TTS stream.
pub struct DownlinkEncoder {
    encoder: OpusEncoder,
}

impl DownlinkEncoder {
    pub fn new() -> Result<Self> {
        let encoder = OpusEncoder::new(DOWNLINK_RATE, Channels::Mono, Application::Voip)
            .context("creating 24 kHz Opus encoder")?;
        Ok(Self { encoder })
    }

    /// Encode 24 kHz mono PCM into a sequence of 60 ms Opus packets. The tail is
    /// zero-padded to a full frame so the last words are never clipped.
    pub fn encode_stream(&mut self, pcm: &[i16]) -> Result<Vec<Vec<u8>>> {
        let mut packets = Vec::new();
        let mut offset = 0;
        // Reusable per-packet output buffer (Opus packets are well under 4 KiB at
        // these bitrates; 4000 is the conventional max).
        let mut scratch = [0u8; 4000];
        while offset < pcm.len() {
            let end = (offset + DOWNLINK_FRAME_SAMPLES).min(pcm.len());
            let mut frame: Vec<i16> = pcm[offset..end].to_vec();
            if frame.len() < DOWNLINK_FRAME_SAMPLES {
                frame.resize(DOWNLINK_FRAME_SAMPLES, 0);
            }
            let n = self
                .encoder
                .encode(&frame, &mut scratch)
                .context("encoding downlink Opus frame")?;
            packets.push(scratch[..n].to_vec());
            offset += DOWNLINK_FRAME_SAMPLES;
        }
        Ok(packets)
    }
}

/// Wrap 16 kHz mono PCM (i16) as a RIFF/WAV byte blob for the whisper/meetings
/// transcribe path, which takes WAV `file` bytes.
pub fn pcm16_to_wav(pcm: &[i16], sample_rate: u32) -> Result<Vec<u8>> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec).context("creating WAV writer")?;
        for &sample in pcm {
            writer.write_sample(sample).context("writing WAV sample")?;
        }
        writer.finalize().context("finalizing WAV")?;
    }
    Ok(cursor.into_inner())
}

/// Parsed PCM from a WAV blob (mono i16 at its native rate). Returned by
/// [`wav_to_pcm16`] so the TTS WAV produced by OuteTTS can be re-encoded as Opus.
pub struct DecodedWav {
    pub samples: Vec<i16>,
    pub sample_rate: u32,
}

/// Decode a WAV blob to mono i16 PCM. Down-mixes any multi-channel input and
/// converts float samples to i16. The sample rate is read from the header so the
/// caller can resample to the 24 kHz Opus downlink as needed.
pub fn wav_to_pcm16(wav: &[u8]) -> Result<DecodedWav> {
    let cursor = std::io::Cursor::new(wav);
    let mut reader = hound::WavReader::new(cursor).context("parsing WAV header")?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;

    let interleaved: Vec<i32> = match spec.sample_format {
        hound::SampleFormat::Int => reader
            .samples::<i32>()
            .collect::<std::result::Result<Vec<_>, _>>()
            .context("reading int WAV samples")?,
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .map(|s| s.map(|v| (v.clamp(-1.0, 1.0) * i16::MAX as f32) as i32))
            .collect::<std::result::Result<Vec<_>, _>>()
            .context("reading float WAV samples")?,
    };

    // Scale integer PCM down to 16-bit if the source was wider (e.g. 24/32-bit).
    let shift = match spec.bits_per_sample {
        0..=16 => 0,
        bits => bits - 16,
    };

    let mut mono = Vec::with_capacity(interleaved.len() / channels.max(1));
    for frame in interleaved.chunks(channels) {
        let sum: i64 = frame.iter().map(|&s| (s >> shift) as i64).sum();
        let avg = (sum / channels as i64).clamp(i16::MIN as i64, i16::MAX as i64);
        mono.push(avg as i16);
    }

    Ok(DecodedWav {
        samples: mono,
        sample_rate: spec.sample_rate,
    })
}

/// Linear-interpolation resampler to the 24 kHz Opus downlink rate. OuteTTS
/// already emits 24 kHz mono, so this is a near-no-op fast path when rates match;
/// it exists so a different TTS engine (a `?engine=` sidecar at another rate)
/// still produces a correctly-pitched downlink rather than a chipmunk artifact.
pub fn resample_to(pcm: &[i16], from_rate: u32, to_rate: u32) -> Vec<i16> {
    if from_rate == to_rate || pcm.is_empty() {
        return pcm.to_vec();
    }
    let ratio = to_rate as f64 / from_rate as f64;
    let out_len = ((pcm.len() as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = i as f64 / ratio;
        let idx = src_pos.floor() as usize;
        let frac = src_pos - idx as f64;
        let a = pcm.get(idx).copied().unwrap_or(0) as f64;
        let b = pcm.get(idx + 1).copied().unwrap_or(a as i16) as f64;
        out.push((a + (b - a) * frac).round() as i16);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_roundtrip_preserves_samples() {
        let pcm: Vec<i16> = (0..480).map(|i| ((i * 137) % 1000 - 500) as i16).collect();
        let wav = pcm16_to_wav(&pcm, UPLINK_RATE).unwrap();
        let decoded = wav_to_pcm16(&wav).unwrap();
        assert_eq!(decoded.sample_rate, UPLINK_RATE);
        assert_eq!(decoded.samples, pcm);
    }

    #[test]
    fn resample_is_noop_when_rates_match() {
        let pcm = vec![1i16, 2, 3, 4];
        assert_eq!(resample_to(&pcm, 24_000, 24_000), pcm);
    }

    #[test]
    fn resample_doubles_length_when_rate_doubles() {
        let pcm = vec![0i16, 100, 0, 100];
        let out = resample_to(&pcm, 12_000, 24_000);
        assert_eq!(out.len(), 8);
    }

    #[test]
    fn opus_encode_then_decode_roundtrips_length() {
        // 24 kHz: encode a 60 ms tone, decode it back through a 24 kHz decoder.
        let mut enc = DownlinkEncoder::new().unwrap();
        let tone: Vec<i16> = (0..DOWNLINK_FRAME_SAMPLES)
            .map(|i| ((i as f64 * 0.2).sin() * 8000.0) as i16)
            .collect();
        let packets = enc.encode_stream(&tone).unwrap();
        assert_eq!(packets.len(), 1);
        assert!(!packets[0].is_empty());

        let mut dec = OpusDecoder::new(DOWNLINK_RATE, Channels::Mono).unwrap();
        let mut out = vec![0i16; DOWNLINK_FRAME_SAMPLES];
        let n = dec.decode(&packets[0], &mut out[..], false).unwrap();
        assert_eq!(n, DOWNLINK_FRAME_SAMPLES);
    }
}
