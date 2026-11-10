//! Roles and leaf certificates: issue, sign, revoke, list, and the CRL.

use super::*;

impl PluginSecretStore {
    pub async fn pki_put_role(&self, role: &PkiRole, actor: &AuditActor) -> Result<()> {
        validate_role(role)?;
        let conn = self.conn.lock().await;
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM vault_pki_issuers WHERE name = ?1",
            params![role.issuer],
            |row| row.get(0),
        )?;
        if exists == 0 {
            return Err(VaultError::NotFound(format!("PKI issuer `{}`", role.issuer)).into());
        }
        conn.execute(
            "INSERT INTO vault_pki_roles (name, definition, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(name) DO UPDATE SET definition = excluded.definition",
            params![role.name, serde_json::to_string(role)?, now_millis()],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pki.role.put", "ok")
                .details(serde_json::json!({ "role": role.name })),
        );
        Ok(())
    }

    pub async fn pki_list_roles(&self) -> Result<Vec<PkiRole>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT definition FROM vault_pki_roles ORDER BY name")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str(&row?)?);
        }
        Ok(out)
    }

    pub async fn pki_delete_role(&self, name: &str, actor: &AuditActor) -> Result<bool> {
        let conn = self.conn.lock().await;
        let removed =
            conn.execute("DELETE FROM vault_pki_roles WHERE name = ?1", params![name])? > 0;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pki.role.delete", "ok")
                .details(serde_json::json!({ "role": name })),
        );
        Ok(removed)
    }

    fn load_role(conn: &Connection, name: &str) -> Result<PkiRole> {
        let definition: String = conn
            .query_row(
                "SELECT definition FROM vault_pki_roles WHERE name = ?1",
                params![name],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| VaultError::NotFound(format!("PKI role `{name}`")))?;
        Ok(serde_json::from_str(&definition)?)
    }

    pub(super) fn leaf_params(
        role: &PkiRole,
        common_name: &str,
        alt_names: &[String],
        ip_sans: &[String],
        ttl_secs: Option<i64>,
        issuer_not_after: i64,
    ) -> Result<(CertificateParams, String, i64)> {
        let mut dns: Vec<String> = Vec::new();
        for name in std::iter::once(common_name.to_owned()).chain(alt_names.iter().cloned()) {
            let name = name.trim().to_ascii_lowercase();
            if name.is_empty() || dns.contains(&name) {
                continue;
            }
            if !validate_dns_name(&name) || !domain_allowed(&role.allowed_domains, &name) {
                return Err(VaultError::Denied(format!(
                    "`{name}` is not allowed by role `{}`",
                    role.name
                ))
                .into());
            }
            dns.push(name);
        }
        if dns.len() + ip_sans.len() > MAX_SANS {
            return Err(VaultError::Invalid("too many subject alternative names".into()).into());
        }
        let mut sans = Vec::new();
        for name in &dns {
            sans.push(SanType::DnsName(
                name.clone()
                    .try_into()
                    .map_err(|_| VaultError::Invalid("invalid DNS name".into()))?,
            ));
        }
        for ip in ip_sans {
            if !role.allow_ip_sans {
                return Err(
                    VaultError::Denied("IP SANs are not allowed by this role".into()).into(),
                );
            }
            let parsed: IpAddr = ip
                .parse()
                .map_err(|_| VaultError::Invalid(format!("invalid IP SAN `{ip}`")))?;
            sans.push(SanType::IpAddress(parsed));
        }
        let ttl = ttl_secs.unwrap_or(role.default_ttl_secs);
        if ttl < 60 || ttl > role.max_ttl_secs {
            return Err(VaultError::Invalid(format!(
                "ttl must be between 60 and {} seconds",
                role.max_ttl_secs
            ))
            .into());
        }
        let now = OffsetDateTime::now_utc();
        // A leaf never outlives its issuer.
        let not_after = (now + Duration::seconds(ttl)).min(datetime(issuer_not_after));
        // An expired (or nearly expired) issuer would yield a certificate that
        // is invalid on arrival; refuse before a key or serial is created.
        if not_after < now + Duration::seconds(60) {
            return Err(VaultError::Invalid(
                "the issuing CA has expired or has less than a minute of validity left".into(),
            )
            .into());
        }
        let mut params = CertificateParams::default();
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, common_name.trim());
        params.distinguished_name = dn;
        params.subject_alt_names = sans;
        params.not_before = now - Duration::minutes(1);
        params.not_after = not_after;
        params.key_usages = vec![
            KeyUsagePurpose::DigitalSignature,
            KeyUsagePurpose::KeyEncipherment,
        ];
        if role.server_flag {
            params
                .extended_key_usages
                .push(ExtendedKeyUsagePurpose::ServerAuth);
        }
        if role.client_flag {
            params
                .extended_key_usages
                .push(ExtendedKeyUsagePurpose::ClientAuth);
        }
        params.use_authority_key_identifier_extension = true;
        params.key_identifier_method = KeyIdMethod::Sha256;
        let (serial, serial_hex) = fresh_serial();
        params.serial_number = Some(serial);
        Ok((params, serial_hex, not_after.unix_timestamp() * 1000))
    }

    /// Issue a certificate and a fresh private key under `role`.
    #[allow(clippy::too_many_arguments)]
    pub async fn pki_issue(
        &self,
        role_name: &str,
        common_name: &str,
        alt_names: &[String],
        ip_sans: &[String],
        ttl_secs: Option<i64>,
        actor: &AuditActor,
    ) -> Result<IssuedCertificate> {
        let conn = self.conn.lock().await;
        let role = Self::load_role(&conn, role_name)?;
        let issuer = self.load_issuer(&conn, &role.issuer)?;
        let (params, serial, not_after) = Self::leaf_params(
            &role,
            common_name,
            alt_names,
            ip_sans,
            ttl_secs,
            issuer.not_after,
        )?;
        let leaf_key = KeyPair::generate().map_err(pki_error)?;
        let certificate = cert_pem(
            &params
                .signed_by(&leaf_key, &issuer.signer()?)
                .map_err(pki_error)?,
        );
        self.record_cert(&conn, &serial, &role.issuer, common_name.trim(), not_after)?;
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pki.issue", "ok").details(serde_json::json!({
                "role": role_name, "serial": serial, "commonName": common_name.trim(),
            })),
        ) {
            // The certificate record stays so the serial can still be revoked;
            // the private key is never released.
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(IssuedCertificate {
            certificate,
            private_key: Some(der_to_pem("PRIVATE KEY", &leaf_key.serialize_der())),
            ca_chain: issuer.chain(),
            issuing_ca: issuer.certificate,
            serial,
            not_after,
        })
    }

    /// Sign a PEM CSR under `role`. Only the CSR's public key is used; names
    /// come from `common_name`/`alt_names` and are checked against the role.
    #[allow(clippy::too_many_arguments)]
    pub async fn pki_sign_csr(
        &self,
        role_name: &str,
        csr_pem: &str,
        common_name: &str,
        alt_names: &[String],
        ip_sans: &[String],
        ttl_secs: Option<i64>,
        actor: &AuditActor,
    ) -> Result<IssuedCertificate> {
        let csr = CertificateSigningRequestParams::from_pem(csr_pem).map_err(|_| {
            VaultError::Invalid("CSR is not a valid, self-signed PEM request".into())
        })?;
        let conn = self.conn.lock().await;
        let role = Self::load_role(&conn, role_name)?;
        let issuer = self.load_issuer(&conn, &role.issuer)?;
        let (params, serial, not_after) = Self::leaf_params(
            &role,
            common_name,
            alt_names,
            ip_sans,
            ttl_secs,
            issuer.not_after,
        )?;
        let certificate = cert_pem(
            &params
                .signed_by(&csr.public_key, &issuer.signer()?)
                .map_err(pki_error)?,
        );
        self.record_cert(&conn, &serial, &role.issuer, common_name.trim(), not_after)?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pki.sign", "ok").details(serde_json::json!({
                "role": role_name, "serial": serial, "commonName": common_name.trim(),
            })),
        );
        Ok(IssuedCertificate {
            certificate,
            private_key: None,
            ca_chain: issuer.chain(),
            issuing_ca: issuer.certificate,
            serial,
            not_after,
        })
    }

    /// Revoke a certificate by serial (hex). Idempotent.
    pub async fn pki_revoke(&self, serial: &str, actor: &AuditActor) -> Result<CertRecord> {
        let serial = serial.trim().to_ascii_lowercase().replace(':', "");
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE vault_pki_certs SET revoked_at = COALESCE(revoked_at, ?1) WHERE serial = ?2",
            params![now_millis(), serial],
        )?;
        let record = conn
            .query_row(
                "SELECT serial, issuer, common_name, not_after, revoked_at FROM vault_pki_certs
                 WHERE serial = ?1",
                params![serial],
                |row| {
                    Ok(CertRecord {
                        serial: row.get(0)?,
                        issuer: row.get(1)?,
                        common_name: row.get(2)?,
                        not_after: row.get(3)?,
                        revoked_at: row.get(4)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| VaultError::NotFound(format!("certificate {serial}")))?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pki.revoke", "ok")
                .details(serde_json::json!({ "serial": serial })),
        );
        Ok(record)
    }

    /// Certificates issued by `issuer`, newest first (bounded).
    pub async fn pki_list_certs(&self, issuer: &str) -> Result<Vec<CertRecord>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT serial, issuer, common_name, not_after, revoked_at FROM vault_pki_certs
             WHERE issuer = ?1 ORDER BY created_at DESC LIMIT 500",
        )?;
        let rows = stmt.query_map(params![issuer], |row| {
            Ok(CertRecord {
                serial: row.get(0)?,
                issuer: row.get(1)?,
                common_name: row.get(2)?,
                not_after: row.get(3)?,
                revoked_at: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// A freshly signed CRL (PEM) of unexpired revoked certificates.
    pub async fn pki_crl(&self, issuer_name: &str) -> Result<String> {
        let conn = self.conn.lock().await;
        let issuer = self.load_issuer(&conn, issuer_name)?;
        let revoked: Vec<(String, i64)> = {
            let mut stmt = conn.prepare(
                "SELECT serial, revoked_at FROM vault_pki_certs
                 WHERE issuer = ?1 AND revoked_at IS NOT NULL AND not_after > ?2",
            )?;
            let rows = stmt.query_map(params![issuer_name, now_millis()], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let crl_number: i64 = conn.query_row(
            "UPDATE vault_pki_issuers SET crl_number = crl_number + 1 WHERE name = ?1
             RETURNING crl_number",
            params![issuer_name],
            |row| row.get(0),
        )?;
        let now = OffsetDateTime::now_utc();
        let params = CertificateRevocationListParams {
            this_update: now,
            next_update: now + Duration::seconds(CRL_VALIDITY_SECS),
            crl_number: SerialNumber::from(crl_number as u64),
            issuing_distribution_point: None,
            revoked_certs: revoked
                .into_iter()
                .filter_map(|(serial, at)| {
                    Some(RevokedCertParams {
                        serial_number: SerialNumber::from_slice(&hex::decode(serial).ok()?),
                        revocation_time: datetime(at),
                        reason_code: None,
                        invalidity_date: None,
                    })
                })
                .collect(),
            key_identifier_method: KeyIdMethod::Sha256,
        };
        let crl = params.signed_by(&issuer.signer()?).map_err(pki_error)?;
        Ok(der_to_pem("X509 CRL", crl.der()))
    }
}

#[cfg(test)]
#[path = "certs_tests.rs"]
mod tests;
