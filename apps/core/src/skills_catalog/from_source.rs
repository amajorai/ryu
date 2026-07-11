//! Direct skill install from a source reference (issue #462).
//!
//! Resolves a single user-supplied `source` string into a fetch strategy, pulls
//! the repository (or reads a local path), walks the common container layouts to
//! locate every `SKILL.md`, and copies the **entire** skill directory into the
//! universal Agent Skills location `~/.claude/skills/<name>/`. Copying the whole
//! directory (not just SKILL.md) is deliberate: it beats the upstream skills CLI's
//! SKILL.md-only bug, so bundled resources (references, scripts, assets) come along.
//!
//! Placement (Core vs Gateway, CLAUDE.md §1): resolving + installing a skill is
//! "what runs", so it lives in Core. The Gateway still governs egress at chat time.
//!
//! ## The six source forms
//!
//! | Form                                                | Strategy                         |
//! |-----------------------------------------------------|----------------------------------|
//! | `owner/repo`                                        | tarball (github codeload)        |
//! | `https://github.com/owner/repo`                     | tarball (github codeload)        |
//! | `https://github.com/owner/repo/tree/<ref>/<subdir>` | tarball at `<ref>`, scoped subdir|
//! | `https://gitlab.com/owner/repo` (and subgroups)     | tarball (gitlab archive)         |
//! | `git@host:owner/repo.git`                            | `git clone --depth 1`            |
//! | `/abs/path` or `./rel/path` (existing dir)          | local copy                       |
//!
//! Remote https tarball hosts go through the same SSRF guard the rest of Core uses
//! before any fetch. `git@`/SSH clones shell out to the `git` CLI via
//! `std::process::Command` with **separate args** (never a shell string), so a
//! crafted source can't inject extra commands. A `.tar.gz` fetch is always tried
//! first; `git clone --depth 1` is the fallback when no archive endpoint applies
//! (SSH) or the archive fetch fails.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::skills_catalog::InstallResult;

/// How to obtain the repository contents for a parsed source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchStrategy {
    /// Download + extract a `.tar.gz` archive from `url`. When `subdir` is set,
    /// only that path within the archive is searched for skills.
    Tarball {
        url: String,
        /// Optional path within the repo to scope the skill search to.
        subdir: Option<String>,
    },
    /// `git clone --depth 1 <url>` into a temp dir (used for `git@` SSH and as a
    /// fallback). `subdir`, when set, scopes the post-clone skill search.
    GitClone { url: String, subdir: Option<String> },
    /// Read skills directly from an existing local directory.
    LocalPath { path: PathBuf },
}

/// A parsed source: the strategy plus a human label for errors/logs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSource {
    pub strategy: FetchStrategy,
    /// The original source string, for error messages.
    pub original: String,
}

