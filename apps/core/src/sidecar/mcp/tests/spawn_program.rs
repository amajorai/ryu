//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;
#[cfg(not(windows))]
use crate::sidecar::mcp::tests::present_command;

/// The probe's Windows half: it counts a `.cmd`/`.bat` `PATH` hit as present, and
/// that is only true because the spawn seam rewrites such a command to its full
/// resolved path — `Command::new("npx")` looks for `npx.exe` and nothing else
/// (`std`'s `resolve_exe` appends only `.exe`; `PATHEXT` is a `cmd.exe` rule). The
/// platform bit and the `PATH` lookup are injected so the Windows behaviour is
/// asserted on the unix box this suite actually runs on. (The other unspawnable-hit
/// case, an extensionless `PATH` file, has its own test below.)
#[test]
fn the_spawn_seam_rewrites_windows_batch_shims_to_their_resolved_path() {
    type Lookup = Option<std::path::PathBuf>;
    let shim = |_: &str| -> Lookup { Some(std::path::PathBuf::from(r"C:\npm\npx.cmd")) };
    let never = |_: &str| -> Lookup { panic!("a path must never be looked up on PATH") };

    // Windows + a batch shim: the bare name cannot spawn, the resolved path can
    // (std re-targets a `.cmd` program at `cmd.exe /c`).
    assert_eq!(
        spawn_program_with("npx", true, shim),
        r"C:\npm\npx.cmd",
        "a .cmd runner must be spawned by its resolved path"
    );
    // Same host, `.bat`, upper-cased as PATH entries often are.
    assert_eq!(
        spawn_program_with("thing", true, |_: &str| -> Lookup {
            Some(std::path::PathBuf::from(r"C:\tools\THING.BAT"))
        }),
        r"C:\tools\THING.BAT"
    );

    // An .exe hit keeps the bare name, so PATH stays late-bound and the operator can
    // swap the binary without restarting Core.
    assert_eq!(
        spawn_program_with("npx", true, |_: &str| -> Lookup {
            Some(std::path::PathBuf::from(r"C:\npm\npx.exe"))
        }),
        "npx"
    );

    // Not found: untouched, so the spawn fails with its usual not-found error.
    assert_eq!(
        spawn_program_with("nope", true, |_: &str| -> Lookup { None }),
        "nope"
    );

    // A command carrying a separator is never PATH-resolved (std doesn't either,
    // and it already batch-dispatches a path ending in .cmd/.bat).
    assert_eq!(
        spawn_program_with(r"C:\tools\thing.cmd", true, never),
        r"C:\tools\thing.cmd"
    );
    assert_eq!(
        spawn_program_with("/usr/bin/npx", true, never),
        "/usr/bin/npx"
    );

    // Blank stays blank (the probe already refuses to register it).
    assert_eq!(spawn_program_with("", true, never), "");

    // Non-Windows: the configured program, untouched, whatever PATH holds —
    // including a unix file that merely happens to be named `*.cmd` (executable
    // there, not a shim).
    assert_eq!(spawn_program_with("npx", false, shim), "npx");

    // Surrounding whitespace is stripped on BOTH platforms, because the probe
    // (`mcp_command_is_present`) strips it before declaring the command installed
    // and nothing upstream does: a declared `"npx "` otherwise passes the gate and
    // then ENOENTs in `Command::new`, on unix as much as on Windows.
    assert_eq!(spawn_program_with("  npx  ", false, shim), "npx");
    assert_eq!(spawn_program_with(" npx ", true, shim), r"C:\npm\npx.cmd");
    assert_eq!(
        spawn_program_with("  /usr/bin/npx  ", false, never),
        "/usr/bin/npx"
    );
}

