// test-exempt: part of skills_catalog/from_source.rs (spliced in with include!), moved verbatim; tests in from_source/tests/.

/// Install a source directory, optionally forcing the stable name for a skill
/// that lives at the repository root. `root_name_hint` retains the historical
/// tarball-name behavior; `exact_root_name` is for pack ids and never applies
/// to nested skills.
pub(crate) fn install_from_dir_named(
    dir: &Path,
    root_name_hint: Option<String>,
    exact_root_name: Option<&str>,
) -> Result<InstallResult> {
    match install_dir(dir, root_name_hint, exact_root_name, OnExisting::Replace)? {
        UnattendedInstall::Installed(result) => Ok(result),
        UnattendedInstall::Kept { slug } => {
            anyhow::bail!("skill '{slug}' is already installed")
        }
    }
}

/// What an install does when a skill of the same name is installed already.
enum OnExisting<'a> {
    /// Remove it and install the new copy: every install a person asks for.
    Replace,
    /// Nobody is present (folder sync). Ask the caller first and, when the
    /// answer is no, leave the installed skill untouched. The installed copy
    /// also never keeps an `always-on` flag.
    Unattended(&'a dyn Fn(&Path) -> bool),
}

/// The result of an install that nobody asked for.
pub(crate) enum UnattendedInstall {
    Installed(InstallResult),
    /// A skill of this name is installed already and was left untouched.
    Kept {
        slug: String,
    },
}

/// Install a skill folder with nobody present, which is what folder sync does
/// every 30 seconds for each new or changed `SKILL.md` folder of a synced root.
///
/// The folder may hold files the user never wrote (a cloned repository, a
/// shared folder), and the install name is the front-matter `name` of that
/// file. So two things differ from an install a person asks for:
/// - A skill of the same name that is installed already is replaced only when
///   `may_replace(<its directory>)` says so. The sync worker says yes only for
///   a directory that is still exactly what it installed from this same item.
///   Otherwise the installed skill is kept and nothing is written.
/// - The installed copy does not keep `always-on`. That flag puts the whole
///   body into every turn, and it is for the user to switch on.
pub(crate) fn install_from_dir_unattended(
    dir: &Path,
    may_replace: &dyn Fn(&Path) -> bool,
) -> Result<UnattendedInstall> {
    install_dir(dir, None, None, OnExisting::Unattended(may_replace))
}

