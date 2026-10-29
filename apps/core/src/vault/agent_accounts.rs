//! Agent-owned website accounts.
//!
//! An agent that signs up for a site needs credentials of its own, and it
//! should never hold them: a password the model has seen can end up in a
//! transcript, a memory, or a tool call to the wrong host. An agent account is
//! a typed vault item (kind [`KIND`]) that the agent creates and refers to by
//! id, while every secret stays inside the vault:
//!
//! * [`create`] generates a strong password in the vault and returns only
//!   metadata (site, username, email, and whether a password and TOTP seed are
//!   set);
//! * [`release_for_fill`] hands one field to a **sidecar** that types it into
//!   a page (the browser), never to the agent, and only when the page's origin
//!   belongs to the account's site; a `totp` fill releases the current code,
//!   never the seed;
//! * [`enroll_totp`] stores a 2FA seed the sidecar read off a setup page, under
//!   the same origin binding.
//!
//! Items live in the [`ENVIRONMENT`] environment, one folder per agent
//! ([`agent_folder`]), so the operator sees and manages them with every other
//! item, and one agent can neither list nor fill another agent's accounts.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::audit::AuditActor;
use super::items::{FieldType, FieldView, ItemCoords, ItemPatch, ItemPut, ItemView, PutAccess};
use super::password_policy::{CharsetRule, PasswordPolicySpec};
use super::totp::{OtpauthKey, TotpParams};
use super::VaultError;
use crate::plugin_secrets::PluginSecretStore;

/// The environment agent accounts live in.
pub const ENVIRONMENT: &str = "agents";
/// Item kind of an agent account.
pub const KIND: &str = "agent_login";
/// Folder for calls that carry no agent id.
pub const UNASSIGNED_FOLDER: &str = "unassigned";
/// Default generated password length.
pub const DEFAULT_PASSWORD_LENGTH: u16 = 20;
/// Accepted generated password lengths.
pub const PASSWORD_LENGTHS: std::ops::RangeInclusive<u16> = 12..=128;
/// Most accounts one agent may hold.
pub const MAX_ACCOUNTS_PER_AGENT: usize = 500;
/// Longest username, email, or label.
const MAX_TEXT_LEN: usize = 256;
/// Longest agent id used verbatim as a folder name (the vault segment limit is
/// higher; longer ids are hashed).
const MAX_VERBATIM_AGENT_LEN: usize = 64;

const FIELD_SITE: &str = "site";
const FIELD_USERNAME: &str = "username";
const FIELD_EMAIL: &str = "email";
const FIELD_PASSWORD: &str = "password";
const FIELD_TOTP: &str = "totp";

/// Symbols most sign-up forms accept.
const PASSWORD_SYMBOLS: &str = "!@#$%^&*-_=+?";

/// A field a sidecar may fill.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FillField {
    Username,
    Email,
    Password,
    /// The current one-time code (never the seed).
    Totp,
}

impl FillField {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Username => FIELD_USERNAME,
            Self::Email => FIELD_EMAIL,
            Self::Password => FIELD_PASSWORD,
            Self::Totp => FIELD_TOTP,
        }
    }
}

/// Create an account.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateInput {
    /// The site's URL or bare host, e.g. `https://github.com` or `github.com`.
    pub site: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub password_length: Option<u16>,
    #[serde(default)]
    pub label: Option<String>,
}

/// What the agent sees of an account: never a password, seed, or code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AccountView {
    pub id: String,
    pub site: String,
    pub host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub has_password: bool,
    pub has_totp: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

fn invalid(message: impl Into<String>) -> anyhow::Error {
    VaultError::Invalid(message.into()).into()
}

fn denied(message: impl Into<String>) -> anyhow::Error {
    VaultError::Denied(message.into()).into()
}

fn unknown_account(id: &str) -> anyhow::Error {
    VaultError::NotFound(format!("no account `{id}` for this agent")).into()
}

