//! The `ryu-core data-path …` subcommand entry.

use super::*;

// ── CLI subcommand entry ───────────────────────────────────────────────────────────

/// True when `value` names a profile the stack actually knows.
///
/// Every profile flag on this CLI (`--profile`, `--from-profile`, `--to-profile`)
/// is turned into a directory by `suffix_for(name)`, which has NO notion of a
/// valid name — it maps anything that is not `release` to `-<name>` verbatim. So
/// an unvalidated flag aims a destructive command at `~/.ryu-<whatever the user
/// typed>`:
///
///   * `--profile ""` → `~/.ryu-`, and `--profile canry` → `~/.ryu-canry`. Both
///     pass the `components().count() == 1` containment guard, so the command
///     reports success having cleaned NOTHING — the user believes their canary
///     profile was reset and it was not.
///   * `copy-profile` is the sharp end: `--to-profile` names the directory that
///     gets OVERWRITTEN, master key included, and a typo silently creates a new
///     junk root instead of failing.
///
/// `scripts/wipe.mjs` has guarded this with a name regex plus an empty check
/// since it was written; the Rust path did not. Pure and public so the rejection
/// is testable without driving `std::process::exit`.
pub fn is_known_profile_arg(value: &str) -> bool {
    crate::profile::offset_of(value).is_some()
}

/// Exit rather than aim a destructive path at the release data dir by accident.
fn require_known_profile(flag_name: &str, value: &str) {
    if is_known_profile_arg(value) {
        return;
    }
    eprintln!(
        "data-path: {flag_name} '{value}' is not a known profile (known: {}). \
         Refusing — an unknown or empty profile name resolves to the RELEASE data dir.",
        crate::profile::known_profiles()
    );
    std::process::exit(2);
}

/// Validate recovery admission before obtaining a maintenance lease.
pub(super) fn maintenance_lease(
    roots: &[PathBuf],
    exclusive: bool,
) -> std::io::Result<ryu_runtime_install::data_lease::DataLease> {
    let cache = dirs::cache_dir()
        .ok_or_else(|| std::io::Error::other("could not resolve recovery cache"))?
        .join("ryu-update-recovery");
    let admitted = ryu_runtime_install::data_lease::admit_runtime(
        &cache,
        roots,
        crate::profile::profile(),
        env!("CARGO_PKG_VERSION"),
        None,
    )
    .map_err(|error| {
        std::io::Error::other(format!(
            "update recovery blocked data maintenance: {error:#}"
        ))
    })?;
    if !exclusive {
        return Ok(admitted);
    }
    drop(admitted);
    ryu_runtime_install::data_lease::DataLease::recovery(&cache, roots).map_err(|error| {
        std::io::Error::other(format!(
            "data maintenance requires stopped runtimes: {error:#}"
        ))
    })
}

