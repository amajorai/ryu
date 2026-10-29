//! Project rule discovery for the agent editor.
//!
//! The formats intentionally stay file-backed and provider-compatible: Cursor
//! rules are `.cursor/rules/*.mdc`, Claude rules are `CLAUDE.md` (including
//! `CLAUDE.local.md`) and `.claude/rules/*.md`, and the universal `AGENTS.md`
//! convention is surfaced as its own provider. Discovery is bounded because
//! this endpoint runs against user-selected project directories.

use axum::{extract::Query, http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

const MAX_FILES: usize = 512;
const MAX_TOTAL_BYTES: usize = 4 * 1024 * 1024;
const MAX_DEPTH: usize = 32;
/// Directory-visit budget for one discovery pass. The file cap alone does not
/// bound a scan of a huge tree with few rules (for example `$HOME` or `/`).
/// Real monorepos reach several thousand directories outside the skipped
/// dependency/build trees, so the budget sits well above any project and only
/// stops runaway scans; a pass that hits it reports `truncated`.
const MAX_DIRS: usize = 100_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RuleProvider {
    Cursor,
    Claude,
    Agents,
    Ryu,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RuleApplyMode {
    Always,
    Path,
    Intelligent,
    Manual,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RuleEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub provider: RuleProvider,
    pub scope: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub globs: Vec<String>,
    pub apply_mode: RuleApplyMode,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RuleDiscoveryResponse {
    /// `None` when the caller named no project directory.
    pub cwd: Option<String>,
    pub rules: Vec<RuleEntry>,
    /// `true` when the directory-visit budget stopped the walk early, so
    /// `rules` may be missing entries from directories that were not reached.
    pub truncated: bool,
}

#[derive(Debug, Deserialize)]
pub struct DiscoverQuery {
    pub cwd: Option<String>,
}

/// `GET /api/rules/discover`.
///
/// Without a `cwd` there is no project to scan, so the answer is empty. Core's
/// own process working directory is not a project (it is often `/` for a
/// launchd/systemd-started node), and walking it would scan the whole disk.
pub async fn discover(Query(query): Query<DiscoverQuery>) -> impl IntoResponse {
    let Some(requested) = query.cwd.filter(|value| !value.trim().is_empty()) else {
        return Json(RuleDiscoveryResponse {
            cwd: None,
            rules: Vec::new(),
            truncated: false,
        })
        .into_response();
    };
    match tokio::task::spawn_blocking(move || discover_requested(PathBuf::from(requested))).await {
        Ok(response) => response,
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("rule discovery failed: {error}") })),
        )
            .into_response(),
    }
}

/// Blocking half of [`discover`]: validate the directory and walk it.
fn discover_requested(cwd: PathBuf) -> axum::response::Response {
    let cwd = match fs::canonicalize(&cwd) {
        Ok(path) if path.is_dir() => path,
        Ok(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "cwd must be a directory" })),
            )
                .into_response();
        }
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid cwd: {error}") })),
            )
                .into_response();
        }
    };
    Json(discover_rules(&cwd)).into_response()
}

/// Discover rules below `cwd`, returning a stable path-sorted result.
pub fn discover_rules(cwd: &Path) -> RuleDiscoveryResponse {
    discover_rules_with_budget(cwd, MAX_DIRS)
}

fn discover_rules_with_budget(cwd: &Path, dir_budget: usize) -> RuleDiscoveryResponse {
    let root = fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let mut state = DiscoveryState::new(dir_budget);

    // Walk the project once for nested AGENTS/CLAUDE files. Rule directories
    // get targeted walks: Cursor never follows links, while Claude follows
    // links only inside the documented `.claude/rules` subtree.
    walk_project(&root, &root, 0, &mut state, &mut HashSet::new());

    state
        .rules
        .sort_by(|left, right| left.path.cmp(&right.path));
    RuleDiscoveryResponse {
        cwd: Some(root.to_string_lossy().into_owned()),
        rules: state.rules,
        truncated: state.truncated,
    }
}

struct DiscoveryState {
    rules: Vec<RuleEntry>,
    seen_paths: HashSet<PathBuf>,
    seen_files: HashSet<PathBuf>,
    bytes: usize,
    dirs_visited: usize,
    dir_budget: usize,
    truncated: bool,
}

impl DiscoveryState {
    fn new(dir_budget: usize) -> Self {
        Self {
            rules: Vec::new(),
            seen_paths: HashSet::new(),
            seen_files: HashSet::new(),
            bytes: 0,
            dirs_visited: 0,
            dir_budget,
            truncated: false,
        }
    }

