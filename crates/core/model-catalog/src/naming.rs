//! Quant parsing and the path/filename/repo-id security guards.

use super::*;

pub(crate) fn split_id(id: &str) -> (String, String) {
    match id.split_once('/') {
        Some((a, n)) => (a.to_string(), n.to_string()),
        None => (String::new(), id.to_string()),
    }
}

/// A byte that separates name segments in a GGUF filename.
pub(crate) fn is_quant_sep(b: u8) -> bool {
    matches!(b, b'-' | b'_' | b'.' | b' ' | b'/')
}

/// Try to match a GGUF quant token starting exactly at `i`, returning its byte
/// length. Recognizes the four quant *families* by grammar instead of a fixed
/// token list, so community suffix variants (`Q4_K_P`, `Q4_K_XL`, `Q8_K_P`, …)
/// resolve too:
/// - importance-matrix: `IQ<1-4>_<letters>` (IQ2_XXS, IQ4_NL)
/// - K-quant: `Q<1-8>_K` with an optional `_<letters>` suffix (Q6_K, Q4_K_M, Q4_K_XL)
/// - legacy: `Q<1-8>_<0-1>` (Q4_0, Q8_0)
/// - float: `BF16`, `F16`, `F32`
pub(crate) fn match_quant_at(b: &[u8], i: usize) -> Option<usize> {
    let n = b.len();
    // Float formats.
    for tok in [b"BF16".as_slice(), b"F16", b"F32"] {
        if b[i..].starts_with(tok) {
            return Some(tok.len());
        }
    }
    // Importance-matrix: I Q <1-4> _ <letters+>
    if b[i] == b'I'
        && i + 3 < n
        && b[i + 1] == b'Q'
        && (b'1'..=b'4').contains(&b[i + 2])
        && b[i + 3] == b'_'
    {
        let mut j = i + 4;
        while j < n && b[j].is_ascii_alphabetic() {
            j += 1;
        }
        if j > i + 4 {
            return Some(j - i);
        }
    }
    // Q-quant: Q <1-8> _ …
    if b[i] == b'Q' && i + 3 < n && (b'1'..=b'8').contains(&b[i + 1]) && b[i + 2] == b'_' {
        // K-quant with an optional `_<letters>` suffix.
        if b[i + 3] == b'K' {
            let mut j = i + 4;
            if j < n && b[j] == b'_' {
                let mut k = j + 1;
                while k < n && b[k].is_ascii_alphabetic() {
                    k += 1;
                }
                if k > j + 1 {
                    j = k;
                }
            }
            return Some(j - i);
        }
        // Legacy: Q<d>_<0|1>.
        if b[i + 3] == b'0' || b[i + 3] == b'1' {
            return Some(4);
        }
    }
    None
}

/// Extract the quantization label from a GGUF filename, if present. Scans for a
/// separator-bounded quant token (see [`match_quant_at`]) and keeps the longest
/// match, so `gemma-4-it-Q4_K_M.gguf` → `Q4_K_M` and `model-Q3_K_P.gguf` →
/// `Q3_K_P`. Returns `None` only for genuinely non-standard / mixed quants.
pub(crate) fn parse_quant(filename: &str) -> Option<String> {
    let upper = filename.to_uppercase();
    let b = upper.as_bytes();
    let mut best: Option<(usize, usize)> = None;
    let mut i = 0;
    while i < b.len() {
        if let Some(len) = match_quant_at(b, i) {
            let left_ok = i == 0 || is_quant_sep(b[i - 1]);
            let right = i + len;
            let right_ok = right == b.len() || is_quant_sep(b[right]);
            if left_ok && right_ok {
                if best.is_none_or(|(_, bl)| len > bl) {
                    best = Some((i, len));
                }
                i = right;
                continue;
            }
        }
        i += 1;
    }
    best.map(|(s, l)| upper[s..s + l].to_string())
}

/// Local file stem used to store a downloaded GGUF (`models/chat/<stem>.gguf`).
/// A Hub path in a repo subfolder (`LowNoise/x.gguf`) is stored under its
/// basename, so the models directory stays flat.
pub(crate) fn local_stem(filename: &str) -> String {
    hub_basename(filename).trim_end_matches(".gguf").to_string()
}

