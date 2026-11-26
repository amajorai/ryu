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
    fn direct_skill_md_urls_are_detected_and_named_from_their_parent() {
        assert!(is_direct_skill_md_url(
            "https://example.com/skills/pdf/SKILL.md"
        ));
        // Query/fragment must not defeat the match.
        assert!(is_direct_skill_md_url(
            "https://example.com/skills/pdf/SKILL.md?token=abc"
        ));
        // Narrow on purpose: any other markdown file is still a repo form.
        assert!(!is_direct_skill_md_url("https://example.com/README.md"));
        assert!(!is_direct_skill_md_url("https://github.com/owner/repo"));
        assert!(!is_direct_skill_md_url("owner/repo"));

        assert_eq!(
            skill_name_from_md_url("https://example.com/skills/pdf/SKILL.md"),
            "pdf"
        );
        assert_eq!(
            skill_name_from_md_url("https://example.com/a/b/my-skill/SKILL.md?x=1"),
            "my-skill"
        );
        // A host-root SKILL.md is named after the host, not a shared `skill`.
        assert_eq!(
            skill_name_from_md_url("https://example.com/SKILL.md"),
            "example.com"
        );
        // A repository-root SKILL.md is named after the repo, never its git ref.
        for url in [
            "https://raw.githubusercontent.com/acme/pdf-skill/main/SKILL.md",
            "https://raw.githubusercontent.com/acme/pdf-skill/HEAD/SKILL.md",
            "https://raw.githubusercontent.com/acme/pdf-skill/refs/heads/main/SKILL.md",
            "https://github.com/acme/pdf-skill/blob/main/SKILL.md",
            "https://github.com/acme/pdf-skill/raw/v1.2/SKILL.md",
            "https://gitlab.com/group/sub/pdf-skill/-/raw/main/SKILL.md",
        ] {
            assert_eq!(skill_name_from_md_url(url), "pdf-skill", "{url}");
        }
        // A skill folder inside a repo still names the skill.
        assert_eq!(
            skill_name_from_md_url(
                "https://raw.githubusercontent.com/acme/skills/main/skills/commit-helper/SKILL.md"
            ),
            "commit-helper"
        );
    }

    #[test]
    fn sanitize_name_keeps_safe_chars() {
        assert_eq!(sanitize_name("my-skill_v2.1"), "my-skill_v2.1");
        assert_eq!(sanitize_name("weird name!@#"), "weird-name");
        assert_eq!(sanitize_name("---"), "skill");
    }

    #[test]
    fn exact_root_name_keeps_a_pack_slug_stable() {
        let _env = ryu_skills::SKILLS_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let root = std::env::temp_dir().join(format!("ryu-root-name-src-{}", uniq()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("SKILL.md"),
            "---\nname: Unlazy\ndescription: stable\n---\nInstructions.",
        )
        .unwrap();
        let skills_home = std::env::temp_dir().join(format!("ryu-root-name-dest-{}", uniq()));
        let active_file = skills_home.join("active.json");
        std::env::set_var("RYU_SKILLS_DIR", &skills_home);
        std::env::set_var("RYU_SKILLS_ACTIVE_FILE", &active_file);

        let result =
            install_from_dir_named(&root, Some("unlazy-HEAD".to_owned()), Some("unlazy")).unwrap();

        std::env::remove_var("RYU_SKILLS_DIR");
        std::env::remove_var("RYU_SKILLS_ACTIVE_FILE");
        assert_eq!(result.slug, "unlazy");
        assert!(skills_home.join("unlazy/SKILL.md").is_file());
        assert!(!skills_home.join("unlazy-HEAD").exists());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&skills_home);
    }

    #[test]
    fn installing_a_skill_from_its_own_install_dir_keeps_it() {
        let _env = ryu_skills::SKILLS_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let skills_home = std::env::temp_dir().join(format!("ryu-self-install-{}", uniq()));
        let installed = skills_home.join("pdf");
        std::fs::create_dir_all(installed.join("scripts")).unwrap();
        std::fs::write(
            installed.join("SKILL.md"),
            "---\nname: pdf\n---\nRead PDFs.",
        )
        .unwrap();
        std::fs::write(installed.join("scripts").join("extract.py"), "print()").unwrap();
        let active_file = skills_home.join("active.json");
        std::env::set_var("RYU_SKILLS_DIR", &skills_home);
        std::env::set_var("RYU_SKILLS_ACTIVE_FILE", &active_file);

        let result = install_from_dir(&installed, None);

        std::env::remove_var("RYU_SKILLS_DIR");
        std::env::remove_var("RYU_SKILLS_ACTIVE_FILE");
        assert!(result.is_err(), "self-install must be refused");
        assert!(installed.join("SKILL.md").is_file());
        assert!(installed.join("scripts").join("extract.py").is_file());
        let _ = std::fs::remove_dir_all(&skills_home);
    }

    #[test]
    fn scoped_subdir_installs_use_the_skill_folder_name() {
        let _env = ryu_skills::SKILLS_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // A fetched tarball: `skills-HEAD/skills/{pdf,web-artifacts}/SKILL.md`.
        let extract = std::env::temp_dir().join(format!("ryu-scoped-src-{}", uniq()));
        let repo = extract.join("skills-HEAD");
        for (leaf, body) in [
            ("pdf", "---\nname: PDF Tools\n---\nRead PDFs."),
            (
                "web-artifacts",
                "---\ndescription: no name\n---\nBuild pages.",
            ),
        ] {
            let dir = repo.join("skills").join(leaf);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("SKILL.md"), body).unwrap();
        }
        let skills_home = std::env::temp_dir().join(format!("ryu-scoped-dest-{}", uniq()));
        std::env::set_var("RYU_SKILLS_DIR", &skills_home);
        std::env::set_var("RYU_SKILLS_ACTIVE_FILE", skills_home.join("active.json"));

        let pdf = install_fetched(&extract, Some("skills/pdf"), None, None);
        let web = install_fetched(&extract, Some("skills/web-artifacts"), None, None);

        std::env::remove_var("RYU_SKILLS_DIR");
        std::env::remove_var("RYU_SKILLS_ACTIVE_FILE");
        assert_eq!(pdf.unwrap().slug, "pdf");
        assert_eq!(web.unwrap().slug, "web-artifacts");
        assert!(skills_home.join("pdf/SKILL.md").is_file(), "sibling kept");
        assert!(skills_home.join("web-artifacts/SKILL.md").is_file());
        assert!(!skills_home.join("skills").exists());
        let _ = std::fs::remove_dir_all(&extract);
        let _ = std::fs::remove_dir_all(&skills_home);
    }

    #[test]
    fn content_served_skill_installs_under_the_caller_slug() {
        let _env = ryu_skills::SKILLS_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let skills_home = std::env::temp_dir().join(format!("ryu-md-text-dest-{}", uniq()));
        let existing = skills_home.join("commit");
        std::fs::create_dir_all(&existing).unwrap();
        std::fs::write(existing.join("SKILL.md"), "---\nname: commit\n---\nMine.").unwrap();
        std::env::set_var("RYU_SKILLS_DIR", &skills_home);
        std::env::set_var("RYU_SKILLS_ACTIVE_FILE", skills_home.join("active.json"));

        let result = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(install_skill_md_text(
                "cool-helper",
                "---\nname: commit\n---\nRemote body.",
            ));

        std::env::remove_var("RYU_SKILLS_DIR");
        std::env::remove_var("RYU_SKILLS_ACTIVE_FILE");
        assert_eq!(result.unwrap().slug, "cool-helper");
        assert!(skills_home.join("cool-helper/SKILL.md").is_file());
        assert_eq!(
            std::fs::read_to_string(existing.join("SKILL.md")).unwrap(),
            "---\nname: commit\n---\nMine.",
            "front matter must not pick another installed skill"
        );
        let _ = std::fs::remove_dir_all(&skills_home);
    }

    #[test]
    fn install_from_local_dir_with_nested_skills_layout() {
        // Serialize with other tests that mutate the shared RYU_SKILLS_* env vars,
        // so a parallel run never lets one test's remove_var clobber this set_var.
        let _env = ryu_skills::SKILLS_ENV_LOCK
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
        let active = ryu_skills::load_active_set();

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

    #[test]
    fn owner_repo_shorthand_accepts_only_two_safe_segments() {
        assert!(is_owner_repo_shorthand("owner/repo"));
        assert!(is_owner_repo_shorthand("Vercel-Labs/agent_skills.v2"));
        // Wrong segment count.
        assert!(!is_owner_repo_shorthand("just-one"));
        assert!(!is_owner_repo_shorthand("a/b/c"));
        // Empty / dot segments.
        assert!(!is_owner_repo_shorthand("owner/"));
        assert!(!is_owner_repo_shorthand("./repo"));
        assert!(!is_owner_repo_shorthand("owner/.."));
        // A space disqualifies it (falls through to the error path in parse_source).
        assert!(!is_owner_repo_shorthand("owner name/repo"));
        // A slash-bearing URL-ish string is not shorthand.
        assert!(!is_owner_repo_shorthand("https://x/y"));
    }

    #[test]
    fn strip_git_suffix_only_trims_trailing_dot_git() {
        assert_eq!(strip_git_suffix("repo.git"), "repo");
        assert_eq!(strip_git_suffix("repo"), "repo");
        // Only a trailing suffix is stripped, not a mid-string ".git".
        assert_eq!(strip_git_suffix("my.gitthing"), "my.gitthing");
    }

    #[test]
    fn tarball_url_builders_match_the_documented_shapes() {
        assert_eq!(
            github_tarball("owner", "repo", "HEAD"),
            "https://codeload.github.com/owner/repo/tar.gz/HEAD"
        );
        assert_eq!(
            gitlab_tarball("gitlab.com", "group/sub/repo", "v1.0"),
            "https://gitlab.com/group/sub/repo/-/archive/v1.0/archive.tar.gz"
        );
    }

    #[test]
    fn clone_host_port_handles_https_ssh_and_scp_forms() {
        assert_eq!(
            clone_host_port("https://github.com/o/r.git").unwrap(),
            ("github.com".to_owned(), 443)
        );
        // Explicit port wins over the scheme default.
        assert_eq!(
            clone_host_port("https://git.example.com:8443/o/r.git").unwrap(),
            ("git.example.com".to_owned(), 8443)
        );
        assert_eq!(
            clone_host_port("ssh://git@host.example/o/r").unwrap(),
            ("host.example".to_owned(), 22)
        );
        // scp-like `[user@]host:path` (no scheme) → port 22.
        assert_eq!(
            clone_host_port("git@github.com:owner/repo.git").unwrap(),
            ("github.com".to_owned(), 22)
        );
    }

    #[test]
    fn clone_url_for_derives_git_urls_from_tarball_and_clone_strategies() {
        // github tarball → github .git clone url.
        let gh = parse_source("owner/repo").unwrap();
        assert_eq!(
            clone_url_for(&gh).unwrap(),
            "https://github.com/owner/repo.git"
        );
        // gitlab archive tarball → <project>.git.
        let gl = parse_source("https://gitlab.com/group/sub/repo").unwrap();
        assert_eq!(
            clone_url_for(&gl).unwrap(),
            "https://gitlab.com/group/sub/repo.git"
        );
        // A GitClone strategy passes its url through verbatim.
        let ssh = parse_source("git@github.com:o/r.git").unwrap();
        assert_eq!(clone_url_for(&ssh).unwrap(), "git@github.com:o/r.git");
    }

    #[test]
    fn clone_url_for_local_path_has_no_clone_url() {
        let tmp = std::env::temp_dir().join(format!("ryu-clone-url-local-{}", uniq()));
        std::fs::create_dir_all(&tmp).unwrap();
        let local = parse_source(tmp.to_str().unwrap()).unwrap();
        assert!(clone_url_for(&local).is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn repo_root_name_is_the_single_top_dir_or_none() {
        // One top-level dir → that name.
        let root = std::env::temp_dir().join(format!("ryu-root-name-{}", uniq()));
        std::fs::create_dir_all(root.join("repo-main")).unwrap();
        assert_eq!(repo_root_name(&root).as_deref(), Some("repo-main"));

        // Two top-level entries → None (not a clean tarball root).
        std::fs::create_dir_all(root.join("second")).unwrap();
        assert!(repo_root_name(&root).is_none());
        let _ = std::fs::remove_dir_all(&root);

        // A single top-level FILE (not a dir) → None.
        let root2 = std::env::temp_dir().join(format!("ryu-root-name-file-{}", uniq()));
        std::fs::create_dir_all(&root2).unwrap();
        std::fs::write(root2.join("only.txt"), "x").unwrap();
        assert!(repo_root_name(&root2).is_none());
        let _ = std::fs::remove_dir_all(&root2);
    }

    #[test]
    fn resolve_subdir_descends_single_top_and_blocks_traversal() {
        // extract_root/<top>/skills/x  — resolve_subdir descends into <top> then subdir.
        let root = std::env::temp_dir().join(format!("ryu-resolve-subdir-{}", uniq()));
        let inner = root.join("repo-main").join("skills").join("x");
        std::fs::create_dir_all(&inner).unwrap();
        let resolved = resolve_subdir(&root, Some("skills/x")).unwrap();
        assert!(resolved.ends_with("repo-main/skills/x"));

        // No subdir → the single top dir itself.
        let top_only = resolve_subdir(&root, None).unwrap();
        assert!(top_only.ends_with("repo-main"));

        // A traversal attempt is rejected before any join.
        assert!(resolve_subdir(&root, Some("../escape")).is_err());
        // A missing subdir errors.
        assert!(resolve_subdir(&root, Some("does/not/exist")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
