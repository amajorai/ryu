use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Known model descriptors.
pub struct ModelDescriptor {
    pub name: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size_bytes: u64,
}

pub const CLIP_MODEL: ModelDescriptor = ModelDescriptor {
    name: "mobileclip-s2",
    url: "https://huggingface.co/apple/MobileVLM_V2-1.7B/resolve/main/mobileclip_s2.onnx",
    sha256: "",
    size_bytes: 80_000_000,
};

pub const WHISPER_TINY_MODEL: ModelDescriptor = ModelDescriptor {
    name: "whisper-tiny",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
    sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
    size_bytes: 75_000_000,
};

pub const SHOWUI_MODEL: ModelDescriptor = ModelDescriptor {
    name: "showui-2b",
    url: "https://huggingface.co/showlab/ShowUI-2B/resolve/main/showui-2b.onnx",
    sha256: "",
    size_bytes: 3_000_000_000,
};

/// Manages model downloads and verification.
pub struct ModelManager {
    models_dir: PathBuf,
}

impl ModelManager {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            models_dir: data_dir.join("models"),
        }
    }

    /// Path where a model's file will be stored.
    pub fn model_path(&self, model: &ModelDescriptor) -> PathBuf {
        self.models_dir.join(model.name).join("model.bin")
    }

    /// Return true if the model exists and (if sha256 is set) matches its checksum.
    pub fn is_available(&self, model: &ModelDescriptor) -> bool {
        let path = self.model_path(model);
        if !path.exists() {
            return false;
        }
        if model.sha256.is_empty() {
            return true;
        }
        self.verify_sha256(&path, model.sha256).unwrap_or(false)
    }

    /// Download a model with progress reporting.
    pub async fn download(&self, model: &ModelDescriptor) -> Result<PathBuf> {
        let path = self.model_path(model);
        if self.is_available(model) {
            tracing::info!("Model '{}' already available at {:?}", model.name, path);
            return Ok(path);
        }

        let dir = path.parent().context("Invalid model path")?;
        std::fs::create_dir_all(dir)
            .with_context(|| format!("Failed to create model dir {:?}", dir))?;

        tracing::info!(
            "Downloading model '{}' ({:.1}MB)...",
            model.name,
            model.size_bytes as f64 / 1e6
        );

        let client = reqwest::Client::new();
        let response = client
            .get(model.url)
            .send()
            .await
            .with_context(|| format!("Failed to download model '{}'", model.name))?;

        if !response.status().is_success() {
            anyhow::bail!(
                "HTTP {} downloading model '{}'",
                response.status(),
                model.name
            );
        }

        // Write to a temp file, then atomic rename
        let tmp_path = path.with_extension("tmp");
        let bytes = response
            .bytes()
            .await
            .context("Failed to read model bytes")?;

        std::fs::write(&tmp_path, &bytes)
            .with_context(|| format!("Failed to write model to {:?}", tmp_path))?;

        // Verify checksum
        if !model.sha256.is_empty() {
            let verified = self.verify_sha256(&tmp_path, model.sha256)?;
            if !verified {
                std::fs::remove_file(&tmp_path).ok();
                anyhow::bail!("SHA256 mismatch for model '{}'", model.name);
            }
        }

        // Atomic rename
        std::fs::rename(&tmp_path, &path)
            .with_context(|| format!("Failed to rename {:?} -> {:?}", tmp_path, path))?;

        tracing::info!("Model '{}' downloaded successfully", model.name);
        Ok(path)
    }

    fn verify_sha256(&self, path: &Path, expected: &str) -> Result<bool> {
        let bytes = std::fs::read(path)
            .with_context(|| format!("Failed to read {:?} for checksum", path))?;
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let result = format!("{:x}", hasher.finalize());
        Ok(result == expected)
    }

    /// Ensure all required models are available, downloading if needed.
    pub async fn ensure_models(&self, models: &[&ModelDescriptor]) -> Result<()> {
        for model in models {
            if !self.is_available(model) {
                self.download(model).await?;
            }
        }
        Ok(())
    }
}