/// `owner/repo` shorthand: two non-empty path-safe segments, no scheme, no spaces.
fn is_owner_repo_shorthand(s: &str) -> bool {
    let parts: Vec<&str> = s.split('/').collect();
    if parts.len() != 2 {
        return false;
    }
    let segment_ok = |seg: &str| {
        !seg.is_empty()
            && seg != "."
            && seg != ".."
            && !seg.contains(' ')
            && seg
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    segment_ok(parts[0]) && segment_ok(parts[1])
}

/// Strip a trailing `.git` from a repo name.
fn strip_git_suffix(s: &str) -> &str {
    s.strip_suffix(".git").unwrap_or(s)
}

/// Build the github codeload tarball URL for `owner/repo` at `git_ref` (a branch
/// or tag). github redirects `HEAD` to the default branch's tarball.
fn github_tarball(owner: &str, repo: &str, git_ref: &str) -> String {
    format!("https://codeload.github.com/{owner}/{repo}/tar.gz/{git_ref}")
}

/// Build the gitlab archive tarball URL. gitlab project paths may include
/// subgroups (`group/subgroup/repo`), so `project` is the full slash path.
fn gitlab_tarball(host: &str, project: &str, git_ref: &str) -> String {
    format!("https://{host}/{project}/-/archive/{git_ref}/archive.tar.gz")
}

/// Parse a single source string into a [`ParsedSource`]. Pure + offline: it only
/// classifies the form and computes URLs, never touching the network or disk
/// (except an `exists()` check to recognize a local path).
pub fn parse_source(raw: &str) -> Result<ParsedSource> {
    let source = raw.trim();
    if source.is_empty() {
        anyhow::bail!("source must not be empty");
    }

    // Form 5: git@ SSH — clone-only (no archive endpoint).
    if source.starts_with("git@") || source.starts_with("ssh://") {
        return Ok(ParsedSource {
            strategy: FetchStrategy::GitClone {
                url: source.to_string(),
                subdir: None,
            },
            original: source.to_string(),
        });
    }

    // Forms 2/3/4: explicit http(s) URLs.
    if source.starts_with("http://") || source.starts_with("https://") {
        return parse_http_url(source);
    }

    // Form 6: an existing local filesystem directory.
    let as_path = Path::new(source);
    if as_path.exists() {
        if !as_path.is_dir() {
            anyhow::bail!("local source path is not a directory: {source}");
        }
        return Ok(ParsedSource {
            strategy: FetchStrategy::LocalPath {
                path: as_path.to_path_buf(),
            },
            original: source.to_string(),
        });
    }

    // Form 1: `owner/repo` shorthand (default to github HEAD).
    if is_owner_repo_shorthand(source) {
        let (owner, repo) = source.split_once('/').expect("checked two segments");
        let repo = strip_git_suffix(repo);
        return Ok(ParsedSource {
            strategy: FetchStrategy::Tarball {
                url: github_tarball(owner, repo, "HEAD"),
                subdir: None,
            },
            original: source.to_string(),
        });
    }

    anyhow::bail!(
        "unrecognized skill source '{source}' (expected owner/repo, a github/gitlab URL, a git@ SSH url, or an existing local path)"
    )
}

/// Parse an `http(s)://` source. Handles github (with optional `/tree/<ref>/<subdir>`),
/// gitlab (with subgroups + optional `/-/tree/<ref>/<subdir>`), and falls back to a
/// `git clone` of any other git host URL.
fn parse_http_url(source: &str) -> Result<ParsedSource> {
    let url = url::Url::parse(source).with_context(|| format!("invalid URL: {source}"))?;
    let host = url
        .host_str()
        .context("URL has no host")?
        .to_ascii_lowercase();
    let segments: Vec<String> = url
        .path_segments()
        .map(|it| {
            it.filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();

    let is_github = host == "github.com" || host == "www.github.com";
    let is_gitlab =
        host == "gitlab.com" || host == "www.gitlab.com" || host.ends_with(".gitlab.com");

    if is_github {
        if segments.len() < 2 {
            anyhow::bail!("github URL must be github.com/owner/repo: {source}");
        }
        let owner = segments[0].clone();
        let repo = strip_git_suffix(&segments[1]).to_string();
        // /owner/repo/tree/<ref>/<subdir...>
        let (git_ref, subdir) = if segments.len() >= 4 && segments[2] == "tree" {
            let r = segments[3].clone();
            let sub = if segments.len() > 4 {
                Some(segments[4..].join("/"))
            } else {
                None
            };
            (r, sub)
        } else {
            ("HEAD".to_string(), None)
        };
        return Ok(ParsedSource {
            strategy: FetchStrategy::Tarball {
                url: github_tarball(&owner, &repo, &git_ref),
                subdir,
            },
            original: source.to_string(),
        });
    }

    if is_gitlab {
        // gitlab path: <group>[/<subgroup>...]/<repo>[/-/tree/<ref>/<subdir>]
        // Split on the `-` separator gitlab uses before `tree`/`blob`.
        let (project_segs, ref_subdir): (Vec<String>, Option<(String, Option<String>)>) =
            if let Some(dash_idx) = segments.iter().position(|s| s == "-") {
                let project = segments[..dash_idx].to_vec();
                let rest = &segments[dash_idx + 1..];
                let rs = if rest.len() >= 2 && rest[0] == "tree" {
                    let r = rest[1].clone();
                    let sub = if rest.len() > 2 {
                        Some(rest[2..].join("/"))
                    } else {
                        None
                    };
                    Some((r, sub))
                } else {
                    None
                };
                (project, rs)
            } else {
                (segments.clone(), None)
            };
        if project_segs.len() < 2 {
            anyhow::bail!("gitlab URL must include at least group/repo: {source}");
        }
        let mut project = project_segs.join("/");
        if let Some(stripped) = project.strip_suffix(".git") {
            project = stripped.to_string();
        }
        let (git_ref, subdir) = ref_subdir.unwrap_or(("HEAD".to_string(), None));
        return Ok(ParsedSource {
            strategy: FetchStrategy::Tarball {
                url: gitlab_tarball(&host, &project, &git_ref),
                subdir,
            },
            original: source.to_string(),
        });
    }

    // Any other https git host: clone it.
    Ok(ParsedSource {
        strategy: FetchStrategy::GitClone {
            url: source.to_string(),
            subdir: None,
        },
        original: source.to_string(),
    })
}

// ── Fetch ────────────────────────────────────────────────────────────────────

/// A unique temp working directory for one install. Created under the OS temp dir.
fn temp_workdir() -> Result<PathBuf> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("ryu-skill-src-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("creating temp dir {}", dir.display()))?;
    Ok(dir)
}

/// SSRF guard for a remote tarball URL: only https, host must not resolve to a
/// private/loopback address. The resolve + IP screen is the shared
/// `server::resolve_guarded_host`; this only adds the https-scheme check.
async fn guard_remote_url(raw: &str) -> Result<()> {
    let parsed = url::Url::parse(raw).with_context(|| format!("invalid URL: {raw}"))?;
    if parsed.scheme() != "https" {
        anyhow::bail!("remote skill source must use https");
    }
    let host = parsed.host_str().context("URL has no host")?.to_string();
    let port = parsed.port_or_known_default().unwrap_or(443);
    crate::server::resolve_guarded_host(&host, port)
        .await
        .map_err(|e| anyhow::anyhow!("skill source rejected: {e}"))?;
    Ok(())
}

/// Download a `.tar.gz` and extract it into `dest`, returning the extracted root.
async fn fetch_tarball(client: &reqwest::Client, url: &str, dest: &Path) -> Result<PathBuf> {
    guard_remote_url(url).await?;
    let resp = client
        .get(url)
        .header("User-Agent", super::USER_AGENT)
        .send()
        .await
        .with_context(|| format!("requesting tarball {url}"))?;
    if !resp.status().is_success() {
        anyhow::bail!("tarball fetch returned HTTP {} for {url}", resp.status());
    }
    // Cap the download so a host can't stream an unbounded body at us. Check the
    // advertised Content-Length first, then enforce a running counter as we read
    // (a lying/absent length can't bypass the cap).
    const MAX_TARBALL_BYTES: usize = 200 * 1024 * 1024;
    if let Some(len) = resp.content_length() {
        if len > MAX_TARBALL_BYTES as u64 {
            anyhow::bail!("tarball at {url} is too large ({len} bytes, cap {MAX_TARBALL_BYTES})");
        }
    }
    let mut bytes: Vec<u8> = Vec::new();
    let mut resp = resp;
    while let Some(chunk) = resp.chunk().await.context("reading tarball body")? {
        if bytes.len() + chunk.len() > MAX_TARBALL_BYTES {
            anyhow::bail!("tarball at {url} exceeds the {MAX_TARBALL_BYTES}-byte cap");
        }
        bytes.extend_from_slice(&chunk);
    }
    let extract_root = dest.join("extract");
    crate::sidecar::download_manager::extract_tar_gz_to_dir(&bytes, &extract_root, None)
        .context("extracting tarball")?;
    Ok(extract_root)
}

/// Extract the host from a clone URL for SSRF screening. Handles the three forms
/// `git_clone` is reached with: `https://host/...`, `ssh://[user@]host[:port]/...`,
/// and the scp-like `git@host:owner/repo.git`. Returns `(host, port)`.
fn clone_host_port(url: &str) -> Result<(String, u16)> {
    if url.starts_with("https://") || url.starts_with("ssh://") {
        let parsed = url::Url::parse(url).with_context(|| format!("invalid clone URL: {url}"))?;
        let host = parsed
            .host_str()
            .context("clone URL has no host")?
            .to_string();
        let default_port = if parsed.scheme() == "ssh" { 22 } else { 443 };
        let port = parsed.port().unwrap_or(default_port);
        return Ok((host, port));
    }
    // scp-like syntax: `[user@]host:path` (no scheme). The host is between an
    // optional `user@` and the first `:`.
    let after_user = url.rsplit_once('@').map(|(_, rest)| rest).unwrap_or(url);
    let host = after_user
        .split_once(':')
        .map(|(h, _)| h)
        .unwrap_or(after_user);
    if host.is_empty() {
        anyhow::bail!("could not parse host from clone URL: {url}");
    }
    Ok((host.to_string(), 22))
}

/// SSRF guard for a `git clone` target host: resolve it and reject if any
/// resolved IP is private/loopback/link-local (also catching a literal blocked
/// IP host). Reuses the shared server-side screen so https/ssh/scp clone URLs
/// can't be pointed at internal addresses.
async fn guard_clone_url(url: &str) -> Result<()> {
    let (host, port) = clone_host_port(url)?;
    crate::server::resolve_guarded_host(&host, port)
        .await
        .map_err(|e| anyhow::anyhow!("clone target rejected: {e}"))?;
    Ok(())
}

/// git env vars that let a clone run an arbitrary command (SSH transport, askpass
/// helper, proxy, external diff). We neutralize these on the child so a value
/// inherited from the parent process can't be hijacked into code execution during
/// a clone of an attacker-named source. We do NOT `env_clear` (git still needs
/// `PATH`/`SYSTEMROOT`/`HOME` to run, especially on Windows) — only these are
/// removed, plus prompts are disabled so a clone can never block on credentials.
const GIT_UNSAFE_ENV: &[&str] = &[
    "GIT_SSH_COMMAND",
    "GIT_SSH",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GIT_PROXY_COMMAND",
    "GIT_EXTERNAL_DIFF",
];

/// `git clone --depth 1 <url> <dest/repo>` using the git CLI. Args are passed
/// separately (no shell) so a malicious source can't inject commands. The target
/// host is SSRF-screened before the clone so a `git@`/`ssh://` or non-github/gitlab
/// https source can't be aimed at an internal address. Command-execution env vars
/// are stripped and credential prompts disabled so the clone can't be coerced into
/// running a helper or hanging on input.
async fn git_clone(url: &str, dest: &Path) -> Result<PathBuf> {
    guard_clone_url(url).await?;
    let target = dest.join("repo");
    let target_str = target.to_string_lossy().to_string();
    let url_owned = url.to_string();
    let output = tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("git");
        cmd.args(["clone", "--depth", "1", "--", &url_owned, &target_str])
            // No interactive credential prompt; fail closed instead of hanging.
            .env("GIT_TERMINAL_PROMPT", "0");
        for var in GIT_UNSAFE_ENV {
            cmd.env_remove(var);
        }
        cmd.output()
    })
    .await
    .context("git clone task failed")?
    .context("failed to spawn git (is the git CLI installed and on PATH?)")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git clone failed: {}", stderr.trim());
    }
    Ok(target)
}

