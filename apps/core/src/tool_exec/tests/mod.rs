#[path = "advisor_runtime_test.rs"]
mod advisor_runtime;
#[path = "agent_comms_runtime_test.rs"]
mod agent_comms_runtime;
#[path = "brave_runtime_test.rs"]
mod brave_runtime;
#[path = "exa_runtime_test.rs"]
mod exa_runtime;
#[path = "exfiltration_guard_runtime_test.rs"]
mod exfiltration_guard_runtime;
#[path = "firecrawl_runtime_test.rs"]
mod firecrawl_runtime;
#[path = "honcho_mutation_runtime_test.rs"]
mod honcho_mutation_runtime;
#[path = "honcho_runtime_test.rs"]
mod honcho_runtime;
#[path = "jina_reader_runtime_test.rs"]
mod jina_reader_runtime;
#[path = "kev_runtime_test.rs"]
mod kev_runtime;
#[path = "mem0_runtime_test.rs"]
mod mem0_runtime;
#[path = "parallel_runtime_test.rs"]
mod parallel_runtime;
#[path = "serper_runtime_test.rs"]
mod serper_runtime;
#[path = "shadow_runtime_test.rs"]
mod shadow_runtime;
#[path = "spider_runtime_test.rs"]
mod spider_runtime;
#[path = "spidercloud_runtime_test.rs"]
mod spidercloud_runtime;
#[path = "tavily_runtime_test.rs"]
mod tavily_runtime;

use super::*;

/// The agent lane is signed over the request Core actually sends: the
/// query pairs a bodyless call appends are part of the signed path, and a
/// tool's own copy of the agent headers never survives.
#[test]
fn agent_lane_is_signed_over_the_final_request() {
    let port = core_port_from_bind(std::env::var("RYU_BIND").ok().as_deref());
    let base = format!("http://127.0.0.1:{port}/api/ext/@ryu/social/posts?x=1");
    assert!(targets_local_ext_proxy(&base));
    assert!(!targets_local_ext_proxy(&format!(
        "http://127.0.0.1:{port}/api/agents"
    )));
    assert!(!targets_local_ext_proxy(
        "https://example.com/api/ext/@ryu/social/posts"
    ));

    let client = reqwest::Client::new();
    let mut request = client
        .get(&base)
        .header(crate::sidecar::ext_proxy::HDR_CALLER_AGENT_ID, "forged")
        .query(&[("workspace_id", "w 1")])
        .build()
        .expect("request");
    sign_agent_lane_request(&mut request, Some("agent-1"));
    let header = |request: &reqwest::Request, name: &str| {
        request
            .headers()
            .get_all(name)
            .iter()
            .map(|value| value.to_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        header(&request, crate::sidecar::ext_proxy::HDR_CALLER_AGENT_ID),
        vec!["agent-1".to_owned()]
    );
    let expected = crate::sidecar::ext_proxy::sign_agent_lane(
        "agent-1",
        "GET",
        "/api/ext/@ryu/social/posts?x=1&workspace_id=w+1",
    )
    .expect("an isolated test node has a token");
    assert_eq!(
        header(&request, crate::sidecar::ext_proxy::HDR_CALLER_AGENT_PROOF),
        vec![expected]
    );

    let mut anonymous = client
        .get(&base)
        .header(crate::sidecar::ext_proxy::HDR_CALLER_AGENT_ID, "forged")
        .header(crate::sidecar::ext_proxy::HDR_CALLER_AGENT_PROOF, "forged")
        .build()
        .expect("request");
    sign_agent_lane_request(&mut anonymous, None);
    assert!(anonymous
        .headers()
        .get(crate::sidecar::ext_proxy::HDR_CALLER_AGENT_ID)
        .is_none());
    assert!(anonymous
        .headers()
        .get(crate::sidecar::ext_proxy::HDR_CALLER_AGENT_PROOF)
        .is_none());
}

#[tokio::test]
async fn sidecar_env_requires_exact_manifest_before_shared_secret_lookup() {
    let original = crate::plugin_manifest::PluginManifestLoader::load_install_catalog()
        .into_iter()
        .find(|manifest| manifest.id == "@ryu/exa")
        .expect("compiled Exa manifest");
    let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
    let shared = "RYU_TEST_SHARED_PROVENANCE_KEY";
    store
        .set(&original.id, shared, "synthetic-shared-secret")
        .await
        .unwrap();
    let source = format!("env:{shared}");
    assert_eq!(
        resolve_sidecar_env_source(&original.id, &source, Some(&store), Some(&original)).await,
        Some("synthetic-shared-secret".to_owned())
    );
    let mut installed = original.clone();
    installed.name.push_str(" altered");
    for manifest in [None, Some(&installed)] {
        assert_eq!(
            resolve_sidecar_env_source(&original.id, &source, Some(&store), manifest).await,
            None
        );
        assert_eq!(
            resolve_sidecar_env_source(&original.id, "env:RYU_TOKEN", Some(&store), manifest).await,
            None
        );
    }
    let own = format!("{}KEY", plugin_env_prefix(&original.id));
    store
        .set(&original.id, &own, "synthetic-own-secret")
        .await
        .unwrap();
    assert_eq!(
        resolve_sidecar_env_source(
            &original.id,
            &format!("env:{own}"),
            Some(&store),
            Some(&installed)
        )
        .await,
        Some("synthetic-own-secret".to_owned())
    );
    assert_eq!(
        resolve_sidecar_env_source("com.example.other", &source, Some(&store), Some(&original))
            .await,
        None
    );
}

#[test]
fn installed_bytes_cannot_inherit_catalog_env_privileges() {
    use crate::plugin_manifest::schema::{ToolBackend, ToolConfig};
    let original = crate::plugin_manifest::PluginManifestLoader::load_install_catalog()
        .into_iter()
        .find(|m| m.id == "@ryu/exa")
        .expect("compiled Exa manifest");
    let cfg: ToolConfig = serde_json::from_value(serde_json::json!({
        "slug": "search", "backend": "http", "url": "https://example.com",
        "secret_headers": {"Authorization": "Bearer env:RYU_EXA_API_KEY",
            "X-Node": "env:RYU_TOKEN", "X-Own": "env:RYU_PLUGIN__X40_RYU_X2F_EXA_API_KEY"}
    }))
    .unwrap();
    let mut trusted_backend = cfg.resolve_backend().unwrap();
    restrict_backend_env_sources(&original, &mut trusted_backend);
    let ToolBackend::Http { secret_headers, .. } = trusted_backend else {
        panic!("HTTP backend")
    };
    assert!(secret_headers.contains_key("Authorization"));
    let mut installed = original.clone();
    installed.name.push_str(" altered installed bytes");
    let mut backend = cfg.resolve_backend().unwrap();
    restrict_backend_env_sources(&installed, &mut backend);
    let ToolBackend::Http { secret_headers, .. } = backend else {
        panic!("HTTP backend")
    };
    assert!(!secret_headers.contains_key("Authorization"));
    assert!(!secret_headers.contains_key("X-Node"));
    assert!(secret_headers.contains_key("X-Own"));
    let command: ToolConfig = serde_json::from_value(serde_json::json!({
        "slug": "run", "backend": "command", "bin": "rtk",
        "command_env": {"STOLEN": "env:RYU_TOKEN", "OWN": "env:RYU_PLUGIN__X40_RYU_X2F_EXA_API_KEY"}
    }))
    .unwrap();
    let mut backend = command.resolve_backend().unwrap();
    restrict_backend_env_sources(&installed, &mut backend);
    let ToolBackend::Command { env, .. } = backend else {
        panic!("command backend")
    };
    assert!(!env.contains_key("STOLEN"));
    assert!(env.contains_key("OWN"));
}
use crate::plugin_manifest::schema::CommandOutput;
use crate::sidecar::adapters::acp::AcpAgentRegistry;

// ── Declarative `command` ToolBackend ─────────────────────────────────────

fn grants(items: &[&str]) -> std::collections::HashSet<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn test_absolute_path(path: &str) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        let name = path
            .trim_start_matches('/')
            .trim_start_matches('\\')
            .replace('/', "_")
            .replace('\\', "_");
        std::env::temp_dir().join(format!("ryu-core-test-path-{name}"))
    }
    #[cfg(not(windows))]
    {
        std::path::PathBuf::from(path)
    }
}

fn test_command_path(_name: &str) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("SystemRoot")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"))
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe")
    }
    #[cfg(not(windows))]
    {
        // Same executable-only `PATH` walk production uses, so a stray
        // non-executable file (e.g. a text `~/.local/bin/env`) earlier on the
        // host PATH cannot be picked as the test binary.
        crate::sidecar::manifest_sidecar::which_on_path(_name)
            .unwrap_or_else(|| std::path::PathBuf::from(format!("/bin/{_name}")))
    }
}

fn test_allowlist_entry(name: &str) -> String {
    format!("{name}={}", test_command_path(name).display())
}

/// Return the platform-native child arguments used by command-tool tests.
/// Windows PowerShell's `-File` mode keeps the rendered values in `$args`,
/// rather than reparsing them as a `-Command` string, so metacharacter and
/// JSON tests retain their literal-argv coverage.
fn test_command_args(
    command: &str,
    placeholders: &[&str],
) -> (Option<tempfile::TempDir>, Vec<String>) {
    #[cfg(windows)]
    {
        let script_body = match command {
            "echo" => "[Console]::WriteLine([String]::Join(' ', $args))\n",
            "sleep" => "Start-Sleep -Seconds 30\n",
            "dd" => "[byte[]]$bytes = New-Object byte[] 2097152\n[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)\n[Console]::Error.WriteLine('records')\n",
            "env" => "Get-ChildItem Env: | ForEach-Object { '{0}={1}' -f $_.Name, $_.Value }\n",
            "sh" => "[Console]::WriteLine('the-stdout')\n[Console]::Error.WriteLine('the-stderr')\n",
            _ => panic!("unknown Windows test command: {command}"),
        };
        let dir = tempfile::tempdir().expect("test command tempdir");
        let script = dir.path().join(format!("{command}.ps1"));
        std::fs::write(&script, script_body).expect("write PowerShell test script");
        let mut args = vec![
            "-NoProfile".to_owned(),
            "-ExecutionPolicy".to_owned(),
            "Bypass".to_owned(),
            "-File".to_owned(),
            script.to_string_lossy().into_owned(),
        ];
        args.extend(placeholders.iter().map(|name| format!("{{{name}}}")));
        (Some(dir), args)
    }
    #[cfg(not(windows))]
    {
        let args = match command {
            "echo" => placeholders
                .iter()
                .map(|name| format!("{{{name}}}"))
                .collect(),
            "sleep" => vec!["30".to_owned()],
            "dd" => vec![
                "if=/dev/zero".to_owned(),
                "bs=1024".to_owned(),
                "count=2048".to_owned(),
            ],
            "env" => Vec::new(),
            "sh" => vec![
                "-c".to_owned(),
                "printf 'the-stdout\\n'; printf 'the-stderr\\n' 1>&2".to_owned(),
            ],
            _ => panic!("unknown Unix test command: {command}"),
        };
        (None, args)
    }
}

#[test]
fn parse_command_allowlist_keeps_only_absolute_named_entries() {
    let echo = test_command_path("echo");
    let sleep = test_command_path("sleep");
    let invalid_name = test_command_path("invalid");
    let dd = test_command_path("dd");
    let map = parse_command_allowlist(&format!(
        "echo={}, sleep = {} ; bad=relative/path, ={}, noeq, dd={}",
        echo.display(),
        sleep.display(),
        invalid_name.display(),
        dd.display()
    ));
    assert_eq!(map.get("echo"), Some(&echo));
    assert_eq!(map.get("sleep"), Some(&sleep));
    assert_eq!(map.get("dd"), Some(&dd));
    // Relative path, empty name, and malformed entries are dropped.
    assert!(!map.contains_key("bad"));
    assert_eq!(map.len(), 3);
    // Empty string ⇒ empty map ⇒ fail-closed.
    assert!(parse_command_allowlist("").is_empty());
}

#[test]
fn render_command_arg_substitutes_rejects_and_guards() {
    let args = serde_json::json!({ "q": "hello", "n": 5, "obj": { "a": 1 } });
    // Glued flag keeps the value one token.
    assert_eq!(
        render_command_arg("--query={q}", &args).unwrap(),
        "--query=hello"
    );
    // Numbers stringify.
    assert_eq!(render_command_arg("--num={n}", &args).unwrap(), "--num=5");
    // Missing placeholder → error.
    assert!(render_command_arg("{missing}", &args).is_err());
    // Non-scalar arg → error.
    assert!(render_command_arg("{obj}", &args).is_err());
    // Option-injection guard: a leading-dash interpolated VALUE is rejected …
    let dash = serde_json::json!({ "q": "-rf" });
    assert!(render_command_arg("{q}", &dash).is_err());
    // … but a leading dash in the TEMPLATE (author-controlled) is fine.
    assert_eq!(
        render_command_arg("--flag={q}", &serde_json::json!({ "q": "ok" })).unwrap(),
        "--flag=ok"
    );
}

#[test]
fn workspace_path_args_refuse_stores_hidden_from_a_limited_agent() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    let store = root.join("vendor").join(".claude");
    let src = root.join("src");
    std::fs::create_dir_all(&store).unwrap();
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(store.join("credentials.json"), "{}").unwrap();
    let hidden = vec![std::fs::canonicalize(&store).unwrap()];

    for (raw, refused) in [
        ("vendor/.claude/credentials.json", true),
        ("vendor/.claude", true),
        // A folder containing the store: a recursive tool would walk into it.
        ("vendor", true),
        (".", true),
        ("src", false),
    ] {
        let mut args = serde_json::json!({ "path": raw });
        let result =
            prepare_workspace_path_args(&mut args, &["path".to_owned()], Some(&root), &hidden);
        if refused {
            let error = result.expect_err(raw);
            assert!(error.contains("account access"), "{raw}: {error}");
        } else {
            result.expect(raw);
        }
        // An unrestricted agent hides nothing.
        let mut args = serde_json::json!({ "path": raw });
        prepare_workspace_path_args(&mut args, &["path".to_owned()], Some(&root), &[]).expect(raw);
    }
}

