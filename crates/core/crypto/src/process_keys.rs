//! Cross-process key distribution: how a process that does NOT hold the master
//! key (the Gateway Core spawns, an app satellite, a sidecar) gets a key that
//! seals only its own data.
//!
//! Core holds the master key. For a child it spawns, Core derives a
//! purpose-bound subkey with HKDF-SHA256 and passes it in the child's
//! environment ([`SEAL_KEY_ENV`] plus [`SEAL_SCOPE_ENV`]). The subkey is never
//! written to disk, and it opens only what that child sealed. A process that
//! runs without Core (a standalone Gateway, a satellite started by hand) derives
//! the SAME subkey from the master key it resolves itself, so its data stays
//! readable whichever way it is started.
//!
//! Two scope kinds exist, each with its own KDF domain and envelope prefix, so a
//! value can never be opened by the wrong kind of key:
//!
//! | Scope | KDF info | Envelope |
//! |---|---|---|
//! | plugin (`plugin:<canonical id>`) | `ryu-plugin-crypto-v1:<id>` | `encp:v1:` |
//! | component (`component:<name>`) | `ryu-component-crypto-v1:<name>` | `encc:v1:` |
//!
//! The plugin scope is the same derivation as [`crate::plugin_cipher`] (the
//! sandbox bridge's `host.crypto.*`), so a satellite's sidecar and its UI frame
//! read each other's sealed values.

use std::sync::OnceLock;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;

use crate::{
    b64, decode_key, host_slot, FieldCipher, PluginCipher, BOUND_ENVELOPE_PREFIX, ENVELOPE_PREFIX,
    ENV_MASTER_KEY, KEY_LEN, PLUGIN_ENVELOPE_PREFIX, PLUGIN_KDF_INFO_PREFIX, PLUGIN_KDF_SALT,
};

/// Env var carrying a Core-derived subkey (base64, 32 bytes) into a child process.
pub const SEAL_KEY_ENV: &str = "RYU_SEAL_KEY";
/// Env var naming what [`SEAL_KEY_ENV`] is for: `plugin:<canonical id>` or
/// `component:<name>`. A process refuses a key delivered for another scope.
pub const SEAL_SCOPE_ENV: &str = "RYU_SEAL_SCOPE";
/// Env var carrying the same scope's subkeys under RETIRED master keys (base64,
/// 32 bytes each, comma separated). Set only when the master key was replaced
/// (`ryu-core keys adopt`, a data-folder import): the child opens what it sealed
/// before, reports those stores as `Retired`, and reseals them. Never used to seal.
pub const SEAL_RETIRED_KEYS_ENV: &str = "RYU_SEAL_RETIRED_KEYS";
/// Every env var that carries key material into a child. A process that spawns
/// its own children removes these from the child's environment
/// ([`scrub_seal_env`]) so a key never travels further than intended.
pub const SEAL_ENV_VARS: [&str; 4] = [
    SEAL_KEY_ENV,
    SEAL_SCOPE_ENV,
    SEAL_RETIRED_KEYS_ENV,
    ENV_MASTER_KEY,
];

/// Envelope prefix for values sealed with a component subkey.
pub(crate) const COMPONENT_ENVELOPE_PREFIX: &str = "encc:v1:";
const COMPONENT_KDF_SALT: &[u8] = b"ryu-component-crypto-v1";
const COMPONENT_KDF_INFO_PREFIX: &[u8] = b"ryu-component-crypto-v1:";

/// Registered component names. A component name is part of the KDF input, so
/// renaming one orphans everything it sealed: add names, never change them.
pub mod components {
    /// The Ryu Gateway (`gateway.toml` secrets, Gateway-owned stores).
    pub const GATEWAY: &str = "gateway";
    /// Shadow, the screen/audio capture sidecar (capture logs, indexes, media).
    pub const SHADOW: &str = "shadow";
    /// Ghost, the desktop-automation MCP server.
    pub const GHOST: &str = "ghost";
}

/// What a delivered subkey is for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyScope {
    /// One plugin or app satellite, by canonical id (`@ryu/mail`).
    Plugin(String),
    /// One first-party component other than Core (see [`components`]).
    Component(String),
}

impl KeyScope {
    /// The [`SEAL_SCOPE_ENV`] wire value.
    pub fn env_value(&self) -> String {
        match self {
            Self::Plugin(id) => format!("plugin:{id}"),
            Self::Component(name) => format!("component:{name}"),
        }
    }

