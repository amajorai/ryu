//! Confine a command-tool child run for a confined agent, or one that
//! receives workspace path arguments.
//!
//! A confined caller's child always runs under the runner: a command tool
//! with no path arguments can still read any path it is told to (rtk's
//! `proxy` mode runs an arbitrary command), so keying confinement on declared
//! path arguments alone would hand a limited agent an unmasked host exec.
//!
//! [`prepare_workspace_path_args`] checks each path once, but the child opens
//! it later by name. A caller that can write the workspace (a confined agent's
//! engine) can swap a checked folder for a symlink into a hidden store in
//! between, so the child is spawned through the agent sandbox runner with
//! those stores masked: a swapped symlink, or one the child meets while
//! walking, then resolves to an empty mask instead of the store.

use std::path::{Path, PathBuf};

use super::*;

/// The program and argv to spawn for `bin` with `argv`.
///
/// An unconfined caller (`hidden` empty) without path arguments runs the bin
/// directly. A confined caller (`hidden` non-empty), whether or not the tool
/// takes path arguments, and any path-taking call run the bin under the runner
/// with `hidden` (the caller's account-hidden stores) and Ryu's own data and
/// home credential stores masked; the bin itself stays visible.
/// `support` asks [`crate::agent_sandbox::untrusted_support`], only when needed: when the
/// host cannot sandbox, a confined caller is refused and any other caller
/// keeps the direct spawn behind the check-time refusals.
pub(super) fn command_spawn_program(
    bin: &Path,
    argv: &[String],
    has_path_args: bool,
    hidden: &[PathBuf],
    support: impl FnOnce() -> Result<(), String>,
) -> Result<(PathBuf, Vec<String>), String> {
    let direct = || Ok((bin.to_owned(), argv.to_vec()));
    if !has_path_args && hidden.is_empty() {
        return direct();
    }
    let masks = command_child_masks(bin, hidden);
    if masks.is_empty() {
        return direct();
    }
    if let Err(reason) = support() {
        if hidden.is_empty() {
            return direct();
        }
        return Err(format!(
            "command tool: this agent's account access needs the agent sandbox for command \
             tools, which this host cannot provide ({reason})"
        ));
    }
    let runner = std::env::current_exe()
        .map_err(|e| format!("command tool: could not resolve the agent sandbox runner: {e}"))?;
    Ok((
        runner,
        crate::agent_sandbox::masked_runner_args(bin, argv, &masks),
    ))
}

