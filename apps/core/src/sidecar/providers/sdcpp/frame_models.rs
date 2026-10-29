//! Wan image-to-video and first/last-frame models on the local sd.cpp engine.
//!
//! The pinned stable-diffusion.cpp release
//! ([`super::downloader::TARGET_VERSION`], `master-890-74988b2`) runs these Wan
//! variants through `POST /sdcpp/v1/vid_gen`. The request takes the start frame
//! as `init_image` and the end frame as `end_image` (raw base64 or a
//! `data:image/...` URL); the server picks video mode from the loaded model.
//! What each variant needs at launch follows that release's `docs/wan.md` and
//! `src/pipeline/video.cpp`:
//!
//! | Variant | Frames | Launch companions |
//! | --- | --- | --- |
//! | Wan2.1 I2V 14B (480p / 720p) | first | umt5-xxl, Wan2.1 VAE, CLIP-vision H |
//! | Wan2.1 FLF2V 14B 720p | first + last | umt5-xxl, Wan2.1 VAE, CLIP-vision H |
//! | Wan2.2 TI2V 5B | first | umt5-xxl, Wan2.2 VAE |
//! | Wan2.2 I2V A14B (low + high noise pair) | first + last | umt5-xxl, Wan2.1 VAE, `--high-noise-diffusion-model` |
//!
//! The diffusion transformer is the user's own catalog install (for example a
//! `city96/Wan2.1-FLF2V-14B-720P-gguf` or `QuantStack/Wan2.2-I2V-A14B-GGUF`
//! file). Selecting it as the active diffusion model is the opt-in that lets
//! the sidecar fetch the companions listed above; nothing here downloads on
//! its own. These transformer GGUFs carry no `model.diffusion_model.` prefix,
//! so they load with `--diffusion-model`, not `-m`.

use std::path::{Path, PathBuf};

use ryu_image::video::LocalVideoInputs;

use super::downloader;

/// A Wan model the local engine can drive from reference frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WanFrameModel {
    /// Wan2.1 I2V 14B: animates from a start frame.
    Wan21I2v,
    /// Wan2.1 FLF2V 14B: animates from a start frame to an end frame.
    Wan21Flf2v,
    /// Wan2.2 TI2V 5B: text-or-image to video from a start frame.
    Wan22Ti2v,
    /// Wan2.2 I2V A14B: a low-noise and a high-noise transformer pair that
    /// takes a start frame and, optionally, an end frame.
    Wan22I2vA14b,
}

/// A companion weight file a frame model loads beside its transformer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameCompanion {
    /// umt5-xxl text encoder (`--t5xxl`).
    TextEncoder,
    /// Wan2.1 VAE (`--vae`), shared by every Wan model except TI2V 5B.
    Wan21Vae,
    /// Wan2.2 VAE (`--vae`), TI2V 5B only.
    Wan22Vae,
    /// CLIP-vision H image encoder (`--clip_vision`), Wan2.1 I2V/FLF2V only.
    ClipVision,
}

impl FrameCompanion {
    /// The `sd-server` flag that loads this file.
    pub const fn flag(self) -> &'static str {
        match self {
            Self::TextEncoder => "--t5xxl",
            Self::Wan21Vae | Self::Wan22Vae => "--vae",
            Self::ClipVision => "--clip_vision",
        }
    }

    /// Where the downloader installs this file.
    pub fn path(self) -> PathBuf {
        match self {
            Self::TextEncoder => downloader::video_t5xxl_path(),
            Self::Wan21Vae => downloader::video_vae_path(),
            Self::Wan22Vae => downloader::video_wan22_vae_path(),
            Self::ClipVision => downloader::video_clip_vision_path(),
        }
    }
}

/// Which half of a Wan2.2 A14B transformer pair a file is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NoiseRole {
    Low,
    High,
}

/// Lowercase alphanumeric tokens of a model stem (`Wan2.1-I2V-14B` →
/// `wan2`, `1`, `i2v`, `14b`).
fn tokens(stem: &str) -> Vec<String> {
    stem.to_ascii_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect()
}

/// The Wan minor version (`1` for 2.1, `2` for 2.2) a stem names, read from
/// `wan2.1` / `wan2_2` / `wan21` style tokens.
fn wan_minor_version(tokens: &[String]) -> Option<u8> {
    for (index, token) in tokens.iter().enumerate() {
        match token.as_str() {
            "wan21" => return Some(1),
            "wan22" => return Some(2),
            "wan2" => match tokens.get(index + 1).map(String::as_str) {
                Some("1") => return Some(1),
                Some("2") => return Some(2),
                _ => {}
            },
            _ => {}
        }
    }
    None
}

