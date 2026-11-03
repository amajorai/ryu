//! Static-role rotation: one role now, every due role, and failure bookkeeping.
//!
//! test-exempt: moved out of `static_roles.rs` to keep it within the size limits; covered by
//! `static_roles/tests.rs` and `target_guard_test.rs`.

use super::*;

impl PluginSecretStore {
    pub(super) async fn static_record_failure(
        &self,
        name: &str,
        error: &anyhow::Error,
        actor: &AuditActor,
    ) {
        let conn = self.conn.lock().await;
        let message: String = error.to_string().chars().take(500).collect();
        if let Err(write_error) = conn.execute(
            "UPDATE vault_static_roles SET last_error = ?1, next_rotation_at = ?2 WHERE name = ?3",
            params![message, now_millis() + RETRY_SECS * 1000, name],
        ) {
            tracing::warn!("recording static rotation failure for `{name}`: {write_error:#}");
        }
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "static.rotate", "error")
                .details(json!({ "role": name, "error": message })),
        );
    }

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

    pub(super) async fn static_rotate_locked(
        &self,
        info: &StaticRoleInfo,
        mut state: SealedState,
        actor: &AuditActor,
    ) -> Result<()> {
        let name = info.name.as_str();
        let mut retired_key: Option<String> = None;
        let value = match &state.provider {
            StaticProvider::AwsIam {
                access_key_id,
                secret_access_key,
                user_name,
                current_access_key_id,
            } => {
                let created = match state.pending.clone() {
                    Some(pending) => pending,
                    None => {
                        // Free AWS's two-key slot from earlier failed
                        // deletions before creating another key.
                        if !state.retired_access_keys.is_empty() {
                            let (kept, _) = iam_delete_access_keys(
                                access_key_id,
                                secret_access_key,
                                user_name,
                                state.retired_access_keys.clone(),
                            )
                            .await;
                            if kept != state.retired_access_keys {
                                state.retired_access_keys = kept;
                                let conn = self.conn.lock().await;
                                self.static_seal_state(&conn, name, &state)?;
                            }
                        }
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
                        let created =
                            json!({ "accessKeyId": id, "secretAccessKey": secret }).to_string();
                        // Persist before anything else can fail: the key is
                        // already live at AWS.
                        state.pending = Some(created.clone());
                        let conn = self.conn.lock().await;
                        self.static_seal_state(&conn, name, &state)?;
                        created
                    }
                };
                retired_key = current_access_key_id.clone();
                created
            }
            provider => {
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
                apply_password(provider, name, &password, state.egress).await?
            }
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

        // The new value is current; retire the old AWS key and record the
        // new one so the next rotation deletes it.
        let mut warning: Option<String> = None;
        if let StaticProvider::AwsIam {
            access_key_id,
            secret_access_key,
            user_name,
            current_access_key_id,
        } = &mut state.provider
        {
            let new_id = serde_json::from_str::<Value>(&value).ok().and_then(|v| {
                v.get("accessKeyId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            // Every replaced key stays recorded until AWS confirms its
            // deletion, so a transient failure is retried instead of leaving
            // a live key Core no longer knows about.
            let mut retired = std::mem::take(&mut state.retired_access_keys);
            if let Some(old) = retired_key.filter(|old| Some(old) != new_id.as_ref()) {
                retired.push(old);
            }
            retired.retain(|id| Some(id) != new_id.as_ref());
            if !retired.is_empty() {
                let (kept, failed) =
                    iam_delete_access_keys(access_key_id, secret_access_key, user_name, retired)
                        .await;
                state.retired_access_keys = kept;
                warning = failed;
            }
            *current_access_key_id = new_id;
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