    /// Spend one directory visit; `false` (and `truncated`) once the budget
    /// is exhausted.
    fn visit_dir(&mut self) -> bool {
        if self.dirs_visited >= self.dir_budget {
            self.truncated = true;
            return false;
        }
        self.dirs_visited += 1;
        true
    }
}

fn walk_project(
    dir: &Path,
    project_root: &Path,
    depth: usize,
    state: &mut DiscoveryState,
    visited_dirs: &mut HashSet<PathBuf>,
) {
    if depth > MAX_DEPTH || state.rules.len() >= MAX_FILES {
        return;
    }
    if !visited_dirs.insert(dir.to_path_buf()) || !state.visit_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        if state.rules.len() >= MAX_FILES {
            break;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_file() {
            if is_agents_rule(&path) || is_claude_rule(&path) {
                add_rule(&path, project_root, state);
            }
            continue;
        }
        if !metadata.is_dir() {
            continue;
        }
        // Keep common dependency/build/cache trees out of a recursive scan. A
        // rule may still live under a hidden directory such as `.claude`.
        if matches!(
            entry.file_name().to_str(),
            Some(".git" | "node_modules" | "target" | ".venv" | "__pycache__" | ".next" | ".turbo")
        ) {
            continue;
        }
        let name = entry.file_name();
        if name == "rules" {
            let parent_name = dir.file_name().and_then(|value| value.to_str());
            if parent_name == Some(".cursor") {
                walk_rule_dir(
                    &path,
                    project_root,
                    depth + 1,
                    false,
                    state,
                    &mut HashSet::new(),
                    is_cursor_rule,
                );
                continue;
            }
            if parent_name == Some(".claude") {
                walk_rule_dir(
                    &path,
                    project_root,
                    depth + 1,
                    true,
                    state,
                    &mut HashSet::new(),
                    is_claude_rule,
                );
                continue;
            }
        }
        walk_project(&path, project_root, depth + 1, state, visited_dirs);
    }
}

fn walk_rule_dir(
    dir: &Path,
    project_root: &Path,
    depth: usize,
    follow_symlinks: bool,
    state: &mut DiscoveryState,
    visited_dirs: &mut HashSet<PathBuf>,
    is_rule: fn(&Path) -> bool,
) {
    if depth > MAX_DEPTH || state.rules.len() >= MAX_FILES {
        return;
    }
    let canonical_dir = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    if !canonical_dir.starts_with(project_root) {
        return;
    }
    if !visited_dirs.insert(canonical_dir) || !state.visit_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if state.rules.len() >= MAX_FILES {
            break;
        }
        let path = entry.path();
        let metadata = if follow_symlinks {
            fs::metadata(&path)
        } else {
            fs::symlink_metadata(&path)
        };
        let Ok(metadata) = metadata else { continue };
        if metadata.is_dir() {
            walk_rule_dir(
                &path,
                project_root,
                depth + 1,
                follow_symlinks,
                state,
                visited_dirs,
                is_rule,
            );
        } else if metadata.is_file() && is_rule(&path) {
            add_rule(&path, project_root, state);
        }
    }
}

fn add_rule(path: &Path, root: &Path, state: &mut DiscoveryState) {
    let Ok(relative) = path.strip_prefix(root) else {
        return;
    };
    let relative = relative.to_string_lossy().replace('\\', "/");
    if !state.seen_paths.insert(PathBuf::from(&relative)) {
        return;
    }
    let Ok(canonical_file) = fs::canonicalize(path) else {
        return;
    };
    if !canonical_file.starts_with(root) {
        return;
    }
    if !state.seen_files.insert(canonical_file.clone()) {
        return;
    }
    let Ok(bytes) = fs::read(&canonical_file) else {
        return;
    };
    if bytes.is_empty() || bytes.len() > MAX_TOTAL_BYTES.saturating_sub(state.bytes) {
        return;
    }
    state.bytes += bytes.len();
    let Ok(content) = String::from_utf8(bytes) else {
        return;
    };
    let metadata = parse_frontmatter(&content);
    let body = strip_frontmatter(&content).to_owned();
    let provider = provider_for_path(path);
    // Claude calls these `paths`; expose them through the shared `globs` field
    // so the editor can render one path-pattern control for both providers.
    let mut globs = if metadata.globs.is_empty() {
        metadata.paths.clone()
    } else {
        metadata.globs.clone()
    };
    if globs.is_empty() {
        if let Some(glob) = nested_instruction_glob(&provider, path, root) {
            globs.push(glob);
        }
    }
    let apply_mode = apply_mode(&provider, &metadata, &globs);
    let name = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("rule")
        .to_owned();
    let id = format!("{}:{relative}", provider_string(&provider));
    state.rules.push(RuleEntry {
        id,
        name,
        path: relative,
        provider,
        scope: "project".to_owned(),
        content: body,
        description: metadata.description,
        globs,
        apply_mode,
        enabled: true,
    });
}

