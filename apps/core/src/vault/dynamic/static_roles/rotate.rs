//! The rotation flow: a generated password applied upstream, or a key
//! minted (or adopted) upstream with the replaced key retired afterwards.

use anyhow::{anyhow, Context, Result};
use rusqlite::params;
use serde_json::{json, Value};

use super::ai_keys::{self, MintedKey};
use super::iam::{iam_call, iam_delete_access_keys, xml_text};
use super::provider::apply_password;
use super::{password_generator, rotation_lock, SealedState, StaticProvider, StaticRoleInfo};
use crate::plugin_secrets::{PluginSecretStore, SecretMetadataPatch, VersionSource, WriteRequest};
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::now_millis;

/// Mint a new key upstream (or adopt the staged Anthropic one). Returns the
/// pending form sealed into the role before anything else can fail.
async fn mint_key(provider: &StaticProvider) -> Result<String> {
    match provider {
        StaticProvider::AwsIam {
            access_key_id,
            secret_access_key,
            user_name,
            ..
        } => {
            let answer = iam_call(
                access_key_id,
                secret_access_key,
                &[("Action", "CreateAccessKey"), ("UserName", user_name)],
            )
            .await?;
            let id = xml_text(&answer, "AccessKeyId")
                .ok_or_else(|| anyhow!("AWS IAM returned no access key id"))?;
            let secret = xml_text(&answer, "SecretAccessKey")
                .ok_or_else(|| anyhow!("AWS IAM returned no secret access key"))?;
            Ok(json!({ "accessKeyId": id, "secretAccessKey": secret }).to_string())
        }
        StaticProvider::OpenAi {
            admin_api_key,
            project_id,
            service_account_name,
            ..
        } => Ok(
            ai_keys::openai_mint(admin_api_key, project_id, service_account_name)
                .await?
                .to_pending(),
        ),
        StaticProvider::Anthropic {
            admin_api_key,
            workspace_id,
            replacement_api_key,
            current_api_key_id,
        } => {
            let staged = replacement_api_key.as_deref().ok_or_else(|| {
                anyhow!(
                    "no replacement key is staged: create a key in the Anthropic Console and \
                     save it on the role as replacementApiKey"
                )
            })?;
            let adopted =
                ai_keys::anthropic_adopt(admin_api_key, workspace_id.as_deref(), staged).await?;
            if current_api_key_id.as_deref() == Some(adopted.id.as_str()) {
                return Err(anyhow!(
                    "the staged replacement key is already the current key; stage a new one"
                ));
            }
            ai_keys::anthropic_probe(staged).await?;
            Ok(adopted.to_pending())
        }
        other => Err(anyhow!("{} roles do not mint keys", other.kind())),
    }
}

