use super::*;

/// What the untrusted-workspace profile confines for one agent process tree.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UntrustedProfile {
    /// Paths hidden from the agent (directories become empty, files read as
    /// empty). Paths that do not exist are skipped by the runner.
    pub masks: Vec<PathBuf>,
    /// `Some(ports)`: cut outbound network except loopback TCP to these ports.
    /// `None`: leave the network alone (the agent reaches its provider
    /// directly, or must download itself at launch).
    pub loopback_ports: Option<Vec<u16>>,
    /// Deny the user's Keychain: on macOS, Seatbelt refuses the Keychain
    /// daemons' Mach services ([`KEYCHAIN_MACH_SERVICES`]). Pair it with
    /// [`keychain_masks`] in `masks` so the Keychain files are hidden too. No
    /// other OS has a macOS Keychain, so the runner ignores it there.
    pub deny_keychain: bool,
}

/// The Mach services through which a process reaches the user's Keychain
/// items: `securityd` for the file-based login Keychain (the `security` CLI
/// and the legacy Security framework calls) and `secd` for the data
/// protection Keychain. Certificate trust is evaluated by `trustd`, which
/// stays reachable, so TLS keeps working.
pub const KEYCHAIN_MACH_SERVICES: &[&str] = &[
    "com.apple.SecurityServer",
    "com.apple.securityd",
    "com.apple.securityd.xpc",
];

/// The user's Keychain files under `home` (`~/Library/Keychains`: the login
/// Keychain database and the data protection Keychain's folder). Hidden
/// together with [`KEYCHAIN_MACH_SERVICES`] so the database cannot be copied
/// out for an offline attack either.
pub fn keychain_masks(home: Option<&Path>) -> Vec<PathBuf> {
    home.map(|home| vec![home.join("Library").join("Keychains")])
        .unwrap_or_default()
}

/// Credential stores under the home directory that a coding agent never needs
/// to read to edit and test a repository. Directories hide everything beneath
/// them. The agent's own login (`~/.claude`, `~/.codex`, Ryu's managed homes)
/// is deliberately absent: hiding it would sign the agent out.
const HOME_CREDENTIAL_PATHS: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".config/gcloud",
    ".kube",
    ".docker",
    ".config/gh",
    ".config/hub",
    ".config/op",
    ".netrc",
    ".git-credentials",
    ".npmrc",
    ".yarnrc.yml",
    ".pypirc",
    ".cargo/credentials",
    ".cargo/credentials.toml",
    ".gem/credentials",
    ".terraform.d/credentials.tfrc.json",
    ".vault-token",
    ".password-store",
    ".local/share/keyrings",
    ".mozilla",
    ".config/google-chrome",
    ".config/chromium",
    ".config/BraveSoftware",
    ".config/microsoft-edge",
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/BraveSoftware",
    "Library/Application Support/Firefox",
    "Library/Cookies",
];

/// The home credential stores, for an untrusted workspace.
pub fn home_credential_masks(home: Option<&Path>) -> Vec<PathBuf> {
    home.map(|home| {
        HOME_CREDENTIAL_PATHS
            .iter()
            .map(|path| home.join(path))
            .collect()
    })
    .unwrap_or_default()
}

/// The Ryu Browser's Electron profile folder (its cookies and site sign-ins)
/// under the OS config dir, named after the app's product name.
pub const RYU_BROWSER_PROFILE_DIR: &str = "Ryu Browser";

/// Prefix of the bundle identifier of every Ryu Desktop build
/// (`ai.amajor.ryu.desktop`, its profile variants, the bot and app host),
/// which names its app data, web view storage and caches.
const RYU_DESKTOP_IDENTIFIER_PREFIX: &str = "ai.amajor.ryu.";