/// The extensionless Windows `PATH` hit: the probe counts it (`which_on_path` tries
/// the bare `dir\program` first) but `Command::new("ghost")` looks only for
/// `ghost.exe`, so the bare name cannot spawn it. Handing over the resolved path can
/// — `resolve_exe` strips the `.exe` it appended to a path-ish program string and
/// passes it verbatim. The rewrite is conditional: it must not shadow a real
/// `<name>.exe` that the bare name still resolves.
#[test]
fn the_spawn_seam_rewrites_an_unspawnable_extensionless_path_hit() {
    type Lookup = Option<std::path::PathBuf>;

    // Only the extensionless file exists ⇒ the bare name is a guaranteed ENOENT, so
    // spawn the file the probe actually found.
    let extensionless_only = |program: &str| -> Lookup {
        (program == "ghost").then(|| std::path::PathBuf::from(r"C:\bin\ghost"))
    };
    assert_eq!(
        spawn_program_with("ghost", true, extensionless_only),
        r"C:\bin\ghost",
        "an extensionless hit must be spawned by its resolved path"
    );

    // A real `ghost.exe` elsewhere on PATH ⇒ the bare name still resolves (std
    // appends .exe and walks PATH), so leave it late-bound rather than pinning the
    // spawn to a shell script that shadows it.
    let extensionless_then_exe = |program: &str| -> Lookup {
        match program {
            "ghost" => Some(std::path::PathBuf::from(r"C:\git\usr\bin\ghost")),
            "ghost.exe" => Some(std::path::PathBuf::from(r"C:\bin\ghost.exe")),
            _ => None,
        }
    };
    assert_eq!(
        spawn_program_with("ghost", true, extensionless_then_exe),
        "ghost",
        "a resolvable bare name must not be pinned to an extensionless shadow"
    );

    // A batch shim still wins on its own terms — the .exe probe is never reached for
    // it, so first-PATH-directory-wins (cmd.exe's own rule) is preserved.
    let cmd_then_exe = |program: &str| -> Lookup {
        match program {
            "npx" => Some(std::path::PathBuf::from(r"C:\npm\npx.cmd")),
            "npx.exe" => panic!("a .cmd hit must not trigger the .exe probe"),
            _ => None,
        }
    };
    assert_eq!(
        spawn_program_with("npx", true, cmd_then_exe),
        r"C:\npm\npx.cmd"
    );

    // Unix is untouched: no PATH walk at all, extensionless or not.
    assert_eq!(
        spawn_program_with("ghost", false, |_: &str| -> Lookup {
            panic!("unix must never look up PATH on the spawn path")
        }),
        "ghost"
    );
}

/// `to_target`'s stdio branch is the only seam between a registry config and
/// `Command::new`, and on unix it must hand over exactly the configured program —
/// present, absent, or path-ish. Whitespace-padded commands are covered separately
/// (they normalize to what the probe validated, on every platform).
#[cfg(not(windows))]
#[test]
fn to_command_is_identity_on_unix() {
    let absent = format!("ryu-absent-mcp-{}", uuid::Uuid::new_v4());
    let present = present_command();
    for command in ["sh", absent.as_str(), present.as_str()] {
        let cfg = McpServerConfig {
            command: Some(command.to_owned()),
            args: vec!["-y".to_owned()],
            ..Default::default()
        };
        let McpTarget::Stdio(lowered) = cfg.to_target().expect("stdio target") else {
            panic!("a config with a command must lower to the stdio transport");
        };
        assert_eq!(
            lowered.command, command,
            "unix spawn program must be the configured command verbatim"
        );
    }

    // A BLANK command is the one input that is no longer passed through. It
    // used to lower to an empty program string and fail at `Command::new`
    // with an opaque ENOENT; now that `command` is optional it is
    // indistinguishable from "no command declared", so it fails at lowering
    // with a message that says which half of the entry is missing. That is a
    // deliberate behaviour change, not identity being broken: nothing can
    // spawn an empty program, so there is no identity to preserve.
    let blank = McpServerConfig {
        command: Some("   ".to_owned()),
        ..Default::default()
    };
    let err = blank.to_target().expect_err("a blank command cannot lower");
    assert!(
        err.to_string().contains("'url'"),
        "the error must point at the two ways to declare a server: {err}"
    );
}