// ── Skill discovery (container-dir walk) ──────────────────────────────────────

/// A skill found inside a fetched repo: its directory and resolved name.
struct FoundSkill {
    /// The skill's own directory (contains SKILL.md).
    dir: PathBuf,
    /// The install name (directory name, or front-matter name fallback).
    name: String,
}

/// Walk a fetched repo root to find skill directories. Recognizes:
/// - a SKILL.md at the root (the repo *is* one skill),
/// - `skills/<name>/SKILL.md`,
/// - `skills/<category>/<name>/SKILL.md`,
/// - and, generically, any directory up to a small depth that directly contains a
///   SKILL.md. The skill **name** is the containing directory's name (repo name
///   when SKILL.md is at the root).
fn find_skills(root: &Path) -> Vec<FoundSkill> {
    let mut out: Vec<FoundSkill> = Vec::new();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    walk(root, root, 0, &mut out, &mut seen);
    out
}

/// Recursive bounded walk (max depth 4 below the root). Any directory that
/// directly contains a SKILL.md is recorded as a skill and not descended into.
fn walk(
    root: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<FoundSkill>,
    seen: &mut std::collections::HashSet<PathBuf>,
) {
    const MAX_DEPTH: usize = 4;
    if depth > MAX_DEPTH {
        return;
    }
    if has_skill_md(dir) {
        if seen.insert(dir.to_path_buf()) {
            out.push(FoundSkill {
                dir: dir.to_path_buf(),
                name: skill_name_for(root, dir),
            });
        }
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            let name = entry.file_name();
            // Skip VCS + hidden housekeeping dirs.
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            walk(root, &path, depth + 1, out, seen);
        }
    }
}

