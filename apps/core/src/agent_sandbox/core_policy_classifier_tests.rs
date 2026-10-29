//! Fail-closed Codex classification for launch shapes whose commands are not
//! written out in the declaration: shell script files and standard input,
//! package.json scripts, `env -S` strings, PowerShell `-EncodedCommand`, and
//! shell functions, aliases, compound commands and command substitution.
//!
//! Every case drives the shipping classifier ([`is_codex_stdio`]) and the
//! consumer that acts on it ([`confine_codex_stdio`]): a launch that may start
//! Codex must come back wrapped in Ryu's OS runner with its exact original
//! command line, and a launch that cannot start Codex must come back unchanged.

use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};

fn declared(command: &str, args: &[&str]) -> McpServerStdio {
    McpServerStdio::new("agent", command)
        .args(args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>())
}

/// PowerShell's `-EncodedCommand` form: Base64 of the UTF-16LE script.
fn encoded(script: &str) -> String {
    let bytes = script
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    STANDARD.encode(bytes)
}

/// The launch reaches Codex: classified, and wrapped in the runner on hosts
/// that have one (Windows refuses it through the same classification).
#[track_caller]
fn assert_confined(stdio: McpServerStdio) {
    let label = format!("{} {:?}", stdio.command.display(), stdio.args);
    assert!(
        is_codex_stdio(&stdio),
        "{label} may start Codex and must be confined"
    );
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let original_command = stdio.command.to_string_lossy().into_owned();
        let original_args = stdio.args.clone();
        let confined = confine_codex_stdio(stdio).expect("supported host runner");
        assert_eq!(
            confined.command,
            std::env::current_exe().expect("current executable"),
            "{label} escaped the runner"
        );
        let mut expected = vec![
            AGENT_SANDBOX_RUNNER_ARG.to_owned(),
            ARG_SEPARATOR.to_owned(),
            original_command,
        ];
        expected.extend(original_args);
        assert_eq!(confined.args, expected, "{label} lost its command line");
    }
}

/// The launch cannot start Codex: unclassified and spawned exactly as declared.
#[track_caller]
fn assert_unconfined(stdio: McpServerStdio) {
    let label = format!("{} {:?}", stdio.command.display(), stdio.args);
    assert!(!is_codex_stdio(&stdio), "{label} does not start Codex");
    let confined = confine_codex_stdio(stdio.clone()).expect("non-Codex launch unchanged");
    assert_eq!(confined.command, stdio.command, "{label}");
    assert_eq!(confined.args, stdio.args, "{label}");
}

mod launchers_and_interpreters;
mod quoted_data;
mod script_package_env_and_powershell;
mod settings_guard_and_wrappers;
mod shell_functions_and_compounds;
