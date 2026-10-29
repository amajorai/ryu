use std::ffi::OsString;
use std::time::Duration;

use serde_json::json;

use crate::baml::{
    error_message, output_from_response, ryu_client_source, validate_function, validate_source,
};
use crate::placement::{host_rule, opt_in, Placement};
use crate::process::Captured;
use crate::programs::{interpret, invocation, sandbox_script, uses_sorry};
use crate::toolchain::{resolve, resolve_with, Tool};
use crate::{
    clamp_timeout, run_code, CodeLanguage, CodeMode, CodeRequest, LlmRoute, MAX_SOURCE_BYTES,
};

fn captured(exit_code: Option<i32>, stdout: &str, stderr: &str) -> Captured {
    Captured {
        exit_code,
        stdout: stdout.to_string(),
        stderr: stderr.to_string(),
    }
}

fn request<'a>(
    language: CodeLanguage,
    mode: CodeMode,
    source: &'a str,
    input: &'a str,
    args: &'a serde_json::Value,
) -> CodeRequest<'a> {
    CodeRequest {
        language,
        mode,
        source,
        input,
        function: None,
        args,
        timeout: Duration::from_secs(120),
        llm: None,
    }
}

// ── Wire shapes and limits ───────────────────────────────────────────────────

#[test]
fn language_and_mode_use_lowercase_wire_names() {
    assert_eq!(
        serde_json::to_value(CodeLanguage::Lean).unwrap(),
        json!("lean")
    );
    assert_eq!(
        serde_json::to_value(CodeLanguage::Bend).unwrap(),
        json!("bend")
    );
    assert_eq!(
        serde_json::to_value(CodeLanguage::Baml).unwrap(),
        json!("baml")
    );
    assert_eq!(
        serde_json::from_value::<CodeMode>(json!("check")).unwrap(),
        CodeMode::Check
    );
    assert_eq!(CodeMode::default(), CodeMode::Run);
    assert!(serde_json::from_value::<CodeLanguage>(json!("python")).is_err());
}

#[test]
fn timeout_is_clamped_to_the_sandbox_range() {
    assert_eq!(clamp_timeout(Duration::ZERO), Duration::from_secs(1));
    assert_eq!(
        clamp_timeout(Duration::from_secs(45)),
        Duration::from_secs(45)
    );
    assert_eq!(
        clamp_timeout(Duration::from_secs(9_000)),
        Duration::from_secs(300)
    );
}

#[tokio::test]
async fn empty_oversized_and_nul_sources_are_refused_before_anything_runs() {
    let args = serde_json::Value::Null;
    let empty = run_code(&request(
        CodeLanguage::Lean,
        CodeMode::Run,
        "  \n",
        "",
        &args,
    ))
    .await;
    assert_eq!(empty.unwrap_err(), "Lean code step has no source");

    let big = "x".repeat(MAX_SOURCE_BYTES + 1);
    let oversized = run_code(&request(CodeLanguage::Bend, CodeMode::Run, &big, "", &args)).await;
    assert!(oversized.unwrap_err().contains("at most 65536"));

    let nul = run_code(&request(
        CodeLanguage::Lean,
        CodeMode::Run,
        "def main",
        "a\0b",
        &args,
    ))
    .await;
    assert!(nul.unwrap_err().contains("NUL"));
}

// ── Lean / Bend invocation and interpretation ─────────────────────────────────

#[test]
fn invocations_pass_the_input_as_one_argument() {
    let lean = invocation(CodeLanguage::Lean, CodeMode::Run, "{\"a\":1}");
    assert_eq!(lean.file_name, "Main.lean");
    assert_eq!(lean.args, ["--run", "Main.lean", "{\"a\":1}"]);
    assert_eq!(
        invocation(CodeLanguage::Lean, CodeMode::Check, "ignored").args,
        ["Main.lean"]
    );

    let bend = invocation(CodeLanguage::Bend, CodeMode::Run, "--looks-like-a-flag");
    assert_eq!(bend.args, ["main.bend", "--", "--looks-like-a-flag"]);
    assert_eq!(
        invocation(CodeLanguage::Bend, CodeMode::Check, "ignored").args,
        ["main.bend", "--check-only"]
    );
}