/// True when `dir` directly contains a SKILL.md (case-insensitive).
fn has_skill_md(dir: &Path) -> bool {
    if dir.join("SKILL.md").is_file() {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|e| {
        e.path().is_file()
            && e.file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case("SKILL.md")
    })
}

/// The install name for a skill directory: the directory's own name, except when
/// the skill is at the repo root (a github tarball expands to `repo-ref/`), where
/// we strip the `-<ref>` suffix the archive adds.
fn skill_name_for(root: &Path, dir: &Path) -> String {
    if dir == root {
        // Tarball root looks like `<repo>-<ref>`; fall back to a generic name if
        // we can't read it. The SKILL.md front-matter name is preferred if present.
        if let Some(fm_name) = front_matter_name(dir) {
            return sanitize_name(&fm_name);
        }
        let base = dir
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        return sanitize_name(base.rsplit_once('-').map(|(a, _)| a).unwrap_or(&base));
    }
    let base = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    sanitize_name(&base)
}

/// Read the front-matter `name` from a skill dir's SKILL.md, if any.
fn front_matter_name(dir: &Path) -> Option<String> {
    let path = if dir.join("SKILL.md").is_file() {
        dir.join("SKILL.md")
    } else {
        std::fs::read_dir(dir).ok()?.flatten().find_map(|e| {
            let p = e.path();
            (p.is_file()
                && e.file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case("SKILL.md"))
            .then_some(p)
        })?
    };
    let content = std::fs::read_to_string(path).ok()?;
    let record = crate::skills::parse_skill_md("_probe", &content).ok()?;
    Some(record.name)
}