    /// Parse a [`SEAL_SCOPE_ENV`] value.
    pub fn parse(value: &str) -> Result<Self> {
        let value = value.trim();
        if let Some(id) = value.strip_prefix("plugin:") {
            return Ok(Self::Plugin(valid_plugin_id(id)?.to_owned()));
        }
        if let Some(name) = value.strip_prefix("component:") {
            return Ok(Self::Component(valid_component(name)?.to_owned()));
        }
        bail!("{SEAL_SCOPE_ENV} must be `plugin:<id>` or `component:<name>`")
    }
}

fn valid_plugin_id(id: &str) -> Result<&str> {
    let id = id.trim();
    if id.is_empty() {
        bail!("a plugin subkey cannot be derived for an empty plugin id");
    }
    Ok(id)
}

fn valid_component(name: &str) -> Result<&str> {
    let name = name.trim();
    let ok = !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if !ok {
        bail!("component names are non-empty lowercase ASCII letters, digits, and '-'");
    }
    Ok(name)
}

/// HKDF-SHA256 subkey for one plugin. Identical to the derivation behind
/// [`crate::plugin_cipher`].
pub(crate) fn derive_plugin_key(master: &[u8; KEY_LEN], plugin_id: &str) -> [u8; KEY_LEN] {
    hkdf_subkey(master, PLUGIN_KDF_SALT, PLUGIN_KDF_INFO_PREFIX, plugin_id)
}

fn derive_component_key(master: &[u8; KEY_LEN], component: &str) -> [u8; KEY_LEN] {
    hkdf_subkey(
        master,
        COMPONENT_KDF_SALT,
        COMPONENT_KDF_INFO_PREFIX,
        component,
    )
}

fn hkdf_subkey(master: &[u8; KEY_LEN], salt: &[u8], prefix: &[u8], id: &str) -> [u8; KEY_LEN] {
    let mut info = Vec::with_capacity(prefix.len() + id.len());
    info.extend_from_slice(prefix);
    info.extend_from_slice(id.as_bytes());
    let mut subkey = [0u8; KEY_LEN];
    hkdf::Hkdf::<sha2::Sha256>::new(Some(salt), master)
        .expand(&info, &mut subkey)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    subkey
}

impl PluginCipher {
    /// Build a plugin cipher from its already-derived subkey (base64, 32 bytes),
    /// as delivered in [`SEAL_KEY_ENV`]. Mainly for tests and cross-language
    /// fixtures; processes call [`plugin_cipher_for_process`].
    pub fn from_subkey_b64(plugin_id: &str, subkey_b64: &str) -> Result<Self> {
        let subkey = decode_key(subkey_b64)
            .ok_or_else(|| anyhow!("a plugin subkey must be base64 of exactly 32 bytes"))?;
        Ok(Self::from_subkeys(
            valid_plugin_id(plugin_id)?,
            subkey,
            Vec::new(),
        ))
    }

    /// A plugin cipher from its subkey and the same plugin's subkeys under
    /// retired master keys (opened, never sealed with).
    pub(crate) fn from_subkeys(
        plugin_id: &str,
        subkey: [u8; KEY_LEN],
        retired: Vec<[u8; KEY_LEN]>,
    ) -> Self {
        Self {
            inner: FieldCipher::new(&subkey).with_retired(&retired),
            plugin_id: plugin_id.to_owned(),
            subkey,
            retired,
        }
    }
}

/// A cipher bound to ONE first-party component (see [`components`]), derived
/// from the master key. Same shape as [`PluginCipher`], separate KDF domain and
/// envelope (`encc:v1:`), so a plugin and a component with the same spelling
/// never share a key.
#[derive(Clone)]
pub struct ComponentCipher {
    inner: FieldCipher,
    component: String,
    /// The subkey, kept to derive this component's content keys.
    pub(crate) subkey: [u8; KEY_LEN],
    /// This component's subkeys under retired master keys: open only.
    pub(crate) retired: Vec<[u8; KEY_LEN]>,
}

impl ComponentCipher {
    #[cfg(test)]
    fn from_master(master: &[u8; KEY_LEN], component: &str) -> Result<Self> {
        let component = valid_component(component)?;
        Ok(Self::from_subkey(
            &derive_component_key(master, component),
            component,
        ))
    }

