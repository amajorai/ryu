//! Skill packs — a named collection of skills installable as a unit.
//!
//! A pack is either a **repo** (every `SKILL.md` directory in it is a member —
//! the "repo is a pack" model skills.sh uses for `owner/repo` pages) or a
//! **custom** user-defined pack: a manifest listing skills.sh ids
//! (`owner/repo/slug`) and parent repo URLs (`owner/repo` or
//! `https://github.com/...`). Pack members resolve to ordinary skill ids and
//! install through the existing per-skill paths, so a pack adds no second
//! install mechanism — it is a grouping over the skills the catalog already
//! knows how to fetch.
//!
//! Placement (Core vs Gateway, CLAUDE.md §1): resolving and installing skills is
//! "what runs", so packs live here in Core beside the skills catalog. Desktop,
//! web, and mobile read them through the HTTP API.
//!
//! ## Repo packs share the tap's tree walk
//!
//! Member discovery for a repo pack reuses `catalog_source::skill_registries`
//! [`GithubTapSource::skill_paths`](crate::catalog_source::skill_registries::GithubTapSource::skill_paths)
//! — the same 24h-cached recursive tree walk the GitHub tap source uses to index
//! `skills/<name>/SKILL.md` directories. A pack over `owner/repo` and the tap for
//! the same repo must never disagree about what skills it contains, so they share
//! one implementation rather than two walks that could drift.

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::catalog_source::skill_registries::GithubTapSource;
use crate::skills_catalog::{self, from_source, InstallResult};

const ROOT_SKILL_PATH: &str = ".";

/// The persisted user-pack registry file (`~/.ryu/skill-packs.json`).
fn user_packs_path() -> PathBuf {
    crate::paths::state_path("skill-packs.json")
}

/// How a pack's members are obtained.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PackSource {
    /// A repo whose `SKILL.md` directories are the members.
    Repo {
        /// `owner/repo`.
        repo: String,
    },
    /// A user-defined list: skills.sh ids (`owner/repo/slug`) and/or parent repo
    /// URLs (`owner/repo` or a `https://github.com/...` URL).
    Custom { entries: Vec<String> },
}

/// A pack listing: identity + how its members are resolved.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillPack {
    /// Stable id. For a repo pack it is `owner/repo`; for a custom pack a
    /// user-chosen kebab-case id.
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(flatten)]
    pub source: PackSource,
    /// True for the catalog Ryu ships; false for a user-added pack.
    #[serde(default)]
    pub builtin: bool,
}

/// One resolved member of a pack, as the detail payload shows it.
#[derive(Debug, Clone, Serialize)]
pub struct PackMember {
    /// Full skill id (`owner/repo/slug`, or the repo+leaf for a repo pack).
    pub id: String,
    pub name: String,
    /// One-line description when the source can supply one without a per-member
    /// round trip (repo packs read it from the front matter of the on-disk
    /// SKILL.md for installed members; custom entries reuse the catalog search).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub installed: bool,
}

