//! Named password policies: length plus character-set rules with minimums.
//!
//! A policy is `{ name, length, rules: [{ charset, minChars }] }`. Generated
//! passwords draw from the union of every rule's characters with the OS CSPRNG
//! and always contain at least `minChars` characters from each rule's set.
//! Policies are referenced by the key/value generator
//! (`{ "kind": "random", "policy": "<name>" }`), so the scheduler's rotation
//! path and first-write generation follow the same rules, and by the
//! `generate` route. A policy referenced by any stored value (live or
//! soft-deleted) cannot be deleted.
//!
//! Policies are configuration, not secrets, so the table is not sealed.

use anyhow::{Context, Result};
use rand::rngs::OsRng;
use rand::seq::SliceRandom;
use rand::Rng;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::audit::{AuditActor, AuditEntry};
use super::{now_millis, VaultError};
use crate::plugin_secrets::PluginSecretStore;

pub const MIN_LENGTH: u16 = 8;
pub const MAX_LENGTH: u16 = 256;
const MAX_RULES: usize = 16;
const MAX_CHARSET_LEN: usize = 256;
const MAX_DESCRIPTION_LEN: usize = 512;

/// One character-set rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharsetRule {
    /// Printable ASCII characters (no spaces); duplicates are ignored.
    pub charset: String,
    #[serde(default)]
    pub min_chars: u16,
}

/// A stored policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordPolicy {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub length: u16,
    pub rules: Vec<CharsetRule>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// Create/update body (the name comes from the path).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordPolicySpec {
    #[serde(default)]
    pub description: String,
    pub length: u16,
    pub rules: Vec<CharsetRule>,
}

/// Policy names share the engine object grammar `^[a-z0-9][a-z0-9_-]{0,63}$`.
pub fn is_valid_name(name: &str) -> bool {
    super::transit::is_valid_key_name(name)
}

fn dedup_charset(charset: &str) -> Vec<char> {
    let mut out: Vec<char> = Vec::new();
    for character in charset.chars() {
        if !out.contains(&character) {
            out.push(character);
        }
    }
    out
}

impl PasswordPolicySpec {
    /// Check the policy is well formed and satisfiable: every rule has a
    /// non-empty printable charset and the minimums fit inside `length`.
    pub fn validate(&self) -> Result<()> {
        let invalid = |message: String| -> anyhow::Error { VaultError::Invalid(message).into() };
        if self.description.len() > MAX_DESCRIPTION_LEN {
            return Err(invalid(format!(
                "description is longer than {MAX_DESCRIPTION_LEN} characters"
            )));
        }
        if !(MIN_LENGTH..=MAX_LENGTH).contains(&self.length) {
            return Err(invalid(format!(
                "length must be {MIN_LENGTH} to {MAX_LENGTH}"
            )));
        }
        if self.rules.is_empty() || self.rules.len() > MAX_RULES {
            return Err(invalid(format!("a policy needs 1 to {MAX_RULES} rules")));
        }
        let mut minimum: u32 = 0;
        for rule in &self.rules {
            let chars = dedup_charset(&rule.charset);
            if chars.is_empty() || chars.len() > MAX_CHARSET_LEN {
                return Err(invalid(format!(
                    "each charset needs 1 to {MAX_CHARSET_LEN} characters"
                )));
            }
            if !chars.iter().all(|c| c.is_ascii_graphic()) {
                return Err(invalid(
                    "charsets may contain only printable ASCII without spaces".into(),
                ));
            }
            minimum += u32::from(rule.min_chars);
        }
        if minimum > u32::from(self.length) {
            return Err(invalid(format!(
                "the rules require {minimum} characters but length is {}",
                self.length
            )));
        }
        Ok(())
    }

    /// Generate one password. The spec must be valid.
    pub fn generate(&self) -> String {
        let mut rng = OsRng;
        let union = dedup_charset(
            &self
                .rules
                .iter()
                .map(|rule| rule.charset.as_str())
                .collect::<String>(),
        );
        let mut out: Vec<char> = Vec::with_capacity(usize::from(self.length));
        for rule in &self.rules {
            let chars = dedup_charset(&rule.charset);
            for _ in 0..rule.min_chars {
                out.push(chars[rng.gen_range(0..chars.len())]);
            }
        }
        while out.len() < usize::from(self.length) {
            out.push(union[rng.gen_range(0..union.len())]);
        }
        // The required characters were placed first; shuffle so their
        // positions are uniform.
        out.shuffle(&mut rng);
        out.into_iter().collect()
    }
}

