//! Transit operations: encrypt, decrypt, rewrap, data keys, sign, verify, and HMAC.

use super::*;

impl PluginSecretStore {
    /// Encrypt base64 `plaintext` (optional base64 `context` as AAD).
    pub async fn transit_encrypt(
        &self,
        name: &str,
        plaintext_b64: &str,
        context_b64: Option<&str>,
        actor: &AuditActor,
    ) -> Result<String> {
        self.transit_encrypt_with(
            name,
            plaintext_b64,
            &TransitOpOptions::with_context(context_b64),
            actor,
        )
        .await
    }

    /// Encrypt base64 `plaintext` with per-operation options.
    pub async fn transit_encrypt_with(
        &self,
        name: &str,
        plaintext_b64: &str,
        options: &TransitOpOptions,
        actor: &AuditActor,
    ) -> Result<String> {
        // Encryption hands out no secret material, so it never fails closed.
        let (ciphertext, _permitted) = self
            .transit_encrypt_audited(name, plaintext_b64, options, actor, "transit.encrypt")
            .await?;
        Ok(ciphertext)
    }

    /// Encrypt and audit under `action`; also returns the audit verdict.
    pub(super) async fn transit_encrypt_audited(
        &self,
        name: &str,
        plaintext_b64: &str,
        options: &TransitOpOptions,
        actor: &AuditActor,
        action: &str,
    ) -> Result<(String, bool)> {
        let plaintext = decode_input(plaintext_b64)?;
        let context = options.context.as_deref().map(decode_input).transpose()?;
        let associated = options
            .associated_data
            .as_deref()
            .map(decode_input)
            .transpose()?;
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        if !meta.key_type.can_encrypt() {
            return Err(invalid("this key type cannot encrypt"));
        }
        let version = meta.select_version(options.key_version)?;
        let material = self.transit_material(&conn, name, version)?;
        let out = if meta.key_type.is_symmetric() {
            let (key, aad) = aead_key_and_aad(&meta, &material, context, associated)?;
            let nonce = meta
                .convergent
                .then(|| convergent_nonce(&key, &aad, &plaintext));
            aead_encrypt(meta.key_type, &key, &plaintext, &aad, nonce)?
        } else {
            if context.is_some() || associated.is_some() {
                return Err(invalid("RSA encryption takes no context or associatedData"));
            }
            RsaPublicKey::from(&rsa_key(&material)?)
                .encrypt(&mut OsRng, Oaep::new::<Sha256>(), &plaintext)
                .map_err(|_| invalid("plaintext is too long for this RSA key"))?
        };
        let permitted = self.audit_locked(
            &conn,
            &AuditEntry::new(actor, action, "ok")
                .details(serde_json::json!({ "key": name, "version": version })),
        );
        Ok((encode(version, &out), permitted))
    }

    /// Decrypt a transit ciphertext, returning base64 plaintext.
    pub async fn transit_decrypt(
        &self,
        name: &str,
        ciphertext: &str,
        context_b64: Option<&str>,
        actor: &AuditActor,
    ) -> Result<String> {
        self.transit_decrypt_with(
            name,
            ciphertext,
            &TransitOpOptions::with_context(context_b64),
            actor,
        )
        .await
    }

