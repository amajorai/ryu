//! Fake `op` / `bws` CLIs: a POSIX shell script on Unix and a batch file on
//! Windows, with the same behavior and the same `calls.log` lines, so the
//! production spawn path (absolute binary, cleared environment, token in the
//! environment only) runs on every platform.

use super::*;

/// The file name a fake CLI is written under.
pub(super) fn fake_cli_file_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.cmd")
    } else {
        name.to_owned()
    }
}

/// A fake CLI in `dir` that logs each call (never the token itself) to
/// `calls.log`: its argv, whether the token appeared in argv, and whether the
/// expected token arrived in the environment.
pub(super) fn fake_cli(dir: &Path, name: &str) -> PathBuf {
    let log = dir.join("calls.log");
    let body = script(&log.display().to_string(), name);
    let path = dir.join(fake_cli_file_name(name));
    std::fs::write(&path, body).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}

#[cfg(not(windows))]
fn script(log: &str, name: &str) -> String {
    match name {
        "bws" => format!(
            r#"#!/bin/sh
log="{log}"
printf 'argv:%s\n' "$*" >> "$log"
case "$*" in *{BWS_TOKEN}*) echo "token-in-argv:yes" >> "$log";; *) echo "token-in-argv:no" >> "$log";; esac
if [ "$BWS_ACCESS_TOKEN" = "{BWS_TOKEN}" ]; then echo "env-token:yes" >> "$log"; else echo "env-token:no" >> "$log"; fi
if [ "$BWS_ACCESS_TOKEN" != "{BWS_TOKEN}" ]; then echo "Error: 401 Unauthorized" >&2; exit 1; fi
if [ "$1 $2" = "secret get" ]; then
  if [ "$3" = "{SECRET_ID}" ]; then
    printf '{{"id":"%s","key":"API_KEY","value":"bw-secret-value","note":""}}' "$3"
    exit 0
  fi
  echo "Error: Resource not found" >&2; exit 1
fi
if [ "$1 $2" = "project list" ]; then printf '[]'; exit 0; fi
echo "unexpected" >&2; exit 2
"#
        ),
        _ => format!(
            r#"#!/bin/sh
log="{log}"
printf 'argv:%s\n' "$*" >> "$log"
case "$*" in *{OP_TOKEN}*) echo "token-in-argv:yes" >> "$log";; *) echo "token-in-argv:no" >> "$log";; esac
if [ "$OP_SERVICE_ACCOUNT_TOKEN" = "{OP_TOKEN}" ]; then echo "env-token:yes" >> "$log"; else echo "env-token:no" >> "$log"; fi
if [ "$OP_SERVICE_ACCOUNT_TOKEN" != "{OP_TOKEN}" ]; then echo "[ERROR] authentication failed: invalid token" >&2; exit 1; fi
if [ "$1" = "read" ] && [ "$3" = "op://dev/GitHub/token" ]; then printf 'op-secret-value'; exit 0; fi
if [ "$1" = "read" ]; then echo "[ERROR] \"x\" isn't an item in the \"dev\" vault" >&2; exit 1; fi
if [ "$1 $2" = "vault list" ]; then printf '[]'; exit 0; fi
echo "unexpected" >&2; exit 2
"#
        ),
    }
}

/// The batch equivalent of the shell script. Rust runs `.cmd` files through
/// `cmd.exe /c`; the arguments used here need no quoting, so `%*` is the
/// argv joined by spaces, like `$*`.
#[cfg(windows)]
fn script(log: &str, name: &str) -> String {
    let (token_env, token) = match name {
        "bws" => ("BWS_ACCESS_TOKEN", BWS_TOKEN),
        _ => ("OP_SERVICE_ACCOUNT_TOKEN", OP_TOKEN),
    };
    let prelude = format!(
        r#"@echo off
setlocal
set "log={log}"
>>"%log%" echo argv:%*
set "args=%*"
set "inargv=no"
if defined args if not "%args:{token}=%"=="%args%" set "inargv=yes"
>>"%log%" echo token-in-argv:%inargv%
if "%{token_env}%"=="{token}" (>>"%log%" echo env-token:yes) else (>>"%log%" echo env-token:no)
"#
    );
    let commands = match name {
        "bws" => format!(
            r#"if not "%{token_env}%"=="{token}" (echo Error: 401 Unauthorized 1>&2& exit /b 1)
if "%~1 %~2"=="secret get" (
  if "%~3"=="{SECRET_ID}" (
    echo {{"id":"%~3","key":"API_KEY","value":"bw-secret-value","note":""}}
    exit /b 0
  )
  echo Error: Resource not found 1>&2
  exit /b 1
)
if "%~1 %~2"=="project list" (echo []& exit /b 0)
echo unexpected 1>&2
exit /b 2
"#
        ),
        _ => format!(
            r#"if not "%{token_env}%"=="{token}" (echo [ERROR] authentication failed: invalid token 1>&2& exit /b 1)
if "%~1"=="read" if "%~3"=="op://dev/GitHub/token" (<nul set /p "=op-secret-value"& exit /b 0)
if "%~1"=="read" (echo [ERROR] "x" isn't an item in the "dev" vault 1>&2& exit /b 1)
if "%~1 %~2"=="vault list" (echo []& exit /b 0)
echo unexpected 1>&2
exit /b 2
"#
        ),
    };
    format!("{prelude}{commands}").replace('\n', "\r\n")
}