    fn from_subkey(subkey: &[u8; KEY_LEN], component: &str) -> Self {
        Self::from_subkeys(subkey, Vec::new(), component)
    }

    fn from_subkeys(subkey: &[u8; KEY_LEN], retired: Vec<[u8; KEY_LEN]>, component: &str) -> Self {
        Self {
            inner: FieldCipher::new(subkey).with_retired(&retired),
            component: component.to_owned(),
            subkey: *subkey,
            retired,
        }
    }

    /// Build from an already-derived subkey (base64, 32 bytes). For tests and
    /// fixtures; processes call [`component_cipher_for_process`].
    pub fn from_subkey_b64(component: &str, subkey_b64: &str) -> Result<Self> {
        let subkey = decode_key(subkey_b64)
            .ok_or_else(|| anyhow!("a component subkey must be base64 of exactly 32 bytes"))?;
        Ok(Self::from_subkey(&subkey, valid_component(component)?))
    }

    /// The component this cipher is bound to (diagnostics; no key material).
    pub fn component(&self) -> &str {
        &self.component
    }

    /// Seal a string into the `encc:v1:` envelope under this component's subkey.
    pub fn seal(&self, plaintext: &str) -> Result<String> {
        self.inner
            .seal_with_prefix(COMPONENT_ENVELOPE_PREFIX, plaintext)
    }

    /// Open a stored value: `encc:v1:` is decrypted, a value sealed under
    /// another scheme (`enc:v1:`, `encp:v1:`, `enc:v2:`) is refused, and
    /// anything else is legacy plaintext returned verbatim.
    pub fn open(&self, stored: &str) -> Result<String> {
        if let Some(encoded) = stored.strip_prefix(COMPONENT_ENVELOPE_PREFIX) {
            return self.inner.open_body(encoded).with_context(|| {
                format!(
                    "opening a value sealed for a different key than component '{}'",
                    self.component
                )
            });
        }
        if crate::looks_sealed(stored) {
            bail!(
                "value is sealed under another key scheme, not component '{}''s subkey",
                self.component
            );
        }
        Ok(stored.to_owned())
    }

    /// Whether a stored value carries the component envelope.
    pub fn is_sealed(stored: &str) -> bool {
        stored.starts_with(COMPONENT_ENVELOPE_PREFIX)
    }
}

/// The cipher for `component`, in a process that holds the master key (Core,
/// or a standalone process with an installed host). Fails closed.
pub fn component_cipher(component: &str) -> Result<ComponentCipher> {
    let component = valid_component(component)?;
    let (master, retired) = crate::resolved_master_and_retired()?;
    let retired = retired
        .iter()
        .map(|key| derive_component_key(key, component))
        .collect();
    Ok(ComponentCipher::from_subkeys(
        &derive_component_key(&master, component),
        retired,
        component,
    ))
}

/// The env entries Core sets on a plugin/app child so it can seal its own
/// data: `[(SEAL_KEY_ENV, subkey), (SEAL_SCOPE_ENV, "plugin:<id>")]`, plus
/// [`SEAL_RETIRED_KEYS_ENV`] when the master key has retired predecessors.
///
/// `plugin_id` must be the CANONICAL id (see [`crate::plugin_cipher`]). Fails
/// closed when the master key is unavailable; the caller then omits the
/// entries and the child refuses to write secrets.
pub fn plugin_child_env(plugin_id: &str) -> Result<Vec<(String, String)>> {
    let plugin_id = valid_plugin_id(plugin_id)?;
    let (master, retired) = crate::resolved_master_and_retired()?;
    Ok(child_env(
        &master,
        &retired,
        derive_plugin_key,
        &KeyScope::Plugin(plugin_id.to_owned()),
        plugin_id,
    ))
}

/// The env entries Core sets on a first-party component child it spawns
/// (the Gateway): `[(SEAL_KEY_ENV, subkey), (SEAL_SCOPE_ENV, "component:<name>")]`,
/// plus [`SEAL_RETIRED_KEYS_ENV`] when the master key has retired predecessors.
pub fn component_child_env(component: &str) -> Result<Vec<(String, String)>> {
    let component = valid_component(component)?;
    let (master, retired) = crate::resolved_master_and_retired()?;
    Ok(child_env(
        &master,
        &retired,
        derive_component_key,
        &KeyScope::Component(component.to_owned()),
        component,
    ))
}