#[test]
fn workspace_path_args_refuse_home_credential_stores_for_a_confined_agent() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let ryu_dir = temp.path().join("ryu");
    std::fs::create_dir_all(&ryu_dir).unwrap();
    for dir in [
        ".ssh",
        ".config/gcloud",
        ".mozilla/firefox/profile",
        "Library/Keychains",
        "projects/app",
        "projects/aws-keys",
    ] {
        std::fs::create_dir_all(home.join(dir)).unwrap();
    }
    std::fs::write(home.join(".ssh/id_ed25519"), "key").unwrap();
    std::fs::write(home.join(".config/gcloud/credentials.db"), "creds").unwrap();
    std::fs::write(home.join(".mozilla/firefox/profile/cookies.sqlite"), "c").unwrap();
    std::fs::write(home.join("Library/Keychains/login.keychain-db"), "kc").unwrap();
    std::fs::write(home.join("projects/app/main.rs"), "fn main() {}\n").unwrap();
    std::fs::write(home.join("projects/aws-keys/credentials"), "aws").unwrap();
    std::fs::write(home.join("notes.txt"), "notes").unwrap();
    // A store that is a symlink is hidden where it really lives, even when
    // that is an ordinary-looking folder the workspace can reach directly.
    #[cfg(unix)]
    std::os::unix::fs::symlink(home.join("projects/aws-keys"), home.join(".aws")).unwrap();

    let hidden = confined_hidden_paths(&ryu_dir, Some(&home), None);
    let canonical = |path: &str| std::fs::canonicalize(home.join(path)).unwrap();
    assert!(hidden.contains(&canonical(".ssh")));
    assert!(hidden.contains(&canonical(".config/gcloud")));
    assert!(hidden.contains(&canonical(".mozilla")));
    assert!(hidden.contains(&canonical("Library/Keychains")));
    assert!(hidden.contains(&std::fs::canonicalize(&ryu_dir).unwrap()));
    // The home folder itself, and folders without a store, are not stores.
    assert!(!hidden.contains(&canonical(".")));
    assert!(!hidden.contains(&canonical("projects/app")));

    let mut cases = vec![
        (".ssh/id_ed25519", true),
        (".ssh", true),
        (".config/gcloud/credentials.db", true),
        (".mozilla/firefox/profile/cookies.sqlite", true),
        ("Library/Keychains/login.keychain-db", true),
        // Folders containing a store: a recursive tool would walk into it.
        (".config", true),
        (".", true),
        // A workspace at the home folder keeps its ordinary paths.
        ("notes.txt", false),
        ("projects/app/main.rs", false),
        ("projects/app", false),
    ];
    #[cfg(unix)]
    cases.extend([("projects/aws-keys/credentials", true), ("projects", true)]);
    for (raw, refused) in cases {
        let mut args = serde_json::json!({ "path": raw });
        let result =
            prepare_workspace_path_args(&mut args, &["path".to_owned()], Some(&home), &hidden);
        if refused {
            let error = result.expect_err(raw);
            assert!(error.contains("account access"), "{raw}: {error}");
        } else {
            result.expect(raw);
        }
    }
    // An absolute spelling of a store path is refused the same way.
    let absolute = home.join(".ssh/id_ed25519").to_string_lossy().into_owned();
    let mut args = serde_json::json!({ "path": absolute });
    prepare_workspace_path_args(&mut args, &["path".to_owned()], Some(&home), &hidden)
        .expect_err("absolute store path");
    // An unrestricted agent hides nothing beyond the protected host paths.
    for raw in ["notes.txt", "projects/app/main.rs", ".config"] {
        let mut args = serde_json::json!({ "path": raw });
        prepare_workspace_path_args(&mut args, &["path".to_owned()], Some(&home), &[]).expect(raw);
    }
}

#[test]
fn workspace_path_args_allow_only_existing_non_symlink_workspace_paths() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    let nested = root.join("src");
    std::fs::create_dir_all(&nested).unwrap();
    let file = nested.join("main.rs");
    std::fs::write(&file, "fn main() {}\n").unwrap();

    let mut args = serde_json::json!({ "path": "src/main.rs" });
    prepare_workspace_path_args(&mut args, &["path".to_owned()], Some(&root), &[]).unwrap();
    assert_eq!(
        args["path"].as_str(),
        Some(
            std::fs::canonicalize(&file)
                .unwrap()
                .to_string_lossy()
                .as_ref()
        )
    );

    for path in ["../outside", "/tmp", "src/missing.rs"] {
        let mut args = serde_json::json!({ "path": path });
        let error = prepare_workspace_path_args(&mut args, &["path".to_owned()], Some(&root), &[])
            .expect_err("out-of-workspace or missing path must be denied");
        assert!(
            error.contains("workspace") || error.contains("resolved") || error.contains("symlink"),
            "unexpected error for {path}: {error}"
        );
    }

    #[cfg(unix)]
    {
        let outside = temp.path().join("outside.txt");
        std::fs::write(&outside, "not in workspace\n").unwrap();
        let link = root.join("link.txt");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let mut args = serde_json::json!({ "path": "link.txt" });
        let error = prepare_workspace_path_args(&mut args, &["path".to_owned()], Some(&root), &[])
            .expect_err("symlink path must be denied");
        assert!(
            error.contains("symlink") || error.contains("workspace"),
            "unexpected error: {error}"
        );
    }
}

#[test]
fn protected_host_paths_are_denied_even_when_the_workspace_is_a_parent() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    std::fs::create_dir_all(&root).unwrap();
    let token = root.join("node-auth.token");
    std::fs::write(&token, "not a real token").unwrap();

    let mut args = serde_json::json!({ "path": "node-auth.token" });
    let error = prepare_workspace_path_args(&mut args, &["path".to_owned()], Some(&root), &[])
        .expect_err("known Ryu credential filenames must be denied");
    assert!(error.contains("protected"), "unexpected error: {error}");

    if let Some(home) = dirs::home_dir() {
        for directory in [".codex", ".pi"] {
            if let Ok(path) = std::fs::canonicalize(home.join(directory)) {
                assert!(
                    is_protected_host_path(&path),
                    "agent credential directory {directory} must be protected"
                );
            }
        }
    }
}

#[cfg(unix)]
#[test]
fn a_workspace_that_is_a_parent_of_the_home_folder_is_refused() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let temp = tempfile::tempdir().unwrap();
    let parent = std::fs::canonicalize(temp.path()).unwrap();
    let home = parent.join("alice");
    std::fs::create_dir_all(home.join(".ssh")).unwrap();
    std::fs::create_dir_all(home.join("project")).unwrap();
    let previous_home = std::env::var("HOME").ok();
    std::env::set_var("HOME", &home);

    // `/home`-style parent: no protected store is inside the root's own path,
    // but `alice/.ssh` sits below it.
    let mut args = serde_json::json!({ "path": "." });
    let error = prepare_workspace_path_args(&mut args, &["path".to_owned()], Some(&parent), &[])
        .expect_err("a parent of the home folder must be refused");
    let usable_parent = is_usable_workspace_root(&parent);
    let usable_home = is_usable_workspace_root(&home);
    let usable_project = is_usable_workspace_root(&home.join("project"));
    restore_env("HOME", previous_home);

    assert!(error.contains("protected"), "unexpected error: {error}");
    assert!(
        !usable_parent,
        "a parent of the home folder is not a usable root"
    );
    assert!(!usable_home, "the home folder is not a usable root");
    assert!(
        usable_project,
        "a project inside the home folder stays usable"
    );
}

#[test]
fn workspace_path_args_require_a_workspace_root() {
    let mut args = serde_json::json!({ "path": "src/main.rs" });
    let error = prepare_workspace_path_args(&mut args, &["path".to_owned()], None, &[])
        .expect_err("path-scoped commands must fail closed without a root");
    assert!(
        error.contains("active workspace"),
        "unexpected error: {error}"
    );
}

#[tokio::test]
async fn ripgrep_workspace_boundary_allows_in_root_and_denies_outside() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let _env = CmdEnvGuard::armed();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    std::fs::create_dir_all(&root).unwrap();
    let inside = root.join("notes.txt");
    let outside = temp.path().join("outside.txt");
    std::fs::write(&inside, "RYU_WORKSPACE_SEARCH_PROOF\n").unwrap();
    std::fs::write(&outside, "RYU_OUTSIDE_SEARCH_PROOF\n").unwrap();
    std::env::set_var(ENV_COMMAND_TOOL_ALLOWLIST, test_allowlist_entry("rg"));

    let templates = vec![
        "--json".to_owned(),
        "--color".to_owned(),
        "never".to_owned(),
        "--".to_owned(),
        "{pattern}".to_owned(),
        "{path}".to_owned(),
    ];
    let path_args = vec!["path".to_owned()];
    let grants = grants(&["tool:command:rg"]);
    let inside_result = run_command_tool_with_agent_and_workspace(
        "rg",
        &templates,
        None,
        &BTreeMap::new(),
        None,
        10,
        CommandOutput::Stdout,
        None,
        &BTreeMap::new(),
        serde_json::json!({ "pattern": "RYU_WORKSPACE_SEARCH_PROOF", "path": "notes.txt" }),
        &grants,
        "@ryu/ripgrep",
        None,
        None,
        Some(&root),
        &path_args,
        None,
    )
    .await
    .expect("in-workspace ripgrep search runs");
    let stdout = inside_result["stdout"].as_str().unwrap_or_default();
    assert!(stdout.contains("RYU_WORKSPACE_SEARCH_PROOF"), "{stdout}");

    let outside_error = run_command_tool_with_agent_and_workspace(
        "rg",
        &templates,
        None,
        &BTreeMap::new(),
        None,
        10,
        CommandOutput::Stdout,
        None,
        &BTreeMap::new(),
        serde_json::json!({ "pattern": "RYU_OUTSIDE_SEARCH_PROOF", "path": outside }),
        &grants,
        "@ryu/ripgrep",
        None,
        None,
        Some(&root),
        &path_args,
        None,
    )
    .await
    .expect_err("outside-workspace ripgrep search must be denied");
    assert!(
        outside_error.contains("active workspace"),
        "{outside_error}"
    );
}

/// Build the exact `rtk` arg-spec list (mode-map + shell-split command).
fn rtk_specs() -> Vec<crate::plugin_manifest::schema::ArgSpec> {
    serde_json::from_value(serde_json::json!([
        { "from": "mode", "map": { "wrap": [], "proxy": ["proxy"], "test": ["test"], "err": ["err"] }, "default": "wrap" },
        { "from": "command", "split": "shell", "required": true }
    ]))
    .unwrap()
}

#[test]
fn expand_arg_specs_reproduces_rtk_argv() {
    let specs = rtk_specs();
    // mode "wrap" contributes ZERO tokens; command shell-splits into variadic.
    assert_eq!(
        expand_arg_specs(
            &specs,
            &serde_json::json!({ "command": "git status", "mode": "wrap" })
        )
        .unwrap(),
        vec!["git", "status"]
    );
    // Absent mode defaults to "wrap" → still zero mode tokens.
    assert_eq!(
        expand_arg_specs(&specs, &serde_json::json!({ "command": "cargo test" })).unwrap(),
        vec!["cargo", "test"]
    );
    // A non-wrap mode prepends its subcommand token.
    assert_eq!(
        expand_arg_specs(
            &specs,
            &serde_json::json!({ "command": "ls -la", "mode": "proxy" })
        )
        .unwrap(),
        vec!["proxy", "ls", "-la"]
    );
    // Split tokens carrying leading dashes are NOT option-injection-guarded
    // (a wrapped command legitimately has flags).
    assert_eq!(
        expand_arg_specs(&specs, &serde_json::json!({ "command": "grep -rn foo" })).unwrap(),
        vec!["grep", "-rn", "foo"]
    );
}

#[test]
fn expand_arg_specs_error_paths() {
    let specs = rtk_specs();
    // Unknown mode → error (mirrors the old mode_prefix rejection).
    assert!(expand_arg_specs(
        &specs,
        &serde_json::json!({ "command": "ls", "mode": "bogus" })
    )
    .is_err());
    // Blank required command → error.
    assert!(expand_arg_specs(&specs, &serde_json::json!({ "command": "   " })).is_err());
    // Missing required command → error.
    assert!(expand_arg_specs(&specs, &serde_json::json!({})).is_err());
    // Unbalanced quotes → parse error, nothing spawned.
    assert!(expand_arg_specs(&specs, &serde_json::json!({ "command": "git \"status" })).is_err());
}

#[tokio::test]
async fn command_tool_missing_grant_refused_before_allowlist_io() {
    // No grant → deterministic refusal before any allowlist read or spawn.
    let err = run_command_tool(
        "echo",
        &["{msg}".to_string()],
        None,
        &BTreeMap::new(),
        None,
        5,
        CommandOutput::Stdout,
        None,
        &BTreeMap::new(),
        serde_json::json!({ "msg": "hi" }),
        &grants(&[]),
        "com.test.cmd",
        None,
    )
    .await
    .expect_err("missing grant must be refused");
    assert!(
        err.contains("not granted") && err.contains("tool:command:echo"),
        "{err}"
    );
}

/// URL-fetching command tools screen the URL argument before any allowlist
/// resolution or spawn; a passing URL then runs behind the egress broker.
async fn crawl_url(url: &str) -> Result<Value, String> {
    // Pin the guard to its default posture (ON, no host allowlist) so the
    // assertions don't depend on ambient env; these are the process defaults,
    // so writing them is harmless even if it leaks to a sibling test.
    std::env::set_var("RYU_AGENT_EGRESS_SSRF_GUARD", "1");
    std::env::remove_var("RYU_AGENT_EGRESS_ALLOW_HOSTS");
    let requirement = spider_bin_version();
    run_command_tool_with_agent_and_workspace(
        "spider",
        &["crawl".to_string(), "--".to_string(), "{url}".to_string()],
        None,
        &BTreeMap::new(),
        None,
        5,
        CommandOutput::Json,
        Some("url"),
        &BTreeMap::new(),
        serde_json::json!({ "url": url }),
        &grants(&["tool:command:spider"]),
        "spider",
        None,
        None,
        None,
        &[],
        Some(&requirement),
    )
    .await
}

fn spider_bin_version() -> crate::plugin_manifest::schema::CommandBinVersion {
    serde_json::from_value(serde_json::json!({
        "pattern": "spider_cli {version}",
        "requirement": "=2.53.9",
    }))
    .unwrap()
}

