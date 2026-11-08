//! Identity challenge keyed by a broker session.
//!
//! An agent Ryu starts through the broker holds only its `rvb_` session, not
//! the node token, so it cannot run the node-token identity challenge
//! (`server/core_identity.rs`) before sending the session to a plain-HTTP
//! loopback Core. Instead it names its session by a one-way lookup id and Core
//! proves it holds that session's stored hash:
//!
//! - key `K = sha256_hex(token)`, the value Core stores as `token_hash`;
//! - lookup `L = sha256_hex("ryu-broker-session-lookup-v1:" + K)`, sent as
//!   `broker_session=L` next to the nonce;
//! - proof `HMAC-SHA256(K, "ryu-core-identity-broker-v1:<local address>:<nonce>")`.
//!
//! A squatter sees only `L`, from which it cannot recover `K`, so it cannot
//! answer. The proof is domain-separated from the node-token proof and from
//! the session itself, and authorizes nothing.

use anyhow::Result;
use rusqlite::{params, Connection};

use crate::vault::{now_millis, sha256_hex};

const LOOKUP_DOMAIN: &str = "ryu-broker-session-lookup-v1";

/// The lookup id a client sends for the session whose stored hash is
/// `token_hash`.
pub fn lookup_id(token_hash: &str) -> String {
    sha256_hex(format!("{LOOKUP_DOMAIN}:{token_hash}").as_bytes())
}

/// A well-formed lookup id: 64 hex digits.
pub fn valid_lookup_id(lookup: &str) -> bool {
    lookup.len() == 64 && lookup.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// The proof key (the stored `token_hash`) of the unrevoked, unexpired session
/// that `lookup` names, if any.
pub fn identity_key(conn: &Connection, lookup: &str) -> Result<Option<String>> {
    if !valid_lookup_id(lookup) {
        return Ok(None);
    }
    let wanted = lookup.to_ascii_lowercase();
    let mut statement = conn.prepare(
        "SELECT token_hash FROM vault_broker_sessions
         WHERE revoked_at IS NULL AND expires_at > ?1",
    )?;
    let hashes = statement.query_map(params![now_millis()], |row| row.get::<_, String>(0))?;
    for hash in hashes {
        let hash = hash?;
        if lookup_id(&hash) == wanted {
            return Ok(Some(hash));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::broker::sessions::{self, MintRequest};

    fn request() -> MintRequest {
        MintRequest {
            environment: "dev".into(),
            services: vec!["github".into()],
            label: String::new(),
            minted_by: "operator".into(),
            ttl_secs: None,
            not_after: None,
            minted_token: None,
            minter_scope: None,
        }
    }

    #[tokio::test]
    async fn finds_the_key_of_a_live_session_by_its_lookup_id_only() {
        let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
        let conn = store.conn.lock().await;
        let (token, session) = sessions::mint(&conn, request()).unwrap();
        let key = sha256_hex(token.as_bytes());
        let lookup = lookup_id(&key);
        assert_eq!(identity_key(&conn, &lookup).unwrap(), Some(key.clone()));
        assert_eq!(
            identity_key(&conn, &lookup.to_ascii_uppercase()).unwrap(),
            Some(key.clone())
        );
        // The key itself, the token, or junk name no session.
        assert_eq!(identity_key(&conn, &key).unwrap(), None);
        assert_eq!(identity_key(&conn, &token).unwrap(), None);
        assert_eq!(identity_key(&conn, "abc").unwrap(), None);
        // A revoked session proves nothing.
        assert!(sessions::revoke(&conn, &session.id).unwrap());
        assert_eq!(identity_key(&conn, &lookup).unwrap(), None);
    }

    #[test]
    fn lookup_vector_is_pinned_for_clients() {
        // Shared with packages/core-client/src/core-identity-broker.test.ts.
        assert_eq!(
            lookup_id(&sha256_hex(b"rvb_example")),
            "44a024002bf182a6d5de111fed8e49bc285336b160ae6a9aa0a460dfe8510c77"
        );
    }
}
