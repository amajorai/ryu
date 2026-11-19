//! Stripe and Cloudflare key rotators.
//!
//! * Stripe: `POST /v2/iam/api_keys/{id}/rotate` (Stripe's API keys API)
//!   creates a key with the same permissions and expires the old one at
//!   once. Every request sends a fresh RSA public key; a live-mode secret
//!   comes back as a JWE (`RSA-OAEP-256` / `A256GCM`) that only this
//!   rotation's private key opens, while test-mode keys come back in
//!   plaintext.
//! * Cloudflare: `PUT …/tokens/{id}/value` rolls an API token: the id stays,
//!   the value changes, and the old value stops working at once.
//!
//! As with the AI rotators, errors carry only the HTTP status and the
//! vendor's error code, never a response body that could echo a key.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine as _;
use rand::rngs::OsRng;
use rsa::pkcs8::{EncodePublicKey, LineEnding};
use rsa::{Oaep, RsaPrivateKey};
use serde_json::{json, Value};
use sha2::Sha256;

use super::ai_keys::MintedKey;

const STRIPE_BASE: &str = "https://api.stripe.com";
const CLOUDFLARE_BASE: &str = "https://api.cloudflare.com/client/v4";
/// Stripe's API keys API is versioned as a preview.
pub(super) const DEFAULT_STRIPE_VERSION: &str = "2026-10-28.preview";
const RSA_BITS: usize = 2048;

#[cfg(test)]
thread_local! {
    /// Test-only base URL for both vendors (a local fake).
    pub(super) static VENDOR_ENDPOINT: std::cell::RefCell<Option<String>> =
        const { std::cell::RefCell::new(None) };
}

fn base_url(production: &str) -> String {
    #[cfg(test)]
    if let Some(endpoint) = VENDOR_ENDPOINT.with(|cell| cell.borrow().clone()) {
        return endpoint;
    }
    production.to_owned()
}

fn is_id(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

pub(super) fn validate_stripe(
    admin_api_key: &str,
    current_api_key_id: Option<&str>,
    stripe_context: Option<&str>,
    stripe_version: &str,
) -> Result<()> {
    if !(admin_api_key.starts_with("sk_") || admin_api_key.starts_with("rk_")) {
        bail!("adminApiKey must be a Stripe secret or restricted key (sk_… or rk_…)");
    }
    match current_api_key_id {
        Some(id) if is_id(id, 255) => {}
        Some(_) => bail!("currentApiKeyId is not an API key id"),
        None => bail!("currentApiKeyId is required: the id of the key that rotates"),
    }
    if stripe_context.is_some_and(|context| !is_id(context, 255)) {
        bail!("stripeContext must be an account id");
    }
    if !stripe_version
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.'))
        || stripe_version.is_empty()
    {
        bail!("stripeVersion is invalid");
    }
    Ok(())
}

pub(super) fn validate_cloudflare(
    admin_api_token: &str,
    token_id: &str,
    account_id: Option<&str>,
) -> Result<()> {
    if admin_api_token.trim().is_empty() || admin_api_token.len() > 512 {
        bail!("adminApiToken is required");
    }
    if !is_id(token_id, 64) {
        bail!("tokenId is not a Cloudflare token id");
    }
    if account_id.is_some_and(|id| !is_id(id, 64)) {
        bail!("accountId is not a Cloudflare account id");
    }
    Ok(())
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_default()
}

/// `"<vendor> returned <status> (<code>)"`, never the body text.
async fn upstream_error(vendor: &str, response: reqwest::Response) -> anyhow::Error {
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    let code = body
        .pointer("/error/code")
        .or_else(|| body.pointer("/error/type"))
        .or_else(|| body.pointer("/errors/0/code"))
        .map(|code| match code {
            Value::String(text) if is_id(text, 64) => text.clone(),
            Value::Number(number) => number.to_string(),
            _ => "unknown".to_owned(),
        })
        .unwrap_or_else(|| "unknown".to_owned());
    anyhow!("{vendor} returned {status} ({code})")
}

/// Open a compact JWE (`RSA-OAEP-256` key wrap, `A256GCM` content).
pub(super) fn open_jwe(compact: &str, key: &RsaPrivateKey) -> Result<String> {
    let parts: Vec<&str> = compact.trim().split('.').collect();
    let [header, wrapped, iv, ciphertext, tag] = parts.as_slice() else {
        bail!("the encrypted key is not a compact JWE");
    };
    let decode = |part: &str| {
        B64URL
            .decode(part)
            .context("the encrypted key is malformed")
    };
    let protected: Value =
        serde_json::from_slice(&decode(header)?).context("the JWE header is malformed")?;
    if protected.get("alg").and_then(Value::as_str) != Some("RSA-OAEP-256")
        || protected.get("enc").and_then(Value::as_str) != Some("A256GCM")
    {
        bail!("the encrypted key uses an unsupported JWE algorithm");
    }
    let cek = key
        .decrypt(Oaep::new::<Sha256>(), &decode(wrapped)?)
        .map_err(|_| anyhow!("the encrypted key could not be unwrapped"))?;
    let iv = decode(iv)?;
    if cek.len() != 32 || iv.len() != 12 {
        bail!("the encrypted key is malformed");
    }
    let mut sealed = decode(ciphertext)?;
    sealed.extend_from_slice(&decode(tag)?);
    let cipher = Aes256Gcm::new_from_slice(&cek).map_err(|_| anyhow!("bad content key"))?;
    let plain = cipher
        .decrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: &sealed,
                aad: header.as_bytes(),
            },
        )
        .map_err(|_| anyhow!("the encrypted key failed authentication"))?;
    String::from_utf8(plain).context("the decrypted key is not text")
}

