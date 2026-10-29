//! Package-level behavioral evaluations for installed Ryu plugins and apps.
//!
//! The on-disk layout intentionally follows Claude Code's plugin-evals shape:
//! `evals/<case>/prompt.md` plus `graders/*.md`, with an optional `case.yaml`.
//! Ryu owns the execution boundary, however. The parser is read-only and safe to
//! use from the plugin doctor; the run endpoint is the explicit, authenticated
//! path that executes an enabled artifact through Core's normal agent pipeline.
//!
//! This module contains the shared contract and parser. It does not treat a
//! missing suite as a broken plugin: behavioral coverage is an authoring signal,
//! while manifest/lifecycle validity remains the doctor's hard contract.

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

pub(crate) const EVAL_DIR_NAME: &str = "evals";
pub(crate) const SCHEMA_VERSION: &str = "1";
pub(crate) const RULESET_VERSION: &str = "ryu-plugin-evals-1";
pub(crate) const DEFAULT_RUNS: usize = 3;
pub(crate) const MAX_RUNS: usize = 10;
pub(crate) const MAX_CASES: usize = 100;
pub(crate) const MAX_GRADERS_PER_CASE: usize = 32;
pub(crate) const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_DISCOVERY_DEPTH: usize = 64;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EvalIssue {
    pub code: String,
    pub message: String,
    pub path: String,
    pub severity: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EvalCaseSummary {
    pub id: String,
    pub name: String,
    pub path: String,
    pub runs: usize,
    pub max_turns: usize,
    pub timeout_seconds: u64,
    pub grader_count: usize,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runnable: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EvalSuiteSummary {
    pub schema_version: &'static str,
    pub ruleset_version: &'static str,
    pub status: String,
    pub directory: String,
    pub case_count: usize,
    pub grader_count: usize,
    pub supported_graders: Vec<String>,
    pub unsupported_graders: Vec<String>,
    pub cases: Vec<EvalCaseSummary>,
    pub issues: Vec<EvalIssue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EvalOverview {
    pub plugin_id: String,
    pub artifact_kind: String,
    pub suite: EvalSuiteSummary,
}

#[derive(Debug, Clone)]
pub(crate) struct ParsedSuite {
    pub overview: EvalOverview,
    pub cases: Vec<ParsedCase>,
}

#[derive(Debug, Clone)]
pub(crate) struct ParsedCase {
    pub summary: EvalCaseSummary,
    pub prompt: String,
    pub graders: Vec<ParsedGrader>,
}

#[derive(Debug, Clone)]
pub(crate) struct ParsedGrader {
    pub id: String,
    pub kind: String,
    pub spec: GraderSpec,
}

#[derive(Debug, Clone)]
pub(crate) enum GraderSpec {
    Regex {
        pattern: String,
        flags: String,
        match_mode: String,
        target: String,
    },
    ToolUsed {
        tool: String,
        input_match: Option<String>,
        min: usize,
        max: Option<usize>,
    },
    ToolOrder {
        before: String,
        after: String,
    },
    Llm {
        criteria: String,
        focus: String,
        model: Option<String>,
    },
    Unsupported {
        reason: String,
    },
}

impl GraderSpec {
    pub(crate) fn supported_kind(&self) -> bool {
        !matches!(self, Self::Unsupported { .. })
    }
}

/// Inspect a package's conventional `evals/` directory without executing any
/// package code. `root` must already be resolved by the caller to the installed
/// package directory.
pub(crate) fn inspect_package(root: &Path, plugin_id: &str, artifact_kind: &str) -> ParsedSuite {
    let eval_root = root.join(EVAL_DIR_NAME);
    let mut summary = empty_summary();
    if !eval_root.is_dir() {
        return ParsedSuite {
            overview: EvalOverview {
                plugin_id: plugin_id.to_owned(),
                artifact_kind: artifact_kind.to_owned(),
                suite: summary,
            },
            cases: Vec::new(),
        };
    }

    let canonical_package_root = match std::fs::canonicalize(root) {
        Ok(path) => path,
        Err(error) => {
            summary.status = "invalid".to_owned();
            summary.issues.push(issue(
                "evals.package-unreadable",
                "error",
                ".",
                format!("could not resolve the package root: {error}"),
            ));
            return ParsedSuite {
                overview: EvalOverview {
                    plugin_id: plugin_id.to_owned(),
                    artifact_kind: artifact_kind.to_owned(),
                    suite: summary,
                },
                cases: Vec::new(),
            };
        }
    };
    let canonical_root = match std::fs::canonicalize(&eval_root) {
        Ok(path) => path,
        Err(error) => {
            summary.status = "invalid".to_owned();
            summary.issues.push(issue(
                "evals.directory-unreadable",
                "error",
                &format!("{EVAL_DIR_NAME}/"),
                format!("could not resolve the eval directory: {error}"),
            ));
            return ParsedSuite {
                overview: EvalOverview {
                    plugin_id: plugin_id.to_owned(),
                    artifact_kind: artifact_kind.to_owned(),
                    suite: summary,
                },
                cases: Vec::new(),
            };
        }
    };
    if !canonical_root.starts_with(&canonical_package_root) {
        summary.status = "invalid".to_owned();
        summary.issues.push(issue(
            "evals.path-escape",
            "error",
            EVAL_DIR_NAME,
            "eval directory resolves outside the package root",
        ));
        return ParsedSuite {
            overview: EvalOverview {
                plugin_id: plugin_id.to_owned(),
                artifact_kind: artifact_kind.to_owned(),
                suite: summary,
            },
            cases: Vec::new(),
        };
    }

    let mut case_dirs = Vec::new();
    let mut visited_dirs = HashSet::new();
    discover_case_dirs(
        &canonical_root,
        &canonical_root,
        &mut case_dirs,
        &mut summary.issues,
        &mut visited_dirs,
        0,
    );
    case_dirs.sort_by(|left, right| left.0.cmp(&right.0));

    if case_dirs.len() > MAX_CASES {
        summary.status = "invalid".to_owned();
        summary.issues.push(issue(
            "evals.too-many-cases",
            "error",
            &format!("{EVAL_DIR_NAME}/"),
            format!("suite contains more than {MAX_CASES} cases"),
        ));
        case_dirs.truncate(MAX_CASES);
    }

    let mut cases = Vec::new();
    let mut supported = BTreeSet::new();
    let mut unsupported = BTreeSet::new();
    for (relative_path, case_dir) in case_dirs {
        match parse_case(
            &canonical_root,
            &relative_path,
            &case_dir,
            &mut summary.issues,
        ) {
            Ok(case) => {
                summary.grader_count += case.graders.len();
                for grader in &case.graders {
                    if grader.spec.supported_kind() {
                        supported.insert(grader.kind.clone());
                    } else {
                        unsupported.insert(grader.kind.clone());
                    }
                }
                summary.cases.push(case.summary.clone());
                cases.push(case);
            }
            Err(()) => {}
        }
    }
    summary.case_count = summary.cases.len();
    summary.supported_graders = supported.into_iter().collect();
    summary.unsupported_graders = unsupported.into_iter().collect();
    summary.status = if summary.issues.iter().any(|entry| entry.severity == "error") {
        "invalid"
    } else if summary.case_count == 0 {
        "empty"
    } else if summary
        .issues
        .iter()
        .any(|entry| entry.severity == "warning")
    {
        "ready_with_warnings"
    } else {
        "ready"
    }
    .to_owned();

    ParsedSuite {
        overview: EvalOverview {
            plugin_id: plugin_id.to_owned(),
            artifact_kind: artifact_kind.to_owned(),
            suite: summary,
        },
        cases,
    }
}

fn empty_summary() -> EvalSuiteSummary {
    EvalSuiteSummary {
        schema_version: SCHEMA_VERSION,
        ruleset_version: RULESET_VERSION,
        status: "not_configured".to_owned(),
        directory: EVAL_DIR_NAME.to_owned(),
        case_count: 0,
        grader_count: 0,
        supported_graders: Vec::new(),
        unsupported_graders: Vec::new(),
        cases: Vec::new(),
        issues: Vec::new(),
    }
}

fn issue(code: &str, severity: &str, path: &str, message: impl Into<String>) -> EvalIssue {
    EvalIssue {
        code: code.to_owned(),
        message: message.into(),
        path: path.to_owned(),
        severity: severity.to_owned(),
    }
}

fn discover_case_dirs(
    root: &Path,
    current: &Path,
    out: &mut Vec<(String, PathBuf)>,
    issues: &mut Vec<EvalIssue>,
    visited_dirs: &mut HashSet<PathBuf>,
    depth: usize,
) {
    if depth > MAX_DISCOVERY_DEPTH {
        issues.push(issue(
            "evals.directory-too-deep",
            "error",
            &relative_path(root, current),
            format!("eval directory nesting exceeds {MAX_DISCOVERY_DEPTH} levels"),
        ));
        return;
    }
    // Package contents are untrusted. A symlink may point back to an ancestor
    // inside the package, so canonicalize-and-recurse needs a visited set or a
    // malicious eval tree can make the doctor recurse forever and exhaust Core's
    // stack. Re-visiting an already inspected directory is a no-op.
    if !visited_dirs.insert(current.to_path_buf()) {
        return;
    }
    if current != root && current.file_name().and_then(|name| name.to_str()) == Some("results") {
        return;
    }
    let Ok(entries) = std::fs::read_dir(current) else {
        issues.push(issue(
            "evals.directory-unreadable",
            "error",
            &relative_path(root, current),
            "could not read a case directory",
        ));
        return;
    };
    let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
    entries.sort_by_key(|entry| entry.file_name());
    let has_prompt = current.join("prompt.md").is_file();
    let has_case_yaml = current.join("case.yaml").is_file();
    if current != root && (has_prompt || has_case_yaml) {
        out.push((relative_path(root, current), current.to_owned()));
        return;
    }
    for entry in entries {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !(file_type.is_dir() || (file_type.is_symlink() && path.is_dir())) {
            continue;
        }
        let Ok(canonical) = std::fs::canonicalize(&path) else {
            issues.push(issue(
                "evals.path-unreadable",
                "error",
                &relative_path(root, &path),
                "could not resolve an eval path",
            ));
            continue;
        };
        if !canonical.starts_with(root) {
            issues.push(issue(
                "evals.path-escape",
                "error",
                &relative_path(root, &path),
                "eval path resolves outside the package eval directory",
            ));
            continue;
        }
        discover_case_dirs(root, &canonical, out, issues, visited_dirs, depth + 1);
    }
}

fn parse_case(
    root: &Path,
    relative_path: &str,
    case_dir: &Path,
    issues: &mut Vec<EvalIssue>,
) -> Result<ParsedCase, ()> {
    let case_yaml_path = case_dir.join("case.yaml");
    let case_yaml = if case_yaml_path.is_file() {
        let parsed = match read_yaml_file(root, &case_yaml_path, relative_path, issues) {
            Some(value) => value,
            None => return Err(()),
        };
        match string_field(&parsed, "schema_version").as_deref() {
            Some("1.1") => {}
            Some(version) => {
                issues.push(issue(
                    "evals.case-schema-version",
                    "error",
                    &format!("{relative_path}/case.yaml"),
                    format!("unsupported case.yaml schema_version '{version}'; expected '1.1'"),
                ));
                return Err(());
            }
            None => {
                issues.push(issue(
                    "evals.case-schema-version",
                    "error",
                    &format!("{relative_path}/case.yaml"),
                    "case.yaml must declare schema_version '1.1'",
                ));
                return Err(());
            }
        }
        parsed
    } else {
        Value::Object(Map::new())
    };

    let prompt_path = case_dir.join("prompt.md");
    let (prompt_frontmatter, prompt_body) = if prompt_path.is_file() {
        let Some(raw) = read_text_file(root, &prompt_path, relative_path, issues) else {
            return Err(());
        };
        match split_frontmatter(&raw, &format!("{relative_path}/prompt.md")) {
            Ok(value) => value,
            Err(error) => {
                issues.push(issue(
                    "evals.prompt-frontmatter",
                    "error",
                    &format!("{relative_path}/prompt.md"),
                    error,
                ));
                return Err(());
            }
        }
    } else {
        (Value::Object(Map::new()), String::new())
    };

    let prompt = if prompt_body.trim().is_empty() {
        nested_string(&case_yaml, &["execution", "prompt"])
            .or_else(|| string_field(&case_yaml, "prompt"))
            .unwrap_or_default()
    } else {
        prompt_body.trim().to_owned()
    };
    if prompt.trim().is_empty() {
        issues.push(issue(
            "evals.prompt-missing",
            "error",
            relative_path,
            "case needs prompt.md with a body or case.yaml execution.prompt",
        ));
        return Err(());
    }

    let name = string_field(&prompt_frontmatter, "name")
        .or_else(|| string_field(&case_yaml, "name"))
        .unwrap_or_else(|| {
            case_dir
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("case")
                .to_owned()
        });
    let runs = numeric_field(&prompt_frontmatter, "runs")
        .or_else(|| numeric_field(&case_yaml, "runs"))
        .unwrap_or(DEFAULT_RUNS)
        .clamp(1, MAX_RUNS);
    let max_turns = numeric_field(&prompt_frontmatter, "max_turns")
        .or_else(|| nested_number(&case_yaml, &["execution", "max_turns"]))
        .unwrap_or(10)
        .clamp(1, 200);
    let timeout_seconds = numeric_field(&prompt_frontmatter, "timeout_seconds")
        .or_else(|| nested_number(&case_yaml, &["execution", "timeout_seconds"]))
        .unwrap_or(300)
        .clamp(1, 3600);
    let tags = list_field(&prompt_frontmatter, "tags")
        .or_else(|| list_field(&case_yaml, "tags"))
        .unwrap_or_default();
    let runnable = string_field(&prompt_frontmatter, "runnable")
        .or_else(|| nested_string(&case_yaml, &["execution", "runnable"]));

    let grader_dir = case_dir.join("graders");
    let mut graders = Vec::new();
    if grader_dir.is_dir() {
        let Ok(entries) = std::fs::read_dir(&grader_dir) else {
            issues.push(issue(
                "evals.graders-unreadable",
                "error",
                &format!("{relative_path}/graders"),
                "could not read the graders directory",
            ));
            return Err(());
        };
        let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
                continue;
            }
            if graders.len() >= MAX_GRADERS_PER_CASE {
                issues.push(issue(
                    "evals.too-many-graders",
                    "error",
                    &format!("{relative_path}/graders"),
                    format!("a case may contain at most {MAX_GRADERS_PER_CASE} graders"),
                ));
                break;
            }
            let grader_id = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("grader")
                .to_owned();
            let grader_path = format!("{relative_path}/graders/{}.md", grader_id);
            let Some(raw) = read_text_file(root, &path, &grader_path, issues) else {
                continue;
            };
            match parse_grader(&raw, &grader_path) {
                Ok(grader) => graders.push(ParsedGrader {
                    id: grader_id,
                    kind: grader.0,
                    spec: grader.1,
                }),
                Err(error) => issues.push(error),
            }
        }
    }
    if graders.is_empty() {
        issues.push(issue(
            "evals.no-graders",
            "warning",
            relative_path,
            "case has no graders, so it cannot produce a behavioral score",
        ));
    }

    Ok(ParsedCase {
        summary: EvalCaseSummary {
            id: relative_path.replace('\\', "/"),
            name,
            path: relative_path.to_owned(),
            runs,
            max_turns,
            timeout_seconds: timeout_seconds as u64,
            grader_count: graders.len(),
            tags,
            runnable,
        },
        prompt,
        graders,
    })
}

fn parse_grader(raw: &str, path: &str) -> Result<(String, GraderSpec), EvalIssue> {
    let (frontmatter, body) = split_frontmatter(raw, path)
        .map_err(|error| issue("evals.grader-frontmatter", "error", path, error))?;
    let kind = string_field(&frontmatter, "type")
        .unwrap_or_default()
        .to_ascii_lowercase();
    if kind.is_empty() {
        return Err(issue(
            "evals.grader-type-missing",
            "error",
            path,
            "grader frontmatter must declare type",
        ));
    }
    let spec = match kind.as_str() {
        "regex" => {
            let pattern = string_field(&frontmatter, "pattern")
                .or_else(|| (!body.trim().is_empty()).then(|| body.trim().to_owned()))
                .unwrap_or_default();
            if pattern.is_empty() {
                return Err(issue(
                    "evals.regex-pattern-missing",
                    "error",
                    path,
                    "regex grader needs a pattern",
                ));
            }
            GraderSpec::Regex {
                pattern,
                flags: string_field(&frontmatter, "flags").unwrap_or_default(),
                match_mode: string_field(&frontmatter, "match")
                    .unwrap_or_else(|| "contains".to_owned()),
                target: string_field(&frontmatter, "target")
                    .unwrap_or_else(|| "last_message".to_owned()),
            }
        }
        "tool_used" => {
            let Some(tool) = string_field(&frontmatter, "tool") else {
                return Err(issue(
                    "evals.tool-missing",
                    "error",
                    path,
                    "tool_used grader needs a tool name",
                ));
            };
            GraderSpec::ToolUsed {
                tool,
                input_match: string_field(&frontmatter, "input_match"),
                min: numeric_field(&frontmatter, "min").unwrap_or(1),
                max: numeric_field(&frontmatter, "max"),
            }
        }
        "tool_order" => {
            let before = string_field(&frontmatter, "before").unwrap_or_default();
            let after = string_field(&frontmatter, "after").unwrap_or_default();
            if before.is_empty() || after.is_empty() {
                return Err(issue(
                    "evals.tool-order-missing",
                    "error",
                    path,
                    "tool_order grader needs before and after tool names",
                ));
            }
            GraderSpec::ToolOrder { before, after }
        }
        "llm" => {
            let criteria = string_field(&frontmatter, "criteria")
                .or_else(|| (!body.trim().is_empty()).then(|| body.trim().to_owned()))
                .unwrap_or_default();
            if criteria.is_empty() {
                return Err(issue(
                    "evals.llm-criteria-missing",
                    "error",
                    path,
                    "llm grader needs criteria in its body or frontmatter",
                ));
            }
            GraderSpec::Llm {
                criteria,
                focus: string_field(&frontmatter, "focus")
                    .unwrap_or_else(|| "last_message".to_owned()),
                model: string_field(&frontmatter, "model"),
            }
        }
        "file_exists" => GraderSpec::Unsupported {
            reason: "Ryu does not claim file-created evidence for an agent run yet".to_owned(),
        },
        "baseline" => GraderSpec::Unsupported {
            reason: "Ryu does not mutate a live installation to run a no-plugin baseline"
                .to_owned(),
        },
        _ => GraderSpec::Unsupported {
            reason: format!("grader type '{kind}' is not supported by this Ryu runner"),
        },
    };
    Ok((kind, spec))
}

fn read_text_file(
    root: &Path,
    path: &Path,
    relative_path: &str,
    issues: &mut Vec<EvalIssue>,
) -> Option<String> {
    let canonical = match std::fs::canonicalize(path) {
        Ok(path) => path,
        Err(error) => {
            issues.push(issue(
                "evals.path-unreadable",
                "error",
                relative_path,
                error.to_string(),
            ));
            return None;
        }
    };
    if !canonical.starts_with(root) {
        issues.push(issue(
            "evals.path-escape",
            "error",
            relative_path,
            "eval file resolves outside the package eval directory",
        ));
        return None;
    }
    let metadata = match std::fs::metadata(&canonical) {
        Ok(metadata) => metadata,
        Err(error) => {
            issues.push(issue(
                "evals.file-unreadable",
                "error",
                relative_path,
                error.to_string(),
            ));
            return None;
        }
    };
    if metadata.len() > MAX_FILE_BYTES {
        issues.push(issue(
            "evals.file-too-large",
            "error",
            relative_path,
            format!("file exceeds the {MAX_FILE_BYTES}-byte limit"),
        ));
        return None;
    }
    match std::fs::read_to_string(canonical) {
        Ok(text) => Some(text),
        Err(error) => {
            issues.push(issue(
                "evals.file-not-text",
                "error",
                relative_path,
                format!("eval file must be UTF-8 text: {error}"),
            ));
            None
        }
    }
}

fn read_yaml_file(
    root: &Path,
    path: &Path,
    relative_path: &str,
    issues: &mut Vec<EvalIssue>,
) -> Option<Value> {
    let raw = read_text_file(root, path, &format!("{relative_path}/case.yaml"), issues)?;
    match noyalib::compat::serde_yaml::from_str::<noyalib::compat::serde_yaml::Value>(&raw)
        .ok()
        .and_then(|value| serde_json::to_value(value).ok())
    {
        Some(value) => Some(value),
        None => {
            issues.push(issue(
                "evals.case-yaml",
                "error",
                &format!("{relative_path}/case.yaml"),
                "case.yaml is not valid YAML",
            ));
            None
        }
    }
}

fn split_frontmatter(raw: &str, path: &str) -> Result<(Value, String), String> {
    let Some(first_line_end) = raw.find('\n') else {
        return Ok((Value::Object(Map::new()), raw.to_owned()));
    };
    if raw[..first_line_end].trim() != "---" {
        return Ok((Value::Object(Map::new()), raw.to_owned()));
    }
    let after_open = first_line_end + 1;
    let Some(close_offset) = raw[after_open..]
        .match_indices('\n')
        .find_map(|(offset, _)| {
            let line_start = after_open + offset + 1;
            let line_end = raw[line_start..]
                .find('\n')
                .map(|end| line_start + end)
                .unwrap_or(raw.len());
            (raw[line_start..line_end].trim() == "---").then_some(line_start)
        })
    else {
        return Err(format!(
            "{path} has an opening YAML fence but no closing '---'"
        ));
    };
    let header = &raw[after_open..close_offset - 1];
    let body_start = raw[close_offset..]
        .find('\n')
        .map(|offset| close_offset + offset + 1)
        .unwrap_or(raw.len());
    let frontmatter =
        noyalib::compat::serde_yaml::from_str::<noyalib::compat::serde_yaml::Value>(header)
            .map_err(|error| format!("{path} frontmatter is not valid YAML: {error}"))?;
    let frontmatter = serde_json::to_value(frontmatter)
        .map_err(|error| format!("{path} frontmatter could not be represented as JSON: {error}"))?;
    Ok((frontmatter, raw[body_start..].to_owned()))
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .ok()
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| ".".to_owned())
}

