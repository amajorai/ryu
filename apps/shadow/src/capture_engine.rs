use anyhow::Result;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::utils::wall_micros;

/// Most-recent OCR frame, updated by the screen-capture loop.
/// Holds (text, app_name, timestamp_us).
static LATEST_OCR: std::sync::OnceLock<std::sync::Mutex<Option<(String, String, u64)>>> =
    std::sync::OnceLock::new();

fn latest_ocr_cell() -> &'static std::sync::Mutex<Option<(String, String, u64)>> {
    LATEST_OCR.get_or_init(|| std::sync::Mutex::new(None))
}

/// Read the most recent OCR result captured by the screen-capture loop.
/// Returns `None` when no OCR frame has been produced yet.
pub fn get_latest_ocr() -> Option<(String, String, u64)> {
    latest_ocr_cell().lock().ok()?.clone()
}

/// Expose the raw cell for unit-test seeding. Only available in test builds.
#[cfg(test)]
pub fn get_latest_ocr_cell_for_test() -> &'static std::sync::Mutex<Option<(String, String, u64)>> {
    latest_ocr_cell()
}

use crate::capture::{
    accessibility::PlatformAXTree, input::PlatformInputMonitor, screen::PlatformScreenCapture,
    window::PlatformWindowTracker, AXTree, AudioCapture, InputMonitor, PlatformAudioCapture,
    ScreenCapture, WindowTracker,
};
use crate::video::VideoEncoder;

/// Capture engine orchestrates all capture subsystems.
pub struct CaptureEngine {
    screen: Arc<Mutex<PlatformScreenCapture>>,
    input: Arc<Mutex<PlatformInputMonitor>>,
    window: Arc<Mutex<PlatformWindowTracker>>,
    audio: Arc<Mutex<PlatformAudioCapture>>,
    ax_tree: Arc<Mutex<PlatformAXTree>>,
    /// Per-display video encoders. Populated in `start()` when a data_dir is set.
    video_encoders: Arc<Mutex<Vec<Arc<Mutex<VideoEncoder>>>>>,
    running: bool,
    data_dir: std::path::PathBuf,
}

impl CaptureEngine {
    pub fn new() -> Result<Self> {
        let data_dir = std::env::var("SHADOW_DATA_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::home_dir()
                    .unwrap_or_else(|| std::path::PathBuf::from("."))
                    .join(".shadow")
            });