fn noise_role(tokens: &[String]) -> Option<NoiseRole> {
    let pair = |first: &str| {
        tokens
            .windows(2)
            .any(|window| window[0] == first && window[1] == "noise")
    };
    if tokens.iter().any(|token| token == "lownoise") || pair("low") {
        Some(NoiseRole::Low)
    } else if tokens.iter().any(|token| token == "highnoise") || pair("high") {
        Some(NoiseRole::High)
    } else {
        None
    }
}

/// The stem of the other half of a Wan2.2 A14B pair, keeping the file's own
/// spelling (`Wan2.2-I2V-A14B-LowNoise-Q4_K_M` ↔ `…-HighNoise-Q4_K_M`).
fn sibling_stem(stem: &str, role: NoiseRole) -> Option<String> {
    let lower = stem.to_ascii_lowercase();
    let (from, to) = match role {
        NoiseRole::Low => ("low", "high"),
        NoiseRole::High => ("high", "low"),
    };
    let start = ["noise", "_noise", "-noise"]
        .iter()
        .find_map(|suffix| lower.find(&format!("{from}{suffix}")))?;
    let original = &stem[start..start + from.len()];
    let replacement = if original.chars().all(|c| c.is_ascii_uppercase()) {
        to.to_ascii_uppercase()
    } else if original.starts_with(|c: char| c.is_ascii_uppercase()) {
        let mut chars = to.chars();
        chars
            .next()
            .map(|first| first.to_ascii_uppercase().to_string() + chars.as_str())
            .unwrap_or_default()
    } else {
        to.to_owned()
    };
    Some(format!(
        "{}{}{}",
        &stem[..start],
        replacement,
        &stem[start + from.len()..]
    ))
}

impl WanFrameModel {
    /// Classify a diffusion model by its file stem. Only the Wan variants the
    /// pinned engine conditions on frames qualify; text-to-video, VACE, S2V
    /// and anything unrecognized return `None` so frames stay refused.
    pub fn from_stem(stem: &str) -> Option<Self> {
        let tokens = tokens(stem);
        let has = |wanted: &str| tokens.iter().any(|token| token == wanted);
        match wan_minor_version(&tokens)? {
            1 if has("flf2v") => Some(Self::Wan21Flf2v),
            1 if has("i2v") => Some(Self::Wan21I2v),
            2 if has("ti2v") => Some(Self::Wan22Ti2v),
            2 if has("i2v") && noise_role(&tokens).is_some() => Some(Self::Wan22I2vA14b),
            _ => None,
        }
    }

    /// The reference frames this variant takes.
    pub const fn inputs(self) -> LocalVideoInputs {
        match self {
            Self::Wan21I2v | Self::Wan22Ti2v => LocalVideoInputs {
                first_frame: true,
                last_frame: false,
            },
            Self::Wan21Flf2v | Self::Wan22I2vA14b => LocalVideoInputs {
                first_frame: true,
                last_frame: true,
            },
        }
    }

