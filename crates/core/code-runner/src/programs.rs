//! Lean 4 and Bend 2 programs: write the source into a fresh directory, invoke
//! the toolchain there, and interpret its exit status and output.

use std::time::Duration;

use ryu_sandbox::ExecSpec;
use tokio::process::Command;

use crate::placement::{self, Placement};
use crate::process::{self, Captured};
use crate::toolchain::{self, Tool};
use crate::{check_receipt, clip, CodeLanguage, CodeMode, CodeOutput, CodeRequest};

/// Exit status a POSIX shell reports when the command is not installed.
const EXIT_COMMAND_NOT_FOUND: i32 = 127;
/// Bend's success marker; `bend` prints `SOME PROOFS FAIL` otherwise.
const BEND_PROOFS_CHECK: &str = "ALL PROOFS CHECK";
const ERROR_CLIP: usize = 8192;

/// How one language is invoked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Invocation {
    pub tool: Tool,
    /// File the source is written to, inside the fresh working directory.
    pub file_name: &'static str,
    /// Arguments after the executable.
    pub args: Vec<String>,
}

/// The toolchain invocation for a Lean or Bend step. `input` is passed as one
/// argument; Bend gets a `--` first so an input that starts with `-` is never
/// parsed as a Bend option.
pub(crate) fn invocation(language: CodeLanguage, mode: CodeMode, input: &str) -> Invocation {
    match (language, mode) {
        (CodeLanguage::Lean, CodeMode::Run) => Invocation {
            tool: Tool::Lean,
            file_name: "Main.lean",
            args: vec!["--run".into(), "Main.lean".into(), input.into()],
        },
        (CodeLanguage::Lean, CodeMode::Check) => Invocation {
            tool: Tool::Lean,
            file_name: "Main.lean",
            args: vec!["Main.lean".into()],
        },
        (_, CodeMode::Run) => Invocation {
            tool: Tool::Bend,
            file_name: "main.bend",
            args: vec!["main.bend".into(), "--".into(), input.into()],
        },
        (_, CodeMode::Check) => Invocation {
            tool: Tool::Bend,
            file_name: "main.bend",
            args: vec!["main.bend".into(), "--check-only".into()],
        },
    }
}

/// The `sh -c` script used inside a sandbox: `$1` is the source, the remaining
/// positional parameters are the toolchain arguments.
pub(crate) fn sandbox_script(invocation: &Invocation) -> String {
    format!(
        "set -eu\n\
         d=$(mktemp -d)\n\
         trap 'rm -rf \"$d\"' EXIT\n\
         printf '%s' \"$1\" > \"$d/{file}\"\n\
         shift\n\
         cd \"$d\"\n\
         {tool} \"$@\"\n",
        file = invocation.file_name,
        tool = invocation.tool.binary(),
    )
}

