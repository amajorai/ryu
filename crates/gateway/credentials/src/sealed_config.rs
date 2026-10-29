//! Field-level sealing of the secrets in `gateway.toml`.
//!
//! Core and the Gateway both read and write the same authored file. Every
//! credential leaf in it (provider keys, cloud-speech tokens, web-service
//! accounts, client API keys, the admin master key, channel bot secrets, and
//! service secrets), plus the phone numbers of a phone line's caller allowlist
//! and hand-off target, is stored as an `encc:v1:` envelope sealed with the
//! Gateway's component subkey (`ryu_crypto::components::GATEWAY`). Everything
//! else in the file stays readable TOML, so non-secret readers (routing, ACP,
//! firewall) keep parsing it unchanged.
//!
//! * Reads accept legacy plaintext and sealed leaves. [`open_text`] needs a key
//!   only when the file actually holds a sealed leaf.
//! * Writes go through [`crate::ConfigFileTransaction::commit`], which seals
//!   every plaintext secret leaf before the bytes reach disk and fails closed
//!   when no key is available (unless the leaf was already stored that way, so
//!   an operator's hand-authored plaintext file stays editable without a key
//!   until a key is configured; no NEW secret is ever written in plaintext).
//! * A host may install a [`WriteGate`] (Core does, for an externally managed
//!   Gateway). It runs before a write seals a new secret into a file that holds
//!   no sealed leaf yet, and can refuse that write when the process that reads
//!   the file may not hold the key ([`SealedConfigError::WriteBlocked`]).
//! * Account ids are derived from the plaintext, so they do not change when a
//!   key is sealed: every reader opens the file before hashing.
//!
//! Sealing edits only the secret string values; comments, ordering and layout
//! of the authored file are preserved (`toml_edit`).

use std::borrow::Cow;
use std::collections::BTreeSet;
use std::fmt;
use std::sync::{Arc, OnceLock};

use ryu_crypto::{looks_sealed, SealScope, SecretSealer};
use toml_edit::{DocumentMut, Item, Table, Value};

/// Secret keys anywhere under `[providers]` (native, compatible, GenAI SDK
/// accounts, web-service accounts, Google Cloud TTS and Amazon Polly accounts).
const PROVIDER_SECRET_KEYS: &[&str] = &[
    "api_key",
    "api_keys",
    "org_api_keys",
    "access_token",
    "access_key_id",
    "secret_access_key",
    "session_token",
];

/// Personal data leaves sealed like credentials: a phone line's inbound caller
/// allowlist and its owner hand-off number (E.164 phone numbers of real people).
/// They are opened for every reader exactly as secrets are, and unlike secrets
/// the Gateway's config view shows them to the owner. The line's own
/// `twilio_number` and `caller_id`, and firewall patterns, stay readable TOML.
const PHONE_LINE_PII_KEYS: &[&str] = &["allowed_callers", "transfer_to"];

/// Whether the dotted table path (array indices omitted) names a credential or
/// personal-data leaf in `gateway.toml`. A string, every string in an array,
/// and every string value of a table at such a path is sealed.
pub fn is_secret_path<S: AsRef<str>>(path: &[S]) -> bool {
    let path: Vec<&str> = path.iter().map(AsRef::as_ref).collect();
    match path.as_slice() {
        ["auth", "master_key"]
        | ["auth", "api_keys", "key"]
        | ["composio", "api_key"]
        | ["control_plane", "gateway_key"]
        | ["credits", "internal_secret"]
        | ["compression", "token"]
        | ["channels", "telegram", "token"]
        | ["channels", "telegram", "options", "webhook_secret"]
        | ["channels", "slack", "app_token" | "bot_token"]
        | ["channels", "discord", "token"]
        | ["channels", "whatsapp", "access_token" | "verify_token" | "app_secret"]
        | ["channels", "bluebubbles", "password"]
        | ["providers", "core", "token"]
        | ["providers", "genai", "keys" | "gemini_api_keys"] => true,
        ["providers", _, .., last] => PROVIDER_SECRET_KEYS.contains(last),
        ["channels", "phone_calls", "lines", last] => PHONE_LINE_PII_KEYS.contains(last),
        _ => false,
    }
}

