use super::*;

#[test]
fn slug_of_takes_last_segment() {
    assert_eq!(
        slug_of("vercel-labs/agent-skills/find-skills"),
        "find-skills"
    );
    assert_eq!(slug_of("a/b/react:components"), "react:components");
}

#[test]
fn split_id_three_parts() {
    assert_eq!(
        split_id("vercel-labs/agent-skills/find-skills"),
        Some((
            "vercel-labs".into(),
            "agent-skills".into(),
            "find-skills".into()
        ))
    );
    assert_eq!(split_id("only/two"), None);
}

#[test]
fn front_matter_parsing() {
    let md =
        "---\nname: find-skills\ndescription: \"Helps you discover skills\"\n---\n# Body\ntext";
    let (fm, body) = split_front_matter(md);
    assert_eq!(
        front_matter_field(&fm, "name").as_deref(),
        Some("find-skills")
    );
    assert_eq!(
        front_matter_field(&fm, "description").as_deref(),
        Some("Helps you discover skills")
    );
    assert_eq!(body, "# Body\ntext");
}

#[test]
fn front_matter_absent() {
    let (fm, body) = split_front_matter("# Just markdown");
    assert!(fm.is_empty());
    assert_eq!(body, "# Just markdown");
    assert_eq!(front_matter_field(&fm, "name"), None);
}

#[tokio::test]
async fn staged_skill_replaces_files_and_keeps_the_users_own() {
    let root = tempfile::tempdir().unwrap();
    let staging = root.path().join("staging");
    let skill_dir = root.path().join("skills").join("alpha");
    std::fs::create_dir_all(skill_dir.join("refs")).unwrap();
    std::fs::write(skill_dir.join("SKILL.md"), "old doc").unwrap();
    std::fs::write(skill_dir.join("refs/a.md"), "old a").unwrap();
    std::fs::write(skill_dir.join("my-notes.md"), "mine").unwrap();

    let files = vec![
        DownloadFile {
            path: "alpha/SKILL.md".into(),
            contents: "new doc".into(),
        },
        DownloadFile {
            path: "refs/a.md".into(),
            contents: "new a".into(),
        },
        DownloadFile {
            path: "../escape.md".into(),
            contents: "nope".into(),
        },
    ];
    stage_skill_files(&staging, &files).await.unwrap();
    place_staged_skill(&staging, &skill_dir).await.unwrap();

    assert_eq!(
        std::fs::read_to_string(skill_dir.join("SKILL.md")).unwrap(),
        "new doc"
    );
    assert_eq!(
        std::fs::read_to_string(skill_dir.join("refs/a.md")).unwrap(),
        "new a"
    );
    assert_eq!(
        std::fs::read_to_string(skill_dir.join("my-notes.md")).unwrap(),
        "mine"
    );
    assert!(!root.path().join("escape.md").exists());
    assert!(!root.path().join("skills/escape.md").exists());
}

fn file(path: &str, contents: &str) -> DownloadFile {
    DownloadFile {
        path: path.into(),
        contents: contents.into(),
    }
}

#[test]
fn entry_skill_doc_prefers_the_shallowest_skill_md_in_any_order() {
    let files = vec![
        file("examples/writing-a-skill.md", "example"),
        file("alpha/SKILL.md", "entry"),
        file("alpha/nested/skill.md", "nested"),
    ];
    assert_eq!(entry_skill_doc_index(&files), Some(1));
    let reversed: Vec<_> = files.into_iter().rev().collect();
    assert_eq!(entry_skill_doc_index(&reversed), Some(1));
    assert_eq!(
        entry_skill_doc_index(&[file("b/SKILL.md", "b"), file("SKILL.md", "root")]),
        Some(1)
    );
}

#[test]
fn entry_skill_doc_falls_back_to_a_suffix_match() {
    let files = vec![file("refs/a.md", "a"), file("my-skill.md", "doc")];
    assert_eq!(entry_skill_doc_index(&files), Some(1));
    assert_eq!(entry_skill_doc_index(&[file("README.md", "readme")]), None);
}