    /// Companion files this variant loads beside its transformer.
    pub const fn companions(self) -> &'static [FrameCompanion] {
        match self {
            Self::Wan21I2v | Self::Wan21Flf2v => &[
                FrameCompanion::TextEncoder,
                FrameCompanion::Wan21Vae,
                FrameCompanion::ClipVision,
            ],
            Self::Wan22Ti2v => &[FrameCompanion::TextEncoder, FrameCompanion::Wan22Vae],
            Self::Wan22I2vA14b => &[FrameCompanion::TextEncoder, FrameCompanion::Wan21Vae],
        }
    }

    /// Companions not yet on disk.
    pub fn missing_companions(self) -> Vec<FrameCompanion> {
        self.companions()
            .iter()
            .copied()
            .filter(|companion| !companion.path().exists())
            .collect()
    }

    /// The `(low noise, high noise)` transformer paths of an A14B pair, or
    /// `None` for single-file variants. The other half must be installed
    /// beside `model` under the matching stem.
    fn transformer_pair(self, model: &Path) -> Option<Result<(PathBuf, PathBuf), String>> {
        if self != Self::Wan22I2vA14b {
            return None;
        }
        let stem = model.file_stem().and_then(|stem| stem.to_str())?;
        let role = noise_role(&tokens(stem))?;
        let Some(sibling) = sibling_stem(stem, role) else {
            return Some(Err(format!(
                "cannot derive the other half of the Wan2.2 A14B pair from {stem}"
            )));
        };
        let sibling_path = model.with_file_name(format!("{sibling}.gguf"));
        if !sibling_path.exists() {
            return Some(Err(format!(
                "Wan2.2 I2V A14B runs as a low-noise and high-noise pair; install {sibling}.gguf beside {stem}.gguf from the model catalog"
            )));
        }
        Some(Ok(match role {
            NoiseRole::Low => (model.to_path_buf(), sibling_path),
            NoiseRole::High => (sibling_path, model.to_path_buf()),
        }))
    }

    /// Whether every transformer file this variant needs is installed. The
    /// companions are not checked: the sidecar fetches them at launch.
    pub fn transformers_installed(self, model: &Path) -> bool {
        model.exists() && !matches!(self.transformer_pair(model), Some(Err(_)))
    }

    /// `sd-server` model arguments for this variant: the transformer(s), each
    /// companion, and CPU offload (every 5B/14B example in the engine's Wan
    /// guide offloads, since the weights rarely fit consumer VRAM).
    pub fn launch_args(self, model: &Path) -> Result<Vec<String>, String> {
        let mut args = Vec::new();
        match self.transformer_pair(model) {
            Some(pair) => {
                let (low, high) = pair?;
                args.push("--diffusion-model".to_owned());
                args.push(low.to_string_lossy().into_owned());
                args.push("--high-noise-diffusion-model".to_owned());
                args.push(high.to_string_lossy().into_owned());
            }
            None => {
                args.push("--diffusion-model".to_owned());
                args.push(model.to_string_lossy().into_owned());
            }
        }
        for companion in self.companions() {
            args.push(companion.flag().to_owned());
            args.push(companion.path().to_string_lossy().into_owned());
        }
        args.push("--offload-to-cpu".to_owned());
        Ok(args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIRST: LocalVideoInputs = LocalVideoInputs {
        first_frame: true,
        last_frame: false,
    };
    const BOTH: LocalVideoInputs = LocalVideoInputs {
        first_frame: true,
        last_frame: true,
    };

    #[test]
    fn wan_frame_variants_are_classified_from_published_file_names() {
        let cases = [
            ("wan2.1-i2v-14b-480p-Q4_K_M", Some(WanFrameModel::Wan21I2v)),
            ("wan2.1-i2v-14b-720p-Q8_0", Some(WanFrameModel::Wan21I2v)),
            ("Wan2.1_I2V_14B-Q4", Some(WanFrameModel::Wan21I2v)),
            (
                "wan2.1-flf2v-14b-720p-Q4_K_M",
                Some(WanFrameModel::Wan21Flf2v),
            ),
            ("Wan2.2-TI2V-5B-Q4_K_M", Some(WanFrameModel::Wan22Ti2v)),
            (
                "Wan2.2-I2V-A14B-LowNoise-Q4_K_M",
                Some(WanFrameModel::Wan22I2vA14b),
            ),
            (
                "Wan2.2-I2V-A14B-HighNoise-Q4_K_M",
                Some(WanFrameModel::Wan22I2vA14b),
            ),
            // Text-to-video, VACE, speech-to-video and unversioned names are
            // not frame models.
            (downloader::VIDEO_DEFAULT_STEM, None),
            ("Wan2.2-T2V-A14B-LowNoise-Q8_0", None),
            ("wan2.1-vace-1.3b-q8_0", None),
            ("wan2.2_s2v-14B-Q8_0", None),
            ("i2v-anything-q4", None),
            ("multi2video", None),
            // An A14B transformer without a noise role cannot be paired.
            ("Wan2.2-I2V-A14B-Q4_K_M", None),
        ];
        for (stem, expected) in cases {
            assert_eq!(WanFrameModel::from_stem(stem), expected, "{stem}");
        }
    }

    #[test]
    fn frame_support_and_companions_follow_the_engine_guide() {
        assert_eq!(WanFrameModel::Wan21I2v.inputs(), FIRST);
        assert_eq!(WanFrameModel::Wan22Ti2v.inputs(), FIRST);
        assert_eq!(WanFrameModel::Wan21Flf2v.inputs(), BOTH);
        assert_eq!(WanFrameModel::Wan22I2vA14b.inputs(), BOTH);

        let flags = |model: WanFrameModel| -> Vec<&str> {
            model
                .companions()
                .iter()
                .map(|companion| companion.flag())
                .collect()
        };
        assert_eq!(
            flags(WanFrameModel::Wan21Flf2v),
            ["--t5xxl", "--vae", "--clip_vision"]
        );
        assert_eq!(
            WanFrameModel::Wan22Ti2v.companions(),
            [FrameCompanion::TextEncoder, FrameCompanion::Wan22Vae]
        );
        assert!(!WanFrameModel::Wan22I2vA14b
            .companions()
            .contains(&FrameCompanion::ClipVision));
    }

    #[test]
    fn single_file_variants_launch_with_diffusion_model_and_their_companions() {
        let model = std::env::temp_dir().join("wan2.1-flf2v-14b-720p-Q4_K_M.gguf");
        let args = WanFrameModel::Wan21Flf2v.launch_args(&model).unwrap();
        assert_eq!(args[0], "--diffusion-model");
        assert_eq!(args[1], model.to_string_lossy());
        assert!(!args.iter().any(|arg| arg == "-m"));
        let value_of = |flag: &str| {
            args.iter()
                .position(|arg| arg == flag)
                .map(|index| args[index + 1].clone())
                .unwrap_or_default()
        };
        assert!(value_of("--t5xxl").ends_with(downloader::VIDEO_T5XXL_FILE));
        assert!(value_of("--vae").ends_with(downloader::VIDEO_VAE_FILE));
        assert!(value_of("--clip_vision").ends_with(downloader::VIDEO_CLIP_VISION_FILE));
        assert_eq!(args.last().map(String::as_str), Some("--offload-to-cpu"));

        let ti2v = WanFrameModel::Wan22Ti2v
            .launch_args(Path::new("/models/Wan2.2-TI2V-5B-Q4_K_M.gguf"))
            .unwrap();
        let vae = ti2v.iter().position(|arg| arg == "--vae").unwrap();
        assert!(ti2v[vae + 1].ends_with(downloader::VIDEO_WAN22_VAE_FILE));
        assert!(!ti2v.iter().any(|arg| arg == "--clip_vision"));
    }

    #[test]
    fn a14b_pairs_resolve_both_halves_and_refuse_a_missing_half() {
        let dir = std::env::temp_dir().join(format!("ryu-wan-pair-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let low = dir.join("Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf");
        let high = dir.join("Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf");
        std::fs::write(&low, b"low").unwrap();

        let model = WanFrameModel::Wan22I2vA14b;
        assert!(!model.transformers_installed(&low));
        let error = model.launch_args(&low).unwrap_err();
        assert!(
            error.contains("Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf"),
            "{error}"
        );

        std::fs::write(&high, b"high").unwrap();
        for selected in [&low, &high] {
            assert!(model.transformers_installed(selected));
            let args = model.launch_args(selected).unwrap();
            assert_eq!(args[0], "--diffusion-model");
            assert_eq!(args[1], low.to_string_lossy());
            assert_eq!(args[2], "--high-noise-diffusion-model");
            assert_eq!(args[3], high.to_string_lossy());
            assert!(!args.iter().any(|arg| arg == "--clip_vision"));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a14b_pair_installed_from_the_published_repo_layout_resolves() {
        // QuantStack/Wan2.2-I2V-A14B-GGUF keeps each half in its own folder;
        // the catalog stores both under their basenames in the models dir.
        let published = [
            "LowNoise/Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf",
            "HighNoise/Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf",
        ];
        let dir = std::env::temp_dir().join(format!("ryu-wan-hub-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let installed: Vec<PathBuf> = published
            .iter()
            .map(|path| {
                let stem = crate::model_catalog::installed_stem_for_hub_path(path).unwrap();
                assert_eq!(
                    WanFrameModel::from_stem(&stem),
                    Some(WanFrameModel::Wan22I2vA14b),
                    "{stem}"
                );
                let file = dir.join(format!("{stem}.gguf"));
                std::fs::write(&file, b"weights").unwrap();
                file
            })
            .collect();
        let args = WanFrameModel::Wan22I2vA14b
            .launch_args(&installed[0])
            .unwrap();
        assert_eq!(args[1], installed[0].to_string_lossy());
        assert_eq!(args[3], installed[1].to_string_lossy());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sibling_stems_keep_the_file_spelling() {
        assert_eq!(
            sibling_stem("Wan2.2-I2V-A14B-LowNoise-Q8_0", NoiseRole::Low).as_deref(),
            Some("Wan2.2-I2V-A14B-HighNoise-Q8_0")
        );
        assert_eq!(
            sibling_stem("wan2.2_i2v_high_noise_14b_q4", NoiseRole::High).as_deref(),
            Some("wan2.2_i2v_low_noise_14b_q4")
        );
        assert_eq!(
            sibling_stem("WAN2.2-I2V-A14B-LOW-NOISE", NoiseRole::Low).as_deref(),
            Some("WAN2.2-I2V-A14B-HIGH-NOISE")
        );
    }
}