/// The public wrappers carry no `bin_version` requirement, so an egress
/// (`egress_url_arg`) call through them is refused before the URL screen,
/// allowlist resolution, or any spawn — even when the bin is granted,
/// allowlisted, and installed. Neither wrapper can skip the version check.
#[cfg(unix)]
#[tokio::test]
async fn command_tool_egress_via_wrappers_cannot_skip_version_check() {
    use std::os::unix::fs::PermissionsExt;
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("spawned");
    let bin = dir.path().join("fake-spider");
    std::fs::write(
        &bin,
        format!("#!/bin/sh\ntouch '{}'\necho '{{}}'\n", marker.display()),
    )
    .unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
    let previous = std::env::var(ENV_COMMAND_TOOL_ALLOWLIST).ok();
    std::env::set_var(
        ENV_COMMAND_TOOL_ALLOWLIST,
        format!("spider={}", bin.display()),
    );
    std::env::set_var("RYU_AGENT_EGRESS_SSRF_GUARD", "1");
    std::env::remove_var("RYU_AGENT_EGRESS_ALLOW_HOSTS");
    let argv = ["{url}".to_string()];
    let args = || serde_json::json!({ "url": "http://93.184.216.34/" });
    let spider = grants(&["tool:command:spider"]);
    let via_plain = run_command_tool(
        "spider",
        &argv,
        None,
        &BTreeMap::new(),
        None,
        5,
        CommandOutput::Json,
        Some("url"),
        &BTreeMap::new(),
        args(),
        &spider,
        "spider",
        None,
    )
    .await;
    let via_agent = run_command_tool_with_agent(
        "spider",
        &argv,
        None,
        &BTreeMap::new(),
        None,
        5,
        CommandOutput::Json,
        Some("url"),
        &BTreeMap::new(),
        args(),
        &spider,
        "spider",
        None,
        Some("agent-1"),
    )
    .await;
    restore_env(ENV_COMMAND_TOOL_ALLOWLIST, previous);
    for (entry, res) in [
        ("run_command_tool", via_plain),
        ("run_command_tool_with_agent", via_agent),
    ] {
        let err = res.expect_err(&format!(
            "{entry}: egress without bin_version must be refused"
        ));
        assert!(
            err.contains("egress_url_arg") && err.contains("bin_version"),
            "{entry}: {err}"
        );
    }
    assert!(!marker.exists(), "the binary must never be spawned");
}

/// An allowlisted path that is a regular file without any execute bit is
/// reported as not installed (graceful), never as a ready binary.
#[cfg(unix)]
#[test]
fn resolve_command_bin_treats_non_executable_file_as_not_installed() {
    use std::os::unix::fs::PermissionsExt;
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("plain");
    std::fs::write(&bin, "#!/bin/sh\necho hi\n").unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o644)).unwrap();
    let previous = std::env::var(ENV_COMMAND_TOOL_ALLOWLIST).ok();
    std::env::set_var(
        ENV_COMMAND_TOOL_ALLOWLIST,
        format!("plain={}", bin.display()),
    );
    let not_exec = resolve_command_bin("plain");
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    let exec = resolve_command_bin("plain");
    restore_env(ENV_COMMAND_TOOL_ALLOWLIST, previous);
    match not_exec {
        Ok(BinResolution::NotInstalled(reason)) => {
            assert!(reason.contains("not executable"), "{reason}");
        }
        Ok(BinResolution::Ready(path)) => panic!("non-executable resolved as ready: {path:?}"),
        Err(err) => panic!("non-executable must degrade, not fail closed: {err}"),
    }
    assert!(matches!(exec, Ok(BinResolution::Ready(path)) if path == bin));
}

/// URL-fetching child processes are rejected before any downstream allowlist
/// or network behavior.
fn assert_blocked_by_screen(res: &Result<Value, String>, what: &str) {
    let err = res.as_ref().expect_err(what);
    assert!(
        !err.contains("allowlist"),
        "{what}: expected an egress-screen rejection, but the error came from \
             allowlist resolution (screen let it through): {err}"
    );
}

// These tests pin the pre-spawn URL screen for URL-fetching command tools;
// per-connection screening is covered by `egress_broker::tests`.

#[tokio::test]
async fn command_tool_egress_passes_public_ip_to_allowlist() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let previous = std::env::var(ENV_COMMAND_TOOL_ALLOWLIST).ok();
    std::env::remove_var(ENV_COMMAND_TOOL_ALLOWLIST);
    let res = crawl_url("http://93.184.216.34/").await;
    restore_env(ENV_COMMAND_TOOL_ALLOWLIST, previous);
    // The public URL passes the egress screen and reaches bin resolution,
    // which degrades (not installed) or refuses (not allowlisted).
    match res {
        Ok(value) => assert_eq!(value["available"], false, "{value}"),
        Err(err) => assert!(err.contains("allowlist"), "{err}"),
    }
}

#[tokio::test]
async fn command_tool_egress_rejects_disallowed_port() {
    let err = crawl_url("http://93.184.216.34:8080/")
        .await
        .expect_err("non-80/443 port must be refused before spawn");
    assert!(err.contains("port 8080"), "{err}");
}

#[tokio::test]
async fn command_tool_egress_rejects_non_http_scheme() {
    assert_blocked_by_screen(
        &crawl_url("file:///etc/passwd").await,
        "file:// must be rejected",
    );
    assert_blocked_by_screen(
        &crawl_url("ftp://example.com").await,
        "ftp:// must be rejected",
    );
}

#[tokio::test]
async fn command_tool_egress_rejects_flag_smuggling_url() {
    // A flag-shaped "url" is not valid http/https, so the scheme screen catches
    // it before it can ever reach argv as an injected option.
    assert_blocked_by_screen(
        &crawl_url("--config=/etc/shadow").await,
        "flag-like URL must be rejected",
    );
}

#[tokio::test]
async fn command_tool_egress_blocks_metadata_ip() {
    assert_blocked_by_screen(
        &crawl_url("http://169.254.169.254/").await,
        "cloud metadata IP must be blocked before any spawn",
    );
}

#[tokio::test]
async fn command_tool_egress_blocks_private_ip() {
    for url in [
        "http://10.0.0.1/",
        "http://127.0.0.1/",
        "https://192.168.1.1/",
    ] {
        assert_blocked_by_screen(
            &crawl_url(url).await,
            &format!("private/loopback IP {url} must be blocked"),
        );
    }
}

#[tokio::test]
async fn command_tool_unknown_bin_refused_with_no_spawn() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    std::env::remove_var(ENV_COMMAND_TOOL_ALLOWLIST);
    let err = run_command_tool(
        "echo",
        &[],
        None,
        &BTreeMap::new(),
        None,
        5,
        CommandOutput::Stdout,
        None,
        &BTreeMap::new(),
        serde_json::json!({}),
        &grants(&["tool:command:echo"]),
        "com.test.cmd",
        None,
    )
    .await
    .expect_err("unknown bin (empty allowlist) must be refused");
    assert!(err.contains("command allowlist"), "{err}");
}

/// Arm the fail-open gateway posture + disarm the exec-approval scan so a
/// spawn test reaches the actual child (the scan is armed BY DEFAULT and the
/// budget gate fails CLOSED on an unreachable gateway), and RESTORE those
/// process-global vars on drop so the posture never leaks into sibling tests.
/// Must be constructed while holding [`lock_gateway_env`].
struct CmdEnvGuard {
    previous_gateway_url: Option<String>,
    previous_fallback: Option<String>,
    previous_exec_mode: Option<String>,
    previous_allowlist: Option<String>,
}
impl CmdEnvGuard {
    fn armed() -> Self {
        let previous_gateway_url = std::env::var("RYU_GATEWAY_URL").ok();
        let previous_fallback = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK").ok();
        let previous_exec_mode = std::env::var("RYU_EXEC_APPROVAL_MODE").ok();
        let previous_allowlist = std::env::var(ENV_COMMAND_TOOL_ALLOWLIST).ok();
        // A live default Gateway may belong to another local process and return
        // 401 for this test's local bearer. Force the documented unreachable
        // path so the fallback posture is deterministic.
        std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
        std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", "1");
        std::env::set_var("RYU_EXEC_APPROVAL_MODE", "off");
        Self {
            previous_gateway_url,
            previous_fallback,
            previous_exec_mode,
            previous_allowlist,
        }
    }
}
impl Drop for CmdEnvGuard {
    fn drop(&mut self) {
        restore_env("RYU_GATEWAY_URL", self.previous_gateway_url.take());
        restore_env("RYU_ALLOW_GATEWAY_FALLBACK", self.previous_fallback.take());
        restore_env("RYU_EXEC_APPROVAL_MODE", self.previous_exec_mode.take());
        restore_env(ENV_COMMAND_TOOL_ALLOWLIST, self.previous_allowlist.take());
    }
}

fn restore_env(name: &str, value: Option<String>) {
    match value {
        Some(value) => std::env::set_var(name, value),
        None => std::env::remove_var(name),
    }
}

struct EnvOverride {
    name: &'static str,
    previous: Option<String>,
}

impl EnvOverride {
    fn set(name: &'static str, value: &str) -> Self {
        let previous = std::env::var(name).ok();
        std::env::set_var(name, value);
        Self { name, previous }
    }
}

impl Drop for EnvOverride {
    fn drop(&mut self) {
        restore_env(self.name, self.previous.take());
    }
}

#[tokio::test]
async fn command_tool_no_shell_metachars_are_literal() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let _env = CmdEnvGuard::armed();
    std::env::set_var(ENV_COMMAND_TOOL_ALLOWLIST, test_allowlist_entry("echo"));
    // A value packed with shell metacharacters must arrive as ONE literal argv
    // element — proving there is no shell (this asserts literal argv, NOT scan
    // denial; the scan is disarmed in this test env).
    let payload = "; echo $(whoami) `id` && echo pwned";
    let (_script_dir, command_args) = test_command_args("echo", &["msg"]);
    let out = run_command_tool(
        "echo",
        &command_args,
        None,
        &BTreeMap::new(),
        None,
        10,
        CommandOutput::Stdout,
        None,
        &BTreeMap::new(),
        serde_json::json!({ "msg": payload }),
        &grants(&["tool:command:echo"]),
        "com.test.cmd",
        None,
    )
    .await
    .expect("echo runs");
    let stdout = out
        .get("stdout")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    assert!(
        stdout.contains(payload),
        "metachars must be literal, got: {stdout:?}"
    );
    assert_eq!(out.get("exit_code").and_then(|v| v.as_i64()), Some(0));
}

#[tokio::test]
async fn command_tool_timeout_kills_child() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let _env = CmdEnvGuard::armed();
    std::env::set_var(ENV_COMMAND_TOOL_ALLOWLIST, test_allowlist_entry("sleep"));
    let (_script_dir, command_args) = test_command_args("sleep", &[]);
    let out = run_command_tool(
        "sleep",
        &command_args,
        None,
        &BTreeMap::new(),
        None,
        1, // 1s timeout vs a 30s sleep
        CommandOutput::Stdout,
        None,
        &BTreeMap::new(),
        serde_json::json!({}),
        &grants(&["tool:command:sleep"]),
        "com.test.cmd",
        None,
    )
    .await
    .expect("a timed-out command degrades gracefully (turn-continuation), not Err");
    // Graceful degradation: the child was killed and the result is a soft
    // {available:false} envelope naming the timeout (the audit still records
    // exit 124 independently).
    assert_eq!(out.get("available").and_then(Value::as_bool), Some(false));
    assert!(
        out.get("reason")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("timed out"),
        "reason must name the timeout, got: {out}"
    );
}

#[tokio::test]
async fn command_tool_output_cap_and_stderr_drain() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let _env = CmdEnvGuard::armed();
    std::env::set_var(ENV_COMMAND_TOOL_ALLOWLIST, test_allowlist_entry("dd"));
    let (_script_dir, command_args) = test_command_args("dd", &[]);
    // The test command writes ~2 MiB of zeros to stdout (> the 1 MiB cap) and
    // reports on stderr;
    // the bounded read must cap stdout and the concurrent stderr drain must keep
    // the child from deadlocking on a full stderr pipe.
    let out = run_command_tool(
        "dd",
        &command_args,
        None,
        &BTreeMap::new(),
        None,
        20,
        CommandOutput::Stdout,
        None,
        &BTreeMap::new(),
        serde_json::json!({}),
        &grants(&["tool:command:dd"]),
        "com.test.cmd",
        None,
    )
    .await
    .expect("dd runs to completion without deadlock");
    assert_eq!(out.get("truncated").and_then(|v| v.as_bool()), Some(true));
    // The `stdout` field now carries the bounded stdout PLUS the merged (also
    // bounded) stderr, so each stream is capped at MAX and the field stays
    // bounded by 2×MAX — the child never deadlocks and memory stays bounded.
    let len = out
        .get("stdout")
        .and_then(|v| v.as_str())
        .map(str::len)
        .unwrap_or(0);
    assert!(
        len <= 2 * MAX_COMMAND_OUTPUT_BYTES,
        "merged output must stay bounded, was {len}"
    );
    // The test command reports its transfer on stderr — proof the merge fired.
    let stdout = out
        .get("stdout")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    assert!(
        stdout.contains("records"),
        "dd's stderr stats must be merged into the output"
    );
}

#[tokio::test]
async fn command_tool_json_output_past_the_cap_reports_truncation() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let _env = CmdEnvGuard::armed();
    std::env::set_var(ENV_COMMAND_TOOL_ALLOWLIST, test_allowlist_entry("dd"));
    let (_script_dir, command_args) = test_command_args("dd", &[]);
    // ~2 MiB of zeros is cut at the cap, so it can never parse as JSON.
    let out = run_command_tool(
        "dd",
        &command_args,
        None,
        &BTreeMap::new(),
        None,
        20,
        CommandOutput::Json,
        None,
        &BTreeMap::new(),
        serde_json::json!({}),
        &grants(&["tool:command:dd"]),
        "com.test.cmd",
        None,
    )
    .await
    .expect("an over-cap command still returns a result");
    assert_eq!(out.get("available").and_then(Value::as_bool), Some(true));
    assert_eq!(out.get("truncated").and_then(Value::as_bool), Some(true));
}

#[tokio::test]
async fn command_tool_json_output_parsed_and_invalid_errors() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let _env = CmdEnvGuard::armed();
    std::env::set_var(ENV_COMMAND_TOOL_ALLOWLIST, test_allowlist_entry("echo"));
    let (_script_dir, command_args) = test_command_args("echo", &["payload"]);
    // Valid JSON passed via an interpolated arg is parsed into the result.
    let out = run_command_tool(
        "echo",
        &command_args,
        None,
        &BTreeMap::new(),
        None,
        10,
        CommandOutput::Json,
        None,
        &BTreeMap::new(),
        serde_json::json!({ "payload": "{\"a\":1}" }),
        &grants(&["tool:command:echo"]),
        "com.test.cmd",
        None,
    )
    .await
    .expect("json echo runs");
    assert_eq!(out.get("a").and_then(|v| v.as_i64()), Some(1));
    // Non-JSON stdout under output=json degrades gracefully (spider's posture):
    // the agent still receives the raw text as `content`, not a hard error.
    let soft = run_command_tool(
        "echo",
        &command_args,
        None,
        &BTreeMap::new(),
        None,
        10,
        CommandOutput::Json,
        None,
        &BTreeMap::new(),
        serde_json::json!({ "payload": "not json" }),
        &grants(&["tool:command:echo"]),
        "com.test.cmd",
        None,
    )
    .await
    .expect("non-JSON stdout under output=json degrades to raw content, not Err");
    assert_eq!(soft.get("available").and_then(Value::as_bool), Some(true));
    assert!(
        soft.get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("not json"),
        "raw stdout must be surfaced as content, got: {soft}"
    );
}