/// The folder an agent's accounts live in. An id that is already a valid,
/// short folder segment is used as is; anything else is hashed, so distinct
/// ids never share a folder.
pub fn agent_folder(agent_id: Option<&str>) -> String {
    let Some(agent_id) = agent_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return UNASSIGNED_FOLDER.to_owned();
    };
    let verbatim = agent_id.len() <= MAX_VERBATIM_AGENT_LEN
        && agent_id != UNASSIGNED_FOLDER
        && !agent_id.starts_with("h-")
        && agent_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if verbatim {
        return agent_id.to_owned();
    }
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(agent_id.as_bytes());
    let hex: String = digest[..12].iter().map(|b| format!("{b:02x}")).collect();
    format!("h-{hex}")
}

/// Parse a site into its canonical URL and its bound host (lowercase, without
/// a leading `www.`). A bare host is read as `https://host`.
pub fn parse_site(site: &str) -> Result<(String, String)> {
    let trimmed = site.trim();
    if trimmed.is_empty() {
        return Err(invalid("site is required"));
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_owned()
    } else {
        format!("https://{trimmed}")
    };
    let parsed = url::Url::parse(&with_scheme).map_err(|_| invalid("site is not a URL"))?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err(invalid("site must be an http(s) URL"));
    }
    let host = parsed
        .host_str()
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| invalid("site has no host"))?;
    if parsed.scheme() == "http" && !is_loopback_host(&host) {
        return Err(invalid("site must use https"));
    }
    let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    let origin = parsed.origin().ascii_serialization();
    Ok((origin, host))
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

/// Whether a page at `page_url` belongs to an account bound to `host`: the
/// page is https (or loopback http) and its host is exactly `host` (a leading
/// `www.` is ignored, as it is when the account's site is saved). Subdomains do
/// not match: a site's user-content subdomain (pages, docs, sites) could show a
/// password field and read what is typed into it. A sign-in page on another
/// host of the same site gets an account saved for that host.
pub fn page_matches_host(page_url: &str, host: &str) -> bool {
    let Ok(page) = url::Url::parse(page_url.trim()) else {
        return false;
    };
    let Some(page_host) = page.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    let scheme_ok = match page.scheme() {
        "https" => true,
        "http" => is_loopback_host(&page_host),
        _ => false,
    };
    scheme_ok && page_host.strip_prefix("www.").unwrap_or(&page_host) == host
}

fn clean_text(name: &str, value: Option<&str>) -> Result<Option<String>> {
    let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if value.chars().count() > MAX_TEXT_LEN || value.chars().any(char::is_control) {
        return Err(invalid(format!(
            "{name} must be one line of at most {MAX_TEXT_LEN} characters"
        )));
    }
    Ok(Some(value.to_owned()))
}

/// Generate a password with at least one lowercase letter, uppercase letter,
/// digit, and symbol.
pub fn generate_password(length: u16) -> Result<String> {
    if !PASSWORD_LENGTHS.contains(&length) {
        return Err(invalid(format!(
            "password_length must be {} to {}",
            PASSWORD_LENGTHS.start(),
            PASSWORD_LENGTHS.end()
        )));
    }
    let rule = |charset: &str| CharsetRule {
        charset: charset.to_owned(),
        min_chars: 1,
    };
    let spec = PasswordPolicySpec {
        description: String::new(),
        length,
        rules: vec![
            rule("abcdefghijklmnopqrstuvwxyz"),
            rule("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
            rule("0123456789"),
            rule(PASSWORD_SYMBOLS),
        ],
    };
    spec.validate()?;
    Ok(spec.generate())
}

fn random_suffix() -> String {
    super::random_bytes(4)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn coords(agent_id: Option<&str>, id: &str) -> Result<ItemCoords> {
    ItemCoords::new(Some(ENVIRONMENT), Some(&agent_folder(agent_id)), id)
        .map_err(|_| unknown_account(id))
}

fn field<'a>(view: &'a ItemView, name: &str) -> Option<&'a FieldView> {
    view.fields.iter().find(|f| f.def.name == name)
}

