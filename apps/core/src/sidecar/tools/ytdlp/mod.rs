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
    let entries =
        std::fs::read_dir(work_dir).with_context(|| format!("reading {}", work_dir.display()))?;
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
        if !text.is_empty() && cues.last().map(|c| c.text != text).unwrap_or(true) {
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

    #[test]
    fn parse_vtt_skips_header_and_note_lines_and_blanks() {
        // The header prefixes (WEBVTT/NOTE/Kind:/Language:) and blank lines never
        // contribute transcript text; the caption body does.
        let vtt = "WEBVTT\nKind: captions\nLanguage: en\n\nNOTE this is metadata\n\n00:00:01.000 --> 00:00:02.000\nreal caption\n";
        let text = parse_vtt(vtt);
        assert_eq!(text, "real caption");
    }

    #[test]
    fn parse_vtt_empty_input_yields_empty_string() {
        assert_eq!(parse_vtt(""), "");
        assert_eq!(parse_vtt("WEBVTT\n\n"), "");
    }

    #[test]
    fn strip_tags_removes_angle_markup_only() {
        assert_eq!(strip_tags("plain"), "plain");
        assert_eq!(strip_tags("<c>hi</c>"), "hi");
        assert_eq!(strip_tags("<00:00:01.000>word"), "word");
        // Unclosed tag: everything after `<` is swallowed until a `>` (none here).
        assert_eq!(strip_tags("keep<unclosed"), "keep");
        // Nested/adjacent tags all vanish, surrounding text preserved.
        assert_eq!(strip_tags("a<b><i>c</i></b>d"), "acd");
    }

    #[test]
    fn parse_vtt_timestamp_handles_all_colon_arities() {
        // [h,m,s] full form.
        assert_eq!(parse_vtt_timestamp("01:02:03.500"), Some(3_723_500));
        // [m,s] form (no hours).
        assert_eq!(parse_vtt_timestamp("02:03.000"), Some(123_000));
        // [s] bare seconds.
        assert_eq!(parse_vtt_timestamp("03.250"), Some(3_250));
        // Zero.
        assert_eq!(parse_vtt_timestamp("00:00:00.000"), Some(0));
    }

    #[test]
    fn parse_vtt_timestamp_accepts_comma_millis_and_rejects_garbage() {
        // SRT-style comma decimal is normalised to a dot.
        assert_eq!(parse_vtt_timestamp("00:00:01,500"), Some(1_500));
        // Non-numeric component → None (not a panic).
        assert_eq!(parse_vtt_timestamp("aa:bb:cc.ddd"), None);
        // Too many colon segments → None.
        assert_eq!(parse_vtt_timestamp("1:2:3:4.000"), None);
    }

    #[test]
    fn parse_cue_timing_reads_endpoints_and_ignores_settings() {
        // Trailing cue settings after the end timestamp are ignored.
        let (start, end) =
            parse_cue_timing("00:00:01.000 --> 00:00:03.500 align:start position:0%").unwrap();
        assert_eq!(start, 1_000);
        assert_eq!(end, 3_500);
        // Missing `-->` arrow → None (guarded by the caller's `contains("-->")`, but
        // the parser must still fail closed if handed a malformed line).
        assert_eq!(parse_cue_timing("00:00:01.000 00:00:03.000"), None);
    }

    #[test]
    fn parse_vtt_cues_yields_timed_cues_and_dedups_consecutive() {
        let vtt = "WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nHello <c>world</c>\n\n\
                   2\n00:00:02.000 --> 00:00:04.000\nHello world\n\n\
                   3\n00:00:04.000 --> 00:00:06.000\nsecond cue\n";
        let cues = parse_vtt_cues(vtt);
        // The two identical "Hello world" cues collapse to one; "second cue" survives.
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].text, "Hello world");
        assert_eq!(cues[0].start_ms, 0);
        assert_eq!(cues[0].end_ms, 2_000);
        assert_eq!(cues[1].text, "second cue");
        assert_eq!(cues[1].start_ms, 4_000);
    }

    #[test]
    fn parse_vtt_cues_multiline_text_joins_with_spaces() {
        let vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nline one\nline two\n";
        let cues = parse_vtt_cues(vtt);
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "line one line two");
    }

    #[test]
    fn parse_vtt_cues_empty_when_no_timings() {
        // Header-only / caption-less input yields no cues (unsubtitled video).
        assert!(parse_vtt_cues("WEBVTT\nKind: captions\n").is_empty());
        assert!(parse_vtt_cues("").is_empty());
    }

    #[test]
    fn find_downloaded_video_prefers_merged_mp4() {
        let dir = std::env::temp_dir().join(format!("ryu-ytdlp-vid-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // Both an intermediate webm and the merged mp4 exist; mp4 must win.
        std::fs::write(dir.join("video.webm"), b"x").unwrap();
        std::fs::write(dir.join("video.mp4"), b"x").unwrap();
        // A non-`video` stem must be ignored entirely.
        std::fs::write(dir.join("thumbnail.jpg"), b"x").unwrap();
        let found = find_downloaded_video(&dir).unwrap();
        assert_eq!(found.file_name().unwrap(), "video.mp4");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn find_downloaded_video_falls_back_to_other_container() {
        let dir = std::env::temp_dir().join(format!("ryu-ytdlp-mkv-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("video.mkv"), b"x").unwrap();
        let found = find_downloaded_video(&dir).unwrap();
        assert_eq!(found.file_name().unwrap(), "video.mkv");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn find_downloaded_video_errors_when_absent() {
        let dir = std::env::temp_dir().join(format!("ryu-ytdlp-none-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // Only a subtitle, no video file at all.
        std::fs::write(dir.join("video.vtt"), b"WEBVTT\n").unwrap();
        assert!(find_downloaded_video(&dir).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn first_vtt_and_captions_text_read_the_subtitle() {
        let dir = std::env::temp_dir().join(format!("ryu-ytdlp-cap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("video.en.vtt"),
            "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\ncaption body\n",
        )
        .unwrap();
        assert!(first_vtt(&dir).is_some());
        assert_eq!(find_captions_text(&dir).as_deref(), Some("caption body"));
        let segs = find_caption_segments(&dir);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].text, "caption body");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn caption_helpers_are_none_when_no_vtt() {
        let dir = std::env::temp_dir().join(format!("ryu-ytdlp-novtt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("video.mp4"), b"x").unwrap();
        assert!(first_vtt(&dir).is_none());
        assert!(find_captions_text(&dir).is_none());
        assert!(find_caption_segments(&dir).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn download_video_refuses_non_http_url() {
        // The arg-injection guard: a URL that is not http(s) must bail BEFORE spawning
        // yt-dlp, so a `--exec=…`-style value can never be read as a flag.
        let dir = std::env::temp_dir().join(format!("ryu-ytdlp-guard-{}", uuid::Uuid::new_v4()));
        for evil in ["--exec=rm -rf /", "file:///etc/passwd", "-o/tmp/x", "ftp://h/x"] {
            // `DownloadedVideo` is not `Debug`, so avoid `expect_err`; inspect the Err.
            let err = download_video(evil, &dir, None, None)
                .await
                .err()
                .expect("non-http(s) url must be refused");
            assert!(
                err.to_string().contains("refusing to download non-http(s)"),
                "got: {err}"
            );
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ytdlp_bin_path_lives_under_ryu_bin() {
        let p = ytdlp_bin_path();
        assert!(p.ends_with(if cfg!(target_os = "windows") {
            "yt-dlp.exe"
        } else {
            "yt-dlp"
        }));
        assert_eq!(p.parent().unwrap().file_name().unwrap(), "bin");
    }
}