#[tokio::test]
async fn command_tool_env_injects_declared_and_scrubs_secrets() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let _env = CmdEnvGuard::armed();
    std::env::set_var(ENV_COMMAND_TOOL_ALLOWLIST, test_allowlist_entry("env"));
    let (_script_dir, command_args) = test_command_args("env", &[]);
    // The source var sits in THIS plugin's own `RYU_PLUGIN_<ID>_` namespace, which
    // is what `may_read_env_secret` admits for a disk manifest. It used to be a
    // bare `RYU_CMD_TEST_SRC`; that only worked because the child-env `env:` arm
    // was ungated, so keeping it would mean this test silently asserted the hole.
    // The gate's REFUSAL path has its own test
    // (`a_command_tools_child_env_obeys_the_same_namespace_gate_as_headers`).
    std::env::set_var("RYU_PLUGIN_COM_X2E_TEST_X2E_CMD_SRC", "injected-value");
    assert_eq!(
        std::env::var("RYU_PLUGIN_COM_X2E_TEST_X2E_CMD_SRC").as_deref(),
        Ok("injected-value")
    );
    assert!(may_read_env_secret(
        "com.test.cmd",
        "RYU_PLUGIN_COM_X2E_TEST_X2E_CMD_SRC"
    ));
    // A secret-shaped inherited var that must be scrubbed from the child.
    std::env::set_var("RYU_CMD_TEST_SECRET_TOKEN", "leak-me");
    let mut env_map = BTreeMap::new();
    env_map.insert(
        "RYU_CMD_TEST_DEST".to_string(),
        "env:RYU_PLUGIN_COM_X2E_TEST_X2E_CMD_SRC".to_string(),
    );
    let out = run_command_tool(
        "env",
        &command_args,
        None,
        &env_map,
        None,
        10,
        CommandOutput::Stdout,
        None,
        &BTreeMap::new(),
        serde_json::json!({}),
        &grants(&["tool:command:env"]),
        "com.test.cmd",
        None,
    )
    .await
    .expect("env runs");
    assert_eq!(
        out.get("available"),
        None,
        "env command should execute, got unavailable payload: {out}"
    );
    let stdout = out
        .get("stdout")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    assert!(
        stdout.contains("RYU_CMD_TEST_DEST=injected-value"),
        "declared env var must be injected, got: {stdout}"
    );
    assert!(
        !stdout.contains("leak-me") && !stdout.contains("RYU_CMD_TEST_SECRET_TOKEN"),
        "secret-shaped inherited var must be scrubbed, got: {stdout}"
    );
    std::env::remove_var("RYU_PLUGIN_COM_X2E_TEST_X2E_CMD_SRC");
    std::env::remove_var("RYU_CMD_TEST_SECRET_TOKEN");
}

// ── #4 command graceful degradation + #3 allowlist seeding + #5 clamp ────────

#[tokio::test]
async fn command_tool_allowlisted_but_absent_file_degrades_gracefully() {
    // An allowlisted key whose file does not exist is an OPERATIONAL failure →
    // graceful {available:false} "not installed", NOT a fail-closed Err (which
    // is reserved for an UNKNOWN/unlisted key — the security control).
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let _env = CmdEnvGuard::armed();
    let missing_dir = tempfile::tempdir().expect("missing command tempdir");
    let missing_path = missing_dir.path().join("ghost-binary");
    std::env::set_var(
        ENV_COMMAND_TOOL_ALLOWLIST,
        format!("ghost={}", missing_path.display()),
    );
    let out = run_command_tool(
        "ghost",
        &[],
        None,
        &BTreeMap::new(),
        None,
        5,
        CommandOutput::Stdout,
        None,
        &BTreeMap::new(),
        serde_json::json!({}),
        &grants(&["tool:command:ghost"]),
        "com.test.cmd",
        None,
    )
    .await
    .expect("an allowlisted-but-not-installed bin degrades gracefully, not Err");
    assert_eq!(out.get("available").and_then(Value::as_bool), Some(false));
    assert!(
        out.get("reason")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("not installed"),
        "reason must say not installed, got: {out}"
    );
}

#[test]
fn builtin_command_seed_covers_only_trusted_builtin_bins() {
    // The trusted command keys are seeded independently of the runtime
    // manifest catalog, and an untrusted/user manifest bin never could be.
    // Pure — never touches the process-global OnceLock.
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    // Deterministic paths regardless of the dev box's PATH.
    std::env::set_var("RYU_SPIDER_BIN", "/opt/ryu/bin/spider");
    std::env::set_var("RYU_RTK_BIN", "/opt/ryu/bin/rtk");
    std::env::set_var("RYU_BWS_BIN", "/opt/ryu/bin/bws");
    let seed = builtin_command_seed();
    assert_eq!(
        seed.get("spider"),
        Some(&std::path::PathBuf::from("/opt/ryu/bin/spider"))
    );
    assert_eq!(
        seed.get("rtk"),
        Some(&std::path::PathBuf::from("/opt/ryu/bin/rtk"))
    );
    assert_eq!(
        seed.get("bws"),
        Some(&std::path::PathBuf::from("/opt/ryu/bin/bws"))
    );
    // No arbitrary/untrusted bin is ever auto-allowlisted.
    assert!(!seed.contains_key("bash"));
    assert!(!seed.contains_key("echo"));
    std::env::remove_var("RYU_SPIDER_BIN");
    std::env::remove_var("RYU_RTK_BIN");
    std::env::remove_var("RYU_BWS_BIN");
}

#[test]
fn trusted_command_keys_are_independent_of_builtin_manifests() {
    assert_eq!(TRUSTED_COMMAND_BIN_KEYS, &["spider", "rtk", "bws"]);
    let seed = builtin_command_seed();
    let keys = seed.keys().map(String::as_str).collect::<Vec<_>>();
    assert_eq!(keys, ["bws", "rtk", "spider"]);
}

#[test]
fn merge_command_allowlist_env_wins_and_is_additive() {
    let seed_spider = test_absolute_path("/seed/spider");
    let seed_rtk = test_absolute_path("/seed/rtk");
    let env_spider = test_absolute_path("/env/spider");
    let env_extra = test_absolute_path("/env/extra");
    let mut seed = BTreeMap::new();
    seed.insert("spider".to_owned(), seed_spider.clone());
    seed.insert("rtk".to_owned(), seed_rtk.clone());
    let env = parse_command_allowlist(&format!(
        "spider={}, extra={}",
        env_spider.display(),
        env_extra.display()
    ));
    let merged = merge_command_allowlist(&seed, env);
    // Env overrides a seeded key …
    assert_eq!(merged.get("spider"), Some(&env_spider));
    // … keeps a seed-only key …
    assert_eq!(merged.get("rtk"), Some(&seed_rtk));
    // … and adds an env-only key.
    assert_eq!(merged.get("extra"), Some(&env_extra));
}

#[tokio::test]
async fn command_tool_clamps_and_defaults_from_input_schema() {
    // #5: bounds sourced from input_schema clamp at render time via the
    // `command_args` path (so spider's real `depth`/`limit` flow is exercised),
    // and an integral clamp renders as "10", not "10.0".
    use crate::plugin_manifest::schema::extract_arg_bounds;
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let _env = CmdEnvGuard::armed();
    std::env::set_var(ENV_COMMAND_TOOL_ALLOWLIST, test_allowlist_entry("echo"));
    let (_script_dir, command_args) = test_command_args("echo", &["depth", "limit"]);
    let bounds = extract_arg_bounds(Some(&serde_json::json!({
        "properties": {
            "depth": { "type": "integer", "default": 1, "maximum": 10 },
            "limit": { "type": "integer", "minimum": 1, "maximum": 500 }
        }
    })));
    // depth=9999 clamps to 10; limit=0 clamps to 1 — both echoed as integers.
    let out = run_command_tool(
        "echo",
        &command_args,
        None,
        &BTreeMap::new(),
        None,
        10,
        CommandOutput::Stdout,
        None,
        &bounds,
        serde_json::json!({ "depth": 9999, "limit": 0 }),
        &grants(&["tool:command:echo"]),
        "com.test.cmd",
        None,
    )
    .await
    .expect("echo runs");
    let stdout = out
        .get("stdout")
        .and_then(Value::as_str)
        .unwrap_or_default();
    assert_eq!(stdout.trim(), "10 1", "clamped integers, got: {stdout:?}");

    // Absent depth falls back to its schema default (1).
    let (_script_dir2, command_args2) = test_command_args("echo", &["depth"]);
    let out2 = run_command_tool(
        "echo",
        &command_args2,
        None,
        &BTreeMap::new(),
        None,
        10,
        CommandOutput::Stdout,
        None,
        &bounds,
        serde_json::json!({ "limit": 5 }),
        &grants(&["tool:command:echo"]),
        "com.test.cmd",
        None,
    )
    .await
    .expect("echo runs");
    assert_eq!(
        out2.get("stdout")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim(),
        "1",
        "absent depth must use the schema default"
    );
}

// ── #1 http secret headers + fail-open ───────────────────────────────────────

#[test]
fn build_rest_request_injects_resolved_secret_header() {
    // A pre-resolved secret header rides onto the request without ever being a
    // model arg: it is not consumed from `args`, not required, and never in the
    // url/query/body.
    let (final_url, query, body, headers) = build_rest_request(
        "https://api.exa.ai/search",
        &serde_json::json!({ "query": "hi" }),
        false,
        &[],
        &[("Authorization".to_owned(), "Bearer abc".to_owned())],
    )
    .unwrap();
    assert_eq!(final_url, "https://api.exa.ai/search");
    assert!(query.is_empty());
    assert!(
        headers
            .iter()
            .any(|(n, v)| n == "Authorization" && v == "Bearer abc"),
        "secret header must be present"
    );
    // The body still carries the real arg, and NOT the secret name.
    assert_eq!(body.get("query").and_then(Value::as_str), Some("hi"));
    assert!(body.get("Authorization").is_none());
}

#[test]
fn build_rest_request_secret_header_absent_when_empty() {
    let (_url, _q, _body, headers) = build_rest_request(
        "https://api.example.com/x",
        &serde_json::json!({ "X-Head": "v", "q": "1" }),
        true,
        &["X-Head".to_owned()],
        &[],
    )
    .unwrap();
    // Only the declared header_params entry, no secret header (back-compat).
    assert_eq!(headers, vec![("X-Head".to_owned(), "v".to_owned())]);
}

#[test]
fn finalize_http_result_matrix() {
    // Default `unwrap_body=false` throughout this matrix (envelope behavior).
    // fail_open=false: transport err → Err; any response → Ok({status,body}).
    let (r, exit, err) =
        finalize_http_result(false, false, None, Value::Null, Some("boom".to_owned()));
    assert!(r.is_err() && exit == 1 && err.as_deref() == Some("boom"));
    let (r, exit, _) = finalize_http_result(
        false,
        false,
        Some(200),
        serde_json::json!({ "ok": 1 }),
        None,
    );
    assert_eq!(r.unwrap()["status"], 200);
    assert_eq!(exit, 0);

    // fail_open=true: transport err + 401/403 → Ok(available:false) but audit
    // exit stays 1 (audit-decoupling — outages/auth failures never vanish).
    let (r, exit, err) =
        finalize_http_result(true, false, None, Value::Null, Some("boom".to_owned()));
    assert_eq!(r.unwrap()["available"], false);
    assert_eq!(exit, 1);
    assert!(err.is_some());
    let (r, exit, _) = finalize_http_result(true, false, Some(401), Value::Null, None);
    assert_eq!(r.unwrap()["available"], false);
    assert_eq!(exit, 1);
    let (r, _, _) = finalize_http_result(true, false, Some(403), Value::Null, None);
    assert_eq!(r.unwrap()["available"], false);
    // Every other status still returns {status,body} even with fail_open.
    let (r, exit, _) = finalize_http_result(true, false, Some(404), serde_json::json!("x"), None);
    assert_eq!(r.unwrap()["status"], 404);
    assert_eq!(exit, 1);
    let (r, exit, _) = finalize_http_result(true, false, Some(200), serde_json::json!("y"), None);
    assert_eq!(r.unwrap()["status"], 200);
    assert_eq!(exit, 0);
}

#[test]
fn finalize_http_result_unwrap_body_returns_2xx_verbatim() {
    // GAP A: `unwrap_body=true` returns the parsed 2xx body VERBATIM — no
    // `{status,body}` envelope — reproducing the original exa raw-JSON shape.
    let raw = serde_json::json!({ "results": [{ "title": "t", "url": "u" }] });
    let (r, exit, _) = finalize_http_result(false, true, Some(200), raw.clone(), None);
    assert_eq!(r.unwrap(), raw);
    assert_eq!(exit, 0);
    // A 201 is still a success → still unwrapped verbatim.
    let (r, _, _) =
        finalize_http_result(false, true, Some(201), serde_json::json!({ "id": 5 }), None);
    assert_eq!(r.unwrap()["id"], 5);

    // Non-2xx is NOT unwrapped even with unwrap_body: the envelope preserves the
    // status so an error is legible (500 without fail_open).
    let (r, exit, _) =
        finalize_http_result(false, true, Some(500), serde_json::json!("oops"), None);
    let v = r.unwrap();
    assert_eq!(v["status"], 500);
    assert_eq!(v["body"], "oops");
    assert_eq!(exit, 1);

    // fail_open 401/403 still wins over unwrap → {available:false}, not verbatim.
    let (r, exit, _) = finalize_http_result(true, true, Some(401), Value::Null, None);
    assert_eq!(r.unwrap()["available"], false);
    assert_eq!(exit, 1);
}

#[test]
fn http_tool_redacts_resolved_secret_values_from_reflected_bodies() {
    let body = serde_json::json!({
        "echo": "Bearer super-secret",
        "nested": ["super-secret", "safe"],
    });
    let redacted = redact_secret_values(body, &[String::from("super-secret")]);
    assert_eq!(redacted["echo"], "Bearer [REDACTED]");
    assert_eq!(redacted["nested"][0], "[REDACTED]");
    assert_eq!(redacted["nested"][1], "safe");
}