#[tokio::test]
async fn staged_skill_writes_only_the_entry_doc_as_skill_md() {
    let root = tempfile::tempdir().unwrap();
    let staging = root.path().join("staging");
    let files = vec![
        file("SKILL.md", "entry"),
        file("examples/writing-a-skill.md", "example"),
        file("skill.md", "duplicate root doc"),
    ];
    stage_skill_files(&staging, &files).await.unwrap();

    assert_eq!(
        std::fs::read_to_string(staging.join("SKILL.md")).unwrap(),
        "entry"
    );
    assert_eq!(
        std::fs::read_to_string(staging.join("examples/writing-a-skill.md")).unwrap(),
        "example"
    );
    // The second root-level skill doc is skipped, not written beside
    // SKILL.md, where a case-insensitive filesystem would let it replace
    // the entry doc.
    let mut root_entries: Vec<String> = std::fs::read_dir(&staging)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    root_entries.sort();
    assert_eq!(root_entries, ["SKILL.md", "examples"]);
    // The install fingerprint reads the same entry doc that landed on disk.
    let entry = entry_skill_doc_index(&files).unwrap();
    assert_eq!(files[entry].contents, "entry");
}

#[test]
fn safe_join_keeps_paths_inside_base() {
    let base = std::path::Path::new("/skills/alpha");
    assert_eq!(safe_join(base, "SKILL.md"), Some(base.join("SKILL.md")));
    assert_eq!(
        safe_join(base, "references/guide.md"),
        Some(base.join("references").join("guide.md"))
    );
    // Backslashes normalize to the same nested path.
    assert_eq!(
        safe_join(base, "references\\guide.md"),
        Some(base.join("references").join("guide.md"))
    );
}

#[test]
fn safe_join_rejects_traversal_and_empty() {
    let base = std::path::Path::new("/skills/alpha");
    assert_eq!(safe_join(base, "../escape.md"), None);
    assert_eq!(safe_join(base, "a/../../b.md"), None);
    assert_eq!(safe_join(base, ""), None);
    assert_eq!(safe_join(base, "."), None);
}

#[test]
fn safe_join_rejects_drive_and_rooted_segments() {
    let base = std::path::Path::new("/skills/alpha");
    // A drive-qualified path must not escape (on Windows `push` would replace).
    assert_eq!(safe_join(base, "C:/evil.md"), None);
    // A UNC/share path must not escape either.
    assert_eq!(safe_join(base, "\\\\server\\share\\x.md"), None);
}

// ── HTML-scrape + formatting helper coverage ─────────────────────────────

#[test]
fn safe_cache_segment_sanitizes_to_filename_safe() {
    assert_eq!(safe_cache_segment("owner/repo:skill"), "owner_repo_skill");
    // Alphanumerics and -_. are preserved; everything else becomes '_'.
    assert_eq!(safe_cache_segment("a-b_c.d"), "a-b_c.d");
    assert_eq!(safe_cache_segment("weird name!"), "weird_name_");
}

#[test]
fn format_compact_count_thresholds() {
    assert_eq!(format_compact_count(999), "999");
    assert_eq!(format_compact_count(1_500), "1.5K");
    assert_eq!(format_compact_count(2_000_000), "2.0M");
    assert_eq!(format_compact_count(0), "0");
}

#[test]
fn parse_compact_count_round_trips_suffixes_and_junk() {
    assert_eq!(parse_compact_count(Some("1.5K")), 1_500);
    assert_eq!(parse_compact_count(Some("2m")), 2_000_000);
    assert_eq!(parse_compact_count(Some("1,234")), 1_234);
    assert_eq!(parse_compact_count(Some("42")), 42);
    // Empty / None / non-numeric degrade to 0, never panic.
    assert_eq!(parse_compact_count(Some("   ")), 0);
    assert_eq!(parse_compact_count(None), 0);
    assert_eq!(parse_compact_count(Some("garbage")), 0);
}

#[test]
fn html_escape_decodes_entities() {
    assert_eq!(
        html_escape("a &amp; b &lt;c&gt; &quot;d&quot; &#x27;e&#x27;"),
        "a & b <c> \"d\" 'e'"
    );
}

#[test]
fn strip_tags_removes_markup_and_decodes_entities() {
    let out = strip_tags("<p>Hello &amp; <b>world</b></p>");
    // Tags become newlines; entities are decoded. Collapse for a stable assert.
    let joined: String = out.split_whitespace().collect::<Vec<_>>().join(" ");
    assert_eq!(joined, "Hello & world");
}