#[test]
fn sandbox_script_takes_the_source_as_the_first_positional_argument() {
    let script = sandbox_script(&invocation(CodeLanguage::Lean, CodeMode::Run, "x"));
    assert!(script.starts_with("set -eu\n"));
    assert!(script.contains("printf '%s' \"$1\" > \"$d/Main.lean\"\nshift\n"));
    assert!(script.ends_with("lean \"$@\"\n"));
    // Neither the source nor the input is ever interpolated into the script.
    let with_input = sandbox_script(&invocation(
        CodeLanguage::Bend,
        CodeMode::Run,
        "$(rm -rf /)",
    ));
    assert!(!with_input.contains("rm -rf /"));
}

#[test]
fn run_mode_emits_stdout_without_the_trailing_newline() {
    let ok = captured(Some(0), "42\n", "");
    assert_eq!(
        interpret(CodeLanguage::Lean, CodeMode::Run, &ok, "host").unwrap(),
        "42"
    );

    let failed = captured(Some(1), "SOME PROOFS FAIL\n", "Error: type mismatch");
    let error = interpret(CodeLanguage::Bend, CodeMode::Run, &failed, "host").unwrap_err();
    assert!(error.starts_with("Bend program exited with code 1"));
    assert!(error.contains("type mismatch"));

    let killed = captured(None, "", "");
    let error = interpret(CodeLanguage::Lean, CodeMode::Run, &killed, "host").unwrap_err();
    assert!(error.contains("exited with a signal"));
}