        Ok(Self {
            screen: Arc::new(Mutex::new(PlatformScreenCapture::new()?)),
            input: Arc::new(Mutex::new(PlatformInputMonitor::new()?)),
            window: Arc::new(Mutex::new(PlatformWindowTracker::new()?)),
            audio: Arc::new(Mutex::new(PlatformAudioCapture::new()?)),
            ax_tree: Arc::new(Mutex::new(PlatformAXTree::new()?)),
            video_encoders: Arc::new(Mutex::new(vec![])),
            running: false,
            data_dir,
        })
    }

    /// Override the data directory (called by main.rs after reading config).
    pub fn set_data_dir(&mut self, dir: std::path::PathBuf) {
        self.data_dir = dir;
    }

    /// Start all capture subsystems.
    pub async fn start(&mut self) -> Result<()> {
        if self.running {
            return Ok(());
        }

        tracing::info!("Starting capture engine...");

        self.screen.lock().await.start().await?;
        tracing::info!("✓ Screen capture started");

        self.input.lock().await.start().await?;
        tracing::info!("✓ Input monitoring started");

        // Audio is non-fatal: a machine with no microphone (e.g. a headless
        // dev box or a desktop without an input device) must still run Shadow
        // for screen context. Same warn-and-continue pattern as the video
        // encoder below and the passive capture sources.
        match self.audio.lock().await.start().await {
            Ok(()) => tracing::info!("✓ Audio capture started"),
            Err(e) => tracing::warn!("Audio capture unavailable (non-fatal): {}", e),
        }

        // Create a video encoder for each detected display
        {
            let displays = self.screen.lock().await.get_displays();
            let video_dir = self.data_dir.join("media").join("video");
            let mut encs = self.video_encoders.lock().await;
            for disp in &displays {
                let did = disp.id;
                match VideoEncoder::new(&video_dir, did) {
                    Ok(enc) => {
                        encs.push(Arc::new(Mutex::new(enc)));
                        tracing::info!("✓ Video encoder ready for display {}", did);
                    }
                    Err(e) => {
                        tracing::warn!("Video encoder init failed for display {}: {}", did, e)
                    }
                }
            }
        }

        self.spawn_capture_tasks().await?;

        self.running = true;
        tracing::info!("Capture engine fully started");
        Ok(())
    }

    /// Stop all capture subsystems.
    pub async fn stop(&mut self) -> Result<()> {
        if !self.running {
            return Ok(());
        }

        self.screen.lock().await.stop().await?;
        self.input.lock().await.stop().await?;
        self.audio.lock().await.stop().await?;

        self.running = false;
        tracing::info!("Capture engine stopped");
        Ok(())
    }

    /// Spawn background loops for continuous capture.
    async fn spawn_capture_tasks(&self) -> Result<()> {
        let screen = Arc::clone(&self.screen);
        let window = Arc::clone(&self.window);
        let video_encoders = Arc::clone(&self.video_encoders);

        // ── Screen capture loop at 0.5 fps (2 s interval) ─────────────────────
        tokio::spawn(async move {
            let ocr = crate::ocr::OcrWorker::new().ok();

            // Perceptual hash of last frame per display to skip duplicate frames
            let mut last_hashes: std::collections::HashMap<u32, u64> =
                std::collections::HashMap::new();

            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

                // Enumerate displays
                let displays = screen.lock().await.get_displays();

                for disp in &displays {
                    let did = disp.id;
                    let win_info = window.lock().await.get_active_window().await;
                    let frame_result = screen.lock().await.capture_frame(did).await;

                    match frame_result {
                        Ok(frame) => {
                            // Simple content hash: XOR of strided samples as a change detector
                            let hash = simple_frame_hash(&frame.data);
                            let last = last_hashes.get(&did).copied().unwrap_or(0);
                            let changed = hash != last;
                            last_hashes.insert(did, hash);

                            // Ingest window event on the primary display only
                            if disp.is_primary {
                                if let Some(ref win) = win_info {
                                    ingest_window_event(win, frame.timestamp);
                                }
                            }

                            // OCR + video encode — only when frame content changed
                            if changed {
                                if let Some(ref worker) = ocr {
                                    if let Ok(Some(text)) = worker
                                        .process_frame(&frame.data, frame.width, frame.height)
                                        .await
                                    {
                                        if !text.is_empty() {
                                            let app = win_info
                                                .as_ref()
                                                .map(|w| w.app_name.as_str())
                                                .unwrap_or("");
                                            ingest_ocr_event(&text, app, frame.timestamp);
                                        }
                                    }
                                }

                                // Save a JPEG keyframe for the timeline scrubber.
                                // Gate on the frame toggle AND the same consent
                                // checks the rest of capture honours: never write a
                                // screenshot while paused or for a non-allowlisted
                                // app. (These checks live here, not just in the
                                // /context/current response path.)
                                let app_for_gate =
                                    win_info.as_ref().map(|w| w.app_name.as_str()).unwrap_or("");
                                let frames_ok = crate::server::is_frame_capture_enabled()
                                    && !crate::server::is_capture_paused()
                                    && crate::server::is_capture_allowed(app_for_gate);
                                if frames_ok {
                                    let mut encs = video_encoders.lock().await;
                                    if let Some(enc) = encs.get_mut(did as usize) {
                                        let enc = enc.lock().await;
                                        if let Err(e) = enc.save_keyframe(&frame) {
                                            tracing::trace!(
                                                "Keyframe save error (display {}): {}",
                                                did,
                                                e
                                            );
                                        }
                                        // Full H.265 MP4 encoding only when built
                                        // with the optional `video` feature.
                                        #[cfg(feature = "video")]
                                        {
                                            let mut enc = enc;
                                            if let Err(e) = enc.encode_frame(&frame) {
                                                tracing::trace!(
                                                    "Video encode error (display {}): {}",
                                                    did,
                                                    e
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            // 0x887A0027 = DXGI_ERROR_WAIT_TIMEOUT (normal at 0.5 fps)
                            let msg = e.to_string();
                            if !msg.contains("0x887A0027") && !msg.contains("AcquireNextFrame") {
                                tracing::trace!("Frame capture error (display {}): {}", did, e);
                            }
                        }
                    }
                }
            }
        });

        let ax_tree = Arc::clone(&self.ax_tree);
        let window2 = Arc::clone(&self.window);

        // ── AX tree snapshot on focus change (every 5 s poll) ─────────────────
        tokio::spawn(async move {
            let mut last_app = String::new();
            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;

                if let Some(win) = window2.lock().await.get_active_window().await {
                    if win.app_name != last_app {
                        last_app = win.app_name.clone();

                        match ax_tree.lock().await.get_focused_tree().await {
                            Ok(tree) => {
                                let ts = wall_micros();
                                ingest_ax_event(&tree, &win.app_name, ts);
                            }
                            Err(e) => tracing::trace!("AX tree error: {}", e),
                        }
                    }
                }
            }
        });

        Ok(())
    }

    pub fn is_running(&self) -> bool {
        self.running
    }
}

/// Fast non-cryptographic hash of frame pixel data for change detection.
/// XORs 8-byte words from a strided sample across the frame.
fn simple_frame_hash(data: &[u8]) -> u64 {
    let step = (data.len() / 512).max(8);
    data.chunks(step).take(512).fold(0u64, |acc, chunk| {
        let mut word = 0u64;
        for (i, &b) in chunk.iter().enumerate().take(8) {
            word |= (b as u64) << (i * 8);
        }
        acc ^ word
    })
}

fn ingest_window_event(win: &crate::capture::WindowInfo, ts: u64) {
    use std::collections::HashMap;
    let mut map: HashMap<&str, rmpv::Value> = HashMap::new();
    map.insert("ts", rmpv::Value::from(ts));
    map.insert("v", rmpv::Value::from(2u8));
    map.insert("track", rmpv::Value::from(3u8));
    map.insert("type", rmpv::Value::from("app_switch"));
    map.insert("app_name", rmpv::Value::from(win.app_name.as_str()));
    map.insert("window_title", rmpv::Value::from(win.title.as_str()));
    map.insert("pid", rmpv::Value::from(win.pid));
    if let Some(url) = &win.url {
        map.insert("url", rmpv::Value::from(url.as_str()));
    }
    if let Ok(data) = rmp_serde::to_vec(&map) {
        let _ = shadow_core::write_event(data);
    }
}

fn ingest_ocr_event(text: &str, app_name: &str, ts: u64) {
    use std::collections::HashMap;
    let mut map: HashMap<&str, rmpv::Value> = HashMap::new();
    map.insert("ts", rmpv::Value::from(ts));
    map.insert("v", rmpv::Value::from(2u8));
    map.insert("track", rmpv::Value::from(4u8));
    map.insert("type", rmpv::Value::from("ocr"));
    map.insert("app_name", rmpv::Value::from(app_name));
    map.insert("text_content", rmpv::Value::from(text));
    if let Ok(data) = rmp_serde::to_vec(&map) {
        let _ = shadow_core::write_event(data);
    }

    // Update the in-memory cache so /context/current can read it without
    // parsing the raw event log.
    if let Ok(mut guard) = latest_ocr_cell().lock() {
        *guard = Some((text.to_string(), app_name.to_string(), ts));
    }
}

fn ingest_ax_event(tree: &crate::capture::AXTreeNode, app_name: &str, ts: u64) {
    use std::collections::HashMap;
    let tree_json = serde_json::to_string(tree).unwrap_or_default();
    let mut map: HashMap<&str, rmpv::Value> = HashMap::new();
    map.insert("ts", rmpv::Value::from(ts));
    map.insert("v", rmpv::Value::from(2u8));
    map.insert("track", rmpv::Value::from(5u8));
    map.insert("type", rmpv::Value::from("ax_snapshot"));
    map.insert("app_name", rmpv::Value::from(app_name));
    map.insert("ax_tree", rmpv::Value::from(tree_json.as_str()));
    if let Ok(data) = rmp_serde::to_vec(&map) {
        let _ = shadow_core::write_event(data);
    }
}

impl Default for CaptureEngine {
    fn default() -> Self {
        Self::new().expect("Failed to create CaptureEngine")
    }
}