#[test]
fn deep_merge_json_defaults_under_model_args() {
    // GAP B: manifest `body_defaults` deep-merged UNDER the model body — the
    // model wins on every collision, nested default sub-objects survive omission.
    let defaults = serde_json::json!({
        "num_results": 10,
        "use_autoprompt": true,
        "contents": { "text": true }
    });
    // Model supplies only `query` + overrides `num_results`; omits the rest.
    let model = serde_json::json!({ "query": "cats", "num_results": 3 });
    let mut merged = defaults.clone();
    deep_merge_json(&mut merged, &model);
    assert_eq!(merged["query"], "cats");
    // Model wins on the collision.
    assert_eq!(merged["num_results"], 3);
    // Untouched default carried through.
    assert_eq!(merged["use_autoprompt"], true);
    // Nested default sub-object survives when the model omits it.
    assert_eq!(merged["contents"]["text"], true);

    // A nested object collision merges key-by-key (model wins per leaf).
    let mut merged2 = defaults.clone();
    deep_merge_json(
        &mut merged2,
        &serde_json::json!({ "contents": { "text": false, "summary": true } }),
    );
    assert_eq!(merged2["contents"]["text"], false);
    assert_eq!(merged2["contents"]["summary"], true);
    // Sibling default still present.
    assert_eq!(merged2["num_results"], 10);
}

#[test]
fn exa_search_manifest_resolves_unwrap_and_body_defaults() {
    // GAP A+B, exa success shape: the shipped exa search fixture resolves to an
    // Http backend with unwrap_body ON and the full body_defaults object, so the
    // declarative knobs (not exa-specific code) close both parity gaps.
    use crate::plugin_manifest::schema::{ToolBackend, ToolConfig};
    let cfg: ToolConfig = serde_json::from_value(serde_json::json!({
        "slug": "exa.search",
        "backend": "http",
        "method": "POST",
        "url": "https://api.exa.ai/search",
        "secret_headers": { "Authorization": "env:RYU_EXA_API_KEY" },
        "fail_open": true,
        "unwrap_body": true,
        "body_defaults": {
            "num_results": 10,
            "use_autoprompt": true,
            "contents": { "text": true }
        }
    }))
    .unwrap();
    match cfg.resolve_backend().unwrap() {
        ToolBackend::Http {
            unwrap_body,
            body_defaults,
            fail_open,
            ..
        } => {
            assert!(unwrap_body);
            assert!(fail_open);
            assert_eq!(body_defaults["num_results"], 10);
            assert_eq!(body_defaults["use_autoprompt"], true);
            assert_eq!(body_defaults["contents"]["text"], true);
        }
        other => panic!("expected Http backend, got {other:?}"),
    }

    // A non-object body_defaults is a manifest authoring error.
    let bad: ToolConfig = serde_json::from_value(serde_json::json!({
        "slug": "x", "backend": "http", "url": "https://api.example.com/x",
        "body_defaults": [1, 2, 3]
    }))
    .unwrap();
    assert!(bad.resolve_backend().is_err());
}

/// A Bytebot plugin has no hook/adapter body to hydrate: its production
/// behavior is the six declarative HTTP runnables in the package manifest.
/// Exercise those real configs through Core's HTTP dispatcher against a local
/// daemon fixture, so changes to body-default merging, JSON serialization, or
/// success shaping fail here instead of being hidden by manifest-only checks.
#[tokio::test]
async fn bytebot_manifest_actions_reach_the_http_runtime_with_expected_payloads() {
    use axum::{routing::post, Router};
    use std::sync::Arc;

    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let _env = CmdEnvGuard::armed();

    const BYTEBOT_MANIFEST: &str =
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/bytebot/manifest.json");
    let manifest: Value = serde_json::from_str(BYTEBOT_MANIFEST).unwrap();
    let observed = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind deterministic local Bytebot fixture");
    let address = listener.local_addr().unwrap();
    let app = Router::new().route(
        "/computer-use",
        post(bytebot_fixture_action).with_state(observed.clone()),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve deterministic local Bytebot fixture");
    });

    let grant_set = manifest["permission_grants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|grant| grant.as_str().unwrap().to_owned())
        .collect::<std::collections::HashSet<_>>();
    let cases = [
        ("bytebot.screenshot", serde_json::json!({})),
        (
            "bytebot.click",
            serde_json::json!({
                "coordinates": { "x": 41, "y": 73 },
                "button": "right",
                "clickCount": 2
            }),
        ),
        (
            "bytebot.type_text",
            serde_json::json!({ "text": "fixture text", "delay": 7 }),
        ),
        (
            "bytebot.type_keys",
            serde_json::json!({ "keys": ["ctrl", "s"], "delay": 23 }),
        ),
        (
            "bytebot.scroll",
            serde_json::json!({ "direction": "down", "scrollCount": 7 }),
        ),
        (
            "bytebot.application",
            serde_json::json!({ "application": "terminal" }),
        ),
    ];
    let mut expected_requests = Vec::new();

    for (slug, args) in cases {
        let runnable = manifest["runnables"]
            .as_array()
            .unwrap()
            .iter()
            .find(|runnable| runnable["config"]["slug"] == slug)
            .unwrap_or_else(|| panic!("Bytebot manifest is missing {slug}"));
        let config = &runnable["config"];
        let mut url = reqwest::Url::parse(config["url"].as_str().unwrap()).unwrap();
        url.set_port(Some(address.port())).unwrap();
        let body_defaults = config["body_defaults"].clone();
        let expected_body = match slug {
            "bytebot.screenshot" => serde_json::json!({ "action": "screenshot" }),
            "bytebot.click" => serde_json::json!({
                "action": "click_mouse",
                "button": "right",
                "clickCount": 2,
                "coordinates": { "x": 41, "y": 73 }
            }),
            "bytebot.type_text" => serde_json::json!({
                "action": "type_text",
                "text": "fixture text",
                "delay": 7
            }),
            "bytebot.type_keys" => serde_json::json!({
                "action": "type_keys",
                "keys": ["ctrl", "s"],
                "delay": 23
            }),
            "bytebot.scroll" => serde_json::json!({
                "action": "scroll",
                "scrollCount": 7,
                "direction": "down"
            }),
            "bytebot.application" => serde_json::json!({
                "action": "application",
                "application": "terminal"
            }),
            _ => unreachable!("case list contains only Bytebot tools"),
        };
        expected_requests.push(expected_body);

        let result = run_http_tool(
            url.as_str(),
            config["method"].as_str().unwrap(),
            args,
            &[],
            &BTreeMap::new(),
            config["fail_open"].as_bool().unwrap(),
            config["unwrap_body"].as_bool().unwrap(),
            &body_defaults,
            &grant_set,
            &[],
            "@ryu/bytebot",
            None,
        )
        .await
        .unwrap_or_else(|error| panic!("{slug} failed through Core HTTP runtime: {error}"));

        if slug == "bytebot.screenshot" {
            assert_eq!(result, serde_json::json!({ "image": "iVBORw0KGgo=" }));
        } else {
            // bytebotd returns an empty body for action handlers. The manifest
            // must preserve the success status instead of exposing ambiguous "".
            assert_eq!(result, serde_json::json!({ "status": 201, "body": "" }));
        }
    }

    assert_eq!(*observed.lock().await, expected_requests);
    server.abort();
}

async fn bytebot_fixture_action(
    axum::extract::State(observed): axum::extract::State<
        std::sync::Arc<tokio::sync::Mutex<Vec<Value>>>,
    >,
    axum::Json(body): axum::Json<Value>,
) -> axum::response::Response {
    use axum::{http::StatusCode, response::IntoResponse};

    let action = body["action"].as_str().unwrap_or_default().to_owned();
    observed.lock().await.push(body);
    if action == "screenshot" {
        (
            StatusCode::CREATED,
            axum::Json(serde_json::json!({ "image": "iVBORw0KGgo=" })),
        )
            .into_response()
    } else if [
        "click_mouse",
        "type_text",
        "type_keys",
        "scroll",
        "application",
    ]
    .contains(&action.as_str())
    {
        StatusCode::CREATED.into_response()
    } else {
        (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({ "error": "unknown action" })),
        )
            .into_response()
    }
}

/// The three Mem0 tools are declarative HTTP runnables, so their production
/// behavior is the manifest config plus Core's shared REST dispatcher. Keep
/// this fixture loopback-only and execute the shipped configs after replacing
/// only the upstream origin; the secret template is resolved through Core's
/// actual resolver separately because Core correctly forbids secret headers
/// on the fixture's plain-HTTP loopback connection.
#[tokio::test]
async fn mem0_manifest_tools_reach_the_http_runtime_with_expected_payloads() {
    use axum::{
        routing::{delete, post},
        Router,
    };
    use std::sync::Arc;

    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let _env = CmdEnvGuard::armed();
    let _mem0_key = EnvOverride::set("RYU_MEM0_API_KEY", "mem0-local-fixture-key");

    const MEM0_MANIFEST: &str =
        include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/mem0/manifest.json");
    let manifest: Value = serde_json::from_str(MEM0_MANIFEST).unwrap();
    let observed = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind deterministic local Mem0 fixture");
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/v3/memories/search/", post(mem0_fixture_request))
        .route("/v3/memories/add/", post(mem0_fixture_request))
        .route("/v1/memories/:memory_id/", delete(mem0_fixture_request))
        .with_state(observed.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve deterministic local Mem0 fixture");
    });

    for runnable in manifest["runnables"].as_array().unwrap() {
        let slug = runnable["config"]["slug"].as_str().unwrap();
        let mem0_key_source = runnable["config"]["secret_headers"]["Authorization"]
            .as_str()
            .unwrap_or_else(|| panic!("{slug} has no Authorization secret source"));
        assert_eq!(
            resolve_secret_header_source("Authorization", mem0_key_source, "@ryu/mem0", &[], None,)
                .await
                .unwrap()
                .as_deref(),
            Some("Token mem0-local-fixture-key"),
            "{slug} resolves the manifest Token scheme and env secret through Core"
        );
    }

    let local_grants = grants(&["tool:http-egress:127.0.0.1"]);

    let search_result = run_mem0_manifest_tool(
        &manifest,
        "mem0.search",
        serde_json::json!({
            "query": "the local fixture query",
            "filters": { "user_id": "ryu-test-user" },
            "top_k": 7,
            "threshold": 0.42,
            "rerank": true,
            "show_expired": true
        }),
        address.port(),
        &local_grants,
    )
    .await;
    let search_result = search_result.expect("Mem0 search reaches the local fixture");
    assert_eq!(
        search_result,
        serde_json::json!({
            "results": [{
                "id": "memory-123",
                "memory": "Ryu fixture memory",
                "score": 0.91
            }]
        }),
        "successful search unwraps Mem0's response body"
    );

    let add_result = run_mem0_manifest_tool(
        &manifest,
        "mem0.add",
        serde_json::json!({
            "messages": [
                { "role": "user", "content": "I prefer a quiet workspace." },
                { "role": "assistant", "content": "I will remember that." }
            ],
            "user_id": "ryu-test-user",
            "infer": false
        }),
        address.port(),
        &local_grants,
    )
    .await;
    let add_result = add_result.expect("Mem0 add reaches the local fixture");
    assert_eq!(
        add_result,
        serde_json::json!({
            "message": "Accepted for processing",
            "status": "PENDING",
            "event_id": "event-fixture-1"
        }),
        "successful add unwraps Mem0's asynchronous acceptance envelope"
    );

    // `memory.sync` deliberately omits `infer` so Mem0 performs extraction.
    // The same runnable must preserve that absence rather than injecting the
    // store-only `infer: false` default from the capability binding.
    let sync_result = run_mem0_manifest_tool(
        &manifest,
        "mem0.add",
        serde_json::json!({
            "messages": [{ "role": "user", "content": "Raw turn for sync." }],
            "user_id": "ryu-test-user"
        }),
        address.port(),
        &local_grants,
    )
    .await;
    let sync_result = sync_result.expect("Mem0 sync-shaped add reaches the local fixture");
    assert_eq!(sync_result["status"], "PENDING");

    let delete_result = run_mem0_manifest_tool(
        &manifest,
        "mem0.delete",
        serde_json::json!({ "memory_id": "memory-123" }),
        address.port(),
        &local_grants,
    )
    .await;
    let delete_result = delete_result.expect("Mem0 delete reaches the local fixture");
    assert_eq!(
        delete_result,
        serde_json::json!({ "status": 204, "body": "" }),
        "void delete response keeps a success status envelope"
    );

    let search_error = run_mem0_manifest_tool(
        &manifest,
        "mem0.search",
        serde_json::json!({
            "query": "fixture-error",
            "filters": { "user_id": "ryu-test-user" }
        }),
        address.port(),
        &local_grants,
    )
    .await;
    let search_error = search_error.expect("Mem0 search error response reaches caller");
    assert_eq!(
        search_error,
        serde_json::json!({ "status": 422, "body": { "error": "invalid fixture query" } }),
        "non-auth HTTP errors keep their status and body even with fail_open"
    );

    let requests = observed.lock().await.clone();
    assert_eq!(requests.len(), 5);
    assert_eq!(requests[0]["method"], "POST");
    assert_eq!(requests[0]["path"], "/v3/memories/search/");
    assert_eq!(
        requests[0]["body"],
        serde_json::json!({
            "query": "the local fixture query",
            "filters": { "user_id": "ryu-test-user" },
            "top_k": 7,
            "threshold": 0.42,
            "rerank": true,
            "show_expired": true
        }),
        "search entity scoping stays nested under filters with options intact"
    );
    assert!(requests[0]["body"].get("user_id").is_none());
    assert_eq!(
        requests[1]["body"],
        serde_json::json!({
            "messages": [
                { "role": "user", "content": "I prefer a quiet workspace." },
                { "role": "assistant", "content": "I will remember that." }
            ],
            "user_id": "ryu-test-user",
            "infer": false
        }),
        "add keeps the entity id top-level and preserves conversation turns and infer"
    );
    assert_eq!(
        requests[2]["body"],
        serde_json::json!({
            "messages": [{ "role": "user", "content": "Raw turn for sync." }],
            "user_id": "ryu-test-user"
        }),
        "sync payload leaves infer absent for Mem0's default extraction behavior"
    );
    assert_eq!(requests[3]["method"], "DELETE");
    assert_eq!(requests[3]["path"], "/v1/memories/memory-123/");
    assert_eq!(requests[3]["body"], serde_json::json!({}));
    assert_eq!(requests[4]["body"]["query"], "fixture-error");
    assert!(
        requests
            .iter()
            .all(|request| request["authorization"].is_null()),
        "the HTTP fixture receives no credentials; secret resolution above is local-only"
    );
    server.abort();
}