impl PasswordPolicy {
    fn spec(&self) -> PasswordPolicySpec {
        PasswordPolicySpec {
            description: self.description.clone(),
            length: self.length,
            rules: self.rules.clone(),
        }
    }
}

/// Create the policy table. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_password_policies (
             name        TEXT PRIMARY KEY,
             description TEXT NOT NULL DEFAULT '',
             length      INTEGER NOT NULL,
             rules       TEXT NOT NULL,
             created_at  INTEGER NOT NULL,
             updated_at  INTEGER NOT NULL
         );",
    )
    .context("initializing password policy schema")
}

fn policy_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(PasswordPolicy, String)> {
    Ok((
        PasswordPolicy {
            name: row.get(0)?,
            description: row.get(1)?,
            length: row.get(2)?,
            rules: Vec::new(),
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        },
        row.get(3)?,
    ))
}

fn hydrate((mut policy, rules): (PasswordPolicy, String)) -> Result<PasswordPolicy> {
    policy.rules = serde_json::from_str(&rules).context("decoding password policy rules")?;
    Ok(policy)
}

const COLUMNS: &str = "name, description, length, rules, created_at, updated_at";

/// Load one policy on an open connection.
pub fn get_locked(conn: &Connection, name: &str) -> Result<PasswordPolicy> {
    let row = conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM vault_password_policies WHERE name = ?1"),
            params![name],
            policy_from_row,
        )
        .optional()?
        .ok_or_else(|| VaultError::NotFound(format!("password policy `{name}`")))?;
    hydrate(row)
}

/// Generate a password from a named policy on an open connection (used by the
/// key/value generator inside its write transaction).
pub fn generate_locked(conn: &Connection, name: &str) -> Result<String> {
    let spec = get_locked(conn, name)?.spec();
    // Re-validate: a row written by an older binary must still be satisfiable.
    spec.validate()?;
    Ok(spec.generate())
}

/// Policy keys of values whose generator references `policy`. Soft-deleted
/// values count too: restoring one must not revive a generator that points at
/// a missing policy.
fn values_using(conn: &Connection, policy: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT environment, path, name, generator FROM vault_secrets
         WHERE generator IS NOT NULL",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (environment, path, name, generator) = row?;
        let uses = serde_json::from_str::<crate::plugin_secrets::Generator>(&generator)
            .is_ok_and(|generator| generator.policy_name() == Some(policy));
        if uses {
            out.push(super::policy_key(&environment, &path, &name));
        }
    }
    Ok(out)
}