fn account_view(view: &ItemView) -> Option<AccountView> {
    if view.kind != KIND {
        return None;
    }
    let value = |name: &str| field(view, name).and_then(|f| f.value.clone());
    let has = |name: &str| field(view, name).is_some_and(|f| f.has_value);
    let site = value(FIELD_SITE)?;
    let (site, host) = parse_site(&site).ok()?;
    Some(AccountView {
        id: view.key.clone(),
        site,
        host,
        username: value(FIELD_USERNAME),
        email: value(FIELD_EMAIL),
        label: view.description.clone(),
        has_password: has(FIELD_PASSWORD),
        has_totp: has(FIELD_TOTP),
        created_at: view.created_at,
        updated_at: view.updated_at,
    })
}

/// The account `id` of `agent_id`, or not-found (also for an item of another
/// kind at the same coordinates).
async fn load(
    store: &PluginSecretStore,
    agent_id: Option<&str>,
    id: &str,
) -> Result<(ItemCoords, ItemView, AccountView)> {
    let coords = coords(agent_id, id)?;
    let view = match store.item_get(&coords, true).await {
        Ok(view) => view,
        Err(error) if is_not_found(&error) => return Err(unknown_account(id)),
        Err(error) => return Err(error),
    };
    let account = account_view(&view).ok_or_else(|| unknown_account(id))?;
    Ok((coords, view, account))
}

fn is_not_found(error: &anyhow::Error) -> bool {
    matches!(
        error.downcast_ref::<VaultError>(),
        Some(VaultError::NotFound(_))
    )
}

/// Every account of `agent_id`, optionally only those whose host matches
/// `site` (a URL or host, matched on the exact host).
pub async fn list(
    store: &PluginSecretStore,
    agent_id: Option<&str>,
    site: Option<&str>,
) -> Result<Vec<AccountView>> {
    let filter = match site.map(str::trim).filter(|s| !s.is_empty()) {
        Some(site) => Some(parse_site(site)?.1),
        None => None,
    };
    let folder = agent_folder(agent_id);
    let summaries = store.item_list(Some(ENVIRONMENT), Some(&folder)).await?;
    let mut out = Vec::new();
    for summary in summaries.into_iter().filter(|s| s.kind == KIND) {
        let coords = ItemCoords::new(Some(ENVIRONMENT), Some(&folder), &summary.key)?;
        let Ok(view) = store.item_get(&coords, true).await else {
            continue;
        };
        let Some(account) = account_view(&view) else {
            continue;
        };
        let keep = filter.as_deref().is_none_or(|host| {
            account.host == host || host.ends_with(&format!(".{}", account.host))
        });
        if keep {
            out.push(account);
        }
    }
    Ok(out)
}

/// Create an account with a freshly generated password.
pub async fn create(
    store: &PluginSecretStore,
    agent_id: Option<&str>,
    input: CreateInput,
    actor: &AuditActor,
) -> Result<AccountView> {
    let (site, host) = parse_site(&input.site)?;
    let username = clean_text("username", input.username.as_deref())?;
    let email = clean_text("email", input.email.as_deref())?;
    let label = clean_text("label", input.label.as_deref())?;
    let password = generate_password(input.password_length.unwrap_or(DEFAULT_PASSWORD_LENGTH))?;
    let folder = agent_folder(agent_id);
    let existing = store.item_list(Some(ENVIRONMENT), Some(&folder)).await?;
    if existing.len() >= MAX_ACCOUNTS_PER_AGENT {
        return Err(invalid(format!(
            "an agent may hold at most {MAX_ACCOUNTS_PER_AGENT} accounts"
        )));
    }
    let mut values = std::collections::BTreeMap::new();
    values.insert(FIELD_SITE.to_owned(), site);
    values.insert(FIELD_PASSWORD.to_owned(), password);
    if let Some(username) = username {
        values.insert(FIELD_USERNAME.to_owned(), username);
    }
    if let Some(email) = email {
        values.insert(FIELD_EMAIL.to_owned(), email);
    }
    let put: ItemPut = serde_json::from_value(json!({
        "environment": ENVIRONMENT,
        "path": folder,
        "kind": KIND,
        "description": label,
        "fields": [
            { "name": FIELD_SITE, "label": "Site", "type": "url", "required": true },
            { "name": FIELD_USERNAME, "label": "Username", "type": "text" },
            { "name": FIELD_EMAIL, "label": "Email", "type": "email" },
            { "name": FIELD_PASSWORD, "label": "Password", "type": "password", "required": true },
            { "name": FIELD_TOTP, "label": "Authenticator", "type": "totp" },
        ],
        "values": values,
    }))?;
    // A fresh random suffix makes a collision vanishingly unlikely; a few
    // retries cover it without a read-then-write race.
    for _ in 0..4 {
        let id = format!("{host}--{}", random_suffix());
        if store.item_get(&coords(agent_id, &id)?, false).await.is_ok() {
            continue;
        }
        store
            .item_put(&id, put.clone(), actor, PutAccess::FULL)
            .await?;
        // Write results omit values; read back the plain ones for the view.
        return load(store, agent_id, &id)
            .await
            .map(|(_, _, account)| account);
    }
    Err(VaultError::Conflict("could not allocate an account id".into()).into())
}