fn child_env(
    master: &[u8; KEY_LEN],
    retired_masters: &[[u8; KEY_LEN]],
    derive: fn(&[u8; KEY_LEN], &str) -> [u8; KEY_LEN],
    scope: &KeyScope,
    id: &str,
) -> Vec<(String, String)> {
    let mut env = vec![
        (SEAL_KEY_ENV.to_owned(), b64().encode(derive(master, id))),
        (SEAL_SCOPE_ENV.to_owned(), scope.env_value()),
    ];
    if !retired_masters.is_empty() {
        let retired: Vec<String> = retired_masters
            .iter()
            .map(|key| b64().encode(derive(key, id)))
            .collect();
        env.push((SEAL_RETIRED_KEYS_ENV.to_owned(), retired.join(",")));
    }
    env
}

/// A subkey delivered by the parent process through the environment.
struct Delivered {
    scope: KeyScope,
    key: [u8; KEY_LEN],
    /// The same scope's subkeys under retired master keys.
    retired: Vec<[u8; KEY_LEN]>,
}

/// The delivered key, read once. `Err` holds a message (the error must be
/// cloneable to live in a `OnceLock`); a malformed delivery is an error, never a
/// silent fallback to some other key.
static DELIVERED: OnceLock<std::result::Result<Option<Delivered>, String>> = OnceLock::new();

fn read_delivered(
    key: Option<String>,
    scope: Option<String>,
    retired: Option<String>,
) -> std::result::Result<Option<Delivered>, String> {
    let key = key.filter(|value| !value.trim().is_empty());
    let Some(key) = key else {
        return Ok(None);
    };
    let key =
        decode_key(&key).ok_or_else(|| format!("{SEAL_KEY_ENV} is not base64 of 32 bytes"))?;
    let scope = scope.ok_or_else(|| format!("{SEAL_KEY_ENV} is set without {SEAL_SCOPE_ENV}"))?;
    let scope = KeyScope::parse(&scope).map_err(|error| error.to_string())?;
    let retired = retired
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .split(',')
                .map(|item| {
                    decode_key(item).ok_or_else(|| {
                        format!(
                            "{SEAL_RETIRED_KEYS_ENV} holds a value that is not base64 of 32 bytes"
                        )
                    })
                })
                .collect::<std::result::Result<Vec<_>, String>>()
        })
        .transpose()?
        .unwrap_or_default();
    Ok(Some(Delivered {
        scope,
        key,
        retired,
    }))
}

fn delivered() -> Result<Option<&'static Delivered>> {
    DELIVERED
        .get_or_init(|| {
            read_delivered(
                std::env::var(SEAL_KEY_ENV).ok(),
                std::env::var(SEAL_SCOPE_ENV).ok(),
                std::env::var(SEAL_RETIRED_KEYS_ENV).ok(),
            )
        })
        .as_ref()
        .map(Option::as_ref)
        .map_err(|message| anyhow!("{message}"))
}

/// Read the delivered subkey into memory and REMOVE [`SEAL_KEY_ENV`],
/// [`SEAL_SCOPE_ENV`] and [`SEAL_RETIRED_KEYS_ENV`] from this process's environment, so children this process
/// spawns later do not inherit them. Returns whether a key was delivered.
///
/// Call it first thing in `main`, before any thread starts: changing the
/// environment while another thread reads it is unsound on some platforms.
/// Without the call, the key is still read lazily on first use, but stays in the
/// environment; use [`scrub_seal_env`] on every child command then.
pub fn capture_process_seal_key() -> Result<bool> {
    let delivered = delivered()?.is_some();
    std::env::remove_var(SEAL_KEY_ENV);
    std::env::remove_var(SEAL_SCOPE_ENV);
    std::env::remove_var(SEAL_RETIRED_KEYS_ENV);
    Ok(delivered)
}

/// Remove every key-carrying env var ([`SEAL_ENV_VARS`]) from a child command,
/// so a process never forwards its key to a program it spawns.
pub fn scrub_seal_env(command: &mut std::process::Command) {
    for name in SEAL_ENV_VARS {
        command.env_remove(name);
    }
}

