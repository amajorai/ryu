//! The change-request lifecycle on [`PluginSecretStore`]: create, list,
//! approve (applying once enough approvals exist), and close.
//! test-exempt: moved out of changes.rs; changes/tests.rs and tests_base.rs drive every lifecycle step.

use super::*;

impl PluginSecretStore {
    /// Record a pending change. `patch` is the raw metadata patch JSON.
    pub async fn create_change_request(
        &self,
        coords: SecretCoords,
        operation: ChangeOperation,
        value: Option<&str>,
        patch: Value,
        required_approvals: u8,
        actor: &AuditActor,
        authority: &RequesterAuthority,
    ) -> Result<ChangeRequest> {
        self.create_change_request_from(
            ChangeBase::default(),
            coords,
            operation,
            value,
            patch,
            required_approvals,
            actor,
            authority,
        )
        .await
    }

    /// [`Self::create_change_request`] against the state the caller edited
    /// from: a stale `expected` is refused with a conflict now, instead of
    /// pinning the request to a version the caller never saw.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_change_request_from(
        &self,
        expected: ChangeBase,
        coords: SecretCoords,
        operation: ChangeOperation,
        value: Option<&str>,
        patch: Value,
        required_approvals: u8,
        actor: &AuditActor,
        authority: &RequesterAuthority,
    ) -> Result<ChangeRequest> {
        let coords = coords.normalize()?;
        // Validate the patch now so an approver never applies a bad request.
        serde_json::from_value::<SecretMetadataPatch>(patch.clone())
            .map_err(|error| VaultError::Invalid(format!("invalid metadata: {error}")))?;
        if operation == ChangeOperation::Write && value.is_none() && patch == json!({}) {
            bail!("a write change request needs a value or metadata");
        }
        let sealed = value
            .map(|value| self.seal_row(value.as_bytes()))
            .transpose()?;
        let id = format!("vcr_{}", uuid::Uuid::new_v4().simple());
        // Pin the state this request is reviewed against; approval refuses
        // to apply it over a later change.
        let base = BaseState::of(self.secret_info(&coords).await?.as_ref());
        if let Some(conflict) = base.conflict_with_expected(expected) {
            return Err(conflict);
        }
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO vault_change_requests
                (id, status, operation, coords, patch, nonce, ciphertext, key_version,
                 requested_by, requested_at, required_approvals, requester_subjects,
                 requester_baseline, base_version, base_metadata_version, base_deleted)
             VALUES (?1, 'pending', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                     ?14, ?15)",
            params![
                id,
                match operation {
                    ChangeOperation::Write => "write",
                    ChangeOperation::Delete => "delete",
                },
                serde_json::to_string(&coords)?,
                patch.to_string(),
                sealed.as_ref().map(|(_, nonce, _)| nonce.clone()),
                sealed.as_ref().map(|(_, _, ciphertext)| ciphertext.clone()),
                sealed.as_ref().map(|(version, _, _)| *version).unwrap_or(0),
                subject_of(actor),
                now_millis(),
                required_approvals.clamp(1, 5) as i64,
                serde_json::to_string(&authority.subjects)?,
                serde_json::to_string(&authority.baseline)?,
                base.version,
                base.metadata_version,
                base.deleted,
            ],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "change.request", "ok")
                .secret(
                    coords.scope.as_str(),
                    &coords.scope_id,
                    &coords.environment,
                    &coords.path,
                    &coords.name,
                )
                .details(json!({ "id": id, "operation": operation })),
        );
        load(&conn, &id)
    }

    /// List change requests, newest first, optionally by status.
    pub async fn list_change_requests(
        &self,
        status: Option<ChangeStatus>,
    ) -> Result<Vec<ChangeRequest>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM vault_change_requests
             WHERE (?1 IS NULL OR status = ?1)
             ORDER BY requested_at DESC LIMIT 500"
        ))?;
        let rows = stmt.query_map(params![status.map(ChangeStatus::as_str)], from_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub async fn change_request(&self, id: &str) -> Result<ChangeRequest> {
        let conn = self.conn.lock().await;
        load(&conn, id)
    }

    /// Approve a pending request; applies it once enough approvals exist.
    ///
    /// `current_required` is the environment's `requiredApprovals` now (`None`
    /// when it is no longer protected); the larger of it and the request's
    /// snapshot applies. An expired request is rejected, never applied.
    pub async fn approve_change_request(
        &self,
        id: &str,
        actor: &AuditActor,
        current_required: Option<u8>,
    ) -> Result<ChangeRequest> {
        let approver = subject_of(actor);
        let (request, ready, value) = {
            let conn = self.conn.lock().await;
            let mut request = load(&conn, id)?;
            if request.status != ChangeStatus::Pending {
                return Err(VaultError::Conflict(format!(
                    "change request is {}",
                    request.status.as_str()
                ))
                .into());
            }
            if request.requested_by == approver {
                return Err(VaultError::Denied(
                    "requesters cannot approve their own change".into(),
                )
                .into());
            }
            if request
                .approvals
                .iter()
                .any(|approval| approval.by == approver)
            {
                return Err(
                    VaultError::Conflict("already approved by this principal".into()).into(),
                );
            }
            if now_millis() >= request.expires_at {
                self.reject_stale_locked(&conn, &request, actor, &approver, "expired")?;
                return Err(VaultError::Conflict(
                    "change request expired; it was rejected and must be requested again".into(),
                )
                .into());
            }
            if !requester_still_authorized(&conn, &request)? {
                self.reject_stale_locked(
                    &conn,
                    &request,
                    actor,
                    &approver,
                    REQUESTER_NO_LONGER_AUTHORIZED,
                )?;
                return Err(VaultError::Conflict(
                    "the requester no longer holds the access this change needs; it was rejected"
                        .into(),
                )
                .into());
            }
            let required = request
                .required_approvals
                .max(current_required.unwrap_or(0).min(5));
            request.approvals.push(Approval {
                by: approver.clone(),
                at: now_millis(),
            });
            let ready = request.approvals.len() >= required as usize;
            if ready {
                // Claim the request under the same lock as the threshold
                // approval, so a later approver sees it as no longer pending
                // and the change can never be applied twice.
                conn.execute(
                    "UPDATE vault_change_requests SET approvals = ?1, status = 'applied',
                         decided_by = ?2, decided_at = ?3
                     WHERE id = ?4",
                    params![
                        serde_json::to_string(&request.approvals)?,
                        approver,
                        now_millis(),
                        id
                    ],
                )?;
            } else {
                conn.execute(
                    "UPDATE vault_change_requests SET approvals = ?1 WHERE id = ?2",
                    params![serde_json::to_string(&request.approvals)?, id],
                )?;
            }
            self.audit_locked(
                &conn,
                &AuditEntry::new(actor, "change.approve", "ok")
                    .secret(
                        request.coords.scope.as_str(),
                        &request.coords.scope_id,
                        &request.coords.environment,
                        &request.coords.path,
                        &request.coords.name,
                    )
                    .details(json!({ "id": id })),
            );
            let value = if ready {
                let sealed: Option<(Option<Vec<u8>>, Option<Vec<u8>>, u32)> = conn
                    .query_row(
                        "SELECT nonce, ciphertext, key_version FROM vault_change_requests WHERE id = ?1",
                        params![id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()?;
                match sealed {
                    Some((Some(nonce), Some(ciphertext), key_version)) => Some(
                        String::from_utf8(self.open_row(key_version, &nonce, &ciphertext)?)
                            .context("proposed value is not UTF-8")?,
                    ),
                    _ => None,
                }
            } else {
                None
            };
            (request, ready, value)
        };
        if !ready {
            return Ok(request);
        }
        // Errors here (including a conflict) release the claim below.
        let base_conflict = self.base_version_conflict(&request).await;
        let applied: Result<()> = match (request.operation, base_conflict) {
            (_, Err(error)) | (_, Ok(Some(error))) => Err(error),
            (ChangeOperation::Write, Ok(None)) => {
                match serde_json::from_value::<SecretMetadataPatch>(request.patch.clone()) {
                    Ok(patch) => self
                        .write_secret(WriteRequest {
                            coords: request.coords.clone(),
                            value: value.as_deref(),
                            patch,
                            actor,
                            source: VersionSource::Approval,
                            expected_version: request.base_version,
                        })
                        .await
                        .map(|_| ()),
                    Err(error) => Err(error.into()),
                }
            }
            (ChangeOperation::Delete, Ok(None)) => self
                .soft_delete(request.coords.clone(), actor)
                .await
                .map(|_| ()),
        };
        let conn = self.conn.lock().await;
        if let Err(error) = applied {
            // Release the claim and drop this approval, so the request can be
            // approved again or rejected; the proposed value is still sealed.
            let previous = &request.approvals[..request.approvals.len() - 1];
            conn.execute(
                "UPDATE vault_change_requests SET status = 'pending', decided_by = NULL,
                     decided_at = NULL, approvals = ?1
                 WHERE id = ?2",
                params![serde_json::to_string(previous)?, id],
            )?;
            self.audit_locked(
                &conn,
                &AuditEntry::new(actor, "change.apply", "error")
                    .secret(
                        request.coords.scope.as_str(),
                        &request.coords.scope_id,
                        &request.coords.environment,
                        &request.coords.path,
                        &request.coords.name,
                    )
                    .details(json!({ "id": id, "error": error.to_string() })),
            );
            return Err(error);
        }
        conn.execute(
            "UPDATE vault_change_requests SET nonce = NULL, ciphertext = NULL WHERE id = ?1",
            params![id],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "change.apply", "ok")
                .secret(
                    request.coords.scope.as_str(),
                    &request.coords.scope_id,
                    &request.coords.environment,
                    &request.coords.path,
                    &request.coords.name,
                )
                .details(json!({ "id": id })),
        );
        load(&conn, id)
    }

    /// A conflict when the secret has changed since `request` was made: a
    /// new value version, a metadata-only write, a delete or a restore.
    /// `write_secret` re-checks the value version atomically through
    /// `expected_version`. Requests made before the base metadata version and
    /// deleted state were recorded are checked on the value version only.
    async fn base_version_conflict(
        &self,
        request: &ChangeRequest,
    ) -> Result<Option<anyhow::Error>> {
        let Some(base) = request.base_version else {
            return Ok(None);
        };
        // The lock guard is a temporary, released at the end of the statement.
        let pinned: Option<(Option<i64>, Option<bool>)> = self
            .conn
            .lock()
            .await
            .query_row(
                "SELECT base_metadata_version, base_deleted FROM vault_change_requests
                 WHERE id = ?1",
                params![request.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (base_metadata_version, base_deleted) = pinned.unwrap_or((None, None));
        let current = BaseState::of(self.secret_info(&request.coords).await?.as_ref());
        let message = if current.version != base {
            format!("the secret is at version {}, not {base}", current.version)
        } else if base_metadata_version.is_some_and(|pinned| pinned != current.metadata_version) {
            "the secret metadata changed after this request was made".to_owned()
        } else if base_deleted.is_some_and(|pinned| pinned != current.deleted) {
            if current.deleted {
                "the secret was deleted after this request was made".to_owned()
            } else {
                "the secret was restored after this request was made".to_owned()
            }
        } else {
            return Ok(None);
        };
        Ok(Some(VaultError::Conflict(message).into()))
    }

    /// Close a pending request that can no longer be applied, dropping its
    /// sealed proposal. The caller holds the connection lock.
    fn reject_stale_locked(
        &self,
        conn: &Connection,
        request: &ChangeRequest,
        actor: &AuditActor,
        approver: &str,
        reason: &str,
    ) -> Result<()> {
        conn.execute(
            "UPDATE vault_change_requests SET status = 'rejected', decided_by = ?1,
                 decided_at = ?2, reason = ?3, nonce = NULL, ciphertext = NULL
             WHERE id = ?4 AND status = 'pending'",
            params![approver, now_millis(), reason, request.id],
        )?;
        self.audit_locked(
            conn,
            &AuditEntry::new(actor, "change.reject", "ok")
                .secret(
                    request.coords.scope.as_str(),
                    &request.coords.scope_id,
                    &request.coords.environment,
                    &request.coords.path,
                    &request.coords.name,
                )
                .details(json!({ "id": request.id, "reason": reason })),
        );
        Ok(())
    }

    /// Reject (by an approver) or cancel (by the requester) a pending request.
    pub async fn close_change_request(
        &self,
        id: &str,
        actor: &AuditActor,
        reason: Option<&str>,
        cancel: bool,
    ) -> Result<ChangeRequest> {
        let subject = subject_of(actor);
        let conn = self.conn.lock().await;
        let request = load(&conn, id)?;
        if request.status != ChangeStatus::Pending {
            return Err(VaultError::Conflict("change request is not pending".into()).into());
        }
        if cancel && request.requested_by != subject {
            return Err(VaultError::Denied("only the requester can cancel".into()).into());
        }
        let status = if cancel {
            ChangeStatus::Canceled
        } else {
            ChangeStatus::Rejected
        };
        conn.execute(
            "UPDATE vault_change_requests SET status = ?1, decided_by = ?2, decided_at = ?3,
                 reason = ?4, nonce = NULL, ciphertext = NULL
             WHERE id = ?5",
            params![
                status.as_str(),
                subject,
                now_millis(),
                reason.map(|r| r.chars().take(512).collect::<String>()),
                id
            ],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(
                actor,
                if cancel {
                    "change.cancel"
                } else {
                    "change.reject"
                },
                "ok",
            )
            .secret(
                request.coords.scope.as_str(),
                &request.coords.scope_id,
                &request.coords.environment,
                &request.coords.path,
                &request.coords.name,
            )
            .details(json!({ "id": id })),
        );
        load(&conn, id).map_err(|error| anyhow!(error))
    }
}