/// Release one field of an account to a sidecar that fills it into the page
/// at `page_url`. The page must belong to the account's site. A `totp` field
/// releases the current code. Audited as an item reveal by `actor`.
pub async fn release_for_fill(
    store: &PluginSecretStore,
    agent_id: Option<&str>,
    id: &str,
    fill: FillField,
    page_url: &str,
    actor: &AuditActor,
) -> Result<String> {
    let (coords, view, account) = load(store, agent_id, id).await?;
    if !page_matches_host(page_url, &account.host) {
        return Err(denied(format!(
            "account `{id}` fills only on https pages of {}",
            account.host
        )));
    }
    match fill {
        FillField::Username | FillField::Email => field(&view, fill.as_str())
            .and_then(|f| f.value.clone())
            .ok_or_else(|| {
                VaultError::NotFound(format!("account `{id}` has no {}", fill.as_str())).into()
            }),
        FillField::Password => store.item_reveal(&coords, FIELD_PASSWORD, actor).await,
        FillField::Totp => {
            if !account.has_totp {
                return Err(VaultError::NotFound(format!(
                    "account `{id}` has no authenticator; enroll one first"
                ))
                .into());
            }
            let seed = store.item_reveal(&coords, FIELD_TOTP, actor).await?;
            super::totp::current_code_from_seed_value(&seed)
                .ok_or_else(|| anyhow::anyhow!("stored authenticator seed is unusable"))
        }
    }
}

/// Normalize a captured 2FA secret (`otpauth://totp/` URI or Base32 seed) to a
/// Base32 seed. Keys with non-default parameters are refused, because the
/// account stores only the seed and codes use SHA-1, 6 digits, 30 seconds.
pub fn normalize_enrollment_secret(secret: &str) -> Result<String> {
    let secret = secret.trim();
    if secret
        .get(..10)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("otpauth://"))
    {
        let key = OtpauthKey::parse(secret)?;
        if key.params != TotpParams::default() {
            return Err(invalid(
                "only SHA-1, 6-digit, 30-second authenticator keys are supported",
            ));
        }
    }
    super::items::normalize_totp_seed(secret)
        .ok_or_else(|| invalid("the secret is not an otpauth URI or a Base32 authenticator key"))
}

