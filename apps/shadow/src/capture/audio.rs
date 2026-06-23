use anyhow::Result;
use async_trait::async_trait;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, Host, Stream};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

/// Audio capture trait.
#[async_trait]
pub trait AudioCapture: Send + Sync {
    async fn start(&mut self) -> Result<()>;
    async fn stop(&mut self) -> Result<()>;
    fn is_mic_active(&self) -> bool;
}

/// Cross-platform audio capture using cpal.
/// Writes mic audio to WAV segments in media/audio/.
pub struct PlatformAudioCapture {
    host: Host,
    input_device: Option<Device>,
    stream: Option<Stream>,
    is_active: Arc<AtomicBool>,
    last_active_ts: Arc<AtomicU64>,
    audio_dir: PathBuf,
}

// Stream holds a non-Send callback; mark manually since we only access from single task
unsafe impl Send for PlatformAudioCapture {}
unsafe impl Sync for PlatformAudioCapture {}

impl PlatformAudioCapture {
    pub fn new() -> Result<Self> {
        let host = cpal::default_host();
        let input_device = host.default_input_device();

        let audio_dir = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".shadow")
            .join("media")
            .join("audio");

        Ok(Self {
            host,
            input_device,
            stream: None,
            is_active: Arc::new(AtomicBool::new(false)),
            last_active_ts: Arc::new(AtomicU64::new(0)),
            audio_dir,
        })
    }

    pub fn with_audio_dir(mut self, dir: PathBuf) -> Self {
        self.audio_dir = dir;
        self
    }
}

#[async_trait]
impl AudioCapture for PlatformAudioCapture {
    async fn start(&mut self) -> Result<()> {
        let device = self
            .input_device
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("No audio input device available"))?;

        let config = device
            .default_input_config()
            .map_err(|e| anyhow::anyhow!("No default input config: {}", e))?;

        tracing::info!("Audio capture: {:?} {:?}", device.name(), config);

        let sample_rate = config.sample_rate().0;
        let channels = config.channels() as u16;
        let audio_dir = self.audio_dir.clone();
        let is_active = Arc::clone(&self.is_active);
        let last_active_ts = Arc::clone(&self.last_active_ts);

        // Create WAV writer protected by a mutex
        std::fs::create_dir_all(&audio_dir)?;
        let wav_path = self.current_wav_path();
        let wav_spec = hound::WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let wav_writer = Arc::new(std::sync::Mutex::new(Some(hound::WavWriter::create(
            &wav_path, wav_spec,
        )?)));

        tracing::info!("Writing audio to {:?}", wav_path);

        let wav_for_cb = Arc::clone(&wav_writer);
        let is_active_cb = Arc::clone(&is_active);
        let last_ts_cb = Arc::clone(&last_active_ts);

        let stream = device
            .build_input_stream(
                &config.into(),
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    // Compute RMS energy level
                    let rms: f32 =
                        (data.iter().map(|&s| s * s).sum::<f32>() / data.len() as f32).sqrt();
                    let active = rms > 0.01; // -40 dBFS threshold

                    if active {
                        is_active_cb.store(true, Ordering::Relaxed);
                        last_ts_cb.store(
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_micros() as u64,
                            Ordering::Relaxed,
                        );
                    } else {
                        // 30s post-quiet timeout
                        let last = last_ts_cb.load(Ordering::Relaxed);
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_micros() as u64;
                        if now.saturating_sub(last) > 30 * 1_000_000 {
                            is_active_cb.store(false, Ordering::Relaxed);
                        }
                    }

                    // Write samples as i16 PCM
                    if let Ok(mut guard) = wav_for_cb.lock() {
                        if let Some(writer) = guard.as_mut() {
                            for &sample in data {
                                let pcm = (sample * 32767.0).clamp(-32768.0, 32767.0) as i16;
                                let _ = writer.write_sample(pcm);
                            }
                        }
                    }
                },
                |e| tracing::warn!("Audio stream error: {}", e),
                None,
            )
            .map_err(|e| anyhow::anyhow!("Failed to build audio stream: {}", e))?;

        stream
            .play()
            .map_err(|e| anyhow::anyhow!("Failed to start audio stream: {}", e))?;

        self.stream = Some(stream);
        tracing::info!("Audio capture started");
        Ok(())
    }

    async fn stop(&mut self) -> Result<()> {
        self.stream = None;
        self.is_active.store(false, Ordering::Relaxed);
        tracing::info!("Audio capture stopped");
        Ok(())
    }

    fn is_mic_active(&self) -> bool {
        self.is_active.load(Ordering::Relaxed)
    }
}

impl PlatformAudioCapture {
    fn current_wav_path(&self) -> PathBuf {
        let dt = chrono::Local::now();
        self.audio_dir
            .join(format!("{}.wav", dt.format("%Y-%m-%dT%H")))
    }
}

impl Default for PlatformAudioCapture {
    fn default() -> Self {
        Self::new().expect("Failed to create PlatformAudioCapture")
    }
}