/// Make a string safe to use as a skills-dir directory name: keep alnum, dash,
/// underscore, dot; collapse everything else to a dash; never empty.
fn sanitize_name(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(['-', '.']).to_string();
    if trimmed.is_empty() {
        "skill".to_string()
    } else {
        trimmed
    }
}

// ── Whole-directory copy (path-traversal guarded) ─────────────────────────────

/// Recursively copy `src` dir into `dest` dir, guarding every destination path so
/// it stays within `dest` (defense against symlink/`..` escapes in the source).
fn copy_dir_guarded(src: &Path, dest: &Path) -> Result<()> {
    std::fs::create_dir_all(dest).with_context(|| format!("creating {}", dest.display()))?;
    let dest_canon = dest.canonicalize().unwrap_or_else(|_| dest.to_path_buf());
    for entry in std::fs::read_dir(src).with_context(|| format!("reading {}", src.display()))? {
        let entry = entry?;
        let path = entry.path();
        let file_name = entry.file_name();
        let target = dest.join(&file_name);
        // Reject any target that escapes dest (e.g. via a symlinked component).
        if let Some(parent) = target.parent() {
            if let Ok(parent_canon) = parent.canonicalize() {
                if !parent_canon.starts_with(&dest_canon) {
                    tracing::warn!("skipping unsafe skill copy target: {}", target.display());
                    continue;
                }
            }
        }
        let ft = entry.file_type()?;
        if ft.is_dir() {
            copy_dir_guarded(&path, &target)?;
        } else if ft.is_file() {
            std::fs::copy(&path, &target)
                .with_context(|| format!("copying {} -> {}", path.display(), target.display()))?;
        }
        // Symlinks are skipped (not followed) to avoid escapes.
    }
    Ok(())
}

// ── Install entry point ───────────────────────────────────────────────────────

/// Resolve `source`, fetch it, locate the skill(s), and install the first one
/// found into `~/.claude/skills/<name>/`, marking it active. Returns the installed
/// skill id (its directory name).
///
/// When a repo contains multiple skills the first discovered is installed and a
/// note is logged; this keeps the single-id return contract simple. Callers can
/// invoke per-skill if they need finer control.
pub async fn install_from_source(client: &reqwest::Client, source: &str) -> Result<InstallResult> {
    let parsed = parse_source(source)?;
    tracing::info!(source = %source, strategy = ?parsed.strategy, "installing skill from source");

    // Local paths install in place (no temp dir / cleanup needed).
    if let FetchStrategy::LocalPath { path } = &parsed.strategy {
        return install_from_dir(path, None);
    }

    let workdir = temp_workdir()?;
    let result = install_remote(client, &parsed, &workdir).await;
    // Best-effort cleanup of the temp working tree regardless of outcome.
    let _ = std::fs::remove_dir_all(&workdir);
    result
}