#[test]
fn href_from_anchor_absolute_and_relative() {
    // An absolute href is returned as-is (with &amp; decoded).
    assert_eq!(
        href_from_anchor(r#"<a href="https://x.io/a?b=1&amp;c=2">x</a>"#),
        Some("https://x.io/a?b=1&c=2".to_string())
    );
    // A relative href is prefixed with the API base.
    let rel = href_from_anchor(r#"<a href="/audit/42">x</a>"#).unwrap();
    assert!(rel.ends_with("/audit/42"));
    assert!(rel.starts_with(&api_base()));
    // No href at all → None.
    assert_eq!(href_from_anchor("<a>no href</a>"), None);
}

#[test]
fn repository_url_enforces_https_github_host() {
    // A legitimate github repo link is accepted.
    let html = r#"<div>Repository <a href="https://github.com/o/r">link</a></div>"#;
    assert_eq!(
        repository_url(html).as_deref(),
        Some("https://github.com/o/r")
    );
    // A look-alike host is rejected (no substring bypass).
    let evil = r#"Repository <a href="https://github.com.evil.com/o/r">x</a>"#;
    assert_eq!(repository_url(evil), None);
    // A javascript: URL that merely contains the literal is rejected.
    let js = r#"Repository <a href="javascript:alert('github.com')">x</a>"#;
    assert_eq!(repository_url(js), None);
    // No "Repository" label → None.
    assert_eq!(
        repository_url("<a href=\"https://github.com/o/r\">x</a>"),
        None
    );
}

#[test]
fn text_after_label_reads_first_nonempty_line() {
    let html = "<span>Author</span><div>  </div><div>Ada Lovelace</div>";
    assert_eq!(
        text_after_label(html, "Author").as_deref(),
        Some("Ada Lovelace")
    );
    // A label that isn't present → None.
    assert_eq!(text_after_label(html, "Missing"), None);
}

#[test]
fn security_audits_extracts_known_providers_only() {
    let html = r#"
            Security Audits
            <a href="/audits/socket"><span>Socket</span><span>Passed</span></a>
            <a href="https://snyk.io/x"><span>Snyk</span><span>Clean</span></a>
            <a href="/x"><span>Unknown Provider</span><span>Nope</span></a>
            Browse more
            <a href="/audits/socket"><span>Socket</span></a>
        "#;
    let audits = security_audits(html);
    // Only the two recognized providers before "Browse" are surfaced.
    assert_eq!(audits.len(), 2);
    assert_eq!(audits[0].name, "Socket");
    assert_eq!(audits[0].status, "Passed");
    assert!(audits[0]
        .url
        .as_deref()
        .unwrap()
        .ends_with("/audits/socket"));
    assert_eq!(audits[1].name, "Snyk");
    assert_eq!(audits[1].url.as_deref(), Some("https://snyk.io/x"));

    // No section at all → empty, never panics.
    assert!(security_audits("<div>nothing</div>").is_empty());
}

#[test]
fn normalise_skill_md_strips_crlf_and_trailing_space() {
    assert_eq!(
        normalise_skill_md("line1\r\nline2\r\n\n  \n"),
        "line1\nline2"
    );
}

#[test]
fn find_repo_file_path_prefers_exact_then_suffix_match() {
    let tree = vec![
        GithubTreeItem {
            path: "other/SKILL.md".into(),
            kind: "blob".into(),
        },
        GithubTreeItem {
            path: "my-skill/SKILL.md".into(),
            kind: "blob".into(),
        },
    ];
    // Exact package-path match wins.
    assert_eq!(
        find_repo_file_path(&tree, "my-skill", "my-skill/SKILL.md").as_deref(),
        Some("my-skill/SKILL.md")
    );
    // A nested layout is found via the `/slug/<pkg>` suffix rule.
    let nested = vec![GithubTreeItem {
        path: "packages/my-skill/SKILL.md".into(),
        kind: "blob".into(),
    }];
    assert_eq!(
        find_repo_file_path(&nested, "my-skill", "SKILL.md").as_deref(),
        Some("packages/my-skill/SKILL.md")
    );
    // Nothing matches → None.
    assert_eq!(find_repo_file_path(&[], "x", "SKILL.md"), None);
}

#[test]
fn stale_github_cache_survives_the_freshness_window() {
    let path = std::env::temp_dir().join(format!(
        "ryu-skill-cache-test-{}-{}.json",
        std::process::id(),
        now_unix_seconds()
    ));
    let envelope = CacheEnvelope {
        fetched_at: 0,
        value: vec!["skills/pdf".to_string()],
    };
    std::fs::write(&path, serde_json::to_vec(&envelope).unwrap()).unwrap();

    assert_eq!(read_fresh_cache::<Vec<String>>(&path), None);
    assert_eq!(
        read_stale_cache::<Vec<String>>(&path),
        Some(vec!["skills/pdf".to_string()])
    );

    let _ = std::fs::remove_file(path);
}
