use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A (screenshot, instruction, coordinates) training tuple.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrainingTuple {
    pub screenshot_path: String,
    pub instruction: String,
    pub norm_x: f32,
    pub norm_y: f32,
    pub app_name: String,
    pub timestamp_us: u64,
}

/// Collects training tuples from enriched click events.
pub struct TrainingDataGenerator {
    training_dir: PathBuf,
    min_tuples_for_training: usize,
}

impl TrainingDataGenerator {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            training_dir: data_dir.join("training"),
            min_tuples_for_training: 100,
        }
    }

    /// Record a click event as a training tuple.
    pub fn record_click(
        &self,
        screenshot_path: &str,
        instruction: &str,
        norm_x: f32,
        norm_y: f32,
        app_name: &str,
        timestamp_us: u64,
    ) -> Result<()> {
        std::fs::create_dir_all(&self.training_dir)?;

        let tuple = TrainingTuple {
            screenshot_path: screenshot_path.to_string(),
            instruction: instruction.to_string(),
            norm_x,
            norm_y,
            app_name: app_name.to_string(),
            timestamp_us,
        };

        let manifest = self.training_dir.join("tuples.jsonl");
        let line = serde_json::to_string(&tuple)? + "\n";
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&manifest)?
            .write_all(line.as_bytes())
            .map_err(|e| anyhow::anyhow!("Failed to write training tuple: {}", e))?;

        Ok(())
    }

    /// Count accumulated training tuples.
    pub fn tuple_count(&self) -> usize {
        let manifest = self.training_dir.join("tuples.jsonl");
        if !manifest.exists() {
            return 0;
        }
        std::fs::read_to_string(&manifest)
            .unwrap_or_default()
            .lines()
            .count()
    }

    /// Return true if enough tuples have been collected to trigger training.
    pub fn ready_for_training(&self) -> bool {
        self.tuple_count() >= self.min_tuples_for_training
    }
}

use std::io::Write;

/// Triggers LoRA fine-tuning of the ShowUI-2B grounding model.
/// Only available on macOS (MLX requirement). On other platforms, logs and skips.
pub struct LoRATrainer {
    models_dir: PathBuf,
    training_dir: PathBuf,
    last_trained: std::sync::Mutex<Option<std::time::Instant>>,
}

impl LoRATrainer {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            models_dir: data_dir.join("models"),
            training_dir: data_dir.join("training"),
            last_trained: std::sync::Mutex::new(None),
        }
    }

    /// Trigger LoRA training if enough data is available and cooldown has passed.
    pub fn trigger_training(&self, generator: &TrainingDataGenerator) -> Result<bool> {
        if !generator.ready_for_training() {
            tracing::debug!(
                "Not enough training tuples yet ({}/{})",
                generator.tuple_count(),
                generator.min_tuples_for_training
            );
            return Ok(false);
        }

        // 24-hour cooldown between training runs
        #[allow(unused_mut)]
        let mut last = self.last_trained.lock().unwrap();
        if let Some(t) = *last {
            if t.elapsed() < std::time::Duration::from_secs(24 * 3600) {
                tracing::debug!("LoRA training on cooldown");
                return Ok(false);
            }
        }

        #[cfg(target_os = "macos")]
        {
            self.run_mlx_training()?;
            *last = Some(std::time::Instant::now());
            return Ok(true);
        }

        #[cfg(not(target_os = "macos"))]
        {
            tracing::info!("LoRA training skipped: requires macOS + MLX");
            return Ok(false);
        }
    }

    #[cfg(target_os = "macos")]
    fn run_mlx_training(&self) -> Result<()> {
        let adapter_dir = self.models_dir.join("showui-lora");
        std::fs::create_dir_all(&adapter_dir)?;

        let tuples_path = self.training_dir.join("tuples.jsonl");

        // Spawn mlx_lm fine-tuning as a background process
        let output = std::process::Command::new("python3")
            .args([
                "-m",
                "mlx_lm.lora",
                "--model",
                self.models_dir.join("showui").to_str().unwrap_or(""),
                "--data",
                tuples_path.to_str().unwrap_or(""),
                "--adapter-path",
                adapter_dir.to_str().unwrap_or(""),
                "--iters",
                "500",
                "--batch-size",
                "4",
            ])
            .output()
            .map_err(|e| anyhow::anyhow!("Failed to run mlx_lm training: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("LoRA training failed: {}", stderr);
        }

        tracing::info!(
            "LoRA training completed, adapter saved to {:?}",
            adapter_dir
        );
        Ok(())
    }
}