/// `RYU_MASTER_KEY`, decoded, for a process with no installed host.
pub(crate) fn env_master_key() -> Result<Option<[u8; KEY_LEN]>> {
    match std::env::var(ENV_MASTER_KEY) {
        Ok(value) if !value.trim().is_empty() => decode_key(&value)
            .map(Some)
            .ok_or_else(|| anyhow!("{ENV_MASTER_KEY} is not a base64 32-byte key")),
        _ => Ok(None),
    }
}

/// The master key and retired master keys for a process that may not have
/// installed a host: the host's resolution when one is installed, else
/// `RYU_MASTER_KEY` (no retired keys). `None` when neither.
fn process_master_key() -> Result<Option<([u8; KEY_LEN], Vec<[u8; KEY_LEN]>)>> {
    if host_slot().get().is_some() {
        return crate::resolved_master_and_retired().map(Some);
    }
    Ok(env_master_key()?.map(|master| (master, Vec::new())))
}

fn no_key_error(scope: &KeyScope) -> anyhow::Error {
    anyhow!(
        "no sealing key for {}: start this process from Core (which sets {SEAL_KEY_ENV}), \
         set {ENV_MASTER_KEY}, or install a CryptoHost (see install_standalone_host)",
        scope.env_value()
    )
}

/// The subkey for `scope` and its retired predecessors, from the delivered keys
/// or the process's master key.
fn process_subkey(
    scope: &KeyScope,
    derive: fn(&[u8; KEY_LEN], &str) -> [u8; KEY_LEN],
    id: &str,
) -> Result<([u8; KEY_LEN], Vec<[u8; KEY_LEN]>)> {
    subkey_from(delivered()?, process_master_key, scope, derive, id)
}

fn subkey_from(
    delivered: Option<&Delivered>,
    master: impl FnOnce() -> Result<Option<([u8; KEY_LEN], Vec<[u8; KEY_LEN]>)>>,
    scope: &KeyScope,
    derive: fn(&[u8; KEY_LEN], &str) -> [u8; KEY_LEN],
    id: &str,
) -> Result<([u8; KEY_LEN], Vec<[u8; KEY_LEN]>)> {
    if let Some(delivered) = delivered {
        if &delivered.scope != scope {
            bail!(
                "{SEAL_KEY_ENV} was delivered for {}, not {}",
                delivered.scope.env_value(),
                scope.env_value()
            );
        }
        return Ok((delivered.key, delivered.retired.clone()));
    }
    match master()? {
        Some((master, retired)) => Ok((
            derive(&master, id),
            retired.iter().map(|key| derive(key, id)).collect(),
        )),
        None => Err(no_key_error(scope)),
    }
}

/// The sealing cipher for a plugin or app satellite's OWN process (a sidecar or
/// backend Core spawned, or the same binary started by hand).
///
/// Resolution: the subkey Core delivered ([`SEAL_KEY_ENV`], scope must be
/// `plugin:<plugin_id>`) → the installed host's master key → `RYU_MASTER_KEY`.
/// Fails closed when none is available: the caller must then refuse to store a
/// secret rather than store it in plaintext. `plugin_id` is the canonical id.
pub fn plugin_cipher_for_process(plugin_id: &str) -> Result<PluginCipher> {
    let plugin_id = valid_plugin_id(plugin_id)?;
    let scope = KeyScope::Plugin(plugin_id.to_owned());
    let (subkey, retired) = process_subkey(&scope, derive_plugin_key, plugin_id)?;
    Ok(PluginCipher::from_subkeys(plugin_id, subkey, retired))
}

/// The sealing cipher for a first-party component's own process (the Gateway).
///
/// Resolution: the subkey Core delivered ([`SEAL_KEY_ENV`], scope must be
/// `component:<component>`) → the installed host's master key (a standalone
/// Gateway installs [`crate::StandaloneCryptoHost`]) → `RYU_MASTER_KEY`. Every
/// path yields the same subkey for the same master key. Fails closed.
pub fn component_cipher_for_process(component: &str) -> Result<ComponentCipher> {
    let component = valid_component(component)?;
    let scope = KeyScope::Component(component.to_owned());
    let (subkey, retired) = process_subkey(&scope, derive_component_key, component)?;
    Ok(ComponentCipher::from_subkeys(&subkey, retired, component))
}