/// The paths hidden from a path-taking command child: `hidden`, Ryu's data
/// dir and the home credential stores ([`confined_hidden_paths`] without the
/// provider stores), and the [`protected_host_roots`], narrowed so `bin`
/// itself stays visible.
pub(super) fn command_child_masks(bin: &Path, hidden: &[PathBuf]) -> Vec<PathBuf> {
    let mut masks = hidden.to_vec();
    masks.extend(confined_hidden_paths(
        &crate::paths::ryu_dir(),
        dirs::home_dir().as_deref(),
        None,
    ));
    masks.extend(protected_host_roots());
    masks.sort();
    masks.dedup();
    crate::agent_sandbox::keep_visible(masks, &[bin.to_owned()])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv() -> Vec<String> {
        vec!["--json".to_owned(), "--".to_owned(), "/ws/d".to_owned()]
    }

    /// A temp `store` holding a secret, standing in for a hidden store, and a
    /// bin outside it.
    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let store = std::fs::canonicalize(tmp.path()).unwrap().join("store");
        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(store.join("core.token"), "TOPSECRET").unwrap();
        let bin = std::fs::canonicalize(tmp.path()).unwrap().join("rg");
        std::fs::write(&bin, "").unwrap();
        (tmp, store, bin)
    }

    fn mask_values(args: &[String]) -> Vec<PathBuf> {
        args.windows(2)
            .filter(|pair| pair[0] == "--mask")
            .map(|pair| PathBuf::from(&pair[1]))
            .collect()
    }

    #[test]
    fn a_confined_path_call_runs_under_the_runner_with_its_hidden_stores_masked() {
        let (_tmp, store, bin) = fixture();
        let (program, args) =
            command_spawn_program(&bin, &argv(), true, std::slice::from_ref(&store), || Ok(()))
                .unwrap();
        assert_eq!(program, std::env::current_exe().unwrap());
        assert_eq!(args[0], crate::agent_sandbox::AGENT_SANDBOX_RUNNER_ARG);
        assert!(mask_values(&args).contains(&store), "{args:?}");
        let separator = args.iter().position(|arg| arg == "--").unwrap();
        assert_eq!(args[separator + 1], bin.to_string_lossy());
        assert_eq!(&args[separator + 2..], argv().as_slice());
    }

    #[test]
    fn a_confined_path_call_is_refused_when_the_host_cannot_sandbox() {
        let (_tmp, store, bin) = fixture();
        let refused = command_spawn_program(&bin, &argv(), true, &[store], || {
            Err("unprivileged user namespaces are not available".to_owned())
        })
        .unwrap_err();
        assert!(refused.contains("needs the agent sandbox"), "{refused}");
    }

    #[test]
    fn an_unconfined_call_keeps_the_direct_spawn_when_the_host_cannot_sandbox() {
        let (_tmp, _store, bin) = fixture();
        let spawned =
            command_spawn_program(&bin, &argv(), true, &[], || Err("no userns".to_owned()))
                .unwrap();
        assert_eq!(spawned, (bin, argv()));
    }

    #[test]
    fn an_unconfined_call_without_path_arguments_runs_the_bin_directly() {
        let (_tmp, _store, bin) = fixture();
        let spawned = command_spawn_program(&bin, &argv(), false, &[], || {
            panic!("no sandbox probe for an unconfined call without path arguments")
        })
        .unwrap();
        assert_eq!(spawned, (bin, argv()));
    }

    /// Regression: a general-exec bin (rtk `proxy <cmd>`) declares no path
    /// arguments, but a confined caller must still not get an unmasked spawn.
    #[test]
    fn a_confined_call_without_path_arguments_runs_under_the_runner_with_its_stores_masked() {
        let (_tmp, store, bin) = fixture();
        let (program, args) = command_spawn_program(
            &bin,
            &argv(),
            false,
            std::slice::from_ref(&store),
            || Ok(()),
        )
        .unwrap();
        assert_eq!(program, std::env::current_exe().unwrap());
        assert_eq!(args[0], crate::agent_sandbox::AGENT_SANDBOX_RUNNER_ARG);
        assert!(mask_values(&args).contains(&store), "{args:?}");
        let separator = args.iter().position(|arg| arg == "--").unwrap();
        assert_eq!(args[separator + 1], bin.to_string_lossy());
        assert_eq!(&args[separator + 2..], argv().as_slice());
    }

    #[test]
    fn a_confined_call_without_path_arguments_is_refused_when_the_host_cannot_sandbox() {
        let (_tmp, store, bin) = fixture();
        let refused = command_spawn_program(&bin, &argv(), false, &[store], || {
            Err("no userns".to_owned())
        })
        .unwrap_err();
        assert!(refused.contains("needs the agent sandbox"), "{refused}");
    }

    #[test]
    fn a_bin_inside_a_hidden_store_stays_visible_while_the_rest_is_masked() {
        let (_tmp, store, _bin) = fixture();
        let bin_dir = store.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let bin = bin_dir.join("rg");
        std::fs::write(&bin, "").unwrap();
        let masks = command_child_masks(&bin, std::slice::from_ref(&store));
        assert!(!masks.contains(&store), "{masks:?}");
        assert!(masks.contains(&store.join("core.token")), "{masks:?}");
        assert!(!masks.iter().any(|mask| bin.starts_with(mask)), "{masks:?}");
    }
}