fn is_agents_rule(path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()) == Some("AGENTS.md")
}

fn is_claude_rule(path: &Path) -> bool {
    let name = path.file_name().and_then(|name| name.to_str());
    name == Some("CLAUDE.md")
        || name == Some("CLAUDE.local.md")
        || (name.is_some_and(|name| name.ends_with(".md")) && has_directory(path, ".claude/rules"))
}

/// A nested instruction file is inherited by its directory, not by the whole
/// project. Normalize that implicit scope into the shared path-pattern field so
/// callers injecting rules do not apply every subtree's CLAUDE/AGENTS file to a
/// root-level turn.
fn nested_instruction_glob(provider: &RuleProvider, path: &Path, root: &Path) -> Option<String> {
    if !matches!(provider, RuleProvider::Agents | RuleProvider::Claude) {
        return None;
    }
    let relative = path.strip_prefix(root).ok()?;
    let relative_name = relative.file_name()?.to_str()?;
    if !matches!(relative_name, "AGENTS.md" | "CLAUDE.md" | "CLAUDE.local.md") {
        return None;
    }
    let mut directory = relative.parent()?.to_path_buf();
    // `.claude/CLAUDE.md` at the project root is a project-wide Claude rule;
    // for nested copies, its parent is the project subtree it governs.
    if directory.file_name().and_then(|name| name.to_str()) == Some(".claude") {
        directory = directory.parent().unwrap_or(Path::new("")).to_path_buf();
    }
    if directory.as_os_str().is_empty() {
        return None;
    }
    Some(format!(
        "{}/**",
        directory.to_string_lossy().replace('\\', "/")
    ))
}

fn is_cursor_rule(path: &Path) -> bool {
    path.extension().and_then(|extension| extension.to_str()) == Some("mdc")
        && has_directory(path, ".cursor/rules")
}

fn has_directory(path: &Path, expected: &str) -> bool {
    let components: Vec<_> = path
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect();
    let expected: Vec<_> = expected.split('/').collect();
    components
        .windows(expected.len())
        .any(|window| window == expected)
}

#[derive(Default)]
struct Frontmatter {
    description: Option<String>,
    globs: Vec<String>,
    paths: Vec<String>,
    always_apply: Option<bool>,
}