/// Envelope prefix of cloud-only Mongo field sealing (AES-256-GCM, per-tenant
/// keys). Never produced in Rust; recognised so it is never mistaken for
/// plaintext.
const CLOUD_CONTENT_ENVELOPE_PREFIX: &str = "encm:v1:";

/// Whether a stored value carries ANY Ryu envelope (`enc:v1:`, `enc:v2:`,
/// `encp:v1:`, `encc:v1:`, the content envelope `encb:v1:`, or the cloud
/// `encm:v1:`). A reader uses it to tell legacy plaintext (accept, reseal on
/// next write) from a sealed value (must open, or fail).
pub fn looks_sealed(stored: &str) -> bool {
    [
        ENVELOPE_PREFIX,
        BOUND_ENVELOPE_PREFIX,
        PLUGIN_ENVELOPE_PREFIX,
        COMPONENT_ENVELOPE_PREFIX,
        crate::content::CONTENT_TEXT_PREFIX,
        CLOUD_CONTENT_ENVELOPE_PREFIX,
    ]
    .iter()
    .any(|prefix| stored.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MASTER: [u8; KEY_LEN] = [7u8; KEY_LEN];

    #[test]
    fn scope_wire_values_round_trip_and_reject_garbage() {
        for scope in [
            KeyScope::Plugin("@ryu/mail".into()),
            KeyScope::Component("gateway".into()),
        ] {
            assert_eq!(KeyScope::parse(&scope.env_value()).unwrap(), scope);
        }
        assert!(KeyScope::parse("gateway").is_err());
        assert!(KeyScope::parse("plugin:").is_err());
        assert!(KeyScope::parse("component:Gate Way").is_err());
    }

    #[test]
    fn the_delivered_plugin_subkey_is_the_bridge_subkey() {
        // A satellite holding the env-delivered subkey must read what its UI frame
        // sealed through host.crypto (crate::plugin_cipher), and vice versa.
        let bridge = crate::derive_plugin_cipher(&MASTER, "@ryu/mail").unwrap();
        let delivered = PluginCipher::from_subkey_b64(
            "@ryu/mail",
            &b64().encode(derive_plugin_key(&MASTER, "@ryu/mail")),
        )
        .unwrap();
        let sealed = bridge.seal("smtp-password").unwrap();
        assert_eq!(delivered.open(&sealed).unwrap(), "smtp-password");
        let sealed = delivered.seal("imap-token").unwrap();
        assert_eq!(bridge.open(&sealed).unwrap(), "imap-token");
    }

    #[test]
    fn component_keys_are_separate_from_plugin_and_master_keys() {
        let gateway = ComponentCipher::from_master(&MASTER, "gateway").unwrap();
        let sealed = gateway.seal("sk-live-123").unwrap();
        assert!(sealed.starts_with(COMPONENT_ENVELOPE_PREFIX));
        assert!(!sealed.contains("sk-live-123"));
        assert!(looks_sealed(&sealed));
        assert_eq!(gateway.open(&sealed).unwrap(), "sk-live-123");

        // The same spelling as a plugin id derives a different key.
        assert_ne!(
            derive_component_key(&MASTER, "gateway"),
            derive_plugin_key(&MASTER, "gateway")
        );
        // A master-key cipher passes the unknown envelope through as text; it
        // can never decrypt it.
        assert_eq!(FieldCipher::new(&MASTER).open(&sealed).unwrap(), sealed);
        // Other schemes are refused, not passed through.
        let master_sealed = FieldCipher::new(&MASTER).seal("x").unwrap();
        assert!(gateway.open(&master_sealed).is_err());
        let plugin_sealed = crate::derive_plugin_cipher(&MASTER, "gateway")
            .unwrap()
            .seal("x")
            .unwrap();
        assert!(gateway.open(&plugin_sealed).is_err());
        // Another component cannot open it.
        let other = ComponentCipher::from_master(&MASTER, "channels").unwrap();
        assert!(other.open(&sealed).is_err());
        // Legacy plaintext passes through for lazy migration.
        assert_eq!(gateway.open("legacy").unwrap(), "legacy");
    }

    #[test]
    fn the_child_env_carries_the_derived_subkey_and_scope() {
        let env = child_env(
            &MASTER,
            &[],
            derive_component_key,
            &KeyScope::Component("gateway".into()),
            "gateway",
        );
        // No retired keys: no retired-keys entry.
        assert_eq!(env.len(), 2);
        let delivered = read_delivered(Some(env[0].1.clone()), Some(env[1].1.clone()), None)
            .unwrap()
            .unwrap();
        assert!(delivered.retired.is_empty());
        assert_eq!(delivered.scope, KeyScope::Component("gateway".into()));
        // The child, holding only the subkey, opens what the parent's derivation
        // sealed: the delivery path and the standalone path agree.
        let parent = ComponentCipher::from_master(&MASTER, "gateway").unwrap();
        let child = ComponentCipher::from_subkey(&delivered.key, "gateway");
        assert_eq!(child.open(&parent.seal("v").unwrap()).unwrap(), "v");
        // The env never carries the master key itself.
        assert!(env.iter().all(|(_, value)| value != &b64().encode(MASTER)));
    }

    /// Keys of a child after its master key was replaced: `B` current, `A`
    /// retired, through Core's delivery and through a standalone resolution.
    fn after_key_adopt(scope: &KeyScope, id: &str) -> [([u8; KEY_LEN], Vec<[u8; KEY_LEN]>); 2] {
        const A: [u8; KEY_LEN] = [1; KEY_LEN];
        const B: [u8; KEY_LEN] = [2; KEY_LEN];
        let derive = match scope {
            KeyScope::Plugin(_) => derive_plugin_key,
            KeyScope::Component(_) => derive_component_key,
        };
        let env = child_env(&B, &[A], derive, scope, id);
        let value = |name: &str| {
            env.iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        };
        // The retired subkey travels; the retired MASTER key never does.
        let retired_env = value(SEAL_RETIRED_KEYS_ENV).unwrap();
        assert!(!retired_env.contains(&b64().encode(A)));
        let delivered = read_delivered(
            value(SEAL_KEY_ENV),
            value(SEAL_SCOPE_ENV),
            Some(retired_env),
        )
        .unwrap()
        .unwrap();
        let from_core =
            subkey_from(Some(&delivered), || unreachable!(), scope, derive, id).unwrap();
        let standalone = subkey_from(None, || Ok(Some((B, vec![A]))), scope, derive, id).unwrap();
        assert_eq!(from_core, standalone);
        assert_eq!(from_core.1, vec![derive(&A, id)]);
        [from_core, standalone]
    }

    #[test]
    fn process_ciphers_open_what_they_sealed_under_a_retired_master_key() {
        let scope = KeyScope::Plugin("@ryu/mail".into());
        let before = crate::derive_plugin_cipher(&[1; KEY_LEN], "@ryu/mail").unwrap();
        let secret = before.seal("smtp-password").unwrap();
        let row = crate::ContentContext::for_id("items.body", "1");
        let content = before
            .content_cipher("mail.db")
            .seal_text("subject", &row)
            .unwrap();
        for (subkey, retired) in after_key_adopt(&scope, "@ryu/mail") {
            let after = PluginCipher::from_subkeys("@ryu/mail", subkey, retired);
            assert_eq!(after.open(&secret).unwrap(), "smtp-password");
            let store = after.content_cipher("mail.db");
            let opened = store.open_text(&content, &row).unwrap();
            assert_eq!(opened.value, "subject");
            assert!(opened.needs_reseal);
            assert_eq!(store.match_kcv(&before.kcv()), crate::KcvMatch::Retired);
            assert_eq!(store.kcv(), after.kcv());
        }

        let scope = KeyScope::Component("gateway".into());
        let before = ComponentCipher::from_master(&[1; KEY_LEN], "gateway").unwrap();
        let secret = before.seal("sk-live").unwrap();
        for (subkey, retired) in after_key_adopt(&scope, "gateway") {
            let after = ComponentCipher::from_subkeys(&subkey, retired, "gateway");
            assert_eq!(after.open(&secret).unwrap(), "sk-live");
            assert_eq!(
                after.content_cipher("spend.db").match_kcv(&before.kcv()),
                crate::KcvMatch::Retired
            );
        }
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn a_component_store_sealed_before_a_key_adopt_is_retired_then_resealed_to_current() {
        use crate::content_sqlite::{
            check_store_key, enable_secure_delete, migrate_columns, reset_items, ColumnPlan,
            KeyKind, StoreKeyState,
        };
        let dir = tempfile::tempdir().unwrap();
        let mut conn = rusqlite::Connection::open(dir.path().join("spend.db")).unwrap();
        conn.execute_batch("CREATE TABLE spend (id TEXT PRIMARY KEY, note TEXT);")
            .unwrap();
        enable_secure_delete(&conn).unwrap();
        let plans = [ColumnPlan::text("spend", "note", "id", KeyKind::Text).unwrap()];

        // Sealed by the Gateway under the subkey of master A.
        let before = ComponentCipher::from_master(&[1; KEY_LEN], "gateway")
            .unwrap()
            .content_cipher("spend.db");
        assert_eq!(
            check_store_key(&conn, &before).unwrap(),
            StoreKeyState::Recorded
        );
        let sealed = before
            .seal_text(
                "gpt call",
                &crate::ContentContext::for_id("spend.note", "r1"),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO spend (id, note) VALUES ('r1', ?1)",
            rusqlite::params![sealed],
        )
        .unwrap();

        // After `keys adopt` (B current, A retired) the Gateway restarts.
        let [(subkey, retired), _] =
            after_key_adopt(&KeyScope::Component("gateway".into()), "gateway");
        let after =
            ComponentCipher::from_subkeys(&subkey, retired, "gateway").content_cipher("spend.db");
        assert_eq!(
            check_store_key(&conn, &after).unwrap(),
            StoreKeyState::Retired
        );
        reset_items(&conn, after.store(), &plans).unwrap();
        let report = migrate_columns(&mut conn, &after, &plans).unwrap();
        assert_eq!((report.sealed, report.unreadable), (1, 0));
        assert_eq!(
            check_store_key(&conn, &after).unwrap(),
            StoreKeyState::Current
        );
        crate::content_sqlite::assert_all_open(&conn, &after, &plans).unwrap();
    }

    #[test]
    fn malformed_or_unscoped_deliveries_fail_instead_of_falling_back() {
        assert!(read_delivered(None, None, None).unwrap().is_none());
        assert!(read_delivered(Some("  ".into()), None, None)
            .unwrap()
            .is_none());
        assert!(read_delivered(
            Some("not-base64!".into()),
            Some("component:gateway".into()),
            None
        )
        .is_err());
        let key = b64().encode([1u8; KEY_LEN]);
        assert!(read_delivered(Some(key.clone()), None, None).is_err());
        assert!(read_delivered(Some(key.clone()), Some("bogus".into()), None).is_err());
        // A malformed retired key is an error too, never silently dropped.
        assert!(read_delivered(
            Some(key.clone()),
            Some("component:gateway".into()),
            Some(format!("{key},short"))
        )
        .is_err());
    }

    /// Cross-language fixture: master key `[7; 32]`, plugin `@ryu/forms`, value
    /// sealed by an independent implementation (Python `cryptography`) with a
    /// fixed nonce. The TypeScript helper in `packages/sidecar-runtime` asserts
    /// the same vector, so all three agree on KDF, AEAD, and envelope layout.
    pub(crate) const FORMS_SUBKEY_B64: &str = "9mkpBp6aF4R2Ik7g9laiJVWhDFYQUz6E5u9jB+Lak9w=";
    const FORMS_SEALED: &str = "encp:v1:AAECAwQFBgcICQoL1nNMTWwoK3z4Hm2Ay9qBARr3Zp4hKiyv/g==";

    #[test]
    fn the_plugin_envelope_matches_the_cross_language_fixture() {
        assert_eq!(
            b64().encode(derive_plugin_key(&MASTER, "@ryu/forms")),
            FORMS_SUBKEY_B64
        );
        let cipher = crate::derive_plugin_cipher(&MASTER, "@ryu/forms").unwrap();
        assert_eq!(cipher.open(FORMS_SEALED).unwrap(), "py-sealed");
    }

    #[test]
    fn looks_sealed_knows_every_envelope_and_nothing_else() {
        assert!(looks_sealed("enc:v1:abc"));
        assert!(looks_sealed("enc:v2:abc"));
        assert!(looks_sealed("encp:v1:abc"));
        assert!(looks_sealed("encc:v1:abc"));
        assert!(looks_sealed("encb:v1:abc"));
        assert!(looks_sealed("encm:v1:abc"));
        assert!(!looks_sealed("sk-plain"));
        assert!(!looks_sealed(""));
    }
}
