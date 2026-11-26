// test-exempt: part of skills_catalog/from_source.rs (spliced in with include!), moved verbatim; tests in from_source/tests/.

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
    let record = ryu_skills::parse_skill_md("_probe", &content).ok()?;
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
    install_from_source_named(client, source, None).await
}

/// Install a repository-root skill with a caller-supplied stable directory name.
/// Pack member ids are stable (`owner/repo/repo`), while a tarball's extracted
/// root is often named `<repo>-HEAD`; the explicit hint keeps the filesystem
/// slug aligned with the pack catalog and its origin ledger.
pub(crate) async fn install_from_source_named(
    client: &reqwest::Client,
    source: &str,
    root_name: Option<&str>,
) -> Result<InstallResult> {
    // Form 7: a direct `SKILL.md` over HTTP(S). There is no repo to clone — the
    // URL *is* the skill — so this is handled before `parse_source`, which would
    // otherwise treat it as a generic git remote and fail. It uses the same
    // pinned Core client as archive sources; skipping it would make this the one
    // fetch that could be pointed at the loopback interface.
    if is_direct_skill_md_url(source) {
        let url = source.trim();
        tracing::info!(source = %url, "installing skill from a direct SKILL.md URL");
        let (guarded_client, parsed_url) = crate::server::guarded_client(url)
            .await
            .map_err(|error| anyhow::anyhow!("skill source rejected: {error}"))?;
        let resp = guarded_client
            .get(parsed_url.as_str())
            .send()
            .await
            .with_context(|| {
                format!(
                    "requesting SKILL.md ({})",
                    crate::server::redact_url_for_display(url)
                )
            })?;
        if !resp.status().is_success() {
            anyhow::bail!("SKILL.md URL returned HTTP {}", resp.status());
        }
        if resp
            .content_length()
            .is_some_and(|length| length > MAX_DIRECT_SKILL_MD_BYTES as u64)
        {
            anyhow::bail!("SKILL.md response exceeds the {MAX_DIRECT_SKILL_MD_BYTES}-byte cap");
        }
        let mut bytes = Vec::new();
        let mut resp = resp;
        while let Some(chunk) = resp.chunk().await.context("reading SKILL.md body")? {
            if bytes.len().saturating_add(chunk.len()) > MAX_DIRECT_SKILL_MD_BYTES {
                anyhow::bail!("SKILL.md response exceeds the {MAX_DIRECT_SKILL_MD_BYTES}-byte cap");
            }
            bytes.extend_from_slice(&chunk);
        }
        let markdown = String::from_utf8(bytes).context("SKILL.md body is not UTF-8")?;
        return install_skill_md_text(&skill_name_from_md_url(url), &markdown).await;
    }

    let parsed = parse_source(source)?;
    tracing::info!(source = %source, strategy = ?parsed.strategy, "installing skill from source");

    // Local paths install in place (no temp dir / cleanup needed).
    if let FetchStrategy::LocalPath { path } = &parsed.strategy {
        return install_from_dir(path, None);
    }

    let workdir = temp_workdir()?;
    let root_name_hint = root_name.map(|name| format!("{name}-HEAD"));
    let result = install_remote(
        client,
        &parsed,
        &workdir,
        root_name,
        root_name_hint.as_deref(),
    )
    .await;
    // Best-effort cleanup of the temp working tree regardless of outcome.
    let _ = std::fs::remove_dir_all(&workdir);
    result
}

/// Install a skill from an in-memory `.tar.gz` bundle — the signed
/// **Ryu-bundle** path for a Marketplace skill. Unlike
/// [`install_from_source`], there is no public git repo / URL: the archive bytes
/// were served from the control plane and their integrity was already verified
/// (sha256 over these exact bytes against the
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
            .context("extracting Marketplace skill bundle")?;
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

/// Fetch a remote source into `workdir` then install. Only HTTPS archive sources
/// are supported so the fetch can remain inside Core's pinned egress boundary.
async fn install_remote(
    client: &reqwest::Client,
    parsed: &ParsedSource,
    workdir: &Path,
    exact_root_name: Option<&str>,
    root_name_hint: Option<&str>,
) -> Result<InstallResult> {
    let (repo_root, subdir) = match &parsed.strategy {
        FetchStrategy::Tarball { url, subdir } => {
            let root = fetch_tarball(client, url, workdir)
                .await
                .context("fetching skill source tarball")?;
            (root, subdir.clone())
        }
        FetchStrategy::GitClone { url, subdir } => (git_clone(url, workdir).await?, subdir.clone()),
        FetchStrategy::LocalPath { .. } => unreachable!("local handled in install_from_source"),
    };

    install_fetched(
        &repo_root,
        subdir.as_deref(),
        exact_root_name,
        root_name_hint,
    )
}

/// Install from a fetched (extracted or cloned) repo root, scoped to `subdir`.
///
/// The `<repo>-<ref>` root-name hint only names a skill whose SKILL.md sits at
/// the repository root. A source scoped to a skill folder (`…/tree/HEAD/skills/pdf`)
/// installs under that folder's own name, so sibling skills from one repo get
/// distinct directories instead of all landing in (and replacing) `skills/<repo>`.
fn install_fetched(
    repo_root: &Path,
    subdir: Option<&str>,
    exact_root_name: Option<&str>,
    root_name_hint: Option<&str>,
) -> Result<InstallResult> {
    // Scope to the requested subdir, if any. A tarball expands to a single
    // `<repo>-<ref>/` top dir, so resolve the subdir beneath that.
    let search_root = resolve_subdir(repo_root, subdir)?;
    if subdir.is_some_and(|sub| !sub.is_empty()) {
        let leaf_name = has_skill_md(&search_root)
            .then(|| {
                search_root
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
            })
            .flatten();
        return install_from_dir_named(
            &search_root,
            None,
            exact_root_name.or(leaf_name.as_deref()),
        );
    }
    install_from_dir_named(
        &search_root,
        root_name_hint
            .map(ToOwned::to_owned)
            .or_else(|| repo_root_name(repo_root)),
        exact_root_name,
    )
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
///
/// `pub(crate)`: the setup-import engine (`crate::import`) reuses this exact
/// copy + activate path when importing a skill found in a scanned folder, so an
/// imported skill is byte-for-byte the same install a URL/source install produces.
pub(crate) fn install_from_dir(
    dir: &Path,
    root_name_hint: Option<String>,
) -> Result<InstallResult> {
    install_from_dir_named(dir, root_name_hint, None)
}
