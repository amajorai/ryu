//! yt-dlp — the swappable default video downloader for Ryu Clips ingest.
//!
//! Core owns *what runs* (CLAUDE.md §1): resolving a watched URL into a local
//! video + best-effort captions is orchestration, so it lives here. The binary
//! is managed like every other tool (Ghost/Restate) — pinned default version,
//! `RYU_YTDLP_URL`/`RYU_YTDLP_VERSION` overrides, installed through the modern
//! [`crate::downloads::DownloadCenter`] (#456) so it streams to disk with resume.
//!
//! yt-dlp is a single-file binary (no archive to extract), so [`downloader`]
//! clones Ghost's flow but drops the extraction step.

pub mod downloader;

pub use downloader::YtDlpDownloader;

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::win_process::NoWindow;

/// Absolute path to the managed yt-dlp binary (`~/.ryu/bin/yt-dlp[.exe]`).
///
/// Single source of truth for both existence checks and spawning — always spawn
/// via this absolute path, never a bare `yt-dlp`, so a fresh install (nothing on
/// PATH yet) still works on Windows.
pub fn ytdlp_bin_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    };
    crate::paths::ryu_dir().join("bin").join(name)
}

/// A downloaded video plus any captions yt-dlp pulled alongside it.
pub struct DownloadedVideo {
    pub video: PathBuf,
    /// Plain-text captions (deduped, tags stripped) for the transcript body.
    pub captions: Option<String>,
    /// Timed caption cues parsed from the same `.vtt`, for transcript segments.
    pub caption_segments: Vec<CaptionCue>,
}

/// One timed caption cue parsed from a WebVTT subtitle.
#[derive(Debug, Clone)]
pub struct CaptionCue {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// Download `url` into `work_dir` as `video.<ext>` (merged to mp4 when possible),
/// also requesting English subtitles (manual + auto) so ingest can go
/// captions-first. `start`/`end` (ms) trim the download to a section when set,
/// saving bandwidth; the resulting file's timeline is 0-based for that section.
pub async fn download_video(
    url: &str,
    work_dir: &Path,
    start: Option<u64>,
    end: Option<u64>,
) -> Result<DownloadedVideo> {
    tokio::fs::create_dir_all(work_dir)
        .await
        .with_context(|| format!("creating clip work dir {}", work_dir.display()))?;

    let bin = ytdlp_bin_path();
    let out_template = work_dir.join("video.%(ext)s");

    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("-f")
        .arg("bv*+ba/b")
        .arg("--merge-output-format")
        .arg("mp4")
        .arg("--no-playlist")
        .arg("--no-progress")
        .arg("--write-subs")
        .arg("--write-auto-subs")
        .arg("--sub-langs")
        .arg("en.*")
        .arg("--sub-format")
        .arg("vtt")
        .arg("-o")
        .arg(&out_template);

    // Trim at download when a section is requested (yt-dlp `*start-end`, seconds).
    if start.is_some() || end.is_some() {
        let start_s = start.unwrap_or(0) as f64 / 1000.0;
        let section = match end {
            Some(e) => format!("*{start_s}-{}", e as f64 / 1000.0),
            None => format!("*{start_s}-inf"),
        };
        cmd.arg("--download-sections").arg(section);
    }

    // Argument-injection guard: the URL is untrusted (comes from a watched clip
    // source), so a value like `--exec=…`, `-o`, or `--config-location` would be
    // read by yt-dlp as a flag rather than a positional. Require an http(s) URL
    // (which also can't start with `-`) and insert an end-of-options marker so
    // everything after `--` is treated as positional.
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        anyhow::bail!("refusing to download non-http(s) URL: {url}");
    }
    cmd.arg("--");
    cmd.arg(url);
    cmd.no_window();