/// Install a skill from an in-memory `.tar.gz` bundle — the entitlement-gated
/// **Ryu-bundle** path for a PAID marketplace skill (Phase 4A). Unlike
/// [`install_from_source`], there is no public git repo / URL: the archive bytes
/// were served from the control plane behind the 402 license gate and their
/// integrity was already verified (sha256 over these exact bytes against the
/// signed `manifest.artifact_sha256`) by the caller. This extracts to a temp dir
/// and installs the first discovered skill, mirroring the remote path minus the
/// fetch. Synchronous (extraction is CPU-bound, no I/O await).
pub fn install_from_tarball_bytes(bytes: &[u8]) -> Result<InstallResult> {
    let workdir = temp_workdir()?;
    let extract_root = workdir.join("extract");
    // Extract + install inside a closure so the temp tree is always cleaned up,
    // success or failure, exactly like `install_from_source`'s remote path.
    let result = (|| {
        crate::sidecar::download_manager::extract_tar_gz_to_dir(bytes, &extract_root, None)
            .context("extracting paid skill bundle")?;
        // A well-formed skill bundle is either a single top-level dir (as a github
        // tarball expands) or the skill files at the archive root; `resolve_subdir`
        // (no subdir) + `repo_root_name` handle both, reusing the remote path's
        // discovery so naming/lookup stay identical.
        let search_root = resolve_subdir(&extract_root, None)?;
        install_from_dir(&search_root, repo_root_name(&extract_root))
    })();
    let _ = std::fs::remove_dir_all(&workdir);
    result
}

/// Fetch a remote source into `workdir` then install. Tarball is tried first; a
/// clone is the fallback for tarball-failure or SSH/other-host strategies.
async fn install_remote(
    client: &reqwest::Client,
    parsed: &ParsedSource,
    workdir: &Path,
) -> Result<InstallResult> {
    let (repo_root, subdir) = match &parsed.strategy {
        FetchStrategy::Tarball { url, subdir } => match fetch_tarball(client, url, workdir).await {
            Ok(root) => (root, subdir.clone()),
            Err(tar_err) => {
                // Fall back to a git clone of the same repo (derive a clone URL).
                tracing::warn!("tarball fetch failed ({tar_err}); falling back to git clone");
                let clone_url = clone_url_for(parsed)?;
                (git_clone(&clone_url, workdir).await?, subdir.clone())
            }
        },
        FetchStrategy::GitClone { url, subdir } => (git_clone(url, workdir).await?, subdir.clone()),
        FetchStrategy::LocalPath { .. } => unreachable!("local handled in install_from_source"),
    };

    // Scope to the requested subdir, if any. A tarball expands to a single
    // `<repo>-<ref>/` top dir, so resolve the subdir beneath that.
    let search_root = resolve_subdir(&repo_root, subdir.as_deref())?;
    install_from_dir(&search_root, repo_root_name(&repo_root))
}

/// Derive a `git clone` URL from a parsed source (for the tarball→clone fallback).
fn clone_url_for(parsed: &ParsedSource) -> Result<String> {
    match &parsed.strategy {
        FetchStrategy::GitClone { url, .. } => Ok(url.clone()),
        FetchStrategy::Tarball { url, .. } => {
            // codeload.github.com/<owner>/<repo>/tar.gz/<ref> -> github.com/<owner>/<repo>.git
            if let Some(rest) = url.strip_prefix("https://codeload.github.com/") {
                let mut it = rest.splitn(3, '/');
                if let (Some(owner), Some(repo)) = (it.next(), it.next()) {
                    return Ok(format!("https://github.com/{owner}/{repo}.git"));
                }
            }
            // gitlab: https://<host>/<project>/-/archive/<ref>/archive.tar.gz
            if let Some(idx) = url.find("/-/archive/") {
                return Ok(format!("{}.git", &url[..idx]));
            }
            anyhow::bail!("cannot derive a clone URL from {url}")
        }
        FetchStrategy::LocalPath { .. } => anyhow::bail!("local path has no clone URL"),
    }
}