impl PluginSecretStore {
    /// Create or replace a policy.
    pub async fn password_policy_put(
        &self,
        name: &str,
        spec: &PasswordPolicySpec,
        actor: &AuditActor,
    ) -> Result<PasswordPolicy> {
        if !is_valid_name(name) {
            return Err(VaultError::Invalid("invalid password policy name".into()).into());
        }
        spec.validate()?;
        let rules = serde_json::to_string(&spec.rules)?;
        let now = now_millis();
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO vault_password_policies
                (name, description, length, rules, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(name) DO UPDATE SET description = excluded.description,
                 length = excluded.length, rules = excluded.rules,
                 updated_at = excluded.updated_at",
            params![name, spec.description.trim(), spec.length, rules, now],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "password_policy.put", "ok")
                .details(serde_json::json!({ "policy": name })),
        );
        get_locked(&conn, name)
    }

    /// Every policy.
    pub async fn password_policy_list(&self) -> Result<Vec<PasswordPolicy>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM vault_password_policies ORDER BY name"
        ))?;
        let rows = stmt.query_map([], policy_from_row)?;
        rows.map(|row| hydrate(row?)).collect()
    }

    /// One policy.
    pub async fn password_policy_get(&self, name: &str) -> Result<PasswordPolicy> {
        let conn = self.conn.lock().await;
        get_locked(&conn, name)
    }

    /// Delete a policy no value (live or soft-deleted) references. The
    /// conflict reports only a count: values span scopes the caller may hold
    /// no grant on, so their names go to the audit log instead.
    pub async fn password_policy_delete(&self, name: &str, actor: &AuditActor) -> Result<()> {
        let conn = self.conn.lock().await;
        get_locked(&conn, name)?;
        let users = values_using(&conn, name)?;
        if !users.is_empty() {
            self.audit_locked(
                &conn,
                &AuditEntry::new(actor, "password_policy.delete", "in_use")
                    .details(serde_json::json!({ "policy": name, "values": users })),
            );
            return Err(VaultError::Conflict(format!(
                "password policy `{name}` is used by {} stored value(s)",
                users.len()
            ))
            .into());
        }
        conn.execute(
            "DELETE FROM vault_password_policies WHERE name = ?1",
            params![name],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "password_policy.delete", "ok")
                .details(serde_json::json!({ "policy": name })),
        );
        Ok(())
    }

    /// Generate a password from a policy. Audited without the value.
    pub async fn password_policy_generate(&self, name: &str, actor: &AuditActor) -> Result<String> {
        let conn = self.conn.lock().await;
        let password = generate_locked(&conn, name)?;
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "password_policy.generate", "ok")
                .details(serde_json::json!({ "policy": name })),
        ) {
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(password)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_secrets::kv::{SecretMetadataPatch, VersionSource, WriteRequest};
    use crate::plugin_secrets::{Generator, SecretCoords, SecretScope};

    fn actor() -> AuditActor {
        AuditActor::new("operator", None)
    }

    fn rule(charset: &str, min_chars: u16) -> CharsetRule {
        CharsetRule {
            charset: charset.into(),
            min_chars,
        }
    }

    fn strict() -> PasswordPolicySpec {
        PasswordPolicySpec {
            description: "db".into(),
            length: 12,
            rules: vec![
                rule("abcdefghijklmnopqrstuvwxyz", 1),
                rule("ABCDEFGHIJKLMNOPQRSTUVWXYZ", 2),
                rule("0123456789", 3),
                rule("!@#$%", 4),
            ],
        }
    }

    #[test]
    fn generated_passwords_meet_every_minimum() {
        let spec = strict();
        spec.validate().unwrap();
        for _ in 0..200 {
            let password = spec.generate();
            assert_eq!(password.chars().count(), 12);
            for rule in &spec.rules {
                let count = password
                    .chars()
                    .filter(|c| rule.charset.contains(*c))
                    .count();
                assert!(count >= usize::from(rule.min_chars), "{password}");
            }
            assert!(password
                .chars()
                .all(|c| spec.rules.iter().any(|rule| rule.charset.contains(c))));
        }
    }

    #[test]
    fn unsatisfiable_or_malformed_policies_are_rejected() {
        let mut too_many = strict();
        too_many.length = 9;
        let cases = [
            too_many,
            PasswordPolicySpec {
                length: 7,
                ..strict()
            },
            PasswordPolicySpec {
                length: 300,
                ..strict()
            },
            PasswordPolicySpec {
                rules: Vec::new(),
                ..strict()
            },
            PasswordPolicySpec {
                rules: vec![rule("", 0)],
                ..strict()
            },
            PasswordPolicySpec {
                rules: vec![rule("ab c", 0)],
                ..strict()
            },
            PasswordPolicySpec {
                rules: vec![rule("abc\u{e9}", 0)],
                ..strict()
            },
        ];
        for spec in cases {
            assert!(spec.validate().is_err(), "{spec:?}");
        }
    }

    #[tokio::test]
    async fn policies_round_trip_and_generate() {
        let store = PluginSecretStore::in_memory().unwrap();
        assert!(store
            .password_policy_put("Bad Name", &strict(), &actor())
            .await
            .is_err());
        let stored = store
            .password_policy_put("db", &strict(), &actor())
            .await
            .unwrap();
        assert_eq!(stored.rules, strict().rules);
        let mut updated = strict();
        updated.length = 20;
        store
            .password_policy_put("db", &updated, &actor())
            .await
            .unwrap();
        assert_eq!(store.password_policy_get("db").await.unwrap().length, 20);
        assert_eq!(store.password_policy_list().await.unwrap().len(), 1);
        let password = store
            .password_policy_generate("db", &actor())
            .await
            .unwrap();
        assert_eq!(password.len(), 20);
        assert!(store
            .password_policy_generate("missing", &actor())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn kv_generators_use_policies_and_pin_them() {
        let store = PluginSecretStore::in_memory().unwrap();
        let coords = SecretCoords::root(SecretScope::Node, "local", None, "DB_PASSWORD");
        let generator: Generator =
            serde_json::from_value(serde_json::json!({ "kind": "random", "policy": "db" }))
                .unwrap();
        assert_eq!(
            serde_json::to_value(&generator).unwrap(),
            serde_json::json!({ "kind": "random", "policy": "db" })
        );
        let system = AuditActor::system();
        let write = |generator: Generator| WriteRequest {
            coords: coords.clone(),
            value: None,
            patch: SecretMetadataPatch {
                generator: Some(Some(generator)),
                rotation_period_secs: Some(Some(3600)),
                ..Default::default()
            },
            actor: &system,
            source: VersionSource::Write,
            expected_version: None,
        };
        // An unknown policy fails closed.
        assert!(store.write_secret(write(generator.clone())).await.is_err());

        store
            .password_policy_put("db", &strict(), &actor())
            .await
            .unwrap();
        store.write_secret(write(generator)).await.unwrap();
        let first = store
            .reveal(&coords, None, &AuditActor::system())
            .await
            .unwrap();
        assert_eq!(first.chars().count(), 12);
        assert!(first.chars().filter(|c| "!@#$%".contains(*c)).count() >= 4);

        // The scheduler's rotation path generates through the same policy.
        let rotated = store
            .rotate_generated(coords.clone(), &AuditActor::system())
            .await
            .unwrap();
        assert_eq!(rotated.version, 2);
        let second = store
            .reveal(&coords, None, &AuditActor::system())
            .await
            .unwrap();
        assert_eq!(second.chars().count(), 12);

        // A referenced policy cannot be deleted, and the conflict names no
        // values (they may sit in scopes the caller cannot list).
        let error = store
            .password_policy_delete("db", &actor())
            .await
            .unwrap_err();
        let message = error.to_string();
        assert!(message.contains("1 stored value"), "{message}");
        assert!(!message.contains("DB_PASSWORD"), "{message}");
        // A soft-deleted value still pins the policy, so restoring it cannot
        // bring back a generator that points at a missing policy.
        store
            .delete_vault_secret(SecretScope::Node, "local", None, "DB_PASSWORD")
            .await
            .unwrap();
        assert!(store.password_policy_delete("db", &actor()).await.is_err());
        store
            .destroy(coords.clone(), None, &AuditActor::system())
            .await
            .unwrap();
        store.password_policy_delete("db", &actor()).await.unwrap();
    }

    #[tokio::test]
    async fn writes_check_an_inherited_policy_generator() {
        let store = PluginSecretStore::in_memory().unwrap();
        let coords = SecretCoords::root(SecretScope::Node, "local", None, "INHERITED");
        let system = AuditActor::system();
        store
            .password_policy_put("db", &strict(), &actor())
            .await
            .unwrap();
        let generator: Generator =
            serde_json::from_value(serde_json::json!({ "kind": "random", "policy": "db" }))
                .unwrap();
        store
            .write_secret(WriteRequest {
                coords: coords.clone(),
                value: None,
                patch: SecretMetadataPatch {
                    generator: Some(Some(generator)),
                    ..Default::default()
                },
                actor: &system,
                source: VersionSource::Write,
                expected_version: None,
            })
            .await
            .unwrap();
        // Simulate a row whose policy vanished (e.g. written by an older
        // binary): a plain value write that inherits the generator fails.
        {
            let conn = store.conn.lock().await;
            conn.execute("DELETE FROM vault_password_policies", [])
                .unwrap();
        }
        let plain = WriteRequest {
            coords: coords.clone(),
            value: Some("manual-value-123"),
            patch: SecretMetadataPatch::default(),
            actor: &system,
            source: VersionSource::Write,
            expected_version: None,
        };
        assert!(store.write_secret(plain).await.is_err());
    }
}