    let output = cmd
        .output()
        .await
        .with_context(|| format!("spawning yt-dlp at {}", bin.display()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("yt-dlp failed: {stderr}");
    }

    let video = find_downloaded_video(work_dir)
        .with_context(|| format!("no video file produced in {}", work_dir.display()))?;
    let captions = find_captions_text(work_dir);
    let caption_segments = find_caption_segments(work_dir);

    Ok(DownloadedVideo {
        video,
        captions,
        caption_segments,
    })
}

/// Find the produced `video.<ext>` file, preferring the merged mp4.
fn find_downloaded_video(work_dir: &Path) -> Result<PathBuf> {
    const VIDEO_EXTS: &[&str] = &["mp4", "mkv", "webm", "mov", "m4v"];

    let mut candidate: Option<PathBuf> = None;
    let entries = std::fs::read_dir(work_dir)
        .with_context(|| format!("reading {}", work_dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let stem_ok = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s == "video")
            .unwrap_or(false);
        if !stem_ok {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if ext == "mp4" {
            return Ok(path); // merged mp4 always wins
        }
        if VIDEO_EXTS.contains(&ext.as_str()) {
            candidate = Some(path);
        }
    }
    candidate.ok_or_else(|| anyhow::anyhow!("no video.* file found"))
}

/// The first `.vtt` subtitle file in `work_dir`, if any.
fn first_vtt(work_dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(work_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_vtt = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("vtt"))
            .unwrap_or(false);
        if is_vtt {
            return Some(path);
        }
    }
    None
}

/// Read the first `.vtt` subtitle in `work_dir` and parse it to plain transcript
/// text. Returns `None` when there are no captions (an unsubtitled video).
fn find_captions_text(work_dir: &Path) -> Option<String> {
    let vtt = first_vtt(work_dir)?;
    let raw = std::fs::read_to_string(&vtt).ok()?;
    let text = parse_vtt(&raw);
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Read the first `.vtt` subtitle in `work_dir` and parse it to timed cues.
/// Returns an empty vec when there are no captions.
fn find_caption_segments(work_dir: &Path) -> Vec<CaptionCue> {
    let Some(vtt) = first_vtt(work_dir) else {
        return Vec::new();
    };
    match std::fs::read_to_string(&vtt) {
        Ok(raw) => parse_vtt_cues(&raw),
        Err(_) => Vec::new(),
    }
}

/// Parse WebVTT into timed cues: each `HH:MM:SS.mmm --> HH:MM:SS.mmm` timing line
/// with the (tag-stripped) text lines that follow it, collapsing consecutive
/// duplicate cue texts the auto-generated rolling captions repeat.
pub fn parse_vtt_cues(vtt: &str) -> Vec<CaptionCue> {
    let mut cues: Vec<CaptionCue> = Vec::new();
    let mut cur: Option<(u64, u64)> = None;
    let mut buf: Vec<String> = Vec::new();

    for raw in vtt.lines() {
        let line = raw.trim();
        if line.contains("-->") {
            flush_cue(&mut cur, &mut buf, &mut cues);
            cur = parse_cue_timing(line);
            continue;
        }
        if line.is_empty() {
            flush_cue(&mut cur, &mut buf, &mut cues);
            continue;
        }
        if line.starts_with("WEBVTT")
            || line.starts_with("NOTE")
            || line.starts_with("Kind:")
            || line.starts_with("Language:")
            || line.starts_with("STYLE")
        {
            continue;
        }
        // Cue number line (pure digits).
        if line.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        if cur.is_some() {
            let cleaned = strip_tags(line);
            let cleaned = cleaned.trim();
            if !cleaned.is_empty() {
                buf.push(cleaned.to_string());
            }
        }
    }
    flush_cue(&mut cur, &mut buf, &mut cues);
    cues
}

/// Emit the accumulated cue (if any) into `cues`, deduping consecutive identical
/// texts, then clear the text buffer.
fn flush_cue(cur: &mut Option<(u64, u64)>, buf: &mut Vec<String>, cues: &mut Vec<CaptionCue>) {
    if let Some((start_ms, end_ms)) = cur.take() {
        let text = buf.join(" ").trim().to_string();
        if !text.is_empty()
            && cues
                .last()
                .map(|c| c.text != text)
                .unwrap_or(true)
        {
            cues.push(CaptionCue {
                start_ms,
                end_ms,
                text,
            });
        }
    }
    buf.clear();
}

/// Parse a `HH:MM:SS.mmm --> HH:MM:SS.mmm [settings]` cue-timing line into
/// `(start_ms, end_ms)`.
fn parse_cue_timing(line: &str) -> Option<(u64, u64)> {
    let mut parts = line.split("-->");
    let start = parse_vtt_timestamp(parts.next()?.trim())?;
    let end_tok = parts.next()?.trim().split_whitespace().next()?;
    let end = parse_vtt_timestamp(end_tok)?;
    Some((start, end))
}

/// Parse a `[[HH:]MM:]SS.mmm` (or `,mmm`) timestamp into milliseconds.
fn parse_vtt_timestamp(s: &str) -> Option<u64> {
    let segs: Vec<&str> = s.trim().split(':').collect();
    let (h, m, sec_str) = match segs.as_slice() {
        [h, m, s] => (h.parse::<u64>().ok()?, m.parse::<u64>().ok()?, *s),
        [m, s] => (0, m.parse::<u64>().ok()?, *s),
        [s] => (0, 0, *s),
        _ => return None,
    };
    let secs: f64 = sec_str.replace(',', ".").parse().ok()?;
    Some(((h * 3600 + m * 60) as f64 * 1000.0 + secs * 1000.0) as u64)
}

/// Parse WebVTT cue text into a plain transcript: drop the `WEBVTT` header,
/// cue-timing lines, cue numbers, and `<...>` tags, and collapse the consecutive
/// duplicate lines auto-generated (rolling) captions are full of.
pub fn parse_vtt(vtt: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for raw in vtt.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with("WEBVTT")
            || line.starts_with("NOTE")
            || line.starts_with("Kind:")
            || line.starts_with("Language:")
            || line.starts_with("STYLE")
        {
            continue;
        }
        // Cue-timing line: `00:00:01.000 --> 00:00:03.000 ...`.
        if line.contains("-->") {
            continue;
        }
        // Cue number line (pure digits).
        if line.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let cleaned = strip_tags(line);
        let cleaned = cleaned.trim();
        if cleaned.is_empty() {
            continue;
        }
        if out.last().map(|l| l == cleaned).unwrap_or(false) {
            continue; // dedupe consecutive identical caption lines
        }
        out.push(cleaned.to_string());
    }
    out.join(" ")
}

/// Strip `<...>` markup (inline `<c>`/timestamp tags) from a caption line.
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_vtt_strips_headers_timings_and_tags() {
        let vtt = "WEBVTT\nKind: captions\nLanguage: en\n\n1\n00:00:00.000 --> 00:00:02.000\nHello <00:00:01.000><c>there</c>\n\n2\n00:00:02.000 --> 00:00:04.000\nHello there\nsecond line\n";
        let text = parse_vtt(vtt);
        assert!(text.contains("Hello there"));
        assert!(text.contains("second line"));
        assert!(!text.contains("-->"));
        assert!(!text.contains("WEBVTT"));
        assert!(!text.contains("<c>"));
        // consecutive duplicate "Hello there" collapses to one occurrence.
        assert_eq!(text.matches("Hello there").count(), 1);
    }
}