#[test]
fn lean_check_fails_closed_on_sorry_even_when_lean_exits_zero() {
    for warning in [
        "Main.lean:1:8: warning: declaration uses `sorry`",
        "Main.lean:1:8: warning: declaration uses 'sorry'",
    ] {
        assert!(uses_sorry(warning));
        let output = captured(Some(0), warning, "");
        let error = interpret(CodeLanguage::Lean, CodeMode::Check, &output, "host").unwrap_err();
        assert!(error.contains("uses `sorry`"), "{error}");
    }
    let proven = captured(Some(0), "", "");
    let receipt: serde_json::Value = serde_json::from_str(
        &interpret(
            CodeLanguage::Lean,
            CodeMode::Check,
            &proven,
            "sandbox:docker",
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        receipt,
        json!({"language": "lean", "mode": "check", "status": "checked", "runner": "sandbox:docker"})
    );
}

#[test]
fn bend_check_requires_the_all_proofs_marker() {
    let silent = captured(Some(0), "", "");
    assert!(
        interpret(CodeLanguage::Bend, CodeMode::Check, &silent, "host")
            .unwrap_err()
            .contains("ALL PROOFS CHECK")
    );

    let failing = captured(Some(1), "SOME PROOFS FAIL\nError: 2 TODOs found.", "");
    assert!(
        interpret(CodeLanguage::Bend, CodeMode::Check, &failing, "host")
            .unwrap_err()
            .starts_with("Bend rejected the source (code 1)")
    );

    let passing = captured(
        Some(0),
        "ALL PROOFS CHECK\nUse --verdict for mathematical validity.\n",
        "",
    );
    let receipt: serde_json::Value = serde_json::from_str(
        &interpret(CodeLanguage::Bend, CodeMode::Check, &passing, "host").unwrap(),
    )
    .unwrap();
    assert_eq!(receipt["status"], "checked");
    assert!(receipt["diagnostics"]
        .as_str()
        .unwrap()
        .contains("ALL PROOFS CHECK"));
}

// ── Placement ──────────────────────────────────────────────────────────────────

#[test]
fn release_builds_refuse_the_host_unless_the_operator_opts_in() {
    assert!(
        matches!(host_rule("Lean", "wasmtime", false, false), Placement::Refused(reason)
        if reason.contains("RYU_WORKFLOW_ALLOW_UNSANDBOXED_CODE=1") && reason.contains("'wasmtime'"))
    );
    assert!(matches!(
        host_rule("Lean", "wasmtime", true, false),
        Placement::Host
    ));
    assert!(matches!(
        host_rule("Bend", "wasmtime", false, true),
        Placement::Host
    ));
}

#[test]
fn opt_in_accepts_only_the_truthy_set() {
    for value in ["1", "true", "YES", " on "] {
        assert!(opt_in(Some(value)), "{value}");
    }
    for value in ["", "0", "false", "enabled"] {
        assert!(!opt_in(Some(value)), "{value}");
    }
    assert!(!opt_in(None));
}

// ── Toolchain resolution ────────────────────────────────────────────────────────

#[cfg(unix)]
fn fake_executable(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(name);
    std::fs::write(&path, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

#[cfg(unix)]
#[test]
fn toolchain_resolution_prefers_override_then_home_then_path() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let path_dir = root.path().join("path");
    std::fs::create_dir_all(home.join(".elan/bin")).unwrap();
    std::fs::create_dir_all(&path_dir).unwrap();
    let on_path = fake_executable(&path_dir, "lean");
    let path_var = Some(OsString::from(path_dir.as_os_str()));

    let found = resolve_with(Tool::Lean, None, Some(home.clone()), path_var.clone()).unwrap();
    assert_eq!(found, on_path);

    let in_home = fake_executable(&home.join(".elan/bin"), "lean");
    let found = resolve_with(Tool::Lean, None, Some(home.clone()), path_var.clone()).unwrap();
    assert_eq!(found, in_home);

    let pinned = fake_executable(root.path(), "lean-pinned");
    let found = resolve_with(
        Tool::Lean,
        Some(pinned.clone().into_os_string()),
        Some(home),
        path_var,
    )
    .unwrap();
    assert_eq!(found, pinned);
}

#[cfg(unix)]
#[test]
fn toolchain_resolution_explains_how_to_install_a_missing_tool() {
    let root = tempfile::tempdir().unwrap();
    let error = resolve_with(
        Tool::Bend,
        None,
        Some(root.path().into()),
        Some(OsString::new()),
    )
    .unwrap_err();
    assert!(error.contains("`bend` was not found"));
    assert!(error.contains("bend-lang.com/install.sh"));
    assert!(error.contains("RYU_BEND_BIN"));

    let error = resolve_with(
        Tool::Baml,
        Some(root.path().join("missing").into_os_string()),
        None,
        None,
    )
    .unwrap_err();
    assert!(error.starts_with("RYU_BAML_BIN points at"));

    // A non-executable file on PATH is skipped.
    std::fs::write(root.path().join("baml-cli"), "").unwrap();
    assert!(resolve_with(
        Tool::Baml,
        None,
        None,
        Some(OsString::from(root.path().as_os_str()))
    )
    .is_err());
}

// ── BAML source policy and responses ─────────────────────────────────────────────

#[test]
fn baml_sources_cannot_declare_their_own_clients() {
    let named = "client<llm> Mine {\n  provider openai\n}\n";
    assert!(validate_source(named)
        .unwrap_err()
        .contains("cannot declare model clients"));
    let spaced = "client < llm > Mine {}";
    assert!(validate_source(spaced).is_err());
    let shorthand = "function F() -> string {\n  client \"openai/gpt-4o\"\n  prompt #\"hi\"#\n}";
    assert!(validate_source(shorthand)
        .unwrap_err()
        .contains("shorthand clients"));

    let allowed = "// client<llm> mentioned in a comment\nfunction F(text: string) -> string {\n  client Ryu\n  prompt #\"{{ text }}\"#\n}";
    assert!(validate_source(allowed).is_ok());
}

#[test]
fn baml_client_reads_every_value_from_the_server_environment() {
    let with_key = ryu_client_source(true);
    assert!(with_key.contains("client<llm> Ryu {"));
    assert!(with_key.contains("base_url env.RYU_GATEWAY_BASE_URL"));
    assert!(with_key.contains("api_key env.RYU_GATEWAY_API_KEY"));
    assert!(with_key.contains("model env.RYU_GATEWAY_MODEL"));
    assert!(!ryu_client_source(false).contains("api_key"));
}

#[test]
fn baml_function_names_must_be_identifiers() {
    assert_eq!(
        validate_function(Some(" ExtractResume ")).unwrap(),
        "ExtractResume"
    );
    assert_eq!(validate_function(Some("_f2")).unwrap(), "_f2");
    assert!(validate_function(None)
        .unwrap_err()
        .contains("needs `function`"));
    for bad in ["2fast", "a/b", "../call", "F G"] {
        assert!(validate_function(Some(bad)).is_err(), "{bad}");
    }
}

#[test]
fn baml_responses_become_step_output() {
    assert_eq!(output_from_response("\"plain text\""), "plain text");
    assert_eq!(
        output_from_response("{\n  \"name\": \"Ada\"\n}"),
        "{\"name\":\"Ada\"}"
    );
    assert_eq!(output_from_response("42"), "42");
    assert_eq!(
        error_message(
            "{\"error\":\"invalid_argument\",\"message\":\"Missing required parameter: resume\"}"
        ),
        "Missing required parameter: resume"
    );
    assert_eq!(error_message("not json"), "not json");
}

#[tokio::test]
async fn baml_run_validates_function_args_and_gateway_before_calling() {
    if resolve(Tool::Baml).is_err() {
        eprintln!("skipping: baml-cli is not installed");
        return;
    }
    let source =
        "function Echo(text: string) -> string {\n  client Ryu\n  prompt #\"{{ text }}\"#\n}\n";
    let null = serde_json::Value::Null;
    let mut run = request(CodeLanguage::Baml, CodeMode::Run, source, "", &null);
    run.function = Some("Echo");
    let route = LlmRoute {
        base_url: "http://127.0.0.1:9/v1".into(),
        api_key: None,
        model: "m".into(),
    };
    assert!(run_code(&run).await.unwrap_err().contains("gateway"));
    run.llm = Some(&route);
    assert!(run_code(&run).await.unwrap_err().contains("needs `args`"));
    let list = json!(["x"]);
    run.args = &list;
    assert!(run_code(&run).await.unwrap_err().contains("JSON object"));
}

// ── Real toolchains (skipped when the toolchain is not installed) ───────────────

fn installed(tool: Tool) -> bool {
    let found = resolve(tool).is_ok();
    if !found {
        eprintln!("skipping: {} is not installed", tool.binary());
    }
    found
}

#[tokio::test]
async fn lean_runs_main_with_the_step_input_and_checks_proofs() {
    if !installed(Tool::Lean) {
        return;
    }
    let args = serde_json::Value::Null;
    let program =
        "def main (args : List String) : IO Unit :=\n  IO.println s!\"hello {args.headD \"\"}\"\n";
    let out = run_code(&request(
        CodeLanguage::Lean,
        CodeMode::Run,
        program,
        "{\"n\":1}",
        &args,
    ))
    .await
    .unwrap();
    assert_eq!(out.value, "hello {\"n\":1}");
    assert_eq!(out.runner, "host:unsandboxed");

    let proof = "theorem two : 1 + 1 = 2 := by decide\n";
    let checked = run_code(&request(
        CodeLanguage::Lean,
        CodeMode::Check,
        proof,
        "",
        &args,
    ))
    .await
    .unwrap();
    assert!(checked.value.contains("\"status\":\"checked\""));

    let cheat = "theorem bad : 1 = 2 := by sorry\n";
    let error = run_code(&request(
        CodeLanguage::Lean,
        CodeMode::Check,
        cheat,
        "",
        &args,
    ))
    .await
    .unwrap_err();
    assert!(error.contains("uses `sorry`"), "{error}");

    let wrong = "theorem bad : 1 = 2 := by decide\n";
    let error = run_code(&request(
        CodeLanguage::Lean,
        CodeMode::Check,
        wrong,
        "",
        &args,
    ))
    .await
    .unwrap_err();
    assert!(error.starts_with("Lean rejected the source"), "{error}");
}

#[tokio::test]
async fn bend_runs_main_with_the_step_input_and_checks_laws() {
    if !installed(Tool::Bend) {
        return;
    }
    let args = serde_json::Value::Null;
    let program = "import Base\n\n\
def pick(args: List<String>) -> String:\n  match args:\n    case []:\n      \"none\"\n    case prog <> rest:\n      match rest:\n        case []:\n          \"none\"\n        case input <> more:\n          input\n\n\
def main() -> IO(Unit):\n  do IO<Unit>:\n    args : List<String> <- IO.args()\n    IO.print(\"got \" ++ pick(args))\n";
    let out = run_code(&request(
        CodeLanguage::Bend,
        CodeMode::Run,
        program,
        "--flag-like",
        &args,
    ))
    .await
    .unwrap();
    assert_eq!(out.value, "got --flag-like");

    let law = "import Base\n\n\
law add_zero:\n  for x: Nat\n  {Nat.add(x, 0n) == x : Nat}\n\n\
def add_zero(x):\n  match x:\n    case 0n:\n      {==}\n    case 1n+p:\n      %add_zero(p) : {1n+Nat.add(p, 0n) == 1n+_ : Nat}\n      {==}\n";
    let checked = run_code(&request(
        CodeLanguage::Bend,
        CodeMode::Check,
        law,
        "",
        &args,
    ))
    .await
    .unwrap();
    assert!(checked.value.contains("ALL PROOFS CHECK"));

    let open = law.replace("      {==}\n    case 1n", "      ?TODO\n    case 1n");
    let error = run_code(&request(
        CodeLanguage::Bend,
        CodeMode::Check,
        &open,
        "",
        &args,
    ))
    .await
    .unwrap_err();
    assert!(error.contains("SOME PROOFS FAIL"), "{error}");
}

#[tokio::test]
async fn baml_check_accepts_valid_sources_and_reports_errors() {
    if !installed(Tool::Baml) {
        return;
    }
    let args = serde_json::Value::Null;
    let valid = "class Person {\n  name string\n}\nfunction Extract(text: string) -> Person {\n  client Ryu\n  prompt #\"{{ text }} {{ ctx.output_format }}\"#\n}\n";
    let checked = run_code(&request(
        CodeLanguage::Baml,
        CodeMode::Check,
        valid,
        "",
        &args,
    ))
    .await
    .unwrap();
    assert!(checked.value.contains("\"language\":\"baml\""));

    let invalid =
        "function Extract(text: string) -> Missing {\n  client Ryu\n  prompt #\"x\"#\n}\n";
    let error = run_code(&request(
        CodeLanguage::Baml,
        CodeMode::Check,
        invalid,
        "",
        &args,
    ))
    .await
    .unwrap_err();
    assert!(error.starts_with("BAML rejected the source"), "{error}");
}

/// A one-route OpenAI-compatible stand-in for the Ryu gateway. Returns the
/// bound base URL and a handle yielding each request's `Authorization` header
/// and body.
async fn mock_gateway(
    reply: &'static str,
) -> (String, tokio::task::JoinHandle<Vec<(String, String)>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let handle = tokio::spawn(async move {
        let mut seen = Vec::new();
        let Ok(Ok((mut socket, _))) =
            tokio::time::timeout(Duration::from_secs(60), listener.accept()).await
        else {
            return seen;
        };
        let mut raw = Vec::new();
        let mut buf = [0_u8; 4096];
        loop {
            let read = socket.read(&mut buf).await.unwrap_or(0);
            if read == 0 {
                break;
            }
            raw.extend_from_slice(&buf[..read]);
            let text = String::from_utf8_lossy(&raw).to_string();
            if let Some(split) = text.find("\r\n\r\n") {
                let length = text[..split]
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                if raw.len() >= split + 4 + length {
                    let auth = text[..split]
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("authorization")
                                .then(|| value.trim().to_string())
                        })
                        .unwrap_or_default();
                    seen.push((auth, text[split + 4..].to_string()));
                    break;
                }
            }
        }
        let body = json!({
            "id": "mock", "object": "chat.completion", "created": 0, "model": "mock",
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": reply}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
        })
        .to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = socket.write_all(response.as_bytes()).await;
        seen
    });
    (base, handle)
}