fn install_dir(
    dir: &Path,
    root_name_hint: Option<String>,
    exact_root_name: Option<&str>,
    on_existing: OnExisting<'_>,
) -> Result<UnattendedInstall> {
    let mut found = find_skills(dir);
    if found.is_empty() {
        anyhow::bail!(
            "no SKILL.md found in source (looked for SKILL.md, skills/<name>/, skills/<category>/<name>/)"
        );
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
    let name = exact_root_name
        .map(sanitize_name)
        .filter(|n| !n.is_empty())
        .or_else(|| {
            (skill.dir == dir)
                .then(|| {
                    root_name_hint
                        .as_deref()
                        .map(|n| sanitize_name(n.rsplit_once('-').map(|(a, _)| a).unwrap_or(n)))
                        .filter(|n| !n.is_empty())
                })
                .flatten()
        })
        .unwrap_or(skill.name);

    let dest = ryu_skills::SkillRegistry::skills_dir().join(&name);
    // Installing a skill over (or into) its own source would delete the source
    // in the `remove_dir_all` below before anything is copied, leaving an
    // empty skill behind.
    if let (Ok(source), Ok(target)) = (
        std::fs::canonicalize(&skill.dir),
        std::fs::canonicalize(&dest),
    ) {
        if source.starts_with(&target) || target.starts_with(&source) {
            anyhow::bail!(
                "skill '{name}' is already installed at {}",
                target.display()
            );
        }
    }
    let artifact_fingerprint = std::fs::read_to_string(skill.dir.join("SKILL.md"))
        .ok()
        .and_then(|content| super::public_stats::artifact_fingerprint(&name, &content));
    // Replace any existing install of the same name so updates are clean.
    if dest.exists() {
        if let OnExisting::Unattended(may_replace) = &on_existing {
            if !may_replace(dest.as_path()) {
                return Ok(UnattendedInstall::Kept { slug: name });
            }
        }
        std::fs::remove_dir_all(&dest)
            .with_context(|| format!("removing existing skill dir {}", dest.display()))?;
    }
    copy_dir_guarded(&skill.dir, &dest).context("copying skill directory")?;
    if matches!(on_existing, OnExisting::Unattended(_)) {
        if let Err(error) = clear_always_on(&dest) {
            let _ = std::fs::remove_dir_all(&dest);
            return Err(error);
        }
    }

    // A skill installed through Ryu is active by default (consistent with the
    // skills.sh catalog install path).
    ryu_skills::set_active(&name, true);
    // A from-source install is a user choice → user-owned, so the bundled-system
    // sync never auto-removes it. The sync's own installs call this same path and
    // immediately re-record origin `System`, which is what makes a user's
    // reinstall of a bundled skill stick.
    crate::skills_catalog::system_skills::record_origin(
        &name,
        crate::skills_catalog::system_skills::SkillOrigin::User,
    );

    Ok(UnattendedInstall::Installed(InstallResult {
        artifact_fingerprint,
        slug: name.clone(),
        path: dest.join("SKILL.md").to_string_lossy().to_string(),
    }))
}

/// Take the `always-on` flag out of every `SKILL.md` of an installed skill
/// directory. The result is read back with the real parser: when the file
/// still parses as always-on (a YAML form the line filter below does not
/// know), or no longer parses at all, this fails and the caller undoes the
/// install, so a flag the filter missed never reaches a turn.
fn clear_always_on(skill_dir: &Path) -> Result<()> {
    let entries = std::fs::read_dir(skill_dir)
        .with_context(|| format!("reading skill dir {}", skill_dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_skill_md = entry
            .file_name()
            .to_string_lossy()
            .eq_ignore_ascii_case("SKILL.md");
        if !is_skill_md || !path.is_file() {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        if !parses_as_always_on(&content) {
            continue;
        }
        let cleared = without_always_on_key(&content);
        match ryu_skills::parse_skill_md("_probe", &cleared) {
            Ok(record) if !record.always_on => {}
            _ => anyhow::bail!(
                "skill sets always-on in a form that cannot be cleared; import it yourself to review it"
            ),
        }
        std::fs::write(&path, cleared).with_context(|| format!("writing {}", path.display()))?;
    }
    Ok(())
}

fn parses_as_always_on(skill_md: &str) -> bool {
    ryu_skills::parse_skill_md("_probe", skill_md).is_ok_and(|record| record.always_on)
}

/// `skill_md` without the `always-on` key lines of its front matter. Lines
/// outside the front matter are never touched.
fn without_always_on_key(skill_md: &str) -> String {
    let mut out = String::with_capacity(skill_md.len());
    let mut opened = false;
    let mut closed = false;
    for line in skill_md.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\r', '\n']);
        if closed {
            // The body.
        } else if !opened {
            if bare.trim_start().starts_with("---") {
                opened = true;
            } else if !bare.trim().is_empty() {
                // No front matter at all.
                closed = true;
            }
        } else if bare.starts_with("---") {
            closed = true;
        } else if is_always_on_key(bare) {
            continue;
        }
        out.push_str(line);
    }
    out
}

/// True for a front-matter line that sets `always-on`, quoted or not.
fn is_always_on_key(line: &str) -> bool {
    line.trim_start()
        .trim_start_matches(['"', '\''])
        .strip_prefix("always-on")
        .map(|rest| rest.trim_start_matches(['"', '\'']).trim_start())
        .is_some_and(|rest| rest.starts_with(':'))
}

/// True when a source string is a direct `SKILL.md` document rather than a repo.
///
/// Matched on the path only, so a `?token=…` query or `#fragment` does not defeat
/// it. Deliberately narrow — it must be the `SKILL.md` filename itself, not any
/// `.md`, so a README URL still falls through to the repo forms.
fn is_direct_skill_md_url(raw: &str) -> bool {
    let source = raw.trim();
    if !(source.starts_with("http://") || source.starts_with("https://")) {
        return false;
    }
    source
        .split(['?', '#'])
        .next()
        .unwrap_or(source)
        .rsplit('/')
        .next()
        .is_some_and(|file| file.eq_ignore_ascii_case("SKILL.md"))
}

/// Name a skill fetched as a bare `SKILL.md`.
///
/// The parent path segment names it (`…/skills/pdf/SKILL.md` -> `pdf`), except
/// where that segment is the git ref of a repository-root file on a code host:
/// raw.githubusercontent.com `<owner>/<repo>/<ref>/SKILL.md`, GitHub
/// `<owner>/<repo>/{blob,raw}/<ref>/SKILL.md`, and GitLab-style
/// `…/<repo>/-/{raw,blob}/<ref>/SKILL.md` are named after the repo, so two
/// root-level skills do not both land in (and replace) `skills/main`. A
/// `SKILL.md` at the root of a host is named after the host. The front matter
/// never picks the name: [`install_skill_md_text`] installs under exactly this
/// slug, so a fetched document cannot choose (and replace) another skill.
fn skill_name_from_md_url(raw: &str) -> String {
    let Ok(url) = url::Url::parse(raw.trim()) else {
        return "skill".to_string();
    };
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let segments: Vec<&str> = url
        .path_segments()
        .map(|segments| segments.filter(|segment| !segment.is_empty()).collect())
        .unwrap_or_default();
    // The directory segments above the `SKILL.md` file itself.
    let dirs = segments
        .split_last()
        .map(|(_, dirs)| dirs)
        .unwrap_or_default();
    let name = repo_name_for_root_skill_md(&host, dirs)
        .or_else(|| dirs.last().copied())
        .unwrap_or(host.as_str());
    sanitize_name(name)
}

/// The repo segment of a code-host URL whose `SKILL.md` sits at the repository
/// root, where the parent segment is a git ref rather than a skill folder.
fn repo_name_for_root_skill_md<'a>(host: &str, dirs: &[&'a str]) -> Option<&'a str> {
    match (host, dirs) {
        ("raw.githubusercontent.com", [_, repo, _])
        | ("raw.githubusercontent.com", [_, repo, "refs", "heads" | "tags", _])
        | ("github.com" | "www.github.com", [_, repo, "blob" | "raw", _])
        | (_, [.., repo, "-", "raw" | "blob", _]) => Some(*repo),
        _ => None,
    }
}