fn parse_frontmatter(content: &str) -> Frontmatter {
    let mut result = Frontmatter::default();
    let mut list_key: Option<&str> = None;
    let Some(end) = frontmatter_end(content) else {
        return result;
    };
    for line in content[..end].lines().skip(1) {
        let line = line.trim();
        if line == "---" || line == "..." {
            break;
        }
        if let Some(item) = line.strip_prefix("- ") {
            let item = item.trim().trim_matches(['"', '\'']);
            if !item.is_empty() {
                match list_key {
                    Some("globs") => result.globs.push(item.to_owned()),
                    Some("paths") => result.paths.push(item.to_owned()),
                    _ => {}
                }
            }
            continue;
        }
        let Some((key, raw)) = line.split_once(':') else {
            list_key = None;
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let value = raw.trim().trim_matches(['"', '\'']);
        list_key = if value.is_empty() && matches!(key.as_str(), "globs" | "paths") {
            Some(if key == "globs" { "globs" } else { "paths" })
        } else {
            None
        };
        match key.as_str() {
            "description" => result.description = (!value.is_empty()).then(|| value.to_owned()),
            "globs" => result.globs = parse_list(value),
            "paths" => result.paths = parse_list(value),
            "alwaysapply" | "always_apply" => {
                result.always_apply = match value.to_ascii_lowercase().as_str() {
                    "true" | "yes" => Some(true),
                    "false" | "no" => Some(false),
                    _ => None,
                };
            }
            _ => {}
        }
    }
    result
}

fn frontmatter_end(content: &str) -> Option<usize> {
    if !content.starts_with("---") {
        return None;
    }
    let first_newline = content.find('\n')?;
    let mut start = first_newline + 1;
    while start <= content.len() {
        let next_newline = content[start..].find('\n').map(|offset| start + offset);
        let end = next_newline.unwrap_or(content.len());
        let line = content[start..end].trim();
        if line == "---" || line == "..." {
            return Some(next_newline.map_or(end, |offset| offset + 1));
        }
        let Some(next_newline) = next_newline else {
            break;
        };
        start = next_newline + 1;
    }
    None
}

fn strip_frontmatter(content: &str) -> &str {
    frontmatter_end(content)
        .map(|end| content[end..].trim_start_matches('\n'))
        .unwrap_or(content)
}

fn parse_list(value: &str) -> Vec<String> {
    let value = value.trim().trim_start_matches('[').trim_end_matches(']');
    value
        .split(',')
        .map(|item| item.trim().trim_matches(['"', '\'']).to_owned())
        .filter(|item| !item.is_empty())
        .collect()
}

fn apply_mode(provider: &RuleProvider, metadata: &Frontmatter, globs: &[String]) -> RuleApplyMode {
    if metadata.always_apply == Some(true) {
        return RuleApplyMode::Always;
    }
    if !globs.is_empty() || !metadata.paths.is_empty() {
        return RuleApplyMode::Path;
    }
    match provider {
        RuleProvider::Agents | RuleProvider::Claude => RuleApplyMode::Always,
        RuleProvider::Cursor => RuleApplyMode::Intelligent,
        RuleProvider::Ryu => RuleApplyMode::Manual,
    }
}

fn provider_for_path(path: &Path) -> RuleProvider {
    if is_cursor_rule(path) {
        RuleProvider::Cursor
    } else if is_agents_rule(path) {
        RuleProvider::Agents
    } else if is_claude_rule(path) {
        RuleProvider::Claude
    } else {
        RuleProvider::Ryu
    }
}

fn provider_string(provider: &RuleProvider) -> &'static str {
    match provider {
        RuleProvider::Cursor => "cursor",
        RuleProvider::Claude => "claude",
        RuleProvider::Agents => "agents",
        RuleProvider::Ryu => "ryu",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    #[cfg(windows)]
    use std::os::windows::fs::symlink_dir as symlink;

    #[test]
    fn discovers_provider_layouts_and_frontmatter() {
        let root = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(root.path().join(".cursor/rules")).unwrap();
        fs::create_dir_all(root.path().join(".claude/rules")).unwrap();
        fs::create_dir_all(root.path().join("nested")).unwrap();
        fs::write(root.path().join("AGENTS.md"), "agent rule").unwrap();
        fs::write(root.path().join("nested/CLAUDE.local.md"), "claude rule").unwrap();
        fs::write(
            root.path().join(".cursor/rules/types.mdc"),
            "---\ndescription: Type rules\nglobs: [\"**/*.ts\"]\nalwaysApply: false\n---\ncontent",
        )
        .unwrap();
        fs::write(
            root.path().join(".claude/rules/tests.md"),
            "---\npaths:\n  - \"tests/**\"\n---\ncontent",
        )
        .unwrap();

        let response = discover_rules(root.path());
        assert_eq!(response.rules.len(), 4);
        let cursor = response
            .rules
            .iter()
            .find(|rule| rule.provider == RuleProvider::Cursor)
            .unwrap();
        assert_eq!(cursor.apply_mode, RuleApplyMode::Path);
        assert_eq!(cursor.description.as_deref(), Some("Type rules"));
        assert_eq!(cursor.globs, vec!["**/*.ts"]);
        assert_eq!(cursor.content, "content");
        let claude = response
            .rules
            .iter()
            .find(|rule| rule.path.ends_with("tests.md"))
            .unwrap();
        assert_eq!(claude.apply_mode, RuleApplyMode::Path);
        assert_eq!(claude.globs, vec!["tests/**"]);
        let nested = response
            .rules
            .iter()
            .find(|rule| rule.path == "nested/CLAUDE.local.md")
            .unwrap();
        assert_eq!(nested.apply_mode, RuleApplyMode::Path);
        assert_eq!(nested.globs, vec!["nested/**"]);
    }

    #[tokio::test]
    async fn missing_cwd_returns_empty_without_scanning_the_process_cwd() {
        for cwd in [None, Some("   ".to_owned())] {
            let response = discover(Query(DiscoverQuery { cwd })).await.into_response();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body");
            let body: serde_json::Value = serde_json::from_slice(&bytes).expect("json");
            assert_eq!(
                body,
                json!({ "cwd": null, "rules": [], "truncated": false })
            );
        }
    }

    #[test]
    fn directory_visits_are_budgeted_and_report_truncation() {
        let root = tempfile::tempdir().expect("tempdir");
        for name in ["a", "b", "c"] {
            fs::create_dir_all(root.path().join(name)).unwrap();
            fs::write(root.path().join(name).join("AGENTS.md"), name).unwrap();
        }

        // The default budget covers a normal project: every nested rule is
        // found and the result is complete.
        let full = discover_rules(root.path());
        let paths: Vec<_> = full.rules.iter().map(|rule| rule.path.as_str()).collect();
        assert_eq!(paths, vec!["a/AGENTS.md", "b/AGENTS.md", "c/AGENTS.md"]);
        assert!(!full.truncated);

        // A budget of root + one child stops the walk and says so.
        let partial = discover_rules_with_budget(root.path(), 2);
        let paths: Vec<_> = partial
            .rules
            .iter()
            .map(|rule| rule.path.as_str())
            .collect();
        assert_eq!(paths, vec!["a/AGENTS.md"]);
        assert!(partial.truncated);
    }

    #[test]
    fn more_directories_than_the_old_cap_are_still_walked() {
        let root = tempfile::tempdir().expect("tempdir");
        // 4,200 early-sorting directories used to exhaust a 4,096 budget
        // before the walk reached `zz/`.
        for index in 0..4_200 {
            fs::create_dir_all(root.path().join(format!("aa/{index:05}"))).unwrap();
        }
        fs::create_dir_all(root.path().join("zz")).unwrap();
        fs::write(root.path().join("zz/AGENTS.md"), "late rule").unwrap();

        let response = discover_rules(root.path());
        assert!(response
            .rules
            .iter()
            .any(|rule| rule.path == "zz/AGENTS.md"));
        assert!(!response.truncated);
    }

    #[test]
    fn heavy_cache_directories_are_skipped() {
        let root = tempfile::tempdir().expect("tempdir");
        for name in [".venv", "__pycache__", ".next", ".turbo", "src"] {
            fs::create_dir_all(root.path().join(name)).unwrap();
            fs::write(root.path().join(name).join("AGENTS.md"), name).unwrap();
        }
        let response = discover_rules(root.path());
        let paths: Vec<_> = response
            .rules
            .iter()
            .map(|rule| rule.path.as_str())
            .collect();
        assert_eq!(paths, vec!["src/AGENTS.md"]);
    }

    #[cfg(unix)]
    #[test]
    fn claude_symlink_cycle_is_safe_and_cursor_symlink_is_ignored() {
        let root = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(root.path().join("shared/.claude/rules")).unwrap();
        fs::create_dir_all(root.path().join(".cursor/rules")).unwrap();
        fs::write(root.path().join("shared/.claude/rules/shared.md"), "shared").unwrap();
        symlink(root.path(), root.path().join("shared/loop")).unwrap();
        symlink(
            root.path().join("shared/.claude/rules/shared.md"),
            root.path().join(".cursor/rules/link.mdc"),
        )
        .unwrap();

        let response = discover_rules(root.path());
        assert_eq!(
            response
                .rules
                .iter()
                .filter(|rule| rule.provider == RuleProvider::Claude)
                .count(),
            1
        );
        assert!(!response
            .rules
            .iter()
            .any(|rule| rule.provider == RuleProvider::Cursor));
    }

    #[cfg(unix)]
    #[test]
    fn claude_rules_follow_only_symlinks_that_stay_inside_the_project() {
        let root = tempfile::tempdir().expect("project tempdir");
        let outside = tempfile::tempdir().expect("outside tempdir");
        fs::create_dir_all(root.path().join(".claude/rules")).unwrap();
        fs::create_dir_all(root.path().join("shared")).unwrap();
        fs::write(root.path().join("shared/inside.md"), "inside rule").unwrap();
        fs::write(outside.path().join("secret.md"), "outside secret").unwrap();
        fs::create_dir_all(outside.path().join("rules")).unwrap();
        fs::write(outside.path().join("rules/leak.md"), "outside directory").unwrap();

        symlink(
            root.path().join("shared/inside.md"),
            root.path().join(".claude/rules/inside.md"),
        )
        .unwrap();
        symlink(
            outside.path().join("secret.md"),
            root.path().join(".claude/rules/external.md"),
        )
        .unwrap();
        symlink(
            outside.path().join("rules"),
            root.path().join(".claude/rules/external-dir"),
        )
        .unwrap();

        let response = discover_rules(root.path());
        assert_eq!(response.rules.len(), 1);
        assert_eq!(response.rules[0].path, ".claude/rules/inside.md");
        assert_eq!(response.rules[0].content, "inside rule");
    }
}