/// The OS folders the Ryu Desktop app and the Ryu Browser keep their data in:
/// the config, data, local data and cache dirs, and on macOS the `Library`
/// folders WebKit and the system keep per-app state in.
pub fn ryu_app_data_roots(home: Option<&Path>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = [
        dirs::config_dir(),
        dirs::data_dir(),
        dirs::data_local_dir(),
        dirs::cache_dir(),
    ]
    .into_iter()
    .flatten()
    .collect();
    if let Some(home) = home {
        roots.extend(
            [
                "Library/WebKit",
                "Library/HTTPStorages",
                "Library/Preferences",
                "Library/Saved Application State",
            ]
            .iter()
            .map(|path| home.join(path)),
        );
    }
    roots.sort();
    roots.dedup();
    roots
}

/// The Ryu Desktop app's and the Ryu Browser's own data under `roots`
/// ([`ryu_app_data_roots`]): the Browser's profile, and every entry named
/// after a Desktop bundle identifier. They hold the user's web sign-ins and
/// the Desktop's local storage, which a limited agent never needs.
pub fn ryu_app_data_masks(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut masks = Vec::new();
    for root in roots {
        masks.push(root.join(RYU_BROWSER_PROFILE_DIR));
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name
                .to_str()
                .is_some_and(|name| name.starts_with(RYU_DESKTOP_IDENTIFIER_PREFIX))
            {
                masks.push(entry.path());
            }
        }
    }
    masks.sort();
    masks.dedup();
    masks
}

/// Data-dir folders holding Core's tokens and keys (`secrets/`), databases
/// (`db/`, including every agent's record and account access) and state files
/// (`state/`). Hidden as whole folders: on Linux a file mask stops covering a
/// path once the host atomically renames a new file over it, a folder mask
/// does not.
const CORE_STATE_DIRS: &[&str] = &[
    ryu_sidecar_runtime::layout::top::SECRETS,
    ryu_sidecar_runtime::layout::top::DB,
    ryu_sidecar_runtime::layout::top::STATE,
];

/// More Core data an agent with limited account access never needs: app
/// (satellite) data, first-party service state, and logs.
const CORE_PRIVATE_DIRS: &[&str] = &[
    ryu_sidecar_runtime::layout::top::PLUGIN_DATA,
    ryu_sidecar_runtime::layout::top::SERVICES,
    ryu_sidecar_runtime::layout::top::LOGS,
];

/// More Core data an agent in an untrusted workspace never needs: user content
/// (`files/`: blobs, media, voice, source history), first-party service state,
/// and logs. `plugin-data/` stays visible there because agent plugins read
/// their own `${PLUGIN_DATA}` from it.
const UNTRUSTED_PRIVATE_DIRS: &[&str] = &[
    ryu_sidecar_runtime::layout::top::FILES,
    ryu_sidecar_runtime::layout::top::SERVICES,
    ryu_sidecar_runtime::layout::top::LOGS,
];

/// Core's own data in `ryu_dir`: every top-level file (legacy preference and
/// secret stores, node tokens, relay keys) and the [`CORE_STATE_DIRS`]; with
/// `private`, also the [`CORE_PRIVATE_DIRS`]. Managed runtimes, binaries,
/// models and engines stay visible: agents run from them.
pub fn core_data_masks(ryu_dir: &Path, private: bool) -> Vec<PathBuf> {
    let mut masks = Vec::new();
    if let Ok(entries) = std::fs::read_dir(ryu_dir) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_file()) {
                masks.push(entry.path());
            }
        }
    }
    masks.extend(CORE_STATE_DIRS.iter().map(|dir| ryu_dir.join(dir)));
    if private {
        masks.extend(CORE_PRIVATE_DIRS.iter().map(|dir| ryu_dir.join(dir)));
    }
    masks.sort();
    masks.dedup();
    masks
}

/// Core's own data hidden in an untrusted workspace: [`core_data_masks`] plus
/// the [`UNTRUSTED_PRIVATE_DIRS`]. Pass it through [`keep_visible`] so a
/// native-account agent's custody home under `secrets/` stays reachable.
pub fn untrusted_core_masks(ryu_dir: &Path) -> Vec<PathBuf> {
    let mut masks = core_data_masks(ryu_dir, false);
    masks.extend(UNTRUSTED_PRIVATE_DIRS.iter().map(|dir| ryu_dir.join(dir)));
    masks.sort();
    masks.dedup();
    masks
}