/// Why a `gateway.toml` could not be opened or sealed. Never carries file
/// content or key material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SealedConfigError {
    /// Not UTF-8 TOML.
    Syntax,
    /// The file holds sealed secrets (or a secret must be sealed) and no Gateway
    /// sealing key is available in this process.
    KeyUnavailable(String),
    /// A sealed secret could not be opened (wrong key, corrupt, or another
    /// scheme's envelope).
    Open,
    /// A secret could not be sealed.
    Seal,
    /// The installed [`WriteGate`] refused to seal a new secret into this file;
    /// the message says what the operator must do first.
    WriteBlocked(String),
}

impl fmt::Display for SealedConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Syntax => formatter.write_str("gateway configuration is not valid TOML"),
            Self::KeyUnavailable(reason) => write!(
                formatter,
                "gateway configuration secrets need the Gateway sealing key, which is \
                 unavailable: {reason}"
            ),
            Self::Open => formatter.write_str(
                "a sealed gateway configuration secret could not be opened with this key",
            ),
            Self::Seal => formatter.write_str("a gateway configuration secret could not be sealed"),
            Self::WriteBlocked(reason) => formatter.write_str(reason),
        }
    }
}

impl std::error::Error for SealedConfigError {}

/// The Gateway's sealing cipher in this process: the subkey Core delivered to
/// a Core-spawned Gateway, or the subkey derived from the master key this
/// process can resolve (Core itself, a standalone Gateway with
/// `RYU_MASTER_KEY`). Fails closed.
pub fn config_sealer() -> Result<Arc<dyn SecretSealer>, SealedConfigError> {
    ryu_crypto::GatewayScope::sealer()
        .map_err(|error| SealedConfigError::KeyUnavailable(error.to_string()))
}

/// A host check run before a write seals a new secret into a file that holds
/// no sealed leaf yet. `Err` carries an operator-facing reason and refuses the
/// write; secrets already stored in plaintext may still be written back as
/// they are. A file that already holds a sealed leaf is read by a process with
/// the key, so the gate is not consulted for it.
pub type WriteGate = fn() -> Result<(), String>;

static WRITE_GATE: OnceLock<WriteGate> = OnceLock::new();

/// Install the process-wide [`WriteGate`]. The first install wins.
pub fn install_write_gate(gate: WriteGate) {
    let _ = WRITE_GATE.set(gate);
}

/// The sealer source used by [`crate::ConfigFileTransaction::commit`]: runs
/// `gate` (when the file on disk holds no sealed leaf) before resolving the key
/// through `inner`.
pub fn gated_sealer<'a>(
    gate: Option<WriteGate>,
    current: Option<&[u8]>,
    inner: &'a dyn Fn() -> Result<Arc<dyn SecretSealer>, SealedConfigError>,
) -> impl Fn() -> Result<Arc<dyn SecretSealer>, SealedConfigError> + 'a {
    let file_has_sealed = current
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .and_then(|text| census(text).ok())
        .is_some_and(|census| census.sealed > 0);
    move || {
        if let Some(gate) = gate.filter(|_| !file_has_sealed) {
            gate().map_err(SealedConfigError::WriteBlocked)?;
        }
        inner()
    }
}

pub(crate) fn installed_write_gate() -> Option<WriteGate> {
    WRITE_GATE.get().copied()
}

/// How many secret leaves a file holds, by stored form.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SecretCensus {
    /// Leaves stored as an envelope.
    pub sealed: usize,
    /// Non-empty leaves stored as legacy plaintext.
    pub plaintext: usize,
}

fn parse(text: &str) -> Result<DocumentMut, SealedConfigError> {
    text.parse::<DocumentMut>()
        .map_err(|_| SealedConfigError::Syntax)
}

type LeafFn<'a> = dyn FnMut(&str) -> Result<Option<String>, SealedConfigError> + 'a;