/// Install a skill whose entire body is a `SKILL.md` document we already hold in
/// memory, rather than a git repo to clone.
///
/// Three of the registries in [`crate::catalog_source::skill_registries`] serve
/// the markdown itself and never expose a fetchable source repo — ClawHub returns
/// it as `skill.description`, browse.sh as `skillMd`, and a LobeHub agent is
/// synthesized into one. Without this they would be browse-only.
///
/// The write goes through [`install_from_dir_named`] rather than straight to the
/// skills dir so a content-served skill lands in exactly the same shape, and
/// under the same replace-existing and `set_active` rules, as a cloned one.
pub async fn install_skill_md_text(name: &str, markdown: &str) -> Result<InstallResult> {
    let safe = sanitize_name(name);
    if safe.is_empty() {
        anyhow::bail!("skill name `{name}` has no path-safe characters");
    }
    if markdown.trim().is_empty() {
        anyhow::bail!("skill `{name}` has an empty SKILL.md");
    }

    let workdir = temp_workdir()?;
    let result = (|| {
        let dir = workdir.join(&safe);
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("creating staging dir {}", dir.display()))?;
        std::fs::write(dir.join("SKILL.md"), markdown).context("writing staged SKILL.md")?;
        // The caller's slug is the exact install name. Without it the staged
        // SKILL.md's front-matter `name` would pick the destination, letting a
        // fetched document replace a different installed skill. No `repo-<ref>`
        // hint either: that path strips everything after the last `-`, which
        // would truncate a hyphenated slug (`contract-opportunity-search`).
        install_from_dir_named(&dir, None, Some(&safe))
    })();
    // Best-effort cleanup of the staging tree regardless of outcome.
    let _ = std::fs::remove_dir_all(&workdir);
    result
}