async fn mem0_fixture_request(
    axum::extract::State(observed): axum::extract::State<
        std::sync::Arc<tokio::sync::Mutex<Vec<Value>>>,
    >,
    request: axum::http::Request<axum::body::Body>,
) -> axum::response::Response {
    use axum::{http::StatusCode, response::IntoResponse, Json};

    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .expect("read Mem0 fixture request body");
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("Mem0 dispatcher sends JSON")
    };
    let record = serde_json::json!({
        "method": parts.method.as_str(),
        "path": parts.uri.path(),
        "authorization": parts.headers.get("authorization")
            .and_then(|value| value.to_str().ok()),
        "body": body,
    });
    let method = parts.method;
    let path = parts.uri.path().to_owned();
    observed.lock().await.push(record.clone());

    if method == axum::http::Method::DELETE {
        StatusCode::NO_CONTENT.into_response()
    } else if path == "/v3/memories/search/" && record["body"]["query"] == "fixture-error" {
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({ "error": "invalid fixture query" })),
        )
            .into_response()
    } else if path == "/v3/memories/search/" {
        (
            StatusCode::OK,
            Json(serde_json::json!({
                "results": [{
                    "id": "memory-123",
                    "memory": "Ryu fixture memory",
                    "score": 0.91
                }]
            })),
        )
            .into_response()
    } else if path == "/v3/memories/add/" {
        (
            StatusCode::CREATED,
            Json(serde_json::json!({
                "message": "Accepted for processing",
                "status": "PENDING",
                "event_id": "event-fixture-1"
            })),
        )
            .into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "unexpected fixture route" })),
        )
            .into_response()
    }
}

async fn run_mem0_manifest_tool(
    manifest: &Value,
    slug: &str,
    args: Value,
    local_port: u16,
    local_grants: &std::collections::HashSet<String>,
) -> Result<Value, String> {
    let runnable = manifest["runnables"]
        .as_array()
        .and_then(|runnables| {
            runnables
                .iter()
                .find(|runnable| runnable["config"]["slug"] == slug)
        })
        .ok_or_else(|| format!("Mem0 manifest is missing {slug}"))?;
    let config = &runnable["config"];
    let local_origin = format!("http://127.0.0.1:{local_port}");
    let local_url = config["url"]
        .as_str()
        .ok_or_else(|| format!("{slug} has no URL"))?
        .replace("https://api.mem0.ai", &local_origin);
    if !local_url.starts_with(&local_origin) {
        return Err(format!("{slug} URL did not map to the local fixture"));
    }
    let no_body_defaults = Value::Null;
    let body_defaults = config.get("body_defaults").unwrap_or(&no_body_defaults);

    let method = config["method"]
        .as_str()
        .ok_or_else(|| format!("{slug} has no HTTP method"))?;
    let fail_open = config["fail_open"]
        .as_bool()
        .ok_or_else(|| format!("{slug} has no boolean fail_open setting"))?;
    let unwrap_body = config["unwrap_body"]
        .as_bool()
        .ok_or_else(|| format!("{slug} has no boolean unwrap_body setting"))?;

    run_http_tool(
        &local_url,
        method,
        args,
        &[],
        &BTreeMap::new(),
        fail_open,
        unwrap_body,
        body_defaults,
        local_grants,
        &[],
        "@ryu/mem0",
        None,
    )
    .await
}

#[test]
fn http_unavailable_shape() {
    let v = http_unavailable("nope");
    assert_eq!(v["available"], false);
    assert_eq!(v["reason"], "nope");
    assert!(v["hint"].is_string());
}

#[tokio::test]
async fn resolve_secret_header_source_env_and_unsupported() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    std::env::set_var("RYU_TEST_SECRET_TOK", "Bearer topsecret");
    // env: source resolves without the model supplying anything.
    let v = resolve_secret_header_source(
        "Authorization",
        "env:RYU_TEST_SECRET_TOK",
        SECRET_HEADER_TEST_PLUGIN,
        &[],
        None,
    )
    .await
    .unwrap();
    assert_eq!(v.as_deref(), Some("Bearer topsecret"));
    // A missing env var resolves to "absent" (header omitted), NOT an error.
    let none = resolve_secret_header_source(
        "X",
        "env:RYU_TEST_MISSING_XYZ",
        SECRET_HEADER_TEST_PLUGIN,
        &[],
        None,
    )
    .await
    .unwrap();
    assert!(none.is_none());
    // An unsupported prefix is a hard error (never a silent skip).
    assert!(
        resolve_secret_header_source("X", "foo:bar", SECRET_HEADER_TEST_PLUGIN, &[], None)
            .await
            .is_err()
    );
    std::env::remove_var("RYU_TEST_SECRET_TOK");
}

#[test]
fn resume_decision_parses_enum() {
    assert_eq!(
        ResumeDecision::parse("accept"),
        Some(ResumeDecision::Accept)
    );
    assert_eq!(
        ResumeDecision::parse("decline"),
        Some(ResumeDecision::Decline)
    );
    assert_eq!(
        ResumeDecision::parse("cancel"),
        Some(ResumeDecision::Cancel)
    );
    assert_eq!(ResumeDecision::parse("bogus"), None);
    assert_eq!(ResumeDecision::parse(""), None);
}

#[test]
fn exec_outcome_completed_serializes_flat() {
    let out = ExecOutcome::Completed {
        result: Some(serde_json::json!(42)),
        logs: vec!["hi".into()],
        is_error: false,
        error: None,
    };
    let v = serde_json::to_value(&out).unwrap();
    assert_eq!(v["status"], "completed");
    assert_eq!(v["result"], 42);
    assert_eq!(v["logs"][0], "hi");
    assert_eq!(v["is_error"], false);
    // `error: None` is skipped.
    assert!(v.get("error").is_none());
}

#[test]
fn exec_outcome_paused_serializes_flat() {
    let out = ExecOutcome::Paused {
        execution_id: "exec_1".into(),
        message: "connect github".into(),
        elicitation: Elicitation {
            kind: "url".into(),
            message: "connect github".into(),
            url: Some("https://x".into()),
            requested_schema: None,
        },
    };
    let v = serde_json::to_value(&out).unwrap();
    assert_eq!(v["status"], "paused");
    assert_eq!(v["execution_id"], "exec_1");
    assert_eq!(v["elicitation"]["kind"], "url");
    assert_eq!(v["elicitation"]["url"], "https://x");
    // requested_schema is skipped when None.
    assert!(v["elicitation"].get("requested_schema").is_none());
}

#[tokio::test]
async fn resume_execution_rejects_bad_action() {
    // The Contract-4 shim parses `action: String`; a bad action is a
    // terminal error completion (not a panic, not a silent success).
    let out = resume_execution(
        "exec_x".into(),
        "ryu",
        "bogus".into(),
        serde_json::json!({}),
    )
    .await;
    match out {
        ExecOutcome::Completed {
            is_error, error, ..
        } => {
            assert!(is_error);
            assert!(error.unwrap_or_default().contains("invalid resume action"));
        }
        ExecOutcome::Paused { .. } => panic!("expected error completion"),
    }
}

#[tokio::test]
async fn resume_execution_unknown_id_is_error_completion() {
    // A valid action but unknown id → the shim maps None → execution_not_found.
    // The resume now runs a fail-closed gateway budget pre-gate (security M1).
    // To exercise the id-lookup path (not a budget deny), point the gate at a
    // guaranteed-unreachable gateway and enable the unreachable→allow
    // fallback (deterministic regardless of any gateway running locally); the
    // gate's deny behavior is covered by the gateway module's own tests.
    // These are process-global vars other modules' tests also mutate, so hold
    // the shared gateway-env lock across the whole body and restore on exit —
    // otherwise a parallel test can strip RYU_ALLOW_GATEWAY_FALLBACK during
    // the await and flip this into a fail-closed deny.
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let prev_url = std::env::var("RYU_GATEWAY_URL").ok();
    let prev_fb = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK").ok();
    std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
    std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", "1");
    let out = resume_execution(
        "exec_does_not_exist".into(),
        "ryu",
        "accept".into(),
        serde_json::json!({}),
    )
    .await;
    match prev_url {
        Some(v) => std::env::set_var("RYU_GATEWAY_URL", v),
        None => std::env::remove_var("RYU_GATEWAY_URL"),
    }
    match prev_fb {
        Some(v) => std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", v),
        None => std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK"),
    }
    match out {
        ExecOutcome::Completed {
            is_error, error, ..
        } => {
            assert!(is_error);
            assert_eq!(error.as_deref(), Some("execution_not_found"));
        }
        ExecOutcome::Paused { .. } => panic!("expected error completion"),
    }
}

#[test]
fn allowlist_rejects_missing_agent_id() {
    let reg = AcpAgentRegistry::new();
    assert!(resolve_agent_allowlist(&reg, None).is_err());
    assert!(resolve_agent_allowlist(&reg, Some("")).is_err());
}

#[test]
fn allowlist_rejects_unknown_agent() {
    let reg = AcpAgentRegistry::new();
    let err = resolve_agent_allowlist(&reg, Some("does-not-exist-xyz")).unwrap_err();
    assert!(err.contains("unknown agent"));
}

#[test]
fn allowlist_accepts_flagship_ryu_with_no_restriction() {
    // Ensure no env allowlist leaks in from the environment.
    std::env::remove_var("RYU_MCP_ALLOWLIST");
    std::env::remove_var("RYU_MCP_ALLOWLIST_RYU");
    let reg = AcpAgentRegistry::new();
    // Policy (a): the flagship default agent has no restriction (None) so
    // tool_search → execute does not 403 the demo.
    let resolved = resolve_agent_allowlist(&reg, Some("ryu")).expect("ryu is a known agent");
    assert!(
        resolved.is_none(),
        "flagship ryu must default to no restriction"
    );
}

#[test]
fn allowlist_rejects_an_agent_id_that_only_prefix_matches() {
    let reg = AcpAgentRegistry::new();
    let err = resolve_agent_allowlist(&reg, Some("ryu-forged"))
        .expect_err("authorization must require the exact registered principal");
    assert!(err.contains("unknown agent"));
}

#[test]
fn ssrf_guard_classifies_internal_addresses() {
    use std::net::IpAddr;
    for s in [
        "127.0.0.1",
        "10.1.2.3",
        "192.168.0.5",
        "172.16.9.9",
        "169.254.169.254", // cloud metadata
        "100.64.0.1",      // CGNAT
        "0.0.0.0",
        "::1",
        "fe80::1",
        "fc00::1",
        "::ffff:127.0.0.1", // v4-mapped loopback
    ] {
        assert!(
            is_internal_ip(&s.parse::<IpAddr>().unwrap()),
            "{s} must be classified internal"
        );
    }
    for s in ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1::1"] {
        assert!(
            !is_internal_ip(&s.parse::<IpAddr>().unwrap()),
            "{s} must be classified public"
        );
    }
}

#[tokio::test]
async fn ssrf_guard_blocks_ip_literal_and_exempts_explicit_grant() {
    // A URL whose host is an internal IP literal is blocked when the grant was
    // for a public domain...
    assert!(
        http_ssrf_guard("http://169.254.169.254/latest/meta-data/", "example.com")
            .await
            .is_err()
    );
    // ...but allowed when the plugin explicitly holds a grant for that literal
    // internal host (deliberate, install-validated intent). A deliberate
    // internal grant needs no address pin (there is no attacker-raceable DNS
    // lookup), so the guard returns `None`.
    assert_eq!(
        http_ssrf_guard("http://127.0.0.1:9000/health", "127.0.0.1")
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        http_ssrf_guard("http://localhost:9000/health", "localhost")
            .await
            .unwrap(),
        None
    );
    // A literal public IP in the URL also needs no pin — no DNS lookup happens.
    assert_eq!(
        http_ssrf_guard("http://93.184.216.34/", "example.com")
            .await
            .unwrap(),
        None
    );
}

#[test]
fn guarded_dns_pin_does_not_delegate_resolution_to_ambient_proxy() {
    let proxy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    proxy.set_nonblocking(true).unwrap();
    let url = format!("http://{}", proxy.local_addr().unwrap());
    // Poison only the owned proof subprocess; shared test env stays intact.
    let mut proof = std::process::Command::new(std::env::current_exe().unwrap());
    proof.args([
        "--exact",
        "tool_exec::tests::resolve_to_addrs_pins_connection_and_skips_re_resolution",
        "--test-threads=1",
        "--nocapture",
    ]);
    for name in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        proof.env(name, &url);
    }
    proof.env("NO_PROXY", "").env("no_proxy", "");
    let result = proof.output().expect("start actual guarded-client proof");
    assert!(
        result.status.success(),
        "pinned request failed: {} {}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("1 passed; 0 failed"));
    assert_eq!(
        proxy.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock,
        "a screened request must not connect to the ambient proxy"
    );
}

/// The pin mechanism the guard hands back MUST actually override reqwest's DNS
/// resolution. This is the load-bearing half of the F5 DNS-rebinding fix: the
/// guard screens one set of addresses, and the request has to connect to THOSE,
/// not re-resolve the name to something else. `evil.test` is a reserved,
/// never-resolvable name (RFC 6761), so a request that reaches a listener at all
/// proves reqwest honored the pinned addr instead of resolving the host.
#[tokio::test]
async fn resolve_to_addrs_pins_connection_and_skips_re_resolution() {
    // A local listener standing in for "the address the guard validated".
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local_addr = listener.local_addr().unwrap();
    let port = local_addr.port();

    // Accept exactly one connection and answer with a minimal HTTP/1.1 200.
    let server = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut head = Vec::new();
        while !head.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            let mut buf = [0u8; 1024];
            let count = tokio::time::timeout(
                std::time::Duration::from_secs(3),
                tokio::io::AsyncReadExt::read(&mut sock, &mut buf),
            )
            .await
            .expect("request headers must arrive")
            .unwrap();
            assert!(count > 0, "request cannot close before its headers");
            head.extend_from_slice(&buf[..count]);
            assert!(head.len() <= 8192, "bounded proof request headers");
        }
        let request = String::from_utf8_lossy(&head);
        assert!(request.starts_with("GET / HTTP/1.1\r\n"));
        assert!(request
            .to_ascii_lowercase()
            .contains(&format!("host: evil.test:{port}\r\n")));
        tokio::io::AsyncWriteExt::write_all(
            &mut sock,
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
        )
        .await
        .unwrap();
    });

    // Pin the un-resolvable `evil.test` to the local listener, exactly as
    // `run_http_tool` does with the guard's `Some((host, addrs))`.
    let pin = ("evil.test".to_owned(), vec![local_addr]);
    let client = guarded_http_client(Some(&pin)).unwrap();

    let resp = client
        .get(format!("http://evil.test:{port}/"))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .expect("request must reach the pinned listener, not re-resolve evil.test");
    assert_eq!(resp.status().as_u16(), 200);
    assert_eq!(resp.text().await.unwrap(), "ok");
    tokio::time::timeout(std::time::Duration::from_secs(5), server)
        .await
        .expect("the validated listener must receive the request")
        .unwrap();
}

// ── `secret_headers` value-TEMPLATE resolution ───────────────────────────

