use super::*;
use crate::win_process::NoWindow;

fn stdio(command: &str, args: &[&str]) -> McpServerStdio {
    McpServerStdio::new("agent", PathBuf::from(command))
        .args(args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>())
}

fn from_spawn(spawn_cmd: &str) -> McpServerStdio {
    use std::str::FromStr as _;
    match crate::sidecar::adapters::acp_spawn::AcpSpawn::from_str(spawn_cmd)
        .unwrap()
        .into_server()
    {
        agent_client_protocol::schema::v1::McpServer::Stdio(stdio) => stdio,
        _ => panic!("stdio"),
    }
}

mod codex;
mod installer;
mod parse;
mod rewrite;

fn fake_install(root: &Path, spec: &str, stamp: u64, bin_field: serde_json::Value, bin_file: &str) {
    let name = package_name(spec).unwrap();
    let spec_dir = root.join(spec_key(spec));
    let package_dir = name.split('/').fold(
        spec_dir.join(stamp.to_string()).join("node_modules"),
        |dir, part| dir.join(part),
    );
    std::fs::create_dir_all(package_dir.join(bin_file).parent().unwrap()).unwrap();
    std::fs::write(
        package_dir.join("package.json"),
        serde_json::json!({ "name": name, "bin": bin_field }).to_string(),
    )
    .unwrap();
    std::fs::write(package_dir.join(bin_file), "#!/usr/bin/env node\n").unwrap();
    std::fs::write(spec_dir.join(CURRENT_FILE), stamp.to_string()).unwrap();
}

/// Real npm, no network: install a local package through the same path a
/// registry spec takes, then run the resolved bin with node.
#[test]
fn installs_with_npm_and_the_resolved_bin_runs_under_node() {
    let Some(node) = super::super::acp::resolve_in_path("node") else {
        return;
    };
    let source = tempfile::tempdir().unwrap();
    std::fs::write(
        source.path().join("package.json"),
        r#"{"name":"fake-acp","version":"1.0.0","bin":{"fake-acp":"index.js"}}"#,
    )
    .unwrap();
    std::fs::write(
        source.path().join("index.js"),
        "#!/usr/bin/env node\nprocess.stdout.write('fake-acp ' + process.argv.slice(2).join(' '))\n",
    )
    .unwrap();
    let root = tempfile::tempdir().unwrap();
    let spec = format!(
        "fake-acp@file:{}",
        source.path().to_string_lossy().replace('\\', "/")
    );

    let bin = install(root.path(), &spec).expect("npm install");
    let installed = installed_bin(root.path(), &spec).expect("current install");
    assert_eq!(installed.bin, bin);

    let invocation = parse_npx_tokens(&[
        "npx".to_owned(),
        "-y".to_owned(),
        spec.clone(),
        "--acp".to_owned(),
    ])
    .unwrap();
    let stdio = rewrite(
        McpServerStdio::new("agent", PathBuf::from("npx")),
        &invocation,
        &node,
        &installed,
    );
    let output = std::process::Command::new(&stdio.command)
        .args(&stdio.args)
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&output.stdout), "fake-acp --acp");
}

#[test]
fn rewritten_canonical_script_runs_under_node_with_literal_arguments_and_env() {
    let Some(node) = super::super::acp::resolve_in_path("node") else {
        return;
    };
    let root = tempfile::Builder::new()
        .prefix("ACP script spaces ")
        .tempdir()
        .unwrap();
    let script = root.path().join("entry.cjs");
    std::fs::write(
        &script,
        "const fs = require('node:fs'); process.stdout.write(JSON.stringify({ args: process.argv.slice(2), script: fs.realpathSync(process.argv[1]), command: fs.realpathSync(process.env.PI_ACP_PI_COMMAND), literal: process.env.ACP_LITERAL_VALUE }));",
    )
    .unwrap();
    let canonical_script = std::fs::canonicalize(&script).unwrap();
    let literal_value = r"\\?\C:\literal env with spaces & symbols";
    let args = vec![
        "literal & argument".to_owned(),
        r"\\?\C:\literal arg".to_owned(),
    ];
    let invocation = NpxInvocation {
        env: vec![(
            "PI_ACP_PI_COMMAND".to_owned(),
            canonical_script.to_string_lossy().into_owned(),
        )],
        spec: "fixture-acp".to_owned(),
        args: args.clone(),
    };
    let original = McpServerStdio::new("agent", PathBuf::from("npx"))
        .env(vec![EnvVariable::new("ACP_LITERAL_VALUE", literal_value)]);
    let installed = InstalledBin {
        prefix: std::fs::canonicalize(root.path()).unwrap(),
        bin: canonical_script,
        installed_at: 0,
    };
    let rewritten = rewrite(original, &invocation, &node, &installed);
    assert_eq!(&rewritten.args[1..], args.as_slice());
    let mut command = std::process::Command::new(&rewritten.command);
    command.args(&rewritten.args).no_window();
    for variable in &rewritten.env {
        command.env(&variable.name, &variable.value);
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "Node failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["args"], serde_json::json!(args));
    assert_eq!(result["literal"], literal_value);
    assert!(result["script"].as_str().unwrap().ends_with("entry.cjs"));
    assert_eq!(result["script"], result["command"]);
}
