//! Reference-audio handling for voice cloning: data-URL decoding, private
//! staging under the node's voice directory, the boot sweep, and path checks.

use super::*;

pub(super) const MAX_REFERENCE_AUDIO_BYTES: usize = 512 * 1024;

pub(super) fn decode_reference_audio_data_url(value: &str) -> Result<Vec<u8>, String> {
    let encoded = value
        .strip_prefix("data:audio/wav;base64,")
        .ok_or_else(|| "voice sample must be a WAV data URL".to_owned())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "voice sample is not valid base64".to_owned())?;
    if bytes.is_empty() || bytes.len() > MAX_REFERENCE_AUDIO_BYTES {
        return Err(format!(
            "voice sample must be between 1 byte and {MAX_REFERENCE_AUDIO_BYTES} bytes"
        ));
    }
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("voice sample must contain a valid WAV header".to_owned());
    }
    Ok(bytes)
}

/// Where a voice sample sent inline (`reference_audio_data_url`) is staged for
/// the length of one synthesis call: an owner-only scratch directory (0700, file
/// 0600) under the data dir's `tmp/voice`, never the persistent reference
/// directory. The voice engines need a path, so the sample is plaintext on disk
/// only while that request runs; a crash leaves an orphan that
/// [`sweep_voice_staging_at_boot`] removes when Core next starts.
pub(super) fn reference_audio_staging_dir() -> PathBuf {
    crate::paths::tmp_dir_for("voice").join("reference-audio")
}

/// Remove, once per process, every voice sample a previous process left
/// staged (crash orphans in the staging directory, and the plaintext `.tmp*.wav`
/// samples earlier builds staged in the persistent reference directory). Core
/// runs it while starting; staging also runs it first, as a backstop. The sweep
/// sits behind a `Once`, so it finishes before this process stages any sample
/// and never removes one in use. Returns how many files the sweep removed (0 on
/// every call after the first).
pub(crate) fn sweep_voice_staging_at_boot() -> usize {
    static SWEPT: std::sync::Once = std::sync::Once::new();
    let mut removed = 0;
    SWEPT.call_once(|| {
        removed = sweep_staged_reference_audio(
            &reference_audio_staging_dir(),
            &crate::paths::files_path("voice").join("reference-audio"),
            std::time::Duration::ZERO,
        );
        if removed > 0 {
            tracing::info!(removed, "voice: removed orphaned staged voice samples");
        }
    });
    removed
}

pub(super) fn stage_reference_audio_data_url(value: &str) -> Result<NamedTempFile, String> {
    sweep_voice_staging_at_boot();
    stage_reference_audio_data_url_in(value, &reference_audio_staging_dir())
}

/// Create `dir` (and parents) and restrict it to the owner.
pub(super) fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

pub(super) fn stage_reference_audio_data_url_in(
    value: &str,
    root: &Path,
) -> Result<NamedTempFile, String> {
    let bytes = decode_reference_audio_data_url(value)?;
    ensure_private_dir(root).map_err(|error| format!("voice reference directory: {error}"))?;
    // `tempfile` creates the file 0600 with a unique name and deletes it on drop.
    let mut file = tempfile::Builder::new()
        .prefix(STAGED_REFERENCE_PREFIX)
        .suffix(".wav")
        .tempfile_in(root)
        .map_err(|error| format!("creating temporary voice reference: {error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("staging voice reference: {error}"))?;
    file.flush()
        .map_err(|error| format!("staging voice reference: {error}"))?;
    Ok(file)
}

/// Name prefix of every staged sample (also the prefix earlier builds' staged
/// samples carried in the persistent reference directory: `tempfile`'s default).
pub(super) const STAGED_REFERENCE_PREFIX: &str = ".tmp";

/// Remove staged samples left behind by a crash: every staged `.tmp*.wav` in
/// `staging` older than `min_age`, and the plaintext `.tmp*.wav` orphans earlier
/// builds staged inside the persistent reference directory `legacy` (files a user
/// placed there are never touched). Returns how many files were removed.
pub(super) fn sweep_staged_reference_audio(
    staging: &Path,
    legacy: &Path,
    min_age: std::time::Duration,
) -> usize {
    let mut removed = 0;
    for (dir, min_age) in [(staging, min_age), (legacy, std::time::Duration::ZERO)] {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !(name.starts_with(STAGED_REFERENCE_PREFIX) && name.ends_with(".wav")) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            let age = metadata
                .modified()
                .ok()
                .and_then(|modified| modified.elapsed().ok())
                .unwrap_or_default();
            if age < min_age {
                continue;
            }
            if std::fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

/// Reference audio is a local-only, operator-mediated input. Do not forward raw
/// URLs or arbitrary absolute paths to a cloning backend: those backends may fetch
/// the value themselves. The narrow root also keeps voice references separate from
/// Core databases, tokens, and other node data.
pub(super) fn validate_reference_audio(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err(
            "reference_audio must be a file beneath the node voice reference directory".to_owned(),
        );
    }
    let root: PathBuf = crate::paths::files_path("voice").join("reference-audio");
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("voice reference directory: {error}"))?;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| "reference_audio file was not found".to_owned())?;
    if metadata.file_type().is_symlink() {
        return Err("reference_audio symbolic links are not allowed".to_owned());
    }
    let canonical_root = std::fs::canonicalize(&root)
        .map_err(|error| format!("voice reference directory: {error}"))?;
    // A sample sent inline is staged in the private scratch directory instead.
    let canonical_staging = std::fs::canonicalize(reference_audio_staging_dir()).ok();
    let canonical =
        std::fs::canonicalize(path).map_err(|_| "reference_audio file was not found".to_owned())?;
    let inside = canonical.starts_with(&canonical_root)
        || canonical_staging
            .as_ref()
            .is_some_and(|staging| canonical.starts_with(staging));
    if !inside || !canonical.is_file() {
        return Err(
            "reference_audio must be beneath the node voice reference directory".to_owned(),
        );
    }
    Ok(Some(canonical.to_string_lossy().into_owned()))
}