    /// Decrypt with per-operation options.
    pub async fn transit_decrypt_with(
        &self,
        name: &str,
        ciphertext: &str,
        options: &TransitOpOptions,
        actor: &AuditActor,
    ) -> Result<String> {
        let (version, bytes) = decode(ciphertext)?;
        let context = options.context.as_deref().map(decode_input).transpose()?;
        let associated = options
            .associated_data
            .as_deref()
            .map(decode_input)
            .transpose()?;
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        if !meta.key_type.can_encrypt() {
            return Err(invalid("this key type cannot decrypt"));
        }
        meta.check_decryptable(version)?;
        let material = self.transit_material(&conn, name, version)?;
        let plain = if meta.key_type.is_symmetric() {
            let (key, aad) = aead_key_and_aad(&meta, &material, context, associated)?;
            aead_decrypt(meta.key_type, &key, &bytes, &aad)?
        } else {
            rsa_key(&material)?
                .decrypt(Oaep::new::<Sha256>(), &bytes)
                .map_err(|_| invalid("transit ciphertext failed to decrypt"))?
        };
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "transit.decrypt", "ok")
                .details(serde_json::json!({ "key": name, "version": version })),
        ) {
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(B64.encode(plain))
    }

    /// Re-encrypt a ciphertext under the latest key version.
    pub async fn transit_rewrap(
        &self,
        name: &str,
        ciphertext: &str,
        context_b64: Option<&str>,
        actor: &AuditActor,
    ) -> Result<String> {
        self.transit_rewrap_with(
            name,
            ciphertext,
            &TransitOpOptions::with_context(context_b64),
            actor,
        )
        .await
    }

    /// Re-encrypt under `options.key_version` (default latest).
    pub async fn transit_rewrap_with(
        &self,
        name: &str,
        ciphertext: &str,
        options: &TransitOpOptions,
        actor: &AuditActor,
    ) -> Result<String> {
        let plain = self
            .transit_decrypt_with(name, ciphertext, options, actor)
            .await?;
        self.transit_encrypt_with(name, &plain, options, actor)
            .await
    }

    /// Generate a 256-bit data key; return it in plaintext (base64) and
    /// wrapped by the named key (for envelope encryption by the caller).
    pub async fn transit_datakey(
        &self,
        name: &str,
        actor: &AuditActor,
    ) -> Result<(String, String)> {
        self.transit_datakey_with(name, &TransitOpOptions::default(), actor)
            .await
    }

    /// [`Self::transit_datakey`] with options (derived keys need `context`).
    pub async fn transit_datakey_with(
        &self,
        name: &str,
        options: &TransitOpOptions,
        actor: &AuditActor,
    ) -> Result<(String, String)> {
        let data_key = B64.encode(random_bytes(32));
        let (wrapped, permitted) = self
            .transit_encrypt_audited(name, &data_key, options, actor, "transit.datakey")
            .await?;
        if !permitted {
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok((data_key, wrapped))
    }

    /// Sign base64 `input` with the latest version of a signing key.
    pub async fn transit_sign(
        &self,
        name: &str,
        input_b64: &str,
        actor: &AuditActor,
    ) -> Result<String> {
        self.transit_sign_with(name, input_b64, &TransitOpOptions::default(), actor)
            .await
    }

    /// Sign base64 `input` with an Ed25519, ECDSA, or RSA key.
    pub async fn transit_sign_with(
        &self,
        name: &str,
        input_b64: &str,
        options: &TransitOpOptions,
        actor: &AuditActor,
    ) -> Result<String> {
        let input = decode_input(input_b64)?;
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        if !meta.key_type.can_sign() {
            return Err(invalid("this key type cannot sign"));
        }
        let version = meta.select_version(options.key_version)?;
        let material = self.transit_material(&conn, name, version)?;
        let signature = sign_material(
            meta.key_type,
            &material,
            &input,
            options.signature_algorithm.as_deref(),
        )?;
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "transit.sign", "ok")
                .details(serde_json::json!({ "key": name, "version": version })),
        ) {
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(encode(version, &signature))
    }

    /// Verify a signature produced by [`Self::transit_sign`].
    pub async fn transit_verify(
        &self,
        name: &str,
        input_b64: &str,
        signature: &str,
        actor: &AuditActor,
    ) -> Result<bool> {
        self.transit_verify_with(
            name,
            input_b64,
            signature,
            &TransitOpOptions::default(),
            actor,
        )
        .await
    }

    /// Verify a signature with options (`signatureAlgorithm` for RSA).
    pub async fn transit_verify_with(
        &self,
        name: &str,
        input_b64: &str,
        signature: &str,
        options: &TransitOpOptions,
        actor: &AuditActor,
    ) -> Result<bool> {
        let input = decode_input(input_b64)?;
        let (version, bytes) = decode(signature)?;
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        if !meta.key_type.can_sign() {
            return Err(invalid("this key type cannot verify"));
        }
        meta.check_decryptable(version)?;
        let material = self.transit_material(&conn, name, version)?;
        let valid = verify_material(
            meta.key_type,
            &material,
            &input,
            &bytes,
            options.signature_algorithm.as_deref(),
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "transit.verify", if valid { "ok" } else { "denied" })
                .details(serde_json::json!({ "key": name, "version": version })),
        );
        Ok(valid)
    }

    /// HMAC-SHA256 of base64 `input` with the key's latest version.
    pub async fn transit_hmac(
        &self,
        name: &str,
        input_b64: &str,
        actor: &AuditActor,
    ) -> Result<String> {
        self.transit_hmac_with(name, input_b64, &TransitOpOptions::default(), actor)
            .await
    }

    /// HMAC-SHA256 with options (`keyVersion`).
    pub async fn transit_hmac_with(
        &self,
        name: &str,
        input_b64: &str,
        options: &TransitOpOptions,
        actor: &AuditActor,
    ) -> Result<String> {
        let input = decode_input(input_b64)?;
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        if !meta.key_type.can_hmac() {
            return Err(invalid("CMAC keys cannot HMAC; use cmac"));
        }
        let version = meta.select_version(options.key_version)?;
        let material = self.transit_material(&conn, name, version)?;
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&hmac_key(meta.key_type, &material))
            .expect("any key length");
        mac.update(&input);
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "transit.hmac", "ok")
                .details(serde_json::json!({ "key": name, "version": version })),
        ) {
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(encode(version, &mac.finalize().into_bytes()))
    }

    /// Verify an HMAC produced by [`Self::transit_hmac`] (constant time).
    pub async fn transit_verify_hmac(
        &self,
        name: &str,
        input_b64: &str,
        hmac: &str,
        actor: &AuditActor,
    ) -> Result<bool> {
        let input = decode_input(input_b64)?;
        let (version, expected) = decode(hmac)?;
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        if !meta.key_type.can_hmac() {
            return Err(invalid("CMAC keys cannot HMAC; use cmac"));
        }
        meta.check_decryptable(version)?;
        let material = self.transit_material(&conn, name, version)?;
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&hmac_key(meta.key_type, &material))
            .expect("any key length");
        mac.update(&input);
        let valid = mac.verify_slice(&expected).is_ok();
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "transit.verify", if valid { "ok" } else { "denied" })
                .details(serde_json::json!({ "key": name, "version": version, "hmac": true })),
        );
        Ok(valid)
    }
}