/// The local stem a catalog install of Hub path `path` is stored under
/// (`models/<modality>/<stem>.gguf`), after the same validation the install runs.
pub fn installed_stem_for_hub_path(path: &str) -> Result<String> {
    validate_hub_gguf_path(path)?;
    Ok(local_stem(path))
}

/// The last `/`-separated component of a Hub repo path.
pub(crate) fn hub_basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Validate a GGUF path as the Hub lists it in a repo (`rfilename`), which may
/// sit in subfolders (`HighNoise/Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf`). The
/// full path only reaches the download URL; the file is stored under its
/// basename, which must pass [`validate_gguf_filename`]. Every folder segment
/// must be a plain name (`[A-Za-z0-9._-]`, no leading `.`), so `..`, empty
/// segments, absolute paths, backslashes and drive prefixes stay rejected.
pub fn validate_hub_gguf_path(path: &str) -> Result<()> {
    let basename = hub_basename(path);
    validate_gguf_filename(basename)?;
    let folders = &path[..path.len() - basename.len()];
    for segment in folders.split_terminator('/') {
        let plain = !segment.is_empty()
            && !segment.starts_with('.')
            && segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
        if !plain {
            anyhow::bail!("unsafe filename: {path}");
        }
    }
    Ok(())
}

/// Reject anything that isn't a single, safe GGUF filename. The name must be one
/// normal path component — no `/`, `\`, `..`, or leading `.` — ending in
/// `.gguf`. This is security-critical: `filename` becomes the on-disk stem
/// (`models/<modality>/<stem>.gguf`, see [`gguf_download_spec`]), so an
/// unchecked `..`, path separator, or absolute path from the install endpoint
/// would let a caller write the downloaded bytes anywhere on disk (path
/// traversal / arbitrary file write).
pub fn validate_gguf_filename(name: &str) -> Result<()> {
    use std::ffi::OsStr;
    use std::path::{Component, Path};

    if !name.to_lowercase().ends_with(".gguf") {
        anyhow::bail!("only .gguf files can be installed (got {name})");
    }
    if name.starts_with('.') || name.contains('/') || name.contains('\\') {
        anyhow::bail!("unsafe filename: {name}");
    }
    // The whole string must be exactly one normal component (rejects `.`, `..`,
    // and Windows drive/UNC prefixes that `PathBuf::join` would otherwise honor).
    let mut comps = Path::new(name).components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(only)), None) if only == OsStr::new(name) => Ok(()),
        _ => anyhow::bail!("unsafe filename: {name}"),
    }
}

/// Read-only projection of the files a GGUF uninstall would remove.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallPlan {
    pub repo_id: String,
    pub filename: String,
    pub model_path: String,
    pub model_exists: bool,
    pub adapter_path: String,
    pub adapter_exists: bool,
}

pub fn plan_uninstall_file(repo_id: &str, filename: &str) -> Result<UninstallPlan> {
    validate_hub_gguf_path(filename)?;
    let stem = local_stem(filename);
    let model_path = installed::model_file_path(&stem);
    let adapter_path = installed::mmproj_file_path(&stem);
    Ok(UninstallPlan {
        repo_id: repo_id.to_owned(),
        filename: filename.to_owned(),
        model_path: model_path.to_string_lossy().to_string(),
        model_exists: model_path.exists(),
        adapter_path: adapter_path.to_string_lossy().to_string(),
        adapter_exists: adapter_path.exists(),
    })
}

/// Validate a Hugging Face repo id (`author/name`). Both segments must be
/// non-empty, free of `..`, and contain only `[A-Za-z0-9._-]`. `repo_id` is
/// interpolated into Hub URLs and used to look up the expected checksum, so an
/// unvalidated id could manipulate the request path.
pub(crate) fn validate_repo_id(id: &str) -> Result<()> {
    fn ok_segment(s: &str) -> bool {
        !s.is_empty()
            && s != "."
            && s != ".."
            && !s.contains("..")
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    }
    match id.split_once('/') {
        Some((author, name)) if ok_segment(author) && ok_segment(name) => Ok(()),
        _ => anyhow::bail!("unsafe repo id: {id}"),
    }
}

#[cfg(test)]
#[path = "naming_tests.rs"]
mod tests;