pub(crate) async fn run(
    request: &CodeRequest<'_>,
    timeout: Duration,
) -> Result<CodeOutput, String> {
    let invocation = invocation(request.language, request.mode, request.input);
    let label = request.language.display_name();
    let (captured, runner) = match placement::choose(label).await {
        Placement::Refused(reason) => return Err(reason),
        Placement::Sandbox { sandbox, backend } => {
            let mut args = vec![
                "-c".to_string(),
                sandbox_script(&invocation),
                "sh".to_string(),
                request.source.to_string(),
            ];
            args.extend(invocation.args.iter().cloned());
            let mut spec = ExecSpec::new("sh", args);
            spec.timeout_secs = Some(timeout.as_secs().max(1));
            // The backend enforces the timeout; the outer bound adds slack for
            // container start-up and guarantees the step never hangs past it.
            let exec = tokio::time::timeout(timeout + Duration::from_secs(30), sandbox.exec(spec))
                .await
                .map_err(|_| format!("{label} exceeded the {}s step timeout", timeout.as_secs()))?
                .map_err(|error| format!("{label} sandbox '{backend}' failed: {error}"))?;
            let captured = Captured {
                exit_code: Some(exec.exit_code),
                stdout: String::from_utf8_lossy(&exec.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&exec.stderr).into_owned(),
            };
            if exec.exit_code == EXIT_COMMAND_NOT_FOUND {
                return Err(format!(
                    "the '{backend}' sandbox image has no `{}`; use an image that includes the \
                     {label} toolchain (for docker, set RYU_SANDBOX_DOCKER_IMAGE). {}",
                    invocation.tool.binary(),
                    clip(&captured.combined(), 512)
                ));
            }
            (captured, format!("sandbox:{backend}"))
        }
        Placement::Host => {
            tracing::warn!(
                language = request.language.as_str(),
                "running a workflow code step as a bare host subprocess (NOT sandbox-isolated)"
            );
            let binary = toolchain::resolve(invocation.tool)?;
            let workdir = tempfile::tempdir().map_err(|error| {
                format!("could not create a {label} working directory: {error}")
            })?;
            std::fs::write(workdir.path().join(invocation.file_name), request.source)
                .map_err(|error| format!("could not write the {label} source: {error}"))?;
            let mut command = Command::new(binary);
            command.args(&invocation.args).current_dir(workdir.path());
            process::prepare(
                &mut command,
                process::child_env(&host_extra_env(request.language)),
            );
            let captured = process::run_bounded(command, timeout, label).await?;
            (captured, "host:unsandboxed".to_string())
        }
    };
    let value = interpret(request.language, request.mode, &captured, &runner)?;
    Ok(CodeOutput { value, runner })
}

/// Language-specific variables added to the scrubbed host environment.
fn host_extra_env(language: CodeLanguage) -> Vec<(&'static str, String)> {
    match language {
        // Bend otherwise checks bend-lang.com for updates once a day.
        CodeLanguage::Bend => vec![("BEND_NO_TELEMETRY", "1".to_string())],
        _ => Vec::new(),
    }
}

/// Whether Lean reported a declaration that relies on `sorry`. Lean exits 0 for
/// these, so a check must look at the message itself.
pub(crate) fn uses_sorry(output: &str) -> bool {
    output.contains("declaration uses `sorry`") || output.contains("declaration uses 'sorry'")
}

/// Turn a finished toolchain run into the step output or a step error.
pub(crate) fn interpret(
    language: CodeLanguage,
    mode: CodeMode,
    captured: &Captured,
    runner: &str,
) -> Result<String, String> {
    let label = language.display_name();
    let combined = captured.combined();
    let succeeded = captured.exit_code == Some(0);
    let exit = captured
        .exit_code
        .map_or_else(|| "a signal".to_string(), |code| format!("code {code}"));
    match mode {
        CodeMode::Run => {
            if !succeeded {
                return Err(format!(
                    "{label} program exited with {exit}:\n{}",
                    clip(&combined, ERROR_CLIP)
                ));
            }
            Ok(captured.stdout.trim_end_matches(['\n', '\r']).to_string())
        }
        CodeMode::Check => {
            if !succeeded {
                return Err(format!(
                    "{label} rejected the source ({exit}):\n{}",
                    clip(&combined, ERROR_CLIP)
                ));
            }
            if language == CodeLanguage::Lean && uses_sorry(&combined) {
                return Err(format!(
                    "Lean accepted the source only because a declaration uses `sorry`; a check \
                     step requires every declaration to be proven:\n{}",
                    clip(&combined, ERROR_CLIP)
                ));
            }
            if language == CodeLanguage::Bend && !combined.contains(BEND_PROOFS_CHECK) {
                return Err(format!(
                    "Bend did not print \"{BEND_PROOFS_CHECK}\":\n{}",
                    clip(&combined, ERROR_CLIP)
                ));
            }
            Ok(check_receipt(language, runner, &combined))
        }
    }
}