/// The single top-level directory a tarball expands to (e.g. `repo-main`), used as
/// the install-name source when SKILL.md sits at that root.
fn repo_root_name(extract_root: &Path) -> Option<String> {
    let mut entries = std::fs::read_dir(extract_root).ok()?.flatten();
    let first = entries.next()?;
    if entries.next().is_some() {
        return None; // more than one top entry: not a clean tarball root
    }
    first
        .file_type()
        .ok()?
        .is_dir()
        .then(|| first.file_name().to_string_lossy().to_string())
}

/// Resolve the directory to search for skills: descend into a tarball's single
/// top dir, then into `subdir` if given.
fn resolve_subdir(extract_root: &Path, subdir: Option<&str>) -> Result<PathBuf> {
    // A tarball extracts to one top-level dir; a clone is already the repo root.
    let mut base = extract_root.to_path_buf();
    let single_top = {
        let mut it = std::fs::read_dir(extract_root)
            .with_context(|| format!("reading {}", extract_root.display()))?
            .flatten();
        match (it.next(), it.next()) {
            (Some(only), None) if only.file_type().map(|t| t.is_dir()).unwrap_or(false) => {
                Some(only.path())
            }
            _ => None,
        }
    };
    if let Some(top) = single_top {
        base = top;
    }
    if let Some(sub) = subdir.filter(|s| !s.is_empty()) {
        // Guard the subdir against traversal before joining.
        for comp in sub.split('/') {
            if comp == ".." || comp.contains('\\') {
                anyhow::bail!("unsafe subdir in source: {sub}");
            }
        }
        let scoped = base.join(sub);
        if !scoped.exists() {
            anyhow::bail!("subdir '{sub}' not found in fetched repo");
        }
        return Ok(scoped);
    }
    Ok(base)
}

