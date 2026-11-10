//! What a data-folder backup (export and import) leaves out.

use super::*;

// Export and import exclude every credential under `secrets/` except the key
// custody files, plus this denylist by basename at every depth. These files
// either contain reusable credentials or bind the data to the source node. The
// encryption keys (`secrets/master.key`, `secrets/memory.key`) are deliberately
// kept: they are required to restore the encrypted customer databases, so the
// backup itself must be kept private.
pub(super) const BACKUP_KEPT_SECRETS: &[&str] = &["master.key", "memory.key"];
const BACKUP_EXCLUDE_NAMES: &[&str] = &[
    "accounts.json",
    ".reset-pending",
    "auth.json",
    // A Codex auth copy backup older builds kept in the isolated CODEX_HOME.
    "auth.json.ryu-safety-backup",
    "bootstrap-ack.token",
    // The CLIs' own sign-in files: Claude Code's OAuth (`.credentials.json`) and
    // account file (`.claude.json`).
    ".claude.json",
    ".credentials.json",
    "core.token",
    "delegation-ed25519.pub",
    "fleet-artifacts",
    "fleet-desired.json",
    "fleet-enforcement.json",
    "fleet-enrolled-node.json",
    "fleet-enrollment-pending.json",
    "fleet-identity.json",
    "fleet-instance-id.json",
    "fleet-skill-blocks.json",
    "fleet-status.json",
    "gateway-admin.key",
    "gateway-durable.token",
    "gateway-relay.key",
    "gateway-relay.token",
    "mcp.json",
    "models.json",
    "native-accounts",
    "node-auth.token",
    "node-control.token",
    "nodes.json",
    "paired-clients.json",
    "pi-accounts.db",
    // Linked plan accounts (`state/plan-accounts/<provider>-<id>`): each is a
    // CLI config folder holding that account's own sign-in.
    "plan-accounts",
    "plugin-credentials",
    "plugin-secrets.db",
    "org-project-mappings.json",
    "ryu-core.pid",
    // The Ryu Relay routing token; re-minted on the next register.
    "relay.json",
    // Third-party tunnel identities Ryu cannot seal (tailscaled's node keys and
    // the OpenTunnel CLI's token and private key): a restored copy would clone
    // this node's network identity, so they are left out.
    "tailscaled.state",
    "tunnel.json",
];

/// True for a path (relative to the data dir) inside `secrets/` that is not one
/// of the key custody files a backup must carry.
fn is_excluded_secret(path: &Path) -> bool {
    let mut components = path.components();
    let Some(first) = components.next() else {
        return false;
    };
    if !first
        .as_os_str()
        .to_str()
        .is_some_and(|name| name.eq_ignore_ascii_case(layout::top::SECRETS))
    {
        return false;
    }
    let rest: Vec<_> = components.collect();
    match rest.as_slice() {
        // The `secrets/` dir itself is walked so the kept keys can be found.
        [] => false,
        [only] => !only.as_os_str().to_str().is_some_and(|name| {
            BACKUP_KEPT_SECRETS
                .iter()
                .any(|kept| name.eq_ignore_ascii_case(kept))
        }),
        _ => true,
    }
}

pub(crate) fn is_backup_excluded(path: &Path) -> bool {
    is_excluded_secret(path)
        || path.components().any(|component| {
            component.as_os_str().to_str().is_some_and(|name| {
                BACKUP_EXCLUDE_NAMES
                    .iter()
                    .any(|excluded| name.eq_ignore_ascii_case(excluded))
            })
        })
}
