//! Issuer lifecycle: roots, intermediates, imports, and tidy.

use super::*;

impl PluginSecretStore {
    /// Generate a self-signed root CA.
    pub async fn pki_create_root(
        &self,
        name: &str,
        common_name: &str,
        ttl_secs: i64,
        actor: &AuditActor,
    ) -> Result<IssuerInfo> {
        if !crate::vault::transit::is_valid_key_name(name) {
            return Err(VaultError::Invalid("invalid issuer name".into()).into());
        }
        let common_name = common_name.trim();
        if common_name.is_empty() || common_name.len() > 64 {
            return Err(VaultError::Invalid("commonName must be 1-64 characters".into()).into());
        }
        if !(3600..=MAX_ROOT_TTL_SECS).contains(&ttl_secs) {
            return Err(
                VaultError::Invalid("root TTL must be between 1 hour and 10 years".into()).into(),
            );
        }
        let key = KeyPair::generate().map_err(pki_error)?;
        let now = OffsetDateTime::now_utc();
        let not_after = now + Duration::seconds(ttl_secs);
        let mut params = ca_params(common_name, now - Duration::minutes(1), not_after);
        params.serial_number = Some(fresh_serial().0);
        let certificate = cert_pem(&params.self_signed(&key).map_err(pki_error)?);
        let (key_version, nonce, ciphertext) = self.seal_row(&key.serialize_der())?;
        let conn = self.conn.lock().await;
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO vault_pki_issuers
                (name, common_name, nonce, ciphertext, key_version, certificate, not_after, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                name,
                common_name,
                nonce,
                ciphertext,
                key_version,
                certificate,
                not_after.unix_timestamp() * 1000,
                now_millis()
            ],
        )?;
        if inserted == 0 {
            return Err(VaultError::Conflict(format!("PKI issuer `{name}` exists")).into());
        }
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pki.root.create", "ok")
                .details(serde_json::json!({ "issuer": name, "commonName": common_name })),
        );
        Ok(IssuerInfo {
            name: name.to_owned(),
            common_name: common_name.to_owned(),
            certificate,
            not_after: not_after.unix_timestamp() * 1000,
            kind: "root".into(),
            ca_chain: Vec::new(),
            csr: None,
        })
    }

    pub async fn pki_list_issuers(&self) -> Result<Vec<IssuerInfo>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT name FROM vault_pki_issuers ORDER BY name")?;
        let names = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        names
            .iter()
            .map(|name| issuer_info_locked(&conn, name))
            .collect()
    }

    /// Generate an intermediate CA key and return its CSR. The issuer stays
    /// pending (unusable) until [`Self::pki_set_signed`]. Calling it again for
    /// a still-pending issuer replaces the key and CSR.
    pub async fn pki_generate_intermediate(
        &self,
        name: &str,
        common_name: &str,
        actor: &AuditActor,
    ) -> Result<IssuerInfo> {
        if !crate::vault::transit::is_valid_key_name(name) {
            return Err(VaultError::Invalid("invalid issuer name".into()).into());
        }
        let common_name = common_name.trim();
        if common_name.is_empty() || common_name.len() > 64 {
            return Err(VaultError::Invalid("commonName must be 1-64 characters".into()).into());
        }
        let key = KeyPair::generate().map_err(pki_error)?;
        let mut params = CertificateParams::default();
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, common_name);
        params.distinguished_name = dn;
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let request = params.serialize_request(&key).map_err(pki_error)?;
        let csr = der_to_pem("CERTIFICATE REQUEST", request.der());
        let (key_version, nonce, ciphertext) = self.seal_row(&key.serialize_der())?;
        let conn = self.conn.lock().await;
        let pending: Option<Option<String>> = conn
            .query_row(
                "SELECT csr FROM vault_pki_issuers WHERE name = ?1",
                params![name],
                |row| row.get(0),
            )
            .optional()?;
        if matches!(pending, Some(None)) {
            return Err(VaultError::Conflict(format!("PKI issuer `{name}` exists")).into());
        }
        conn.execute(
            "INSERT INTO vault_pki_issuers
                (name, common_name, nonce, ciphertext, key_version, certificate, not_after,
                 created_at, kind, ca_chain, csr)
             VALUES (?1, ?2, ?3, ?4, ?5, '', 0, ?6, 'intermediate', '', ?7)
             ON CONFLICT(name) DO UPDATE SET common_name = excluded.common_name,
                 nonce = excluded.nonce, ciphertext = excluded.ciphertext,
                 key_version = excluded.key_version, csr = excluded.csr",
            params![
                name,
                common_name,
                nonce,
                ciphertext,
                key_version,
                now_millis(),
                csr
            ],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pki.intermediate.generate", "ok")
                .details(serde_json::json!({ "issuer": name, "commonName": common_name })),
        );
        issuer_info_locked(&conn, name)
    }

    /// Install the signed certificate of a pending intermediate. It must be a
    /// currently valid CA certificate for the pending key; `ca_chain` (PEM,
    /// nearest first) must start with its signer when given.
    pub async fn pki_set_signed(
        &self,
        name: &str,
        certificate_pem: &str,
        ca_chain: Option<&str>,
        actor: &AuditActor,
    ) -> Result<IssuerInfo> {
        let ca = parse_ca_certificate(certificate_pem)?;
        let chain = parse_chain(&ca.pem, ca_chain)?;
        let conn = self.conn.lock().await;
        let row: Option<(Vec<u8>, Vec<u8>, u32, Option<String>)> = conn
            .query_row(
                "SELECT nonce, ciphertext, key_version, csr FROM vault_pki_issuers WHERE name = ?1",
                params![name],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let (nonce, ciphertext, key_version, csr) =
            row.ok_or_else(|| VaultError::NotFound(format!("PKI issuer `{name}`")))?;
        if csr.is_none() {
            return Err(VaultError::Conflict(format!(
                "PKI issuer `{name}` is not waiting for a signed certificate"
            ))
            .into());
        }
        let der = self.open_row(key_version, &nonce, &ciphertext)?;
        let key = KeyPair::try_from(der.as_slice()).map_err(pki_error)?;
        if rcgen::PublicKeyData::subject_public_key_info(&key) != ca.spki {
            return Err(VaultError::Invalid(
                "the certificate does not match the pending intermediate key".into(),
            )
            .into());
        }
        conn.execute(
            "UPDATE vault_pki_issuers SET certificate = ?1, not_after = ?2, common_name = ?3,
                 ca_chain = ?4, csr = NULL WHERE name = ?5",
            params![ca.pem, ca.not_after, ca.common_name, chain.concat(), name],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pki.intermediate.set_signed", "ok")
                .details(serde_json::json!({ "issuer": name, "commonName": ca.common_name })),
        );
        issuer_info_locked(&conn, name)
    }

    /// Import an existing CA certificate and its private key (PEM, PKCS#8).
    pub async fn pki_import_issuer(
        &self,
        name: &str,
        certificate_pem: &str,
        private_key_pem: &str,
        ca_chain: Option<&str>,
        actor: &AuditActor,
    ) -> Result<IssuerInfo> {
        if !crate::vault::transit::is_valid_key_name(name) {
            return Err(VaultError::Invalid("invalid issuer name".into()).into());
        }
        let ca = parse_ca_certificate(certificate_pem)?;
        let chain = parse_chain(&ca.pem, ca_chain)?;
        let key = KeyPair::from_pem(private_key_pem).map_err(|_| {
            VaultError::Invalid("privateKey must be a PKCS#8 PEM private key".into())
        })?;
        if rcgen::PublicKeyData::subject_public_key_info(&key) != ca.spki {
            return Err(VaultError::Invalid(
                "the private key does not match the certificate".into(),
            )
            .into());
        }
        let (key_version, nonce, ciphertext) = self.seal_row(&key.serialize_der())?;
        let conn = self.conn.lock().await;
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO vault_pki_issuers
                (name, common_name, nonce, ciphertext, key_version, certificate, not_after,
                 created_at, kind, ca_chain)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'imported', ?9)",
            params![
                name,
                ca.common_name,
                nonce,
                ciphertext,
                key_version,
                ca.pem,
                ca.not_after,
                now_millis(),
                chain.concat()
            ],
        )?;
        if inserted == 0 {
            return Err(VaultError::Conflict(format!("PKI issuer `{name}` exists")).into());
        }
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pki.issuer.import", "ok")
                .details(serde_json::json!({ "issuer": name, "commonName": ca.common_name })),
        );
        issuer_info_locked(&conn, name)
    }

    /// Sign an intermediate CA's CSR with `issuer_name` (path length 0). The
    /// subject is `common_name`; only the CSR's public key is used.
    pub async fn pki_sign_intermediate(
        &self,
        issuer_name: &str,
        csr_pem: &str,
        common_name: &str,
        ttl_secs: Option<i64>,
        actor: &AuditActor,
    ) -> Result<IssuedCertificate> {
        let csr = CertificateSigningRequestParams::from_pem(csr_pem).map_err(|_| {
            VaultError::Invalid("CSR is not a valid, self-signed PEM request".into())
        })?;
        let common_name = common_name.trim();
        if common_name.is_empty() || common_name.len() > 64 {
            return Err(VaultError::Invalid("commonName must be 1-64 characters".into()).into());
        }
        let ttl = ttl_secs.unwrap_or(DEFAULT_INTERMEDIATE_TTL_SECS);
        if !(3600..=MAX_ROOT_TTL_SECS).contains(&ttl) {
            return Err(VaultError::Invalid(
                "intermediate TTL must be between 1 hour and 10 years".into(),
            )
            .into());
        }
        let conn = self.conn.lock().await;
        let issuer = self.load_issuer(&conn, issuer_name)?;
        let path_len_zero = pem_certificates(&issuer.certificate)?
            .first()
            .and_then(|der| {
                let (_, cert) = x509_parser::parse_x509_certificate(der).ok()?;
                let constraints = cert.basic_constraints().ok().flatten()?;
                Some(constraints.value.path_len_constraint == Some(0))
            })
            .unwrap_or(false);
        if path_len_zero {
            return Err(VaultError::Denied(format!(
                "PKI issuer `{issuer_name}` has path length 0 and cannot sign CAs"
            ))
            .into());
        }
        let now = OffsetDateTime::now_utc();
        let not_after = (now + Duration::seconds(ttl)).min(datetime(issuer.not_after));
        if not_after < now + Duration::seconds(3600) {
            return Err(VaultError::Invalid(
                "the issuing CA has less than an hour of validity left".into(),
            )
            .into());
        }
        let mut params = ca_params(common_name, now - Duration::minutes(1), not_after);
        params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
        params.use_authority_key_identifier_extension = true;
        let (serial, serial_hex) = fresh_serial();
        params.serial_number = Some(serial);
        let certificate = cert_pem(
            &params
                .signed_by(&csr.public_key, &issuer.signer()?)
                .map_err(pki_error)?,
        );
        let not_after_millis = not_after.unix_timestamp() * 1000;
        self.record_cert(
            &conn,
            &serial_hex,
            issuer_name,
            common_name,
            not_after_millis,
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pki.intermediate.sign", "ok").details(serde_json::json!({
                "issuer": issuer_name, "serial": serial_hex, "commonName": common_name,
            })),
        );
        Ok(IssuedCertificate {
            certificate,
            private_key: None,
            issuing_ca: issuer.certificate.clone(),
            ca_chain: issuer.chain(),
            serial: serial_hex,
            not_after: not_after_millis,
        })
    }

    /// Forget certificates (revoked or not) that expired more than
    /// `safety_buffer_secs` ago; they can no longer appear on a CRL.
    pub async fn pki_tidy(&self, safety_buffer_secs: i64, actor: &AuditActor) -> Result<usize> {
        const MAX_SAFETY_BUFFER_SECS: i64 = 10 * 365 * 24 * 3600;
        if !(0..=MAX_SAFETY_BUFFER_SECS).contains(&safety_buffer_secs) {
            return Err(VaultError::Invalid(format!(
                "safetyBufferSecs must be between 0 and {MAX_SAFETY_BUFFER_SECS}"
            ))
            .into());
        }
        let now = now_millis();
        let cutoff = safety_buffer_secs
            .checked_mul(1000)
            .and_then(|buffer| now.checked_sub(buffer))
            .ok_or_else(|| VaultError::Invalid("safetyBufferSecs is out of range".into()))?;
        let conn = self.conn.lock().await;
        // `not_after < now` guarantees an unexpired certificate is never tidied,
        // whatever the cutoff, so a revocation can not drop off the CRL early.
        let removed = conn.execute(
            "DELETE FROM vault_pki_certs WHERE not_after < ?1 AND not_after < ?2",
            params![cutoff, now],
        )?;
        if removed > 0 {
            self.audit_locked(
                &conn,
                &AuditEntry::new(actor, "pki.tidy", "ok").details(serde_json::json!({
                    "removed": removed, "safetyBufferSecs": safety_buffer_secs,
                })),
            );
        }
        Ok(removed)
    }
}

#[cfg(test)]
#[path = "issuers_tests.rs"]
mod tests;