/// The masks for an untrusted workspace: the home credential stores plus
/// Core's own data ([`untrusted_core_masks`]). Core builds the two halves
/// separately so only Core's data passes through [`keep_visible`].
#[cfg_attr(not(test), allow(dead_code))]
pub fn untrusted_masks(home: Option<&Path>, ryu_dir: &Path) -> Vec<PathBuf> {
    let mut masks = home_credential_masks(home);
    masks.extend(untrusted_core_masks(ryu_dir));
    masks.sort();
    masks.dedup();
    masks
}

/// The masks for an agent with limited account access, in any folder: all of
/// Core's data ([`core_data_masks`] with its private folders) and, when its
/// model providers are limited too, every store in `provider_stores` (see
/// [`crate::agent_access::user_provider_stores`]). Pass the result through
/// [`keep_visible`] so the engine's own sign-in and launch paths survive.
pub fn account_restricted_masks(
    ryu_dir: &Path,
    provider_stores: Option<&[PathBuf]>,
) -> Vec<PathBuf> {
    let mut masks = core_data_masks(ryu_dir, true);
    if let Some(stores) = provider_stores {
        masks.extend(stores.iter().cloned());
    }
    masks.sort();
    masks.dedup();
    masks
}

/// Drop or narrow every mask that would hide a path in `keep` (the engine's
/// command, working folders and own sign-in home). A mask equal to a kept path
/// is dropped; a mask that contains one is replaced by its entries that do
/// not lead to it, recursively, so everything else beneath it stays hidden. A
/// mask inside a kept folder is left alone: keeping a folder visible never
/// un-hides a credential store within it.
pub fn keep_visible(masks: Vec<PathBuf>, keep: &[PathBuf]) -> Vec<PathBuf> {
    // Compare resolved paths, so a symlinked spelling of a kept folder (macOS
    // `/var` and `/private/var`) still matches the store that contains it.
    let keep: Vec<PathBuf> = keep.iter().map(|path| resolved(path)).collect();
    let mut narrowed = Vec::new();
    for mask in masks {
        narrow_mask(mask, &keep, &mut narrowed, 0);
    }
    narrowed.sort();
    narrowed.dedup();
    narrowed
}

/// How deep [`keep_visible`] descends before hiding a mask whole. Kept paths
/// sit a few levels below a store, so this is never reached in practice.
pub(super) const MAX_NARROW_DEPTH: usize = 8;

fn resolved(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn narrow_mask(mask: PathBuf, keep: &[PathBuf], out: &mut Vec<PathBuf>, depth: usize) {
    let resolved_mask = resolved(&mask);
    if keep.iter().any(|kept| kept == &resolved_mask) {
        tracing::warn!(path = %mask.display(), "agent sandbox: leaving a path the agent runs from visible");
        return;
    }
    if !keep.iter().any(|kept| kept.starts_with(&resolved_mask)) {
        out.push(mask);
        return;
    }
    tracing::warn!(path = %mask.display(), "agent sandbox: hiding the entries of a folder the agent runs from instead of the folder");
    // Fail closed: when the folder cannot be narrowed (too deep, or its
    // entries cannot be listed), hide it whole, kept path and all, rather
    // than leave the rest of the store visible.
    if depth >= MAX_NARROW_DEPTH {
        tracing::warn!(path = %mask.display(), "agent sandbox: too deep to narrow; hiding the whole folder");
        out.push(mask);
        return;
    }
    let Ok(entries) = std::fs::read_dir(&mask) else {
        tracing::warn!(path = %mask.display(), "agent sandbox: cannot list a folder to narrow; hiding the whole folder");
        out.push(mask);
        return;
    };
    for entry in entries.flatten() {
        narrow_mask(entry.path(), keep, out, depth + 1);
    }
}