/// The new key's id and the value written to KV. An AWS pending value is
/// the KV value itself (JSON with `accessKeyId`), as stored before the AI
/// providers existed.
fn minted_parts(provider: &StaticProvider, pending: &str) -> Result<(Option<String>, String)> {
    if let StaticProvider::AwsIam { .. } = provider {
        let id = serde_json::from_str::<Value>(pending).ok().and_then(|v| {
            v.get("accessKeyId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
        return Ok((id, pending.to_owned()));
    }
    let minted = MintedKey::from_pending(pending)?;
    Ok((Some(minted.id), minted.value))
}

/// Retire replaced keys upstream. Returns the ids still live and a warning.
async fn retire_keys(provider: &StaticProvider, ids: Vec<String>) -> (Vec<String>, Option<String>) {
    match provider {
        StaticProvider::AwsIam {
            access_key_id,
            secret_access_key,
            user_name,
            ..
        } => iam_delete_access_keys(access_key_id, secret_access_key, user_name, ids).await,
        StaticProvider::OpenAi {
            admin_api_key,
            project_id,
            ..
        } => ai_keys::openai_retire(admin_api_key, project_id, ids).await,
        StaticProvider::Anthropic { admin_api_key, .. } => {
            ai_keys::anthropic_retire(admin_api_key, ids).await
        }
        _ => (Vec::new(), None),
    }
}

impl PluginSecretStore {
    /// Rotate one static role now.
    pub async fn static_rotate(&self, name: &str, actor: &AuditActor) -> Result<StaticRoleInfo> {
        let _guard = rotation_lock().lock().await;
        let (info, state) = self.static_state(name).await?;
        match self.static_rotate_locked(&info, state, actor).await {
            Ok(()) => self.static_role(name).await,
            Err(error) => {
                self.static_record_failure(name, &error, actor).await;
                Err(error)
            }
        }
    }

    /// The pending key, minting one (after retrying earlier retirements, so
    /// AWS's two-key limit cannot wedge the role) when none is pending.
    async fn static_pending_key(&self, name: &str, state: &mut SealedState) -> Result<String> {
        if let Some(pending) = state.pending.clone() {
            return Ok(pending);
        }
        if !state.retired_access_keys.is_empty() {
            let (kept, _) = retire_keys(&state.provider, state.retired_access_keys.clone()).await;
            if kept != state.retired_access_keys {
                state.retired_access_keys = kept;
                let conn = self.conn.lock().await;
                self.static_seal_state(&conn, name, state)?;
            }
        }
        let pending = mint_key(&state.provider).await?;
        // Persist before anything else can fail: the key is live upstream.
        // A staged Anthropic replacement is consumed into the pending key.
        state.pending = Some(pending.clone());
        if let StaticProvider::Anthropic {
            replacement_api_key,
            ..
        } = &mut state.provider
        {
            *replacement_api_key = None;
        }
        let conn = self.conn.lock().await;
        self.static_seal_state(&conn, name, state)?;
        Ok(pending)
    }

    async fn static_rotate_locked(
        &self,
        info: &StaticRoleInfo,
        mut state: SealedState,
        actor: &AuditActor,
    ) -> Result<()> {
        let name = info.name.as_str();
        let mut minted: Option<(Option<String>, Option<String>)> = None;
        let value = if state.provider.mints_keys() {
            let pending = self.static_pending_key(name, &mut state).await?;
            let (new_id, value) = minted_parts(&state.provider, &pending)?;
            minted = Some((state.provider.current_key_id(), new_id));
            value
        } else {
            let password = match state.pending.clone() {
                Some(pending) => pending,
                None => {
                    let password = password_generator(info.password_length).generate();
                    state.pending = Some(password.clone());
                    let conn = self.conn.lock().await;
                    self.static_seal_state(&conn, name, &state)?;
                    password
                }
            };
            apply_password(&state.provider, name, &password, state.egress).await?
        };
        self.write_secret(WriteRequest {
            coords: info.target.clone(),
            value: Some(&value),
            patch: SecretMetadataPatch::default(),
            actor,
            source: VersionSource::Rotate,
            expected_version: None,
        })
        .await
        .context("writing the rotated credential")?;

        // The new value is current; retire the replaced key and record the
        // new one so the next rotation retires it. Every replaced key stays
        // recorded until the vendor confirms it is gone, so a transient
        // failure is retried instead of leaving a live key Core forgot.
        let mut warning: Option<String> = None;
        if let Some((previous_id, new_id)) = minted {
            let mut retired = std::mem::take(&mut state.retired_access_keys);
            if let Some(old) = previous_id.filter(|old| Some(old) != new_id.as_ref()) {
                retired.push(old);
            }
            retired.retain(|id| Some(id) != new_id.as_ref());
            if !retired.is_empty() {
                let (kept, failed) = retire_keys(&state.provider, retired).await;
                state.retired_access_keys = kept;
                warning = failed;
            }
            state.provider.set_current_key_id(new_id);
        }
        state.pending = None;
        let now = now_millis();
        let conn = self.conn.lock().await;
        self.static_seal_state(&conn, name, &state)?;
        conn.execute(
            "UPDATE vault_static_roles SET last_rotated_at = ?1, next_rotation_at = ?2,
                 last_error = ?3 WHERE name = ?4",
            params![now, now + info.rotation_period_secs * 1000, warning, name],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "static.rotate", "ok")
                .details(json!({ "role": name, "provider": state.provider.kind() })),
        );
        Ok(())
    }

    /// Rotate every due static role. Failures are logged, recorded on the
    /// role, and retried later. Returns how many rotated.
    pub async fn static_rotate_due(&self) -> Result<usize> {
        let due: Vec<String> = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT name FROM vault_static_roles WHERE next_rotation_at <= ?1 ORDER BY name",
            )?;
            let rows = stmt.query_map(params![now_millis()], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let actor = AuditActor::system();
        let mut rotated = 0;
        for name in due {
            match self.static_rotate(&name, &actor).await {
                Ok(_) => rotated += 1,
                Err(error) => tracing::warn!("static role `{name}` rotation failed: {error:#}"),
            }
        }
        Ok(rotated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_keys_keep_their_stored_shapes() {
        let aws: StaticProvider = serde_json::from_value(json!({
            "kind": "aws-iam", "accessKeyId": "A", "secretAccessKey": "s", "userName": "ci"
        }))
        .unwrap();
        // aws-iam pending values predate the AI providers: the value itself.
        let pending = json!({ "accessKeyId": "AKIA1", "secretAccessKey": "s" }).to_string();
        assert_eq!(
            minted_parts(&aws, &pending).unwrap(),
            (Some("AKIA1".to_owned()), pending.clone())
        );
        let openai: StaticProvider = serde_json::from_value(json!({
            "kind": "openai", "adminApiKey": "k", "projectId": "proj_a"
        }))
        .unwrap();
        let minted = MintedKey {
            id: "svc_1".into(),
            value: "sk-svcacct-1".into(),
        };
        assert_eq!(
            minted_parts(&openai, &minted.to_pending()).unwrap(),
            (Some("svc_1".to_owned()), "sk-svcacct-1".to_owned())
        );
        assert!(minted_parts(&openai, "not json").is_err());
    }
}