fn object_field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object()?.get(key)
}

fn nested_field<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter()
        .try_fold(value, |current, key| object_field(current, key))
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    object_field(value, key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| !value.trim().is_empty())
}

fn nested_string(value: &Value, path: &[&str]) -> Option<String> {
    nested_field(value, path)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| !value.trim().is_empty())
}

fn numeric_field(value: &Value, key: &str) -> Option<usize> {
    object_field(value, key).and_then(numeric_value)
}

fn nested_number(value: &Value, path: &[&str]) -> Option<usize> {
    nested_field(value, path).and_then(numeric_value)
}

fn numeric_value(value: &Value) -> Option<usize> {
    value
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .or_else(|| value.as_str()?.trim().parse::<usize>().ok())
}

fn list_field(value: &Value, key: &str) -> Option<Vec<String>> {
    let list = object_field(value, key)?.as_array()?;
    Some(
        list.iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .filter(|value| !value.trim().is_empty())
            .collect(),
    )
}

/// Apply the deterministic Ryu subset of a Claude-style regex grader. The
/// caller owns the target selection; this helper stays pure for unit tests.
pub(crate) fn grade_regex(
    pattern: &str,
    flags: &str,
    match_mode: &str,
    text: &str,
) -> Result<(bool, f32, String), String> {
    let mut builder = regex::RegexBuilder::new(pattern);
    builder.case_insensitive(flags.contains('i'));
    builder.multi_line(flags.contains('m'));
    builder.dot_matches_new_line(flags.contains('s'));
    let expression = builder.build().map_err(|error| error.to_string())?;
    let count = expression.find_iter(text).count();
    let pass = if match_mode == "not_contains" {
        count == 0
    } else if let Some(expected) = match_mode.strip_prefix("count:") {
        count == expected.parse::<usize>().unwrap_or(usize::MAX)
    } else {
        count > 0
    };
    Ok((
        pass,
        if pass { 1.0 } else { 0.0 },
        format!("{count} match{}", if count == 1 { "" } else { "es" }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_style_case_and_graders() {
        let root = tempfile::tempdir().expect("temp root");
        let case = root.path().join("evals").join("first-case");
        std::fs::create_dir_all(case.join("graders")).expect("case dir");
        std::fs::write(
            case.join("prompt.md"),
            "---\nruns: 2\ntags: [smoke]\nrunnable: agent-main\n---\n\nSay hello.",
        )
        .expect("prompt");
        std::fs::write(
            case.join("graders").join("reply.md"),
            "---\ntype: regex\npattern: hello\nflags: i\n---\n",
        )
        .expect("grader");
        std::fs::write(
            case.join("graders").join("tool.md"),
            "---\ntype: tool_used\ntool: app.search\n---\n",
        )
        .expect("tool grader");

        let suite = inspect_package(root.path(), "com.example/demo", "app");
        assert_eq!(suite.overview.suite.status, "ready");
        assert_eq!(suite.overview.suite.case_count, 1);
        assert_eq!(suite.overview.suite.grader_count, 2);
        assert_eq!(suite.overview.suite.cases[0].runs, 2);
        assert_eq!(
            suite.overview.suite.cases[0].runnable.as_deref(),
            Some("agent-main")
        );
        assert!(suite
            .overview
            .suite
            .supported_graders
            .contains(&"regex".to_owned()));
        assert!(suite
            .overview
            .suite
            .supported_graders
            .contains(&"tool_used".to_owned()));
    }

    #[test]
    fn rejects_case_file_symlink_escape() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let root = tempfile::tempdir().expect("temp root");
            let case = root.path().join("evals").join("escape");
            std::fs::create_dir_all(&case).expect("case dir");
            let outside = root.path().join("outside.md");
            std::fs::write(&outside, "Say hello").expect("outside");
            symlink(&outside, case.join("prompt.md")).expect("symlink");
            let suite = inspect_package(root.path(), "com.example/demo", "plugin");
            assert_eq!(suite.overview.suite.status, "invalid");
            assert!(suite
                .overview
                .suite
                .issues
                .iter()
                .any(|entry| entry.code == "evals.path-escape"));
        }
    }

    #[test]
    fn symlink_cycles_do_not_recurse_forever() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let root = tempfile::tempdir().expect("temp root");
            let evals = root.path().join("evals");
            let case = evals.join("real-case");
            std::fs::create_dir_all(&case).expect("case dir");
            std::fs::write(case.join("prompt.md"), "Say hello.").expect("prompt");
            symlink(&evals, evals.join("cycle")).expect("cycle symlink");

            let suite = inspect_package(root.path(), "com.example/demo", "plugin");
            assert_eq!(suite.overview.suite.case_count, 1);
            assert!(!suite
                .overview
                .suite
                .issues
                .iter()
                .any(|entry| entry.code == "evals.directory-too-deep"));
        }
    }

    #[test]
    fn regex_grader_supports_negation_and_exact_counts() {
        assert_eq!(
            grade_regex("hello", "i", "contains", "HELLO").unwrap().0,
            true
        );
        assert_eq!(
            grade_regex("hello", "", "not_contains", "hello").unwrap().0,
            false
        );
        assert_eq!(grade_regex("x", "", "count:2", "x x").unwrap().0, true);
    }

    #[test]
    fn no_suite_is_not_configured_not_invalid() {
        let root = tempfile::tempdir().expect("temp root");
        let suite = inspect_package(root.path(), "com.example/demo", "plugin");
        assert_eq!(suite.overview.suite.status, "not_configured");
        assert!(suite.cases.is_empty());
    }
}
