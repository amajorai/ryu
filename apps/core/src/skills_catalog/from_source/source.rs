// test-exempt: part of skills_catalog/from_source.rs (spliced in with include!), moved verbatim; tests in from_source/tests/.

const MAX_DIRECT_SKILL_MD_BYTES: usize = 4 * 1024 * 1024;

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
pub(crate) fn temp_workdir() -> Result<PathBuf> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("ryu-skill-src-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("creating temp dir {}", dir.display()))?;
    Ok(dir)
}

/// Download a `.tar.gz` and extract it into `dest`, returning the extracted root.
/// Every redirect is resolved, screened, and pinned again before the next hop.
async fn fetch_tarball(_client: &reqwest::Client, url: &str, dest: &Path) -> Result<PathBuf> {
    const MAX_REDIRECT_HOPS: usize = 3;
    let mut current = url.to_owned();
    let mut redirects = 0usize;
    let resp = loop {
        let (client, parsed) = crate::server::guarded_client(&current)
            .await
            .map_err(|error| anyhow::anyhow!("skill source rejected: {error}"))?;
        let resp = client
            .get(parsed.as_str())
            .header("User-Agent", super::USER_AGENT)
            .send()
            .await
            .with_context(|| {
                format!(
                    "requesting tarball {}",
                    crate::server::redact_url_for_display(&current)
                )
            })?;
        if !(300..400).contains(&resp.status().as_u16()) {
            break resp;
        }
        if redirects >= MAX_REDIRECT_HOPS {
            anyhow::bail!("skill source followed more than {MAX_REDIRECT_HOPS} redirects");
        }
        let location = resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| anyhow::anyhow!("skill source redirect has no valid location"))?;
        let next = parsed
            .join(location)
            .context("skill source redirect target is invalid")?;
        current = next.to_string();
        redirects += 1;
    };
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
pub(crate) fn clone_host_port(url: &str) -> Result<(String, u16)> {
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

/// Remote `git clone` cannot consume Core's in-process DNS pin. Refuse it rather
/// than screening once and handing the URL to a child that resolves it again.
async fn guard_clone_url(url: &str) -> Result<()> {
    let _ = clone_host_port(url)?;
    anyhow::bail!(
        "remote git clone is disabled because the git child cannot consume Core's pinned egress; use an HTTPS GitHub or GitLab source"
    )
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

/// Legacy child-process clone seam. It is retained for source compatibility but
/// fails closed before spawning `git`; remote child resolution cannot be pinned by
/// Core's SSRF boundary.
pub(crate) async fn git_clone(url: &str, dest: &Path) -> Result<PathBuf> {
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
        cmd.no_window();
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