/// Install the first skill found under `dir` into the universal skills directory.
/// `root_name_hint` is the tarball/clone top-dir name, used when SKILL.md is at the
/// search root so the install name isn't the raw `repo-ref` directory.
fn install_from_dir(dir: &Path, root_name_hint: Option<String>) -> Result<InstallResult> {
    let mut found = find_skills(dir);
    if found.is_empty() {
        anyhow::bail!("no SKILL.md found in source (looked for SKILL.md, skills/<name>/, skills/<category>/<name>/)");
    }
    if found.len() > 1 {
        tracing::info!(
            count = found.len(),
            "source has multiple skills; installing the first"
        );
    }
    let skill = found.remove(0);

    // If the skill dir is the search root itself, prefer the repo-name hint over
    // the raw `repo-ref` directory name.
    let name = if skill.dir == dir {
        root_name_hint
            .as_deref()
            .map(|n| sanitize_name(n.rsplit_once('-').map(|(a, _)| a).unwrap_or(n)))
            .filter(|n| !n.is_empty())
            .unwrap_or(skill.name)
    } else {
        skill.name
    };

    let dest = crate::skills::SkillRegistry::skills_dir().join(&name);
    // Replace any existing install of the same name so updates are clean.
    if dest.exists() {
        std::fs::remove_dir_all(&dest)
            .with_context(|| format!("removing existing skill dir {}", dest.display()))?;
    }
    copy_dir_guarded(&skill.dir, &dest).context("copying skill directory")?;

    // A skill installed through Ryu is active by default (consistent with the
    // skills.sh catalog install path).
    crate::skills::set_active(&name, true);

    Ok(InstallResult {
        slug: name.clone(),
        path: dest.join("SKILL.md").to_string_lossy().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strat(s: &str) -> FetchStrategy {
        parse_source(s).unwrap().strategy
    }

    #[test]
    fn parses_owner_repo_shorthand_to_github_tarball() {
        assert_eq!(
            strat("vercel-labs/agent-skills"),
            FetchStrategy::Tarball {
                url: "https://codeload.github.com/vercel-labs/agent-skills/tar.gz/HEAD".into(),
                subdir: None,
            }
        );
    }

    #[test]
    fn parses_github_url_to_tarball() {
        assert_eq!(
            strat("https://github.com/owner/repo"),
            FetchStrategy::Tarball {
                url: "https://codeload.github.com/owner/repo/tar.gz/HEAD".into(),
                subdir: None,
            }
        );
        // .git suffix + trailing slash tolerated.
        assert_eq!(
            strat("https://github.com/owner/repo.git"),
            FetchStrategy::Tarball {
                url: "https://codeload.github.com/owner/repo/tar.gz/HEAD".into(),
                subdir: None,
            }
        );
    }

    #[test]
    fn parses_github_tree_ref_and_subdir() {
        assert_eq!(
            strat("https://github.com/owner/repo/tree/main/skills/my-skill"),
            FetchStrategy::Tarball {
                url: "https://codeload.github.com/owner/repo/tar.gz/main".into(),
                subdir: Some("skills/my-skill".into()),
            }
        );
    }

    #[test]
    fn parses_gitlab_url_with_subgroup_and_tree() {
        assert_eq!(
            strat("https://gitlab.com/group/sub/repo"),
            FetchStrategy::Tarball {
                url: "https://gitlab.com/group/sub/repo/-/archive/HEAD/archive.tar.gz".into(),
                subdir: None,
            }
        );
        assert_eq!(
            strat("https://gitlab.com/group/repo/-/tree/v1.0/skills/x"),
            FetchStrategy::Tarball {
                url: "https://gitlab.com/group/repo/-/archive/v1.0/archive.tar.gz".into(),
                subdir: Some("skills/x".into()),
            }
        );
    }

    #[test]
    fn parses_git_ssh_to_clone() {
        assert_eq!(
            strat("git@github.com:owner/repo.git"),
            FetchStrategy::GitClone {
                url: "git@github.com:owner/repo.git".into(),
                subdir: None
            }
        );
    }

    #[test]
    fn parses_local_existing_dir() {
        let tmp = std::env::temp_dir().join(format!("ryu-parse-local-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let parsed = parse_source(tmp.to_str().unwrap()).unwrap();
        assert!(matches!(parsed.strategy, FetchStrategy::LocalPath { .. }));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn unknown_other_https_host_falls_back_to_clone() {
        assert_eq!(
            strat("https://example.com/some/repo.git"),
            FetchStrategy::GitClone {
                url: "https://example.com/some/repo.git".into(),
                subdir: None,
            }
        );
    }

    #[test]
    fn empty_and_garbage_sources_error() {
        assert!(parse_source("   ").is_err());
        // A path that doesn't exist and isn't owner/repo or a URL.
        assert!(parse_source("not a real thing with spaces").is_err());
    }

    #[test]
    fn sanitize_name_keeps_safe_chars() {
        assert_eq!(sanitize_name("my-skill_v2.1"), "my-skill_v2.1");
        assert_eq!(sanitize_name("weird name!@#"), "weird-name");
        assert_eq!(sanitize_name("---"), "skill");
    }

    #[test]
    fn install_from_local_dir_with_nested_skills_layout() {
        // Serialize with other tests that mutate the shared RYU_SKILLS_* env vars,
        // so a parallel run never lets one test's remove_var clobber this set_var.
        let _env = crate::skills::SKILLS_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Build a fake repo: skills/<category>/<name>/SKILL.md + a resource file.
        let root = std::env::temp_dir().join(format!("ryu-local-install-src-{}", uniq()));
        let skill_dir = root.join("skills").join("web").join("my-cool-skill");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: My Cool Skill\n---\nDo cool things.",
        )
        .unwrap();
        std::fs::write(skill_dir.join("reference.md"), "extra docs").unwrap();

        // Point the skills dir at a temp location so we don't touch the real ~/.claude.
        let skills_home = std::env::temp_dir().join(format!("ryu-local-install-dest-{}", uniq()));
        let active_file = skills_home.join("active.json");
        std::env::set_var("RYU_SKILLS_DIR", &skills_home);
        std::env::set_var("RYU_SKILLS_ACTIVE_FILE", &active_file);

        let result = install_from_dir(&root, None).unwrap();

        let installed_dir = skills_home.join("my-cool-skill");
        let skill_md = installed_dir.join("SKILL.md");
        let resource = installed_dir.join("reference.md");
        let active = crate::skills::load_active_set();

        std::env::remove_var("RYU_SKILLS_DIR");
        std::env::remove_var("RYU_SKILLS_ACTIVE_FILE");

        assert_eq!(result.slug, "my-cool-skill");
        assert!(skill_md.is_file(), "SKILL.md copied");
        assert!(resource.is_file(), "whole dir copied, not just SKILL.md");
        assert!(
            active.contains("my-cool-skill"),
            "installed-through-Ryu skill is active"
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&skills_home);
    }

    fn uniq() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    }
}