/// Parse a `skills.sh`-style or GitHub repo reference into a `owner/repo` pair.
///
/// Accepts `owner/repo`, `https://github.com/owner/repo`, and either
/// `https://skills.sh/owner/repo` or `https://www.skills.sh/owner/repo`
/// (skills.sh's repo "pack" pages are exactly the repo's skills). Returns
/// `None` for anything else — the caller decides whether that is a custom
/// manifest or an error.
fn repo_from_ref(raw: &str) -> Option<(String, String)> {
    let trimmed = raw.trim();
    let slug = if let Some(rest) = trimmed
        .strip_prefix("https://github.com/")
        .or_else(|| trimmed.strip_prefix("https://skills.sh/"))
        .or_else(|| trimmed.strip_prefix("https://www.skills.sh/"))
    {
        rest
    } else {
        trimmed
    };
    let slug = slug.trim_end_matches('/');
    let mut parts = slug.splitn(3, '/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim();
    if owner.is_empty()
        || repo.is_empty()
        || parts.next().is_some()
        || !owner
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        || !repo
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

/// Classify a user-supplied pack source string.
///
/// - `owner/repo` / `https://github.com/...` / `https://[www.]skills.sh/owner/repo`
///   → a [`PackSource::Repo`].
/// - `{"entries": [...]}` JSON, or a bare `entries` array → a
///   [`PackSource::Custom`] (the manifest form the CLI and desktop "add custom
///   pack" surface send).
pub fn parse_pack_source(raw: &str) -> Result<PackSource> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        anyhow::bail!("pack source must not be empty");
    }
    if let Some((owner, repo)) = repo_from_ref(trimmed) {
        return Ok(PackSource::Repo {
            repo: format!("{owner}/{repo}"),
        });
    }
    // A custom manifest is a JSON object or array of entries.
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        let entries: Vec<String> =
            if let Ok(obj) = serde_json::from_str::<serde_json::Value>(trimmed) {
                obj.get("entries")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(ToString::to_string))
                            .collect()
                    })
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
        if entries.is_empty() {
            anyhow::bail!("custom pack manifest has no entries");
        }
        return Ok(PackSource::Custom { entries });
    }
    anyhow::bail!("pack source must be `owner/repo`, a github/skills.sh URL, or a custom manifest")
}

/// The built-in pack catalog — the optional external packs Ryu recommends during
/// node onboarding. A pack is a repo whose `SKILL.md` directories are its members.
/// The catalog is available without installing anything; the node's explicit
/// onboarding selection decides which packs Core fetches.
pub const BUILTIN_PACKS: &[(&str, &str)] = &[
    // (id/owner-repo, one-line description)
    (
        "jakubkrehel/skills",
        "Interface design, typography, color, layout, accessibility, writing, and review skills.",
    ),
    (
        "mattpocock/skills",
        "Matt Pocock's skill pack: TDD, code review, debugging, domain modeling and writing workflows.",
    ),
    (
        "anthropics/skills",
        "Anthropic's official document skills (PDF, PPTX, XLSX, DOCX) plus sketch and brand workflows.",
    ),
    (
        "vercel-labs/agent-skills",
        "Vercel's curated agent skills: React, Next.js, TypeScript, testing and performance best practices.",
    ),
    (
        "wshobson/agents",
        "Wshobson's broad engineering and product skill collection: architecture, testing, security, operations and more.",
    ),
    (
        "cathrynlavery/diagram-design",
        "Editorial diagram design: branded architecture, data, flow and security diagrams with HTML, SVG, PNG, Mermaid and draw.io workflows.",
    ),
    (
        "Leonxlnx/unlazy",
        "Anti-laziness execution discipline: gate files, runnable checks, Depth Tree planning, and proof-based completion.",
    ),
    (
        "emilkowalski/skills",
        "Emil Kowalski's design-engineering skills: UI polish, animation taste and interface craft.",
    ),
    (
        "obra/superpowers",
        "Jesse Vincent's Superpowers: brainstorming, planning and execution skills for serious work.",
    ),
    (
        "blader/humanizer",
        "The humanizer skill: rewrite AI-sounding prose into natural, human writing.",
    ),
    (
        "petergyang/no-ai-slop",
        "Detect and strip AI-slop phrasing from generated text before it ships.",
    ),
    (
        "coreyhaines31/marketingskills",
        "Corey Haines' marketing skill pack: positioning, copy and go-to-market workflows.",
    ),
    (
        "mukul975/Anthropic-Cybersecurity-Skills",
        "Cybersecurity analysis skills: threat modeling, audits, and secure-coding review.",
    ),
    (
        "multica-ai/andrej-karpathy-skills",
        "A Karpathy-style teaching pack: explain deeply, from first principles, with rigor.",
    ),
    (
        "googleworkspace/cli",
        "Google Workspace CLI skills: drive Gmail, Calendar, Drive and Docs from the command line.",
    ),
    (
        "Leonxlnx/taste-skill",
        "The taste skill: a refined, design-aware standard for judging and producing great work.",
    ),
    (
        "mvanhorn/last30days-skill",
        "The last-30-days skill: review a product, codebase or business on its recent arc, not its launch.",
    ),
    (
        "adamlyttleapps/claude-skill-aso-appstore-screenshots",
        "App Store / Play Store screenshot generation: craft ASO screenshots that sell.",
    ),
    (
        "cursor/plugins",
        "Cursor's official plugin skills: code review, CI, debugging, workflows and engineering quality.",
    ),
    (
        "openai/plugins",
        "OpenAI's official plugin skills: ChatGPT app development, verification, Slack and agent workflows.",
    ),
    (
        "anthropics/claude-plugins-official",
        "Anthropic's official Claude plugin skills: agent development, MCP apps, automation and plugin authoring.",
    ),
];