fn require_maintenance_lease(roots: &[PathBuf]) -> ryu_runtime_install::data_lease::DataLease {
    match maintenance_lease(roots, true) {
        Ok(lease) => lease,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

/// Handle a data-path command without starting the normal Core server.
pub fn run_cli(args: &[String]) -> bool {
    // args == full argv; find the "data-path" token.
    let Some(pos) = args.iter().position(|a| a == "data-path") else {
        return false;
    };
    let rest = &args[pos + 1..];
    let Some(cmd) = rest.first() else {
        eprintln!(
            "usage: ryu-core data-path <migrate|import|export|copy-profile|deep-clean> [flags]"
        );
        std::process::exit(2);
    };
    let flag = |name: &str| -> Option<String> {
        rest.iter()
            .position(|a| a == name)
            .and_then(|i| rest.get(i + 1))
            .cloned()
    };
    // The archive passphrase comes from the environment (set by the desktop on
    // the child it spawns) or one line of stdin; never from argv.
    let archive_passphrase = || -> Option<String> {
        if let Some(value) = std::env::var(ARCHIVE_PASSPHRASE_ENV)
            .ok()
            .filter(|value| !value.is_empty())
        {
            return Some(value);
        }
        if !rest.iter().any(|a| a == "--passphrase-stdin") {
            return None;
        }
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).ok()?;
        let value = line.trim_end_matches(['\r', '\n']).to_owned();
        (!value.is_empty()).then_some(value)
    };

    let result: std::io::Result<()> = match cmd.as_str() {
        // Resolve exactly as a normal boot would, without opening stores or
        // scanning model/media files. The independent update supervisor uses
        // this to capture the actual configured folder rather than guessing it.
        "location" => {
            let profile =
                flag("--profile").unwrap_or_else(|| crate::profile::profile().to_string());
            require_known_profile("--profile", &profile);
            ryu_runtime_install::data_paths::DataPaths::for_profile(
                &profile,
                dirs::home_dir(),
                dirs::config_dir(),
            )
            .and_then(|location| {
                let data = location.resolve_data_dir(std::env::var_os(paths::RYU_DIR_ENV))?;
                let pi_config_root =
                    crate::required_update_runtime::pi_config_root(&data, &location.config_dir)
                        .map_err(std::io::Error::other)?;
                println!(
                    "{}",
                    serde_json::json!({
                        "data": data,
                        "config": location.config_dir,
                        "profile": profile,
                        "piConfigRoot": pi_config_root,
                        "runtimeRoots": [pi_config_root],
                    })
                );
                Ok(())
            })
        }
        // Copy THIS profile's data into another profile's data dir, carrying the
        // master key. Neither pointer file is touched: both profiles stay usable.
        //
        // `--from-profile` / `--to-profile` are the profile NAMES (release, dev,
        // canary, …); the suffixes they map to are what key the keychain slots, and
        // getting them wrong is what silently orphans the data.
        // Remove the auxiliary roots a node reset never reaches (the OS config
        // dir), optionally clearing the profile's data dir too.
        "deep-clean" => {
            let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
            // Defaults: THIS profile, no data touched.
            let profile =
                flag("--profile").unwrap_or_else(|| crate::profile::profile().to_string());
            // Before ANY path is computed from it: an unknown or empty name maps
            // to the release suffix and would aim this recursive delete at ~/.ryu.
            require_known_profile("--profile", &profile);
            let suffix = crate::profile::suffix_for(&profile);
            let depth = match flag("--depth").as_deref() {
                None | Some("none") => CleanDepth::None,
                Some("state") => CleanDepth::State,
                Some("full") => CleanDepth::Full,
                Some(other) => {
                    eprintln!(
                        "data-path deep-clean: --depth must be none|state|full (got '{other}')"
                    );
                    std::process::exit(2);
                }
            };
            let mut protected = auxiliary_roots(dirs::config_dir().as_deref(), &suffix)
                .into_iter()
                .map(|(_, path)| path)
                .collect::<Vec<_>>();
            protected.push(home.join(format!(".ryu{suffix}")));
            let _maintenance = require_maintenance_lease(&protected);
            let mut removed = clean_profile_data(&home, &suffix, depth);
            removed.extend(deep_clean(&home, dirs::config_dir().as_deref(), &suffix));
            if removed.is_empty() {
                println!("nothing to remove");
            }
            for line in &removed {
                println!("removed {line}");
            }
            Ok(())
        }
        "copy-profile" => {
            let from_profile =
                flag("--from-profile").unwrap_or_else(|| crate::profile::profile().to_string());
            let Some(to_profile) = flag("--to-profile") else {
                eprintln!(
                    "usage: ryu-core data-path copy-profile --to-profile <name> \
                     [--from-profile <name>]"
                );
                std::process::exit(2);
            };
            if from_profile == to_profile {
                eprintln!("data-path copy-profile: source and target are the same profile");
                std::process::exit(2);
            }
            // Same unvalidated-name hole as deep-clean, one step worse: an unknown
            // `--to-profile` resolves to ~/.ryu and this command OVERWRITES the
            // target's files (and its master key) with the source profile's.
            require_known_profile("--from-profile", &from_profile);
            require_known_profile("--to-profile", &to_profile);
            let from_suffix = crate::profile::suffix_for(&from_profile);
            let to_suffix = crate::profile::suffix_for(&to_profile);
            let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
            let from = flag("--from")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(format!(".ryu{from_suffix}")));
            let to = flag("--to")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(format!(".ryu{to_suffix}")));
            let _maintenance = require_maintenance_lease(&[from.clone(), to.clone()]);
            copy_profile(&from, &to, &from_suffix, &to_suffix)
        }
        "migrate" => {
            let from = flag("--from")
                .map(PathBuf::from)
                .unwrap_or_else(paths::ryu_dir);
            let to = flag("--to").map(PathBuf::from);
            let move_source = rest.iter().any(|a| a == "--move");
            match to {
                Some(to) => {
                    let _maintenance =
                        require_maintenance_lease(&[from.clone(), to.clone(), paths::config_dir()]);
                    migrate(&from, &to, move_source)
                }
                None => {
                    eprintln!("data-path migrate requires --to <dir> [--from <dir>] [--move]");
                    std::process::exit(2);
                }
            }
        }
        "import" => {
            let archive = flag("--archive").map(PathBuf::from);
            let to = flag("--to")
                .map(PathBuf::from)
                .unwrap_or_else(paths::ryu_dir);
            match archive {
                Some(archive) => {
                    let _maintenance = require_maintenance_lease(&[
                        archive.clone(),
                        to.clone(),
                        paths::config_dir(),
                    ]);
                    import_zip(&archive, &to, archive_passphrase().as_deref())
                }
                None => {
                    eprintln!("data-path import requires --archive <zip> [--to <dir>] [--passphrase-stdin]");
                    std::process::exit(2);
                }
            }
        }
        // Internal: adopt a key bundle into the folder named by `RYU_DIR` (the
        // import above runs this in a child when restoring into another folder).
        ADOPT_KEY_BUNDLE_CMD => {
            use base64::Engine as _;
            let mut wrap_line = String::new();
            let mut bundle = String::new();
            let read = std::io::stdin()
                .read_line(&mut wrap_line)
                .and_then(|_| std::io::stdin().read_line(&mut bundle));
            match read {
                Err(error) => Err(error),
                Ok(_) => base64::engine::general_purpose::STANDARD
                    .decode(wrap_line.trim())
                    .ok()
                    .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
                    .ok_or_else(|| invalid_input("malformed key-bundle wrapping key"))
                    .and_then(|wrap| {
                        if !adopt_child_keychain_is_off() {
                            // Never let this step touch the profile's keychain
                            // slot: it holds the active folder's key.
                            return Err(invalid_input(format!(
                                "{ADOPT_KEY_BUNDLE_CMD} runs only with \
                                 {ADOPT_CHILD_KEYCHAIN_ENV}={ADOPT_CHILD_KEYCHAIN}"
                            )));
                        }
                        crate::crypto_host::install();
                        adopt_key_bundle_here(&wrap, bundle.trim())
                    }),
            }
        }
        "export" => {
            let from = flag("--from")
                .map(PathBuf::from)
                .unwrap_or_else(paths::ryu_dir);
            let out = flag("--out").map(PathBuf::from);
            match out {
                Some(out) => match maintenance_lease(&[from.clone(), out.clone()], false) {
                    Ok(_maintenance) => match archive_passphrase() {
                        Some(passphrase) => export_zip(&from, &out, &passphrase).map(|_| ()),
                        None => Err(invalid_input(format!(
                            "data-path export needs a passphrase: set {ARCHIVE_PASSPHRASE_ENV} or pass --passphrase-stdin"
                        ))),
                    },
                    Err(error) => Err(error),
                },
                None => {
                    eprintln!("data-path export requires --out <zip> [--from <dir>] [--passphrase-stdin]");
                    std::process::exit(2);
                }
            }
        }
        other => {
            eprintln!("unknown data-path command: {other}");
            std::process::exit(2);
        }
    };

    match result {
        Ok(()) => {
            println!("@@DONE");
            true
        }
        Err(e) => {
            eprintln!("data-path {cmd} failed: {e}");
            std::process::exit(1);
        }
    }
}