/// The plugin id every template-grammar test resolves under. A COMPILED-IN id,
/// so `may_read_env_secret` is unrestricted and these tests keep exercising the
/// template grammar (literal text, multi-token, absent → omit) rather than the
/// env-namespace gate, which has its own tests below.
const SECRET_HEADER_TEST_PLUGIN: &str = "@ryu/shadow";

#[tokio::test]
async fn secret_header_bearer_scheme_substitutes_env_token() {
    // "Bearer env:X" → "Bearer <resolved>": the scheme prefix is literal text
    // preserved around the substituted token (the exa 401 fix).
    std::env::set_var("RYU_HDR_TEST_BEARER", "sk-abc123");
    let out = resolve_secret_header_source(
        "Authorization",
        "Bearer env:RYU_HDR_TEST_BEARER",
        SECRET_HEADER_TEST_PLUGIN,
        &[],
        None,
    )
    .await
    .expect("valid template resolves");
    assert_eq!(out.as_deref(), Some("Bearer sk-abc123"));
    std::env::remove_var("RYU_HDR_TEST_BEARER");
}

#[tokio::test]
async fn secret_header_multi_token_substitution() {
    // Multiple tokens in one value each resolve; literal separators survive.
    std::env::set_var("RYU_HDR_TEST_ID", "id-9");
    std::env::set_var("RYU_HDR_TEST_SECRET", "shh");
    let out = resolve_secret_header_source(
        "X-Auth",
        "Token env:RYU_HDR_TEST_ID env:RYU_HDR_TEST_SECRET",
        SECRET_HEADER_TEST_PLUGIN,
        &[],
        None,
    )
    .await
    .expect("multi-token template resolves");
    assert_eq!(out.as_deref(), Some("Token id-9 shh"));
    std::env::remove_var("RYU_HDR_TEST_ID");
    std::env::remove_var("RYU_HDR_TEST_SECRET");
}

#[tokio::test]
async fn secret_header_whole_value_backcompat() {
    // The degenerate whole-value `env:NAME` still yields the bare secret.
    std::env::set_var("RYU_HDR_TEST_WHOLE", "bare-value");
    let out = resolve_secret_header_source(
        "X-Api-Key",
        "env:RYU_HDR_TEST_WHOLE",
        SECRET_HEADER_TEST_PLUGIN,
        &[],
        None,
    )
    .await
    .expect("whole-value template resolves");
    assert_eq!(out.as_deref(), Some("bare-value"));
    std::env::remove_var("RYU_HDR_TEST_WHOLE");
}

#[tokio::test]
async fn secret_header_missing_env_omits_header() {
    // An unset env token → the WHOLE header is omitted (Ok(None)), which with
    // fail_open + a downstream 401 reproduces the exa missing-key path.
    std::env::remove_var("RYU_HDR_TEST_UNSET");
    let out = resolve_secret_header_source(
        "Authorization",
        "Bearer env:RYU_HDR_TEST_UNSET",
        SECRET_HEADER_TEST_PLUGIN,
        &[],
        None,
    )
    .await
    .expect("missing env is a soft omit, not an Err");
    assert_eq!(out, None);
}

#[tokio::test]
async fn secret_header_no_token_is_rejected() {
    // A value carrying no `env:`/`vault:` token at all is an unsupported
    // source (never a silent skip) — mirrors the command `env:` rejection.
    let err = resolve_secret_header_source(
        "Authorization",
        "Bearer static",
        SECRET_HEADER_TEST_PLUGIN,
        &[],
        None,
    )
    .await
    .expect_err("a token-less value must be rejected");
    assert!(err.contains("unsupported secret source"), "got: {err}");
}

// ── `env:` secret-header namespace gate ──────────────────────────────────

/// Serializes the tests that mutate process-global env vars. Reuses the SAME
/// guard the rest of this module already takes (`lock_gateway_env`) rather than
/// a private mutex — two independent locks would not serialize against each
/// other, and `RYU_RTK_BIN` in particular is set by both the built-in-seed test
/// and the PATH-shadowing test below.
fn lock_env_secret() -> std::sync::MutexGuard<'static, ()> {
    crate::sidecar::gateway::lock_gateway_env()
}

/// A Community-tier manifest naming an unrelated credential var must resolve to
/// "absent" — the header is omitted rather than shipped. `secret_headers` values
/// are excluded from the firewall/DLP scan and the audit trail by design, so an
/// unrestricted `env:` read would be an invisible credential transfer to
/// whatever URL the same manifest names.
#[tokio::test]
async fn community_plugin_cannot_read_an_unrelated_env_secret() {
    let _lock = lock_env_secret();
    std::env::set_var("ANTHROPIC_API_KEY", "sk-ant-victim");
    std::env::remove_var(ENV_SECRET_ALLOWLIST);

    let out =
        resolve_secret_header_source("X-K", "env:ANTHROPIC_API_KEY", "com.evil.plugin", &[], None)
            .await
            .expect("an ungated var is a soft omit, not an Err");
    assert_eq!(
        out, None,
        "a Community plugin must not read a credential outside its own namespace"
    );

    std::env::remove_var("ANTHROPIC_API_KEY");
}

/// A third-party plugin's OWN `RYU_PLUGIN_<UPPER(id)>_*` namespace resolves with
/// no operator configuration at all — the BYOK seam still works, it just lives
/// in a namespace Core does not use for its own configuration.
#[tokio::test]
async fn community_plugin_reads_its_own_prefixed_env_secret() {
    let _lock = lock_env_secret();
    std::env::set_var("RYU_PLUGIN_COM_X2E_ACME_X2E_WEATHER_API_KEY", "acme-key");
    std::env::remove_var(ENV_SECRET_ALLOWLIST);

    let out = resolve_secret_header_source(
        "Authorization",
        "Bearer env:RYU_PLUGIN_COM_X2E_ACME_X2E_WEATHER_API_KEY",
        "com.acme.weather",
        &[],
        None,
    )
    .await
    .expect("own-namespace var resolves");
    assert_eq!(out.as_deref(), Some("Bearer acme-key"));

    std::env::remove_var("RYU_PLUGIN_COM_X2E_ACME_X2E_WEATHER_API_KEY");
}

/// NAMESPACE SQUATTING: plugin ids are free-form (a bare kebab id is legal), so
/// a `RYU_<UPPER(id)>_` prefix would let a plugin name ITSELF after a Core
/// config family and read that family's secrets — id `master` covering
/// `RYU_MASTER_KEY` is the worst case, and `gateway`/`ext`/`github`/
/// `marketplace` are all equally claimable (none is a compiled-in fixture id).
/// The prefix must therefore live under `RYU_PLUGIN_`, which Core never uses for
/// its own configuration.
#[test]
fn a_plugin_cannot_squat_a_core_env_namespace_by_choosing_its_id() {
    for (squatter_id, core_var) in [
        ("master", "RYU_MASTER_KEY"),
        ("gateway", "RYU_GATEWAY_TOKEN"),
        ("gateway", "RYU_GATEWAY_KEY"),
        ("ext", "RYU_EXT_TOKEN"),
        ("github", "RYU_GITHUB_TOKEN"),
        ("marketplace", "RYU_MARKETPLACE_SIGNING_KEY"),
        ("default-llm", "RYU_DEFAULT_LLM_API_KEY"),
    ] {
        assert!(
            !crate::plugins::builtins::is_compiled_in_manifest(squatter_id),
            "'{squatter_id}' must be claimable by a disk manifest for this test to mean \
                 anything — if it became a built-in id, pick another squatter"
        );
        assert!(
            !may_read_env_secret(squatter_id, core_var),
            "a plugin calling itself '{squatter_id}' must not reach Core's '{core_var}'"
        );
    }
}

/// The allowlist var is never readable through the gate it configures (a plugin
/// whose id folds to `env` sits exactly on `RYU_PLUGIN_ENV_`).
#[test]
fn the_env_allowlist_var_is_not_itself_plugin_readable() {
    assert!(!may_read_env_secret("env", ENV_SECRET_ALLOWLIST));
}

/// The COMMAND tool's child-env is the crate's SECOND `env:` reader, and the
/// more dangerous one: a header value stays inside a request Core builds, while
/// this hands the raw secret to a spawned child that can do anything with it.
/// It must obey the same namespace gate as `secret_headers` — a disk manifest
/// declaring `{"env": {"KEY": "env:ANTHROPIC_API_KEY"}}` on an allowlisted binary
/// must not read Core's env.
///
/// This spawns a platform-native environment command and reads the child's
/// actual environment rather than asserting `may_read_env_secret` directly.
/// Asserting the predicate would
/// be vacuous: it passes whether or not the spawn path consults it, which is
/// exactly the bug being guarded against (the gate existed for `secret_headers`
/// and this path simply did not call it).
#[tokio::test]
async fn a_command_tools_child_env_obeys_the_same_namespace_gate_as_headers() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let _env = CmdEnvGuard::armed();
    std::env::set_var(ENV_COMMAND_TOOL_ALLOWLIST, test_allowlist_entry("env"));
    let (_script_dir, command_args) = test_command_args("env", &[]);

    let disk_plugin = "evil";
    assert!(
        !crate::plugins::builtins::is_compiled_in_manifest(disk_plugin),
        "'{disk_plugin}' must be a disk-manifest id for this test to mean anything"
    );
    // This models the ACTUAL attack. The child inherits Core's env with
    // `scrub_child_env` applied, which already strips secret-SHAPED keys — so a
    // real secret (ANTHROPIC_API_KEY, RYU_MASTER_KEY, RYU_TOKEN) never rides in
    // by inheritance. The declared `env:` map was the way to put one BACK, under
    // a fresh name the scrubber has no opinion about. So the victim var here must
    // itself be secret-shaped (hence `_TOKEN`): that proves the gate closes the
    // re-introduction path rather than re-proving what the scrubber already does.
    std::env::set_var("RYU_CMD_VICTIM_TOKEN", "victim-secret");
    let mut env_map = BTreeMap::new();
    env_map.insert("STOLEN".to_string(), "env:RYU_CMD_VICTIM_TOKEN".to_string());

    let out = run_command_tool(
        "env",
        &command_args,
        None,
        &env_map,
        None,
        10,
        CommandOutput::Stdout,
        None,
        &BTreeMap::new(),
        serde_json::json!({}),
        &grants(&["tool:command:env"]),
        disk_plugin,
        None,
    )
    .await
    .expect("env runs");
    let stdout = out
        .get("stdout")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    assert!(
        !stdout.contains("victim-secret") && !stdout.contains("STOLEN="),
        "an out-of-namespace env source must never reach the child, got: {stdout}"
    );
    std::env::remove_var("RYU_CMD_VICTIM_TOKEN");
}

/// The operator escape hatch: a var named in `RYU_PLUGIN_ENV_ALLOWLIST` is
/// readable by any plugin, so a deployment can share a credential without
/// handing out a Core-tier id.
#[tokio::test]
async fn operator_allowlist_opens_a_shared_env_secret() {
    let _lock = lock_env_secret();
    std::env::set_var("RYU_SHARED_PROXY_KEY", "shared");
    std::env::set_var(ENV_SECRET_ALLOWLIST, "OTHER_VAR, RYU_SHARED_PROXY_KEY");

    let out = resolve_secret_header_source(
        "X-K",
        "env:RYU_SHARED_PROXY_KEY",
        "com.acme.weather",
        &[],
        None,
    )
    .await
    .expect("allowlisted var resolves");
    assert_eq!(out.as_deref(), Some("shared"));

    std::env::remove_var(ENV_SECRET_ALLOWLIST);
    std::env::remove_var("RYU_SHARED_PROXY_KEY");
}

/// First-party regression: `@ryu/advisor` and `shadow` authenticate to
/// loopback Core with the SHARED `env:RYU_TOKEN`, which by construction fits no
/// per-plugin prefix. Both ship as compiled-in fixtures, so the gate must not
/// touch them — and `@ryu/advisor` is Community-TIER, which is exactly why
/// the gate keys on provenance rather than tier. The live node token wins over
/// the process environment so rotation never races a child spawn.
#[tokio::test]
async fn compiled_in_plugins_still_read_the_shared_ryu_token() {
    let _lock = lock_env_secret();
    std::env::remove_var(ENV_SECRET_ALLOWLIST);
    let expected = crate::node_token::active_token().expect("node token is available");
    let expected_header = format!("Bearer {expected}");

    for plugin_id in ["@ryu/shadow", "@ryu/advisor"] {
        let out = resolve_secret_header_source(
            "Authorization",
            "Bearer env:RYU_TOKEN",
            plugin_id,
            &[],
            None,
        )
        .await
        .expect("core-tier read resolves");
        assert_eq!(
            out.as_deref(),
            Some(expected_header.as_str()),
            "{plugin_id} must keep reading the shared RYU_TOKEN"
        );
    }
}

/// The prefix is a BYOK seam of the same SHAPE first-party manifests author
/// (`exa` reads `env:RYU_EXA_API_KEY`), but rooted one level deeper so it cannot
/// reach into Core's own configuration namespace. `exa` is compiled in and takes
/// the provenance arm at runtime; a third-party plugin authored the same way
/// names its var `RYU_PLUGIN_<ID>_API_KEY` and needs no operator configuration.
#[test]
fn the_prefix_rule_is_rooted_under_the_plugin_namespace() {
    assert_eq!(
        plugin_env_prefix("@ryu/exa"),
        "RYU_PLUGIN__X40_RYU_X2F_EXA_"
    );
    assert!("RYU_PLUGIN__X40_RYU_X2F_EXA_API_KEY".starts_with(&plugin_env_prefix("@ryu/exa")));
    // Crucially NOT Core's own `RYU_EXA_API_KEY` namespace — which `exa` still
    // reads, but by PROVENANCE (it is compiled in), not by prefix. Every in-repo
    // manifest that authors an `env:` secret header (`exa`, `shadow`, `advisor`)
    // is a compiled-in fixture, so narrowing the prefix regresses none of them.
    assert!(!"RYU_EXA_API_KEY".starts_with(&plugin_env_prefix("@ryu/exa")));
    assert!(may_read_env_secret("@ryu/exa", "RYU_EXA_API_KEY"));
    // Every punctuation byte is escaped, so scoped and flat ids cannot
    // collide even when their punctuation would previously fold together.
    assert_eq!(
        plugin_env_prefix("com.acme.my-app"),
        "RYU_PLUGIN_COM_X2E_ACME_X2E_MY_X2D_APP_"
    );
    assert_ne!(plugin_env_prefix("@a/b"), plugin_env_prefix("a-b"));
    // And the rule is a real fence: the shared loopback token fits no prefix.
    assert!(!may_read_env_secret("com.acme.weather", "RYU_TOKEN"));
}

// ── `env:` → encrypted plugin secret store fallback ──────────────────────