#[tokio::test]
async fn baml_run_calls_the_function_through_the_gateway_route() {
    if !installed(Tool::Baml) {
        return;
    }
    let (base_url, gateway) = mock_gateway("{\"name\": \"Ada\", \"skills\": [\"math\"]}").await;
    let route = LlmRoute {
        base_url,
        api_key: Some("gateway-token".into()),
        model: "ryu-test-model".into(),
    };
    let source = "class Resume {\n  name string\n  skills string[]\n}\n\
function ExtractResume(resume: string) -> Resume {\n  client Ryu\n  prompt #\"Extract: {{ resume }} {{ ctx.output_format }}\"#\n}\n";
    let args = json!({"resume": "Ada Lovelace, mathematician"});
    let mut run = request(CodeLanguage::Baml, CodeMode::Run, source, "", &args);
    run.function = Some("ExtractResume");
    run.llm = Some(&route);
    run.timeout = Duration::from_secs(60);
    let out = run_code(&run).await.unwrap();
    assert_eq!(out.value, "{\"name\":\"Ada\",\"skills\":[\"math\"]}");
    assert_eq!(out.runner, "host:baml");

    let seen = gateway.await.unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].0, "Bearer gateway-token");
    let request_body: serde_json::Value = serde_json::from_str(&seen[0].1).unwrap();
    assert_eq!(request_body["model"], "ryu-test-model");
    assert!(seen[0].1.contains("Ada Lovelace"));
}

#[tokio::test]
async fn a_program_past_its_timeout_is_stopped() {
    if !installed(Tool::Lean) {
        return;
    }
    let args = serde_json::Value::Null;
    let sleeper = "def main : IO Unit := IO.sleep 600000\n";
    let mut run = request(CodeLanguage::Lean, CodeMode::Run, sleeper, "", &args);
    run.timeout = Duration::from_secs(3);
    let started = std::time::Instant::now();
    let error = run_code(&run).await.unwrap_err();
    assert_eq!(error, "Lean exceeded the 3s step timeout");
    assert!(started.elapsed() < Duration::from_secs(20));
}