fn replace_string(value: &mut Value, next: String) {
    let decor = value.decor().clone();
    let mut formatted = toml_edit::Formatted::new(next);
    *formatted.decor_mut() = decor;
    *value = Value::String(formatted);
}

fn apply_secret_value(value: &mut Value, leaf: &mut LeafFn<'_>) -> Result<(), SealedConfigError> {
    match value {
        Value::String(current) => {
            if let Some(next) = leaf(current.value())? {
                replace_string(value, next);
            }
        }
        Value::Array(values) => {
            for value in values.iter_mut() {
                apply_secret_value(value, leaf)?;
            }
        }
        Value::InlineTable(table) => {
            for (_, value) in table.iter_mut() {
                apply_secret_value(value, leaf)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn apply_secret_item(item: &mut Item, leaf: &mut LeafFn<'_>) -> Result<(), SealedConfigError> {
    match item {
        Item::Value(value) => apply_secret_value(value, leaf),
        Item::Table(table) => {
            for (_, item) in table.iter_mut() {
                apply_secret_item(item, leaf)?;
            }
            Ok(())
        }
        Item::ArrayOfTables(_) | Item::None => Ok(()),
    }
}

fn walk_value(
    value: &mut Value,
    path: &mut Vec<String>,
    leaf: &mut LeafFn<'_>,
) -> Result<(), SealedConfigError> {
    match value {
        Value::InlineTable(table) => {
            for (key, value) in table.iter_mut() {
                path.push(key.get().to_owned());
                let result = if is_secret_path(path) {
                    apply_secret_value(value, leaf)
                } else {
                    walk_value(value, path, leaf)
                };
                path.pop();
                result?;
            }
        }
        Value::Array(values) => {
            for value in values.iter_mut() {
                walk_value(value, path, leaf)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn walk_table(
    table: &mut Table,
    path: &mut Vec<String>,
    leaf: &mut LeafFn<'_>,
) -> Result<(), SealedConfigError> {
    for (key, item) in table.iter_mut() {
        path.push(key.get().to_owned());
        let result = if is_secret_path(path) {
            apply_secret_item(item, leaf)
        } else {
            walk_item(item, path, leaf)
        };
        path.pop();
        result?;
    }
    Ok(())
}

fn walk_item(
    item: &mut Item,
    path: &mut Vec<String>,
    leaf: &mut LeafFn<'_>,
) -> Result<(), SealedConfigError> {
    match item {
        Item::Table(table) => walk_table(table, path, leaf),
        Item::ArrayOfTables(tables) => {
            for table in tables.iter_mut() {
                walk_table(table, path, leaf)?;
            }
            Ok(())
        }
        Item::Value(value) => walk_value(value, path, leaf),
        Item::None => Ok(()),
    }
}

fn visit(document: &mut DocumentMut, leaf: &mut LeafFn<'_>) -> Result<(), SealedConfigError> {
    walk_table(document.as_table_mut(), &mut Vec::new(), leaf)
}

/// Count the secret leaves of `text` by stored form. Needs no key.
pub fn census(text: &str) -> Result<SecretCensus, SealedConfigError> {
    let mut document = parse(text)?;
    let mut census = SecretCensus::default();
    visit(&mut document, &mut |stored| {
        if looks_sealed(stored) {
            census.sealed += 1;
        } else if !stored.is_empty() {
            census.plaintext += 1;
        }
        Ok(None)
    })?;
    Ok(census)
}

/// The non-empty secret values `text` stores in plaintext. Needs no key.
pub fn plaintext_secret_values(text: &str) -> Result<BTreeSet<String>, SealedConfigError> {
    let mut document = parse(text)?;
    let mut values = BTreeSet::new();
    visit(&mut document, &mut |stored| {
        if !stored.is_empty() && !looks_sealed(stored) {
            values.insert(stored.to_owned());
        }
        Ok(None)
    })?;
    Ok(values)
}

/// `text` with every sealed secret leaf opened, using `sealer`.
pub fn open_text_with(text: &str, sealer: &dyn SecretSealer) -> Result<String, SealedConfigError> {
    let mut document = parse(text)?;
    visit(&mut document, &mut |stored| {
        if !looks_sealed(stored) {
            return Ok(None);
        }
        sealer
            .open(stored)
            .map(Some)
            .map_err(|_| SealedConfigError::Open)
    })?;
    Ok(document.to_string())
}

/// `text` with every sealed secret leaf opened. Borrowed (and no key resolved)
/// when the file holds no sealed leaf, so a legacy or secret-free file parses
/// exactly as before.
pub fn open_text(text: &str) -> Result<Cow<'_, str>, SealedConfigError> {
    if census(text)?.sealed == 0 {
        return Ok(Cow::Borrowed(text));
    }
    let sealer = config_sealer()?;
    open_text_with(text, sealer.as_ref()).map(Cow::Owned)
}

/// [`open_text`] parsed into a `toml::Value`, for untyped editors.
pub fn open_document(text: &str) -> Result<toml::Value, SealedConfigError> {
    let opened = open_text(text)?;
    toml::from_str(&opened).map_err(|_| SealedConfigError::Syntax)
}

/// `text` with every plaintext secret leaf sealed by `sealer`. Already-sealed
/// leaves are kept byte for byte; another scheme's envelope is an error.
pub fn seal_text_with(text: &str, sealer: &dyn SecretSealer) -> Result<String, SealedConfigError> {
    let mut document = parse(text)?;
    visit(&mut document, &mut |stored| {
        sealer
            .reseal_if_plaintext(stored)
            .map_err(|_| SealedConfigError::Seal)
    })?;
    Ok(document.to_string())
}

/// Prepare authored bytes for disk: plaintext secret leaves are sealed.
///
/// * Bytes that are not UTF-8 TOML, or hold no plaintext secret, are written
///   verbatim (`Cow::Borrowed`).
/// * When `current` (the bytes on disk) opens to the same document as `bytes`
///   and holds no plaintext secret, `Ok(None)`: the commit is a no-op, so an
///   unchanged save does not churn nonces and revisions.
/// * Without a key, plaintext secrets that are already stored in plaintext in
///   `current` (an operator's hand-authored file) are written back unchanged;
///   any other plaintext secret fails closed.
pub(crate) fn prepare_for_disk<'a>(
    current: Option<&[u8]>,
    bytes: &'a [u8],
    sealer: &dyn Fn() -> Result<Arc<dyn SecretSealer>, SealedConfigError>,
) -> Result<Option<Cow<'a, [u8]>>, SealedConfigError> {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Ok(Some(Cow::Borrowed(bytes)));
    };
    let Ok(incoming) = census(text) else {
        return Ok(Some(Cow::Borrowed(bytes)));
    };
    if incoming.plaintext == 0 {
        return Ok(Some(Cow::Borrowed(bytes)));
    }
    let current_text = current.and_then(|bytes| std::str::from_utf8(bytes).ok());
    let sealer = match sealer() {
        Ok(sealer) => sealer,
        Err(error) => {
            let already_plaintext = current_text
                .and_then(|text| plaintext_secret_values(text).ok())
                .unwrap_or_default();
            let incoming_values = plaintext_secret_values(text)?;
            if incoming_values.is_subset(&already_plaintext) {
                return Ok(Some(Cow::Borrowed(bytes)));
            }
            return Err(error);
        }
    };
    if let Some(current_text) = current_text {
        if census(current_text).is_ok_and(|census| census.plaintext == 0) {
            let same = open_text_with(current_text, sealer.as_ref())
                .ok()
                .and_then(|opened| toml::from_str::<toml::Value>(&opened).ok())
                .zip(
                    open_text_with(text, sealer.as_ref())
                        .ok()
                        .and_then(|opened| toml::from_str::<toml::Value>(&opened).ok()),
                )
                .is_some_and(|(current, incoming)| current == incoming);
            if same {
                return Ok(None);
            }
        }
    }
    seal_text_with(text, sealer.as_ref()).map(|sealed| Some(Cow::Owned(sealed.into_bytes())))
}

/// One-time migration: seal every plaintext secret leaf of the file at `path`
/// in place (comments and layout kept). `Ok(true)` when the file was rewritten;
/// `Ok(false)` when it had nothing to seal or no key is available (the file is
/// then left as it is and the next keyed write seals it).
pub fn reseal_file(path: &std::path::Path) -> Result<bool, crate::ConfigCommitError> {
    reseal_file_with(path, &config_sealer)
}

/// [`reseal_file`] with an explicit sealer source.
pub fn reseal_file_with(
    path: &std::path::Path,
    sealer: &dyn Fn() -> Result<Arc<dyn SecretSealer>, SealedConfigError>,
) -> Result<bool, crate::ConfigCommitError> {
    let mut transaction = crate::ConfigFileTransaction::acquire(path)?;
    if !transaction.snapshot().exists() {
        return Ok(false);
    }
    let Ok(text) = std::str::from_utf8(transaction.snapshot().bytes()) else {
        return Ok(false);
    };
    if census(text).map_or(true, |census| census.plaintext == 0) {
        return Ok(false);
    }
    let text = text.to_owned();
    let revision = transaction.snapshot().revision().clone();
    let next = transaction.commit_with_sealer(&revision, text.as_bytes(), sealer)?;
    Ok(next != revision)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) const TEST_SUBKEY: &str = "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=";

    pub(crate) fn test_sealer() -> Arc<dyn SecretSealer> {
        Arc::new(
            ryu_crypto::ComponentCipher::from_subkey_b64(
                ryu_crypto::components::GATEWAY,
                TEST_SUBKEY,
            )
            .unwrap(),
        )
    }

    const SECRETS: &[&str] = &[
        "sk-openai-primary",
        "sk-openai-extra",
        "sk-compat-key",
        "gemini-sdk-key",
        "legacy-groq",
        "legacy-gemini-extra",
        "brave-web-key",
        "ya29.google-token",
        "AKIAPOLLYID",
        "polly-secret",
        "polly-session",
        "or-org-key",
        "core-node-token",
        "gw_client_key",
        "gwadm_master",
        "composio-key",
        "cp-gateway-key",
        "credits-internal",
        "compress-token",
        "123:telegram",
        "tg-webhook-secret",
        "xapp-slack",
        "xoxb-slack",
        "discord-token",
        "wa-access",
        "wa-verify",
        "wa-app-secret",
        "bb-password",
        "+14155550111",
        "+14155550122",
        "+14155550133",
    ];

    pub(crate) const FIXTURE: &str = r#"# operator comment kept
bind = "127.0.0.1:7981"

[auth]
require_auth = true
master_key = "gwadm_master"

[[auth.api_keys]]
key = "gw_client_key" # trailing comment kept
name = "laptop"

[routing]
default_provider = "openai"

[providers.openai]
api_key = "sk-openai-primary"
api_keys = ["sk-openai-extra"]
base_url = "https://api.openai.com/v1"

[providers.openrouter]
api_key = ""
org_api_keys = { acme = "or-org-key" }

[providers.core]
token = "core-node-token"

[providers.compatible.together]
api_key = "sk-compat-key"

[providers.genai.accounts.gemini]
api_key = "gemini-sdk-key"

[providers.genai.keys]
groq = "legacy-groq"

[providers.genai2]
gemini_api_keys = ["not-a-secret-path"]

[providers.genai_legacy_layout]
note = "plain"

[[providers.web.brave.accounts]]
api_key = "brave-web-key"

[[providers.google_tts.accounts]]
access_token = "ya29.google-token"
quota_project = "my-project"

[[providers.polly.accounts]]
access_key_id = "AKIAPOLLYID"
secret_access_key = "polly-secret"
session_token = "polly-session"
region = "us-east-1"

[composio]
api_key = "composio-key"

[control_plane]
gateway_key = "cp-gateway-key"

[credits]
internal_secret = "credits-internal"

[compression]
token = "compress-token"

[channels.telegram]
token = "123:telegram"
options = { webhook_secret = "tg-webhook-secret", webhook_url = "https://example.test/hook" }

[channels.slack]
app_token = "xapp-slack"
bot_token = "xoxb-slack"

[channels.discord]
token = "discord-token"

[channels.whatsapp]
access_token = "wa-access"
verify_token = "wa-verify"
app_secret = "wa-app-secret"

[channels.bluebubbles]
password = "bb-password"
server_url = "http://mac.local:1234"

[[channels.phone_calls.lines]]
id = "home"
twilio_number = "+14155550100"
transfer_to = "+14155550111"
allowed_callers = ["+14155550122", "+14155550133"]
"#;

    fn with_legacy_gemini_extras(text: &str) -> String {
        text.replace(
            "[providers.genai.keys]",
            "[providers.genai]\ngemini_api_keys = [\"legacy-gemini-extra\"]\n\n[providers.genai.keys]",
        )
    }

    #[test]
    fn every_secret_leaf_is_sealed_and_layout_is_kept() {
        let sealer = test_sealer();
        let fixture = with_legacy_gemini_extras(FIXTURE);
        let sealed = seal_text_with(&fixture, sealer.as_ref()).unwrap();
        for secret in SECRETS {
            assert!(
                !sealed.contains(secret),
                "{secret} reached disk in plaintext"
            );
        }
        assert!(sealed.contains("# operator comment kept"));
        assert!(sealed.contains("# trailing comment kept"));
        assert!(sealed.contains("base_url = \"https://api.openai.com/v1\""));
        assert!(sealed.contains("quota_project = \"my-project\""));
        assert!(sealed.contains("webhook_url = \"https://example.test/hook\""));
        assert!(sealed.contains("not-a-secret-path"));
        assert!(sealed.contains("api_key = \"\""), "empty stays unset");
        assert!(
            sealed.contains("twilio_number = \"+14155550100\""),
            "the line's own number stays readable"
        );
        let census = census(&sealed).unwrap();
        assert_eq!(census.plaintext, 0);
        assert_eq!(census.sealed, SECRETS.len());
        // Round trip: the opened document equals the original.
        let opened = open_text_with(&sealed, sealer.as_ref()).unwrap();
        assert_eq!(
            toml::from_str::<toml::Value>(&opened).unwrap(),
            toml::from_str::<toml::Value>(&fixture).unwrap()
        );
        // Sealing again keeps sealed leaves byte for byte.
        assert_eq!(seal_text_with(&sealed, sealer.as_ref()).unwrap(), sealed);
    }

    #[test]
    fn legacy_plaintext_reads_without_a_key() {
        let opened = open_text(FIXTURE).unwrap();
        assert!(matches!(opened, Cow::Borrowed(_)));
        assert_eq!(census(FIXTURE).unwrap().sealed, 0);
        assert_eq!(census(FIXTURE).unwrap().plaintext, SECRETS.len() - 1);
    }

    #[test]
    fn wrong_key_and_foreign_envelopes_fail_instead_of_passing_through() {
        let sealed = seal_text_with(FIXTURE, test_sealer().as_ref()).unwrap();
        let other: Arc<dyn SecretSealer> = Arc::new(
            ryu_crypto::ComponentCipher::from_subkey_b64(
                "gateway",
                "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=",
            )
            .unwrap(),
        );
        assert_eq!(
            open_text_with(&sealed, other.as_ref()),
            Err(SealedConfigError::Open)
        );
        let foreign = "[providers.openai]\napi_key = \"enc:v1:AAAA\"\n";
        assert_eq!(
            open_text_with(foreign, test_sealer().as_ref()),
            Err(SealedConfigError::Open)
        );
        assert_eq!(
            seal_text_with(foreign, test_sealer().as_ref()),
            Err(SealedConfigError::Seal)
        );
        assert!(!SealedConfigError::Open.to_string().contains("AAAA"));
    }

    #[test]
    fn non_secret_paths_are_untouched() {
        for path in [
            vec!["routing", "default_provider"],
            vec!["providers", "openai", "base_url"],
            vec!["providers", "accountPolicies", "openai", "acct_1"],
            vec!["channels", "telegram", "options", "webhook_url"],
            vec!["auth", "api_keys", "name"],
            vec!["treg", "token"],
            vec!["channels", "phone_calls", "lines", "twilio_number"],
            vec!["channels", "phone_calls", "lines", "caller_id"],
            vec!["firewall", "custom_patterns"],
        ] {
            assert!(!is_secret_path(&path), "{path:?}");
        }
        assert!(is_secret_path(&[
            "providers",
            "web",
            "brave",
            "accounts",
            "api_key"
        ]));
        assert!(is_secret_path(&[
            "providers",
            "compatible",
            "x",
            "api_keys"
        ]));
        for leaf in ["allowed_callers", "transfer_to"] {
            assert!(is_secret_path(&["channels", "phone_calls", "lines", leaf]));
        }
    }

    #[test]
    fn phone_line_numbers_survive_a_core_style_untyped_rewrite_sealed() {
        // Core edits gateway.toml as an untyped document: open, change another
        // section, serialize, commit. The phone numbers must reach disk sealed
        // again and open to the same values.
        let sealer = test_sealer();
        let sealed = seal_text_with(FIXTURE, sealer.as_ref()).unwrap();
        let mut document: toml::Value =
            toml::from_str(&open_text_with(&sealed, sealer.as_ref()).unwrap()).unwrap();
        document["routing"]["default_provider"] = toml::Value::String("anthropic".into());
        let rewritten = toml::to_string_pretty(&document).unwrap();
        let with_key = || Ok(test_sealer());
        let prepared = prepare_for_disk(Some(sealed.as_bytes()), rewritten.as_bytes(), &with_key)
            .unwrap()
            .unwrap();
        let on_disk = std::str::from_utf8(&prepared).unwrap();
        for number in ["+14155550111", "+14155550122", "+14155550133"] {
            assert!(!on_disk.contains(number), "{number} reached disk in plaintext");
        }
        let reopened: toml::Value =
            toml::from_str(&open_text_with(on_disk, sealer.as_ref()).unwrap()).unwrap();
        let line = &reopened["channels"]["phone_calls"]["lines"][0];
        assert_eq!(line["transfer_to"].as_str(), Some("+14155550111"));
        assert_eq!(
            line["allowed_callers"].as_array().unwrap().len(),
            2,
            "every caller opens"
        );
        assert_eq!(reopened["routing"]["default_provider"].as_str(), Some("anthropic"));
    }

    #[test]
    fn prepare_for_disk_seals_skips_noops_and_fails_closed() {
        let with_key = || Ok(test_sealer());
        let no_key = || Err(SealedConfigError::KeyUnavailable("test".into()));
        // A secret-free document is written verbatim, key or not.
        let plain = b"[routing]\ndefault_provider = \"openai\"\n";
        assert!(matches!(
            prepare_for_disk(None, plain, &no_key).unwrap(),
            Some(Cow::Borrowed(_))
        ));
        // A new plaintext secret is sealed.
        let new = b"[providers.openai]\napi_key = \"sk-new\"\n";
        let prepared = prepare_for_disk(None, new, &with_key).unwrap().unwrap();
        let prepared = std::str::from_utf8(&prepared).unwrap().to_owned();
        assert!(!prepared.contains("sk-new"));
        // Saving the same opened document again is a no-op.
        assert!(prepare_for_disk(Some(prepared.as_bytes()), new, &with_key)
            .unwrap()
            .is_none());
        // Without a key a new secret is refused...
        assert!(matches!(
            prepare_for_disk(None, new, &no_key),
            Err(SealedConfigError::KeyUnavailable(_))
        ));
        // ...but an operator's existing plaintext is written back unchanged.
        let edited = b"[providers.openai]\napi_key = \"sk-new\"\n[routing]\nx = 1\n";
        assert!(matches!(
            prepare_for_disk(Some(new), edited, &no_key).unwrap(),
            Some(Cow::Borrowed(_))
        ));
        // Non-TOML bytes pass through.
        assert!(matches!(
            prepare_for_disk(None, b"not = = toml", &no_key).unwrap(),
            Some(Cow::Borrowed(_))
        ));
    }
}
