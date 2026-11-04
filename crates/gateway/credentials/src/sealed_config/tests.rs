use super::*;

pub(crate) const TEST_SUBKEY: &str = "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=";

pub(crate) fn test_sealer() -> Arc<dyn SecretSealer> {
    Arc::new(
        ryu_crypto::ComponentCipher::from_subkey_b64(ryu_crypto::components::GATEWAY, TEST_SUBKEY)
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
        assert!(
            !on_disk.contains(number),
            "{number} reached disk in plaintext"
        );
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
    assert_eq!(
        reopened["routing"]["default_provider"].as_str(),
        Some("anthropic")
    );
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
