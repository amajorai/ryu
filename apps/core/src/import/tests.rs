use super::*;
use std::fs;
use std::path::PathBuf;

fn temp_tree() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ryu-import-test-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(dir: &Path, rel: &str, content: &str) {
    let path = dir.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

#[test]
fn scan_finds_instructions_skills_mcp_and_plugin() {
    let root = temp_tree();
    write(&root, "AGENTS.md", "# Repo rules\n");
    write(&root, "skills/foo/SKILL.md", "---\nname: foo\n---\n# Foo\n");
    write(
        &root,
        "mcp.json",
        r#"{"mcpServers":{"git":{"command":"mcp-git","args":["x"]}}}"#,
    );
    write(
        &root,
        "plugins/hello/manifest.json",
        r#"{"id":"@acme/hello","name":"Hello","version":"1.0.0","runnables":[]}"#,
    );

    let res = scan_source(&root).unwrap();
    let kinds: Vec<&str> = res.items.iter().map(|i| i.kind).collect();
    assert!(kinds.contains(&kind::INSTRUCTIONS), "kinds: {kinds:?}");
    assert!(kinds.contains(&kind::SKILL), "kinds: {kinds:?}");
    assert!(kinds.contains(&kind::MCP_SERVER), "kinds: {kinds:?}");
    assert!(kinds.contains(&kind::PLUGIN), "kinds: {kinds:?}");

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn scan_reads_codex_toml_mcp_servers() {
    let root = temp_tree();
    write(
        &root,
        "config.toml",
        r#"[model]
name = "gpt-5"
[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem"]
[mcp_servers.git]
command = "mcp-git"
"#,
    );
    let res = scan_source(&root).unwrap();
    let mcp: Vec<&ScanItem> = res
        .items
        .iter()
        .filter(|i| i.kind == kind::MCP_SERVER)
        .collect();
    assert_eq!(mcp.len(), 2, "items: {res:#?}");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn scan_skips_vcs_and_node_modules() {
    let root = temp_tree();
    write(&root, ".git/HEAD", "ref");
    write(&root, "node_modules/pkg/index.js", "x");
    write(
        &root,
        "skills/real/SKILL.md",
        "---\nname: real\n---\n# Real\n",
    );
    let res = scan_source(&root).unwrap();
    let skills: Vec<&ScanItem> = res.items.iter().filter(|i| i.kind == kind::SKILL).collect();
    assert_eq!(skills.len(), 1);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn scan_finds_memory_files_only_when_they_look_like_claude_memories() {
    let root = temp_tree();
    write(
        &root,
        "projects/abc-123/memory/11111111-1111-1111-1111-111111111111.md",
        r#"{"content":"The build uses bun.","importance":3}"#,
    );
    write(&root, "memory/notes.md", "just some notes\n");
    let res = scan_source(&root).unwrap();
    let mem: Vec<&ScanItem> = res
        .items
        .iter()
        .filter(|i| i.kind == kind::MEMORY)
        .collect();
    assert_eq!(mem.len(), 1, "notes.md must be ignored: {res:#?}");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn resolve_item_path_guards_traversal() {
    let root = temp_tree();
    write(&root, "skills/ok/SKILL.md", "---\nname: ok\n---\n# Ok\n");
    assert!(resolve_item_path(&root, &format!("{}/ok", kind::SKILL)).is_err());
    assert!(resolve_item_path(&root, "../escape").is_err());
    assert!(resolve_item_path(&root, "/etc/passwd").is_err());
    let p = resolve_item_path(&root, &format!("{}/skills/ok", kind::SKILL)).unwrap();
    assert!(p.ends_with("skills/ok"));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn mcp_ids_round_trip() {
    let id = "mcp_server/mcp/cursor-json/foo";
    let (token, name) = resolve_mcp_id(id).unwrap();
    assert_eq!(token, "cursor-json");
    assert_eq!(name, "foo");
    assert!(resolve_mcp_id("mcp_server/whatever/foo").is_err());
}

#[test]
fn parse_claude_memory_handles_three_shapes() {
    let dir = temp_tree();
    let json = dir.join("a.md");
    fs::write(
        &json,
        r#"{"content":"c1","when_to_use":"when x","importance":5}"#,
    )
    .unwrap();
    let (c, w, i) = parse_claude_memory(&json).unwrap();
    assert_eq!(c, "c1");
    assert_eq!(w.as_deref(), Some("when x"));
    assert_eq!(i, 5);

    let fm = dir.join("b.md");
    fs::write(&fm, "---\n{\"content\": \"c2\"}\n---\nbody text").unwrap();
    let (c, _, _) = parse_claude_memory(&fm).unwrap();
    assert!(c.starts_with("c2") && c.contains("body text"), "c: {c}");

    let raw = dir.join("c.md");
    fs::write(&raw, "plain text memory").unwrap();
    let (c, w, i) = parse_claude_memory(&raw).unwrap();
    assert_eq!(c, "plain text memory");
    assert_eq!(w, None);
    assert_eq!(i, 3);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn empty_or_unreadable_folder_degrades_to_empty_scan() {
    let root = std::env::temp_dir().join(format!("ryu-import-empty-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let res = scan_source(&root).unwrap();
    assert!(res.items.is_empty());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn scan_finds_codex_subagents_and_slash_commands() {
    let root = temp_tree();
    write(
            &root,
            ".codex/agents/commit-message.md",
            "---\nname: commit-message\ndescription: Writes good commit messages\nmodel: gpt-5\n---\nWrite a concise commit message.\n",
        );
    write(
        &root,
        "agents/project-note.md",
        "---\nname: project-note\n---\nDo not import me.\n",
    );
    write(
        &root,
        ".codex/prompts/review.md",
        "---\ndescription: Review a diff\n---\nReview the attached diff for bugs.\n",
    );
    write(
        &root,
        "prompts/project.md",
        "---\ndescription: project\n---\nDo not import me.\n",
    );
    write(
        &root,
        ".codex/prompts/empty.md",
        "---\ndescription: empty\n---\n",
    );

    let res = scan_source(&root).unwrap();
    let agents: Vec<&ScanItem> = res.items.iter().filter(|i| i.kind == kind::AGENT).collect();
    let cmds: Vec<&ScanItem> = res
        .items
        .iter()
        .filter(|i| i.kind == kind::SLASH_COMMAND)
        .collect();
    assert_eq!(
        agents.len(),
        1,
        "project-local agents/ must not list as a subagent: {res:#?}"
    );
    assert_eq!(
        cmds.len(),
        1,
        "empty/project prompts must not list: {res:#?}"
    );
    assert!(agents[0].id.contains(".codex/agents/"));
    assert!(cmds[0].id.contains(".codex/prompts/"));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn parse_codex_subagent_extracts_fields() {
    let dir = temp_tree();
    let path = dir.join("x.md");
    fs::write(
            &path,
            "---\nname: reviewer\ndescription: Reviews code\nmodel: gpt-5\ntools:\n  - read\n  - bash\n---\nReview the diff.\n",
        )
        .unwrap();
    let sub = parse_codex_subagent(&path).unwrap();
    assert_eq!(sub.name, "reviewer");
    assert_eq!(sub.description.as_deref(), Some("Reviews code"));
    assert_eq!(sub.model.as_deref(), Some("gpt-5"));
    assert_eq!(sub.tools, vec!["read".to_string(), "bash".to_string()]);
    assert_eq!(sub.system_prompt, "Review the diff.");
    // No front-matter / no name → not a subagent.
    let plain = dir.join("plain.md");
    fs::write(&plain, "just text").unwrap();
    assert!(parse_codex_subagent(&plain).is_none());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn parse_codex_prompt_uses_stem_as_name() {
    let dir = temp_tree();
    let path = dir.join("review.md");
    fs::write(
        &path,
        "---\ndescription: review it\n---\nReview this diff.\n",
    )
    .unwrap();
    let p = parse_codex_prompt(&path).unwrap();
    assert_eq!(p.name, "review");
    assert_eq!(p.description.as_deref(), Some("review it"));
    assert_eq!(p.body, "Review this diff.");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn project_instructions_reads_agents_md_preferring_agents_over_claude() {
    let dir = temp_tree();
    write(&dir, "CLAUDE.md", "# Claude rules\n");
    write(&dir, "AGENTS.md", "# Agent rules\n");
    let (file, content) = project_instructions(&dir.to_string_lossy()).unwrap();
    assert_eq!(file, "AGENTS.md", "AGENTS.md must win over CLAUDE.md");
    assert_eq!(content, "# Agent rules\n");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn project_instructions_returns_none_without_a_candidate_file() {
    let dir = temp_tree();
    write(&dir, "README.md", "# Not instructions\n");
    assert!(project_instructions(&dir.to_string_lossy()).is_none());
    assert!(project_instructions("/definitely/not/a/real/dir").is_none());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn project_instructions_truncates_over_the_prompt_cap() {
    let dir = temp_tree();
    let big = "x".repeat(MAX_PROJECT_INSTRUCTIONS_PROMPT_BYTES as usize + 1000);
    write(&dir, "AGENTS.md", &big);
    let (_, content) = project_instructions(&dir.to_string_lossy()).unwrap();
    assert!(
        content.len() as u64 <= MAX_PROJECT_INSTRUCTIONS_PROMPT_BYTES + 200,
        "content too long: {}",
        content.len()
    );
    assert!(content.contains("truncated"), "missing truncation note");
    let _ = fs::remove_dir_all(&dir);
}
#[test]
fn instruction_revision_tracks_equal_length_edits_and_reverts_without_timestamps() {
    let root = temp_tree();
    write(&root, "AGENTS.md", "alpha");
    let first = scan_source(&root)
        .unwrap()
        .items
        .into_iter()
        .find(|item| item.kind == kind::INSTRUCTIONS)
        .unwrap();
    assert_eq!(
        first.content_revision.as_deref(),
        Some("8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8")
    );
    write(&root, "AGENTS.md", "bravo");
    let second = scan_source(&root)
        .unwrap()
        .items
        .into_iter()
        .find(|item| item.kind == kind::INSTRUCTIONS)
        .unwrap();
    assert_eq!(second.id, first.id);
    assert_ne!(second.content_revision, first.content_revision);
    write(&root, "AGENTS.md", "alpha");
    let restored = scan_source(&root)
        .unwrap()
        .items
        .into_iter()
        .find(|item| item.kind == kind::INSTRUCTIONS)
        .unwrap();
    assert_eq!(restored.content_revision, first.content_revision);
    fs::remove_dir_all(root).unwrap();
}
#[cfg(unix)]
#[test]
fn instruction_revision_never_reads_a_symlink_outside_the_scan_root() {
    let root = temp_tree();
    let outside = temp_tree();
    write(&outside, "private.md", "private instructions");
    std::os::unix::fs::symlink(outside.join("private.md"), root.join("AGENTS.md")).unwrap();
    let item = scan_source(&root)
        .unwrap()
        .items
        .into_iter()
        .find(|item| item.kind == kind::INSTRUCTIONS)
        .unwrap();
    assert!(item.content_revision.is_none());
    assert!(resolve_item_path(&root, &item.id).is_err());
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(outside).unwrap();
}

#[test]
fn english_fills_arguments_and_keeps_apostrophes() {
    let message = Message::new(crate::i18n::messages::IMPORT_EXPORT_PROJECT_CHATS_TITLE_MESSAGE)
        .text("source", "Claude")
        .text("name", "Research")
        .number("count", 3.0, 0, 0);
    assert_eq!(
        english(&message),
        "Project 'Research' from Claude (3 chats)"
    );
    let warning = ScanWarning::new(
        Message::new(crate::i18n::messages::IMPORT_TOO_LARGE_WARNING_MESSAGE)
            .text("path", "/x/{y}"),
    );
    assert_eq!(
        warning.message,
        "Skipped /x/{y} because it is too large to scan."
    );
    let wire = serde_json::to_value(&warning).unwrap();
    assert_eq!(wire["i18n"]["args"]["path"], "/x/{y}");
    let verbatim = serde_json::to_value(ScanWarning::verbatim("a: b".into())).unwrap();
    assert_eq!(verbatim, serde_json::json!({ "message": "a: b" }));
}