/// Rotate a Stripe API key; the new key (id and value) replaces it.
pub(super) async fn stripe_rotate(
    admin_api_key: &str,
    current_api_key_id: &str,
    stripe_context: Option<&str>,
    stripe_version: &str,
) -> Result<MintedKey> {
    // Test-mode keys come back in plaintext; only live mode needs a key pair.
    let private = if admin_api_key.contains("_test_") {
        None
    } else {
        Some(
            tokio::task::spawn_blocking(|| RsaPrivateKey::new(&mut OsRng, RSA_BITS))
                .await?
                .map_err(|error| anyhow!("generating the RSA key for Stripe: {error}"))?,
        )
    };
    let body = match &private {
        Some(private) => {
            let public_pem = private
                .to_public_key()
                .to_public_key_pem(LineEnding::LF)
                .map_err(|error| anyhow!("encoding the RSA key for Stripe: {error}"))?;
            json!({ "public_key": { "pem_key": { "data": public_pem, "algorithm": "RSA" } } })
        }
        None => json!({}),
    };
    let mut request = client()
        .post(format!(
            "{}/v2/iam/api_keys/{current_api_key_id}/rotate",
            base_url(STRIPE_BASE)
        ))
        .bearer_auth(admin_api_key)
        .header("Stripe-Version", stripe_version)
        .json(&body);
    if let Some(context) = stripe_context {
        request = request.header("Stripe-Context", context);
    }
    let response = request.send().await.context("calling the Stripe API")?;
    if !response.status().is_success() {
        return Err(upstream_error("Stripe", response).await);
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| anyhow!("Stripe returned an unreadable API key"))?;
    let id = body
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_id(id, 255))
        .ok_or_else(|| anyhow!("Stripe returned no API key id"))?;
    let secret = body.get("secret_key").unwrap_or(&Value::Null);
    let encrypted = secret
        .pointer("/encrypted_secret/ciphertext")
        .and_then(Value::as_str);
    let value = match (
        encrypted,
        &private,
        secret.get("token").and_then(Value::as_str),
    ) {
        (Some(jwe), Some(private), _) => open_jwe(jwe, private)?,
        (Some(_), None, _) => bail!("Stripe returned an encrypted key for a test-mode request"),
        (None, _, Some(token)) => token.to_owned(),
        (None, _, None) => bail!("Stripe returned no key value"),
    };
    if value.trim().is_empty() {
        bail!("Stripe returned no key value");
    }
    Ok(MintedKey {
        id: id.to_owned(),
        value,
    })
}

/// Roll a Cloudflare API token's value. The token id is unchanged.
pub(super) async fn cloudflare_roll(
    admin_api_token: &str,
    token_id: &str,
    account_id: Option<&str>,
) -> Result<MintedKey> {
    let owner = match account_id {
        Some(account) => format!("accounts/{account}"),
        None => "user".to_owned(),
    };
    let response = client()
        .put(format!(
            "{}/{owner}/tokens/{token_id}/value",
            base_url(CLOUDFLARE_BASE)
        ))
        .bearer_auth(admin_api_token)
        .json(&json!({}))
        .send()
        .await
        .context("calling the Cloudflare API")?;
    if !response.status().is_success() {
        return Err(upstream_error("Cloudflare", response).await);
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| anyhow!("Cloudflare returned an unreadable answer"))?;
    match body.get("result").and_then(Value::as_str) {
        Some(value) if body.get("success") == Some(&json!(true)) && !value.trim().is_empty() => {
            Ok(MintedKey {
                id: token_id.to_owned(),
                value: value.to_owned(),
            })
        }
        _ => bail!("Cloudflare returned no token value"),
    }
}

#[cfg(test)]
#[path = "vendor_keys_tests.rs"]
mod tests;