/// All packs: the built-in catalog plus any persisted user packs.
pub fn list_packs() -> Vec<SkillPack> {
    let mut packs = builtin_packs();
    packs.extend(user_packs());
    packs
}

/// The built-in catalog as [`SkillPack`] values (repo packs).
pub fn builtin_packs() -> Vec<SkillPack> {
    BUILTIN_PACKS
        .iter()
        .map(|(repo, description)| SkillPack {
            id: (*repo).to_string(),
            name: humanize_pack_name(repo),
            description: (*description).to_string(),
            source: PackSource::Repo {
                repo: (*repo).to_string(),
            },
            builtin: true,
        })
        .collect()
}

/// `owner/repo` → "Owner Repo".
fn humanize_pack_name(repo: &str) -> String {
    repo.split('/')
        .flat_map(|part| part.split('-'))
        .filter(|part| !part.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The persisted user packs (the registry file), or `[]` when absent.
pub fn user_packs() -> Vec<SkillPack> {
    std::fs::read_to_string(user_packs_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Add or replace a custom user pack and persist the registry. Refuses a built-in
/// id and a pack whose id collides with a built-in.
pub fn save_user_pack(pack: SkillPack) -> Result<()> {
    if pack.builtin {
        anyhow::bail!("cannot persist a built-in pack");
    }
    if builtin_packs().iter().any(|p| p.id == pack.id) {
        anyhow::bail!("`{}` is a built-in pack id", pack.id);
    }
    let mut packs = user_packs();
    packs.retain(|p| p.id != pack.id);
    packs.push(pack);
    packs.sort_by(|a, b| a.id.cmp(&b.id));
    let path = user_packs_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    crate::atomic_file::write_atomic(&path, serde_json::to_string_pretty(&packs)?.as_bytes())
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

/// Remove a user pack (built-ins cannot be removed). Returns whether it existed.
pub fn remove_user_pack(id: &str) -> Result<bool> {
    if builtin_packs().iter().any(|p| p.id == id) {
        return Ok(false);
    }
    let mut packs = user_packs();
    let before = packs.len();
    packs.retain(|p| p.id != id);
    if packs.len() == before {
        return Ok(false);
    }
    let path = user_packs_path();
    crate::atomic_file::write_atomic(&path, serde_json::to_string_pretty(&packs)?.as_bytes())
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(true)
}

// ── Member resolution ─────────────────────────────────────────────────────────

/// How one pack member installs: either through skills.sh by its full id, or from
/// a repo scoped to one skill directory. A repo-pack member (`owner/repo/leaf`)
/// installs from the repo itself — the repo is the source of truth, and the
/// whole skill directory (scripts, references, assets) comes along, matching the
/// GitHub tap's fidelity. A custom-pack entry named as a skills.sh id installs
/// through skills.sh, the same path a user's catalog install uses.
#[derive(Debug, Clone)]
pub enum MemberSpec {
    /// Install via the skills.sh download path (`owner/repo/slug`).
    SkillsSh { id: String },
    /// Install a skill directory from a repo (`https://github.com/{repo}/tree/HEAD/{path}`).
    RepoLeaf { repo: String, path: String },
}

impl MemberSpec {
    /// The on-disk slug this member installs to.
    pub fn slug(&self) -> String {
        match self {
            MemberSpec::SkillsSh { id } => crate::skills_catalog::slug_of(id),
            MemberSpec::RepoLeaf { repo, path } => repo_leaf_name(repo, path),
        }
    }

    /// The stable catalog id for this member.
    fn id(&self) -> String {
        match self {
            MemberSpec::SkillsSh { id } => id.clone(),
            MemberSpec::RepoLeaf { repo, path } => {
                format!("{repo}/{}", repo_leaf_name(repo, path))
            }
        }
    }
}

/// Root-level skills use the repository name as their stable on-disk slug. The
/// upstream unlazy repository is one such skill (`SKILL.md` at its root).
fn repo_leaf_name(repo: &str, path: &str) -> String {
    if path == ROOT_SKILL_PATH {
        repo.rsplit('/').next().unwrap_or(repo).to_string()
    } else {
        path.rsplit('/').next().unwrap_or(path).to_string()
    }
}

fn repo_skill_source(repo: &str, path: &str) -> String {
    if path == ROOT_SKILL_PATH {
        format!("https://github.com/{repo}")
    } else {
        format!("https://github.com/{repo}/tree/HEAD/{path}")
    }
}

/// Resolve a pack to its member install specs, in repo/tree order. Best-effort: a
/// single entry that cannot resolve (repo gone, entry malformed) is logged and
/// skipped rather than failing the pack.
pub async fn resolve_member_specs(
    client: &reqwest::Client,
    source: &PackSource,
) -> Result<Vec<MemberSpec>> {
    match source {
        PackSource::Repo { repo } => {
            let tap = GithubTapSource::new(
                format!("pack:{repo}"),
                repo.clone(),
                repo.clone(),
                "trusted",
            );
            let paths = tap.skill_paths(client).await?;
            Ok(paths
                .into_iter()
                .map(|path| MemberSpec::RepoLeaf {
                    repo: repo.clone(),
                    path,
                })
                .collect())
        }
        PackSource::Custom { entries } => {
            let mut out = Vec::new();
            for entry in entries {
                match resolve_entry(client, entry).await {
                    Ok(specs) => out.extend(specs),
                    Err(e) => {
                        tracing::warn!(entry = %entry, error = %e, "pack entry resolution failed");
                    }
                }
            }
            Ok(out)
        }
    }
}

/// Resolve one custom-pack entry to member install specs.
async fn resolve_entry(client: &reqwest::Client, entry: &str) -> Result<Vec<MemberSpec>> {
    let trimmed = entry.trim();
    // A `owner/repo/slug` skills.sh id: that one skill is the member.
    if let Some((owner, repo, _slug)) = split_skill_id(trimmed) {
        let repo_full = format!("{owner}/{repo}");
        if repo_from_ref(&repo_full).is_some() {
            return Ok(vec![MemberSpec::SkillsSh {
                id: trimmed.to_string(),
            }]);
        }
    }
    // A repo reference: every skill in the repo is a member.
    if let Some((owner, repo)) = repo_from_ref(trimmed) {
        let repo = format!("{owner}/{repo}");
        let tap = GithubTapSource::new(
            format!("pack:{repo}"),
            repo.clone(),
            repo.clone(),
            "trusted",
        );
        let paths = tap.skill_paths(client).await?;
        return Ok(paths
            .into_iter()
            .map(|path| MemberSpec::RepoLeaf {
                repo: repo.clone(),
                path,
            })
            .collect());
    }
    anyhow::bail!("unrecognized pack entry `{entry}`")
}

/// Split `owner/repo/slug` into its parts. The slug may itself contain a colon
/// but never a slash, so the first two segments are always owner + repo.
fn split_skill_id(id: &str) -> Option<(String, String, String)> {
    let mut parts = id.splitn(3, '/');
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.to_string();
    let slug = parts.next()?.to_string();
    if owner.is_empty() || repo.is_empty() || slug.is_empty() {
        return None;
    }
    Some((owner, repo, slug))
}

/// Resolve a pack to member cards. Repo-pack members read descriptions from the
/// on-disk SKILL.md front matter for installed members (no network); skills.sh
/// members reuse the catalog search so an entry's description flows without a
/// per-member fetch.
pub async fn resolve_members(
    client: &reqwest::Client,
    source: &PackSource,
) -> Result<Vec<PackMember>> {
    let specs = resolve_member_specs(client, source).await?;
    let installed = skills_catalog::installed_slugs();
    let mut members = Vec::with_capacity(specs.len());
    for spec in specs {
        let slug = spec.slug();
        let installed_flag = installed.contains(&slug);
        let description = if installed_flag {
            front_matter_description(&slug)
        } else {
            None
        };
        let id = spec.id();
        members.push(PackMember {
            id,
            name: humanize_pack_name(&slug),
            description,
            installed: installed_flag,
        });
    }
    Ok(members)
}

/// Resolve a pack to its member skill ids (for the list/status payloads). Each
/// member's install spec collapses to its full id.
pub async fn resolve_member_ids(
    client: &reqwest::Client,
    source: &PackSource,
) -> Result<Vec<String>> {
    Ok(resolve_member_specs(client, source)
        .await?
        .into_iter()
        .map(|spec| spec.id())
        .collect())
}

/// Read the one-line `description` from an installed skill's SKILL.md front
/// matter, when present.
fn front_matter_description(slug: &str) -> Option<String> {
    let path = ryu_skills::SkillRegistry::skills_dir()
        .join(slug)
        .join("SKILL.md");
    let contents = std::fs::read_to_string(path).ok()?;
    let record = ryu_skills::parse_skill_md(slug, &contents).ok()?;
    record.description
}

// ── Install ───────────────────────────────────────────────────────────────────

/// Install every member of a pack. Best-effort per member: a member that fails
/// (repo gone, malformed id) is logged and skipped so one bad skill does not
/// strand the rest of the pack. Returns the slugs that landed on disk.
pub async fn install_pack(client: &reqwest::Client, source: &PackSource) -> Result<Vec<String>> {
    let specs = resolve_member_specs(client, source).await?;
    let mut installed = Vec::new();
    for spec in specs {
        match install_one(client, &spec).await {
            Ok(result) => installed.push(result.slug),
            Err(e) => {
                tracing::warn!(skill = %spec.slug(), error = %e, "pack member install failed");
            }
        }
    }
    Ok(installed)
}

/// Install one skill by its full id. A nested `owner/repo/slug` id installs via
/// the skills.sh download path; a root skill whose slug matches its repo name is
/// fetched from the repository so its references, scripts, and assets come
/// along. Public so the system-skills sync installs bundled skills through the
/// same per-skill path a user's install uses.
pub async fn install_skill_by_id(client: &reqwest::Client, id: &str) -> Result<InstallResult> {
    if let Some((owner, repo, slug)) = split_skill_id(id) {
        let repo_full = format!("{owner}/{repo}");
        if repo_from_ref(&repo_full).is_some() {
            if slug == repo {
                return from_source::install_from_source_named(
                    client,
                    &repo_full,
                    Some(slug.as_str()),
                )
                .await;
            }
            return skills_catalog::install_skill(client, id).await;
        }
    }
    // `owner/repo/leaf`: install the leaf subdirectory from the repo.
    let (repo, leaf) = id.rsplit_once('/').context("skill id has no leaf")?;
    if repo_from_ref(repo).is_none() {
        anyhow::bail!("skill id `{id}` does not name a repo + leaf");
    }
    let source = repo_skill_source(repo, leaf);
    from_source::install_from_source(client, &source).await
}

/// Install one resolved member spec. A skills.sh member downloads through the
/// skills.sh path; a repo-leaf member installs the skill directory from the repo
/// (the whole tree — scripts, references, assets — matching the GitHub tap's
/// fidelity).
async fn install_one(client: &reqwest::Client, spec: &MemberSpec) -> Result<InstallResult> {
    match spec {
        MemberSpec::SkillsSh { id } => skills_catalog::install_skill(client, id).await,
        MemberSpec::RepoLeaf { repo, path } => {
            let source = repo_skill_source(repo, path);
            from_source::install_from_source(client, &source).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_repo_forms() {
        assert_eq!(
            parse_pack_source("mattpocock/skills").unwrap(),
            PackSource::Repo {
                repo: "mattpocock/skills".into()
            }
        );
        assert_eq!(
            parse_pack_source("https://github.com/vercel-labs/agent-skills").unwrap(),
            PackSource::Repo {
                repo: "vercel-labs/agent-skills".into()
            }
        );
        assert_eq!(
            parse_pack_source("https://skills.sh/mattpocock/skills").unwrap(),
            PackSource::Repo {
                repo: "mattpocock/skills".into()
            }
        );
        assert_eq!(
            parse_pack_source("https://www.skills.sh/wshobson/agents").unwrap(),
            PackSource::Repo {
                repo: "wshobson/agents".into()
            }
        );
    }

    #[test]
    fn parse_custom_manifest() {
        let src = r#"{"entries": ["vercel-labs/agent-skills/web-design-guidelines", "https://github.com/emilkowalski/skills"]}"#;
        assert_eq!(
            parse_pack_source(src).unwrap(),
            PackSource::Custom {
                entries: vec![
                    "vercel-labs/agent-skills/web-design-guidelines".into(),
                    "https://github.com/emilkowalski/skills".into(),
                ]
            }
        );
    }

    #[test]
    fn parse_rejects_garbage() {
        assert!(parse_pack_source("").is_err());
        assert!(parse_pack_source("not a source").is_err());
    }

    #[test]
    fn repo_from_ref_normalizes() {
        assert_eq!(
            repo_from_ref("https://skills.sh/mattpocock/skills").unwrap(),
            ("mattpocock".into(), "skills".into())
        );
        assert_eq!(
            repo_from_ref("owner/repo").unwrap(),
            ("owner".into(), "repo".into())
        );
        // Three segments is a skill id, not a repo.
        assert!(repo_from_ref("owner/repo/slug").is_none());
        // A URL with a path beyond the repo is not a repo pack.
        assert!(repo_from_ref("https://github.com/owner/repo/tree/main/x").is_none());
    }

    #[test]
    fn split_skill_id_three_parts() {
        assert_eq!(
            split_skill_id("vercel-labs/agent-skills/find-skills"),
            Some((
                "vercel-labs".into(),
                "agent-skills".into(),
                "find-skills".into()
            ))
        );
        assert_eq!(split_skill_id("only/two"), None);
    }

    #[test]
    fn root_repo_member_uses_repo_name_and_root_source() {
        let spec = MemberSpec::RepoLeaf {
            repo: "Leonxlnx/unlazy".into(),
            path: ROOT_SKILL_PATH.into(),
        };
        assert_eq!(spec.slug(), "unlazy");
        assert_eq!(spec.id(), "Leonxlnx/unlazy/unlazy");
        assert_eq!(
            repo_skill_source("Leonxlnx/unlazy", ROOT_SKILL_PATH),
            "https://github.com/Leonxlnx/unlazy"
        );
    }

    #[test]
    fn builtin_packs_are_repo_packs() {
        let packs = builtin_packs();
        assert!(!packs.is_empty());
        assert_eq!(packs[0].id, "jakubkrehel/skills");
        for pack in &packs {
            assert!(pack.builtin);
            assert!(matches!(pack.source, PackSource::Repo { .. }));
            assert_eq!(
                pack.id,
                match &pack.source {
                    PackSource::Repo { repo } => repo.clone(),
                    PackSource::Custom { .. } => String::new(),
                }
            );
        }
    }

    #[test]
    fn builtin_catalog_includes_wshobson_agents() {
        let pack = builtin_packs()
            .into_iter()
            .find(|pack| pack.id == "wshobson/agents")
            .expect("wshobson/agents should ship as a built-in pack");

        assert!(pack.builtin);
        assert_eq!(pack.name, "Wshobson Agents");
        assert!(matches!(
            pack.source,
            PackSource::Repo { ref repo } if repo == "wshobson/agents"
        ));
    }

    #[test]
    fn builtin_catalog_includes_diagram_design() {
        let pack = builtin_packs()
            .into_iter()
            .find(|pack| pack.id == "cathrynlavery/diagram-design")
            .expect("cathrynlavery/diagram-design should ship as a built-in pack");

        assert!(pack.builtin);
        assert_eq!(pack.name, "Cathrynlavery Diagram Design");
        assert!(matches!(
            pack.source,
            PackSource::Repo { ref repo } if repo == "cathrynlavery/diagram-design"
        ));
    }

    #[test]
    fn builtin_catalog_includes_unlazy() {
        let pack = builtin_packs()
            .into_iter()
            .find(|pack| pack.id == "Leonxlnx/unlazy")
            .expect("Leonxlnx/unlazy should ship as a built-in pack");

        assert!(pack.builtin);
        assert_eq!(pack.name, "Leonxlnx Unlazy");
        assert!(matches!(
            pack.source,
            PackSource::Repo { ref repo } if repo == "Leonxlnx/unlazy"
        ));
    }

    #[test]
    fn user_pack_round_trip() {
        // `RYU_DIR` is process-global and `user_packs_path()` resolves through it,
        // so a concurrent test pointing the var at its own tempdir makes the reads
        // below land in an unrelated tree. Hold the shared skills-env lock.
        let _env_lock = ryu_skills::SKILLS_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let prev = std::env::var_os("RYU_DIR");
        let tmp = std::env::temp_dir().join(format!("ryu-packs-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("RYU_DIR", &tmp);

        let pack = SkillPack {
            id: "my-pack".into(),
            name: "My Pack".into(),
            description: "A custom pack".into(),
            source: PackSource::Custom {
                entries: vec!["owner/repo/slug".into()],
            },
            builtin: false,
        };
        save_user_pack(pack.clone()).unwrap();
        assert_eq!(user_packs().len(), 1);
        assert_eq!(user_packs()[0].id, "my-pack");
        assert!(remove_user_pack("my-pack").unwrap());
        assert!(user_packs().is_empty());

        match prev {
            Some(v) => std::env::set_var("RYU_DIR", v),
            None => std::env::remove_var("RYU_DIR"),
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn cannot_persist_builtin_id() {
        assert!(save_user_pack(SkillPack {
            id: "mattpocock/skills".into(),
            name: "x".into(),
            description: "x".into(),
            source: PackSource::Repo {
                repo: "mattpocock/skills".into()
            },
            builtin: false,
        })
        .is_err());
    }

    #[test]
    fn humanize_pack_name_title_cases() {
        assert_eq!(humanize_pack_name("mattpocock/skills"), "Mattpocock Skills");
        assert_eq!(
            humanize_pack_name("vercel-labs/agent-skills"),
            "Vercel Labs Agent Skills"
        );
        assert_eq!(humanize_pack_name("find-skills"), "Find Skills");
    }
}