/// THE GAP THIS CLOSES: `exa`/`tavily` declare `env:RYU_<X>_API_KEY` and there
/// was no way to set such a var from the UI, so swapping the `web.search`
/// capability to a provider whose key was never exported produced a silently
/// unauthenticated tool. With the store wired, the SAME manifest token resolves
/// from an encrypted row — no manifest edit anywhere.
#[tokio::test]
async fn an_unset_env_var_falls_back_to_the_plugin_secret_store() {
    let _lock = lock_env_secret();
    std::env::remove_var("RYU_TAVILY_API_KEY");
    std::env::remove_var(ENV_SECRET_ALLOWLIST);

    let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
    store
        .set("@ryu/tavily", "RYU_TAVILY_API_KEY", "tvly-from-ui")
        .await
        .unwrap();

    let out = resolve_env_secret_from("@ryu/tavily", "RYU_TAVILY_API_KEY", Some(&store)).await;
    assert_eq!(out, SecretToken::Value("tvly-from-ui".to_string()));

    // With no store published at all, behaviour is exactly the pre-store one.
    assert_eq!(
        resolve_env_secret_from("@ryu/tavily", "RYU_TAVILY_API_KEY", None).await,
        SecretToken::Absent
    );
}

/// Precedence is env-then-store, never the reverse: an operator who exported the
/// var in a service unit must see that value in effect, and must be able to
/// explain the process with `env | grep`. A stale UI entry silently shadowing
/// the deployment's own configuration is the failure this pins.
#[tokio::test]
async fn the_process_environment_wins_over_a_stored_secret() {
    let _lock = lock_env_secret();
    std::env::set_var("RYU_TAVILY_API_KEY", "tvly-from-env");
    std::env::remove_var(ENV_SECRET_ALLOWLIST);

    let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
    store
        .set("@ryu/tavily", "RYU_TAVILY_API_KEY", "tvly-from-ui")
        .await
        .unwrap();

    let out = resolve_env_secret_from("@ryu/tavily", "RYU_TAVILY_API_KEY", Some(&store)).await;
    assert_eq!(out, SecretToken::Value("tvly-from-env".to_string()));

    std::env::remove_var("RYU_TAVILY_API_KEY");
}

#[test]
fn live_node_token_wins_over_the_startup_environment_after_rotation() {
    assert_eq!(
        resolve_process_env_value("RYU_TOKEN", Some("live-token"), Some("startup-token")),
        Some("live-token".to_owned())
    );
    assert_eq!(
        resolve_process_env_value(
            "RYU_TAVILY_API_KEY",
            Some("unrelated-node-token"),
            Some("provider-key")
        ),
        Some("provider-key".to_owned())
    );
}

/// THE LOAD-BEARING GUARD. The store is keyed by the CALLING plugin id, so
/// without the namespace gate a disk manifest could name any variable and read
/// whatever the UI had stored under that name for it — turning a write-only
/// settings field into a credential-harvesting surface. The gate must run BEFORE
/// the fallback, not only before the env read.
///
/// Asserted through `resolve_env_secret_from` (the real path) rather than
/// against `may_read_env_secret` directly: the predicate passes whether or not
/// the fallback consults it, which is exactly the bug being guarded against.
#[tokio::test]
async fn the_namespace_gate_also_guards_the_store_fallback() {
    let _lock = lock_env_secret();
    std::env::remove_var(ENV_SECRET_ALLOWLIST);
    std::env::remove_var("ANTHROPIC_API_KEY");

    let evil = "com.evil.plugin";
    assert!(
        !crate::plugins::builtins::is_compiled_in_manifest(evil),
        "'{evil}' must be a disk-manifest id for this test to mean anything"
    );

    let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
    // The attacker stored a value under its OWN row, using a name outside its
    // namespace. The row exists; the gate is the only thing standing between the
    // manifest token and the value.
    store
        .set(evil, "ANTHROPIC_API_KEY", "stolen-shape")
        .await
        .unwrap();

    assert_eq!(
        resolve_env_secret_from(evil, "ANTHROPIC_API_KEY", Some(&store)).await,
        SecretToken::Absent,
        "a plugin must not reach a stored secret named outside its namespace"
    );
    // Its own namespace still works — the gate is a fence, not a wall.
    store
        .set(evil, "RYU_PLUGIN_COM_X2E_EVIL_X2E_PLUGIN_API_KEY", "mine")
        .await
        .unwrap();
    assert_eq!(
        resolve_env_secret_from(
            evil,
            "RYU_PLUGIN_COM_X2E_EVIL_X2E_PLUGIN_API_KEY",
            Some(&store)
        )
        .await,
        SecretToken::Value("mine".to_string())
    );
}

/// An empty stored value is "absent", matching the env branch's
/// `.filter(|v| !v.is_empty())` — so the whole header is omitted rather than a
/// `Bearer ` with nothing after it being shipped to the provider.
#[tokio::test]
async fn an_empty_stored_secret_resolves_to_absent() {
    let _lock = lock_env_secret();
    std::env::remove_var("RYU_PLUGIN_COM_X2E_ACME_X2E_WEATHER_API_KEY");
    std::env::remove_var(ENV_SECRET_ALLOWLIST);

    let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
    store
        .set(
            "com.acme.weather",
            "RYU_PLUGIN_COM_X2E_ACME_X2E_WEATHER_API_KEY",
            "k",
        )
        .await
        .unwrap();
    // Clearing it through the same API used by `PUT` with a blank body.
    store
        .set(
            "com.acme.weather",
            "RYU_PLUGIN_COM_X2E_ACME_X2E_WEATHER_API_KEY",
            "  ",
        )
        .await
        .unwrap();

    assert_eq!(
        resolve_env_secret_from(
            "com.acme.weather",
            "RYU_PLUGIN_COM_X2E_ACME_X2E_WEATHER_API_KEY",
            Some(&store)
        )
        .await,
        SecretToken::Absent
    );
}

// ── built-in command-bin allowlist seed ──────────────────────────────────

/// The `rtk` allowlist entry must resolve to an operator-set absolute override
/// or Ryu's own `~/.ryu/bin/rtk` — never to a `$PATH` walk. `parse_command_allowlist`
/// documents "never a PATH-relative name an attacker could shadow" and enforces
/// it for env-supplied entries; the built-in seed feeds the same allowlist, so a
/// writable directory early on Core's PATH must not be able to plant the bin the
/// model can then invoke.
#[test]
fn rtk_builtin_bin_never_resolves_through_path() {
    let _lock = lock_env_secret();

    let planted_dir = std::env::temp_dir().join(format!("ryu-rtk-shadow-{}", std::process::id()));
    std::fs::create_dir_all(&planted_dir).expect("temp dir");
    let exe = if cfg!(windows) { "rtk.exe" } else { "rtk" };
    let planted = planted_dir.join(exe);
    std::fs::write(&planted, b"#!/bin/sh\n").expect("plant a shadowing rtk");

    let prev_path = std::env::var_os("PATH");
    let prev_bin = std::env::var_os("RYU_RTK_BIN");
    std::env::remove_var("RYU_RTK_BIN");
    std::env::set_var("PATH", &planted_dir);

    let resolved = trusted_builtin_bin_path("rtk").expect("rtk is a known built-in key");

    match prev_path {
        Some(v) => std::env::set_var("PATH", v),
        None => std::env::remove_var("PATH"),
    }
    if let Some(v) = prev_bin {
        std::env::set_var("RYU_RTK_BIN", v);
    }
    let _ = std::fs::remove_dir_all(&planted_dir);

    assert_ne!(
        resolved, planted,
        "a PATH-planted rtk must never become the allowlisted binary"
    );
    assert_eq!(
        resolved,
        crate::paths::bin_dir().join("rtk"),
        "rtk must fall back to Ryu's own bin dir, like spider"
    );
}

/// The operator override still wins, and `spider`'s arm is untouched.
#[test]
fn builtin_bin_env_overrides_still_win() {
    let _lock = lock_env_secret();

    let prev = std::env::var_os("RYU_RTK_BIN");
    let abs = if cfg!(windows) {
        "C:\\ops\\rtk.exe"
    } else {
        "/opt/ops/rtk"
    };
    std::env::set_var("RYU_RTK_BIN", abs);
    let resolved = trusted_builtin_bin_path("rtk").expect("rtk key");
    match prev {
        Some(v) => std::env::set_var("RYU_RTK_BIN", v),
        None => std::env::remove_var("RYU_RTK_BIN"),
    }
    assert_eq!(resolved, std::path::PathBuf::from(abs));
    assert!(trusted_builtin_bin_path("nope").is_none());
}

// ── command SUCCESS merges child stderr into the text output ──────────────

#[tokio::test]
async fn command_tool_success_merges_stderr_into_output() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let _env = CmdEnvGuard::armed();
    std::env::set_var(ENV_COMMAND_TOOL_ALLOWLIST, test_allowlist_entry("sh"));
    let (_script_dir, command_args) = test_command_args("sh", &[]);
    let out = run_command_tool(
        "sh",
        &command_args,
        None,
        &BTreeMap::new(),
        None,
        10,
        CommandOutput::Stdout,
        None,
        &BTreeMap::new(),
        serde_json::json!({}),
        &grants(&["tool:command:sh"]),
        "com.test.cmd",
        None,
    )
    .await
    .expect("sh runs");
    assert_eq!(out.get("exit_code").and_then(Value::as_i64), Some(0));
    let stdout = out
        .get("stdout")
        .and_then(Value::as_str)
        .unwrap_or_default();
    assert!(
        stdout.contains("the-stdout"),
        "stdout must be present, got: {stdout:?}"
    );
    assert!(
        stdout.contains("the-stderr"),
        "non-empty stderr must be merged into the output, got: {stdout:?}"
    );
}

/// The BYOK providers the layer feature ships MUST pass the namespace gate, or
/// the settings panel renders "Stored, but this plugin is not allowed to read
/// this name" on the one feature added to make them configurable.
///
/// They pass by PROVENANCE, not tier: both are Community-tier yet compiled into
/// the binary, and `is_compiled_in_manifest` is what the gate consults. A future
/// change that moved either out of `BUILTIN_MANIFESTS` would silently break BYOK
/// for it, which is what this pins.
#[test]
fn the_shipped_byok_providers_may_read_their_own_keys() {
    assert!(may_read_env_secret("@ryu/tavily", "RYU_TAVILY_API_KEY"));
    assert!(may_read_env_secret("@ryu/exa", "RYU_EXA_API_KEY"));
    // And the gate still holds sideways: one plugin cannot read another's key by
    // simply naming it.
    assert!(!may_read_env_secret(
        "acme-thirdparty",
        "RYU_TAVILY_API_KEY"
    ));
}

/// `core:` must resolve to the ACTIVE profile's Core port, never a hardcoded
/// 7980. The bug this pins: under the `dev` profile (what `bun dev` runs) Core
/// binds 8980, so a hardcoded manifest url reached nothing — or reached a
/// release-profile Core running alongside it, crossing two profiles' data.
#[test]
fn the_core_scheme_resolves_to_this_profiles_loopback_port() {
    // Only the PORT is taken from RYU_BIND; a node bound to 0.0.0.0 is still
    // dialled on loopback, because `http://0.0.0.0/...` is not a route.
    // Only the PORT is taken from RYU_BIND; a node bound to 0.0.0.0 is still
    // dialled on loopback, because `http://0.0.0.0/...` is not a route.
    assert_eq!(core_port_from_bind(Some("0.0.0.0:8980")), 8980);
    assert_eq!(core_port_from_bind(Some("127.0.0.1:7980")), 7980);
    // Absent / malformed falls back through the ONE offset source.
    assert_eq!(
        core_port_from_bind(None),
        crate::profile::port(CORE_BASE_PORT)
    );
    assert_eq!(
        core_port_from_bind(Some("not-a-bind")),
        crate::profile::port(CORE_BASE_PORT)
    );

    let origin = "http://127.0.0.1:8980";
    assert_eq!(
        resolve_core_url_with("core:/api/shadow/search", origin),
        "http://127.0.0.1:8980/api/shadow/search"
    );
    // A leading slash is optional in the manifest and never doubles up.
    assert_eq!(
        resolve_core_url_with("core:api/memory", origin),
        "http://127.0.0.1:8980/api/memory"
    );
}

#[test]
fn a_non_core_url_is_returned_untouched() {
    // The scheme is opt-in: every external provider url must pass through byte
    // for byte, or the egress guard would screen something other than what is
    // dialled.
    for url in [
        "https://api.exa.ai/search",
        "https://api.tavily.com/extract",
        "http://127.0.0.1:9999/whatever",
    ] {
        assert_eq!(resolve_core_url(url), url);
        assert_eq!(resolve_core_url_with(url, "http://127.0.0.1:8980"), url);
    }
}

#[test]
fn node_tokens_are_only_allowed_on_loopback_core_port() {
    assert!(node_token_target_is_local_core(&format!(
        "http://127.0.0.1:{}/api/ext/core",
        core_port_from_bind(None)
    )));
    assert!(!node_token_target_is_local_core("https://example.test/api"));
    assert!(!node_token_target_is_local_core(
        "http://127.0.0.1:9999/api"
    ));
}

#[test]
fn local_core_http_secret_exception_only_allows_the_node_token() {
    let node_token = std::collections::BTreeMap::from([(
        "Authorization".to_owned(),
        "Bearer env:RYU_TOKEN".to_owned(),
    )]);
    assert!(secret_headers_use_only_node_token(&node_token));

    let provider_key = std::collections::BTreeMap::from([(
        "X-API-KEY".to_owned(),
        "env:PROVIDER_API_KEY".to_owned(),
    )]);
    assert!(!secret_headers_use_only_node_token(&provider_key));

    let mixed_secrets = std::collections::BTreeMap::from([
        (
            "Authorization".to_owned(),
            "Bearer env:RYU_TOKEN".to_owned(),
        ),
        ("X-API-KEY".to_owned(), "vault:provider-key".to_owned()),
    ]);
    assert!(!secret_headers_use_only_node_token(&mixed_secrets));
    assert!(!secret_headers_use_only_node_token(
        &std::collections::BTreeMap::new()
    ));
}

/// Every shipped manifest that addresses Core must use `core:`, or it silently
/// breaks on a non-release profile. Guards the migration from regressing.
#[test]
fn no_shipped_manifest_hardcodes_cores_port() {
    for manifest in crate::plugin_manifest::PluginManifestLoader::load_builtins() {
        for entry in &manifest.runnables {
            let Some(cfg) = entry.config.as_ref() else {
                continue;
            };
            let raw = cfg.to_string();
            assert!(
                !raw.contains("127.0.0.1:7980"),
                "manifest '{}' hardcodes Core's release port; use the core: scheme \
                     so it resolves per profile",
                manifest.id
            );
        }
    }
}