/// Store a 2FA seed captured from a setup page at `page_url`, which must
/// belong to the account's site.
pub async fn enroll_totp(
    store: &PluginSecretStore,
    agent_id: Option<&str>,
    id: &str,
    secret: &str,
    page_url: &str,
    actor: &AuditActor,
) -> Result<AccountView> {
    let (coords, view, account) = load(store, agent_id, id).await?;
    if !page_matches_host(page_url, &account.host) {
        return Err(denied(format!(
            "account `{id}` enrolls an authenticator only from https pages of {}",
            account.host
        )));
    }
    debug_assert!(view
        .fields
        .iter()
        .any(|f| f.def.name == FIELD_TOTP && f.def.field_type == FieldType::Totp));
    let seed = normalize_enrollment_secret(secret)?;
    let patch: ItemPatch = serde_json::from_value(json!({
        "environment": coords.environment,
        "path": coords.path,
        "expectedVersion": view.version,
        "expectedId": view.id,
        "values": { FIELD_TOTP: seed },
    }))?;
    store.item_patch(&coords.key, patch, actor).await?;
    load(store, agent_id, id)
        .await
        .map(|(_, _, account)| account)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEED: &str = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

    fn agent() -> AuditActor {
        AuditActor::new("agent", Some("agent-1"))
    }

    fn store() -> PluginSecretStore {
        PluginSecretStore::in_memory().unwrap()
    }

    fn create_input(site: &str) -> CreateInput {
        CreateInput {
            site: site.to_owned(),
            username: Some("ryu-bot".into()),
            email: Some("bot@example.com".into()),
            ..CreateInput::default()
        }
    }

    fn code(error: &anyhow::Error) -> &'static str {
        error.downcast_ref::<VaultError>().expect("typed").code()
    }

    #[test]
    fn folders_are_per_agent_and_never_collide() {
        assert_eq!(agent_folder(None), UNASSIGNED_FOLDER);
        assert_eq!(agent_folder(Some("  ")), UNASSIGNED_FOLDER);
        assert_eq!(agent_folder(Some("research_bot-2")), "research_bot-2");
        let hashed = agent_folder(Some("agent:with/odd chars"));
        assert!(hashed.starts_with("h-"), "{hashed}");
        assert_ne!(hashed, agent_folder(Some("agent:with/odd chars!")));
        // Ids that look like reserved folders are hashed, not reused.
        assert_ne!(agent_folder(Some(UNASSIGNED_FOLDER)), UNASSIGNED_FOLDER);
        assert_ne!(agent_folder(Some(&hashed)), hashed);
        assert!(crate::vault::normalize_path(&agent_folder(Some(&"x".repeat(300)))).is_some());
    }

    #[test]
    fn sites_and_page_binding() {
        assert_eq!(
            parse_site("github.com").unwrap(),
            ("https://github.com".into(), "github.com".into())
        );
        assert_eq!(
            parse_site("https://www.Example.com/signup?x=1").unwrap().1,
            "example.com"
        );
        assert!(parse_site("http://example.com").is_err());
        assert!(parse_site("http://localhost:3000").is_ok());
        assert!(parse_site("ftp://example.com").is_err());
        assert!(parse_site("").is_err());

        assert!(page_matches_host("https://github.com/login", "github.com"));
        assert!(page_matches_host(
            "https://www.github.com/login",
            "github.com"
        ));
        // A subdomain is another site: its pages may be user content.
        assert!(!page_matches_host(
            "https://accounts.github.com/",
            "github.com"
        ));
        assert!(!page_matches_host(
            "https://someone.github.io/login",
            "github.io"
        ));
        assert!(!page_matches_host("http://github.com/login", "github.com"));
        assert!(!page_matches_host("https://evilgithub.com/", "github.com"));
        assert!(!page_matches_host(
            "https://github.com.evil.io/",
            "github.com"
        ));
        assert!(!page_matches_host("not a url", "github.com"));
        assert!(page_matches_host("http://localhost:3000/x", "localhost"));
    }

    #[test]
    fn generated_passwords_mix_every_class() {
        for _ in 0..50 {
            let password = generate_password(DEFAULT_PASSWORD_LENGTH).unwrap();
            assert_eq!(password.len(), usize::from(DEFAULT_PASSWORD_LENGTH));
            assert!(password.bytes().any(|b| b.is_ascii_lowercase()));
            assert!(password.bytes().any(|b| b.is_ascii_uppercase()));
            assert!(password.bytes().any(|b| b.is_ascii_digit()));
            assert!(password.chars().any(|c| PASSWORD_SYMBOLS.contains(c)));
        }
        assert!(generate_password(8).is_err());
        assert!(generate_password(129).is_err());
    }

    #[test]
    fn enrollment_secrets_normalize() {
        assert_eq!(normalize_enrollment_secret(SEED).unwrap(), SEED);
        assert_eq!(
            normalize_enrollment_secret("jbsw y3dp ehpk 3pxp jbsw y3dp ehpk 3pxp").unwrap(),
            SEED
        );
        let uri = format!("otpauth://totp/GitHub:bot?secret={SEED}&issuer=GitHub");
        assert_eq!(normalize_enrollment_secret(&uri).unwrap(), SEED);
        let eight = format!("otpauth://totp/GitHub:bot?secret={SEED}&digits=8");
        assert!(normalize_enrollment_secret(&eight).is_err());
        assert!(normalize_enrollment_secret("not a secret").is_err());
    }

    #[tokio::test]
    async fn create_returns_no_secret_and_lists_per_agent() {
        let store = store();
        let account = create(
            &store,
            Some("agent-1"),
            create_input("github.com"),
            &agent(),
        )
        .await
        .unwrap();
        assert!(account.id.starts_with("github.com--"), "{}", account.id);
        assert_eq!(account.site, "https://github.com");
        assert!(account.has_password);
        assert!(!account.has_totp);
        let serialized = serde_json::to_string(&account).unwrap();
        assert!(!serialized.contains("password\":\""), "{serialized}");

        let mine = list(&store, Some("agent-1"), None).await.unwrap();
        assert_eq!(mine, vec![account.clone()]);
        assert_eq!(
            list(
                &store,
                Some("agent-1"),
                Some("https://accounts.github.com/x")
            )
            .await
            .unwrap()
            .len(),
            1
        );
        assert!(list(&store, Some("agent-1"), Some("gitlab.com"))
            .await
            .unwrap()
            .is_empty());
        assert!(list(&store, Some("agent-2"), None)
            .await
            .unwrap()
            .is_empty());
        assert!(list(&store, None, None).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn fills_are_origin_bound_and_agent_scoped() {
        let store = store();
        let account = create(
            &store,
            Some("agent-1"),
            create_input("github.com"),
            &agent(),
        )
        .await
        .unwrap();
        let id = account.id.as_str();
        let page = "https://github.com/login";

        let password = release_for_fill(
            &store,
            Some("agent-1"),
            id,
            FillField::Password,
            page,
            &agent(),
        )
        .await
        .unwrap();
        assert_eq!(password.len(), usize::from(DEFAULT_PASSWORD_LENGTH));
        let username = release_for_fill(
            &store,
            Some("agent-1"),
            id,
            FillField::Username,
            page,
            &agent(),
        )
        .await
        .unwrap();
        assert_eq!(username, "ryu-bot");

        let error = release_for_fill(
            &store,
            Some("agent-1"),
            id,
            FillField::Password,
            "https://github.com.evil.io/login",
            &agent(),
        )
        .await
        .unwrap_err();
        assert_eq!(code(&error), "vault_denied");

        let error = release_for_fill(
            &store,
            Some("agent-2"),
            id,
            FillField::Password,
            page,
            &agent(),
        )
        .await
        .unwrap_err();
        assert_eq!(code(&error), "vault_not_found");

        let error = release_for_fill(&store, Some("agent-1"), id, FillField::Totp, page, &agent())
            .await
            .unwrap_err();
        assert_eq!(code(&error), "vault_not_found");
    }

    #[tokio::test]
    async fn totp_enrollment_yields_codes_never_seeds() {
        let store = store();
        let account = create(
            &store,
            Some("agent-1"),
            create_input("github.com"),
            &agent(),
        )
        .await
        .unwrap();
        let id = account.id.as_str();
        let error = enroll_totp(
            &store,
            Some("agent-1"),
            id,
            SEED,
            "https://evil.example/setup",
            &agent(),
        )
        .await
        .unwrap_err();
        assert_eq!(code(&error), "vault_denied");

        let enrolled = enroll_totp(
            &store,
            Some("agent-1"),
            id,
            &format!("otpauth://totp/GitHub:bot?secret={SEED}"),
            "https://github.com/settings/2fa",
            &agent(),
        )
        .await
        .unwrap();
        assert!(enrolled.has_totp);

        let code = release_for_fill(
            &store,
            Some("agent-1"),
            id,
            FillField::Totp,
            "https://github.com/sessions/two-factor",
            &agent(),
        )
        .await
        .unwrap();
        assert_eq!(code.len(), 6);
        assert!(code.bytes().all(|b| b.is_ascii_digit()));
        assert_ne!(code, SEED);
    }
}
