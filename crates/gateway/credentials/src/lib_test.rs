//! Tests for lib.rs and inference_scope.rs, moved out of lib.rs unchanged except where noted.

use super::*;

#[test]
fn readiness_request_proof_binds_nonce_and_admin_before_signing() {
    let nonce = "a".repeat(64);
    let proof = readiness_request_signature(&nonce, "admin").unwrap();
    assert!(verify_readiness_request(&nonce, &proof, "admin").is_ok());
    assert!(verify_readiness_request(&nonce, "", "admin").is_err());
    assert!(verify_readiness_request(&nonce, &proof, "wrong").is_err());
    assert!(verify_readiness_request(&"b".repeat(64), &proof, "admin").is_err());
    assert!(verify_readiness_request("bad", &proof, "admin").is_err());
}

#[test]
fn direct_compatible_provider_urls_are_explicitly_allowlisted() {
    let providers = [
        ("voyage", "https://api.voyageai.com/v1"),
        ("jina", "https://api.jina.ai/v1"),
        ("mistral", "https://api.mistral.ai/v1"),
        ("huggingface", "https://router.huggingface.co/v1"),
        ("nvidia", "https://integrate.api.nvidia.com/v1"),
        ("together", "https://api.together.xyz/v1"),
        ("fireworks", "https://api.fireworks.ai/inference/v1"),
        ("chutes", "https://llm.chutes.ai/v1"),
        ("hyperbolic", "https://api.hyperbolic.xyz/v1"),
        ("siliconflow", "https://api.siliconflow.com/v1"),
        ("venice", "https://api.venice.ai/api/v1"),
        ("featherless", "https://api.featherless.ai/v1"),
    ];

    for (provider, expected_url) in providers {
        assert_eq!(direct_compatible_provider_url(provider), Some(expected_url));
    }
    for unknown in ["openai", "Voyage", "https://example.com"] {
        assert_eq!(direct_compatible_provider_url(unknown), None);
    }
}

#[test]
fn persists_distinct_private_keys_and_rejects_invalid_existing_files() {
    let dir = std::env::temp_dir().join(format!("ryu-credentials-{}", uuid::Uuid::new_v4()));
    let path = dir.join("relay.key");
    let key = load_or_create(&path, "gwrelay_").unwrap();
    assert_eq!(load_or_create(&path, "gwrelay_").unwrap(), key);
    assert_ne!(
        load_or_create(&dir.join("admin.key"), "gwadm_").unwrap(),
        key
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load_or_create(&path, "gwrelay_").is_err());
        let link = dir.join("link.key");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(load_or_create(&link, "gwrelay_").is_err());
    }
    std::fs::remove_dir_all(dir).unwrap();
}
fn test_sealer() -> ryu_crypto::ComponentCipher {
    ryu_crypto::ComponentCipher::from_subkey_b64(
        ryu_crypto::components::GATEWAY,
        "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
    )
    .unwrap()
}

#[test]
fn sealed_credentials_round_trip_without_plaintext_on_disk() {
    let dir = std::env::temp_dir().join(format!("ryu-sealed-cred-{}", uuid::Uuid::new_v4()));
    let path = dir.join("gateway-admin.key");
    let sealer = test_sealer();
    let key = load_or_create_sealed(&path, "gwadm_", &sealer).unwrap();
    assert!(key.starts_with("gwadm_"));
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(raw.starts_with("encc:v1:"), "file body must be sealed");
    assert!(!raw.contains(&key), "raw key on disk");
    assert_eq!(
        load_or_create_sealed(&path, "gwadm_", &sealer).unwrap(),
        key
    );
    assert_eq!(read_sealed(&path, &sealer).unwrap(), key);
    // The plaintext loader refuses a sealed file instead of misreading it.
    assert!(load_or_create(&path, "gwadm_").is_err());
    // A wrong key is an error, never a silently minted replacement key.
    let other = ryu_crypto::ComponentCipher::from_subkey_b64(
        ryu_crypto::components::GATEWAY,
        "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=",
    )
    .unwrap();
    assert!(load_or_create_sealed(&path, "gwadm_", &other).is_err());
    assert_eq!(read_sealed(&path, &sealer).unwrap(), key);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn legacy_plaintext_credentials_are_resealed_in_place() {
    let dir = std::env::temp_dir().join(format!("ryu-legacy-cred-{}", uuid::Uuid::new_v4()));
    let path = dir.join("gateway-relay.key");
    let legacy = load_or_create(&path, "gwrelay_").unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), legacy);
    let sealer = ryu_crypto::FieldCipher::new(&[9u8; 32]);
    assert_eq!(
        load_or_create_sealed(&path, "gwrelay_", &sealer).unwrap(),
        legacy
    );
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(raw.starts_with("enc:v1:"));
    assert!(!raw.contains(&legacy));
    assert_eq!(
        load_or_create_sealed(&path, "gwrelay_", &sealer).unwrap(),
        legacy
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let link = dir.join("link.key");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(load_or_create_sealed(&link, "gwrelay_", &sealer).is_err());
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn concurrent_sealed_bootstrap_converges_on_one_key() {
    let directory = std::env::temp_dir().join(format!("ryu-sealed-race-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("relay.key");
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let path = path.clone();
            std::thread::spawn(move || {
                load_or_create_sealed(&path, "gwrelay_", &test_sealer()).unwrap()
            })
        })
        .collect();
    let keys: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert!(keys.iter().all(|key| key == &keys[0]));
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn rejects_blank_short_and_header_injection_values() {
    for key in [
        "",
        "ryu-local",
        "operator-key",
        "abcdefghijklmnopqrstuvwx\n",
    ] {
        assert!(validate(key).is_err());
    }
    assert!(validate("gwrelay_0123456789abcdef0123456789abcdef").is_ok());
}
#[test]
fn concurrent_bootstrap_converges_and_storage_failure_is_fatal() {
    let directory = std::env::temp_dir().join(format!("ryu-key-race-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("relay.key");
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let path = path.clone();
            std::thread::spawn(move || load_or_create(&path, "gwrelay_").unwrap())
        })
        .collect();
    let keys: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert!(keys.iter().all(|key| key == &keys[0]));
    let blocked = directory.join("not-a-directory");
    std::fs::write(&blocked, b"block").unwrap();
    assert!(load_or_create(&blocked.join("key"), "gwrelay_").is_err());
    std::fs::remove_dir_all(directory).unwrap();
}
#[test]
fn readiness_binds_nonce_socket_and_roles() {
    let readiness = Readiness {
        protocol: "ryu-gateway-readiness-v1".into(),
        version: "1".into(),
        nonce: "nonce".into(),
        listener: "127.0.0.1:1234".parse().unwrap(),
        require_auth: true,
        inference_keys: vec![fingerprint("relay")],
        core_keys: vec![fingerprint("core")],
    };
    let proof = ReadinessProof::sign(readiness, "admin").unwrap();
    assert!(proof
        .verify(
            "admin",
            "nonce",
            "127.0.0.1:1234".parse().unwrap(),
            "1",
            "relay",
            "core"
        )
        .is_ok());
    assert!(proof
        .verify(
            "wrong",
            "nonce",
            "127.0.0.1:1234".parse().unwrap(),
            "1",
            "relay",
            "core"
        )
        .is_err());
    assert!(proof
        .verify(
            "admin",
            "other-nonce",
            "127.0.0.1:1234".parse().unwrap(),
            "1",
            "relay",
            "core"
        )
        .is_err());
    assert!(proof
        .verify(
            "admin",
            "nonce",
            "127.0.0.1:5678".parse().unwrap(),
            "1",
            "relay",
            "core"
        )
        .is_err());
    // A different release that speaks the same protocol is no longer refused.
    // The protocol rule itself is tested in readiness.rs.
    assert!(proof
        .verify(
            "admin",
            "nonce",
            "127.0.0.1:1234".parse().unwrap(),
            "2",
            "relay",
            "core"
        )
        .is_ok());
    assert!(proof
        .verify(
            "admin",
            "nonce",
            "127.0.0.1:1234".parse().unwrap(),
            "1",
            "core",
            "relay"
        )
        .is_err());
}
#[test]
fn scoped_inference_identity_cannot_be_changed_by_its_recipient() {
    let scope = InferenceScope {
        agent_id: "agent-a".into(),
        user_id: Some("user-a".into()),
        session_id: Some("session-a".into()),
        expires_at: unix_now() + 3600,
        provider_access: None,
    };
    let token = scope.sign("core-only-signing-key").unwrap();
    assert_eq!(
        InferenceScope::verify(&token, "core-only-signing-key").unwrap(),
        scope
    );
    assert!(InferenceScope::verify(&token, "exported-inference-relay").is_err());
    let mut other = scope.clone();
    other.agent_id = "agent-b".into();
    let payload = hex::encode(serde_json::to_vec(&other).unwrap());
    let (_, signature) = token.rsplit_once('.').unwrap();
    assert!(InferenceScope::verify(
        &format!("gws1.{payload}.{signature}"),
        "core-only-signing-key"
    )
    .is_err());
    other.agent_id = " ".into();
    assert!(other.sign("core-only-signing-key").is_err());
}

#[test]
fn scoped_inference_provider_access_round_trips_and_stays_optional() {
    let key = "core-only-signing-key";
    let limited = InferenceScope {
        agent_id: "agent-a".into(),
        user_id: None,
        session_id: None,
        expires_at: unix_now() + 3600,
        provider_access: Some(vec!["anthropic".into(), "genai".into()]),
    };
    let token = limited.sign(key).unwrap();
    assert_eq!(InferenceScope::verify(&token, key).unwrap(), limited);

    // A token minted without the field (as before it existed) still
    // verifies, reads back unrestricted, and keeps its exact payload.
    let legacy = InferenceScope {
        provider_access: None,
        ..limited.clone()
    };
    let legacy_token = legacy.sign(key).unwrap();
    assert!(!String::from_utf8(
        hex::decode(
            legacy_token
                .strip_prefix("gws1.")
                .unwrap()
                .rsplit_once('.')
                .unwrap()
                .0
        )
        .unwrap()
    )
    .unwrap()
    .contains("providerAccess"));
    assert_eq!(
        InferenceScope::verify(&legacy_token, key)
            .unwrap()
            .provider_access,
        None
    );

    // Unknown fields are still refused, and malformed ids cannot be signed.
    let mut unknown = serde_json::to_value(&legacy).unwrap();
    unknown["extra"] = serde_json::json!(true);
    assert!(serde_json::from_value::<InferenceScope>(unknown).is_err());
    for bad in ["", "open,ai", "OpenAI", "a b"] {
        let scope = InferenceScope {
            provider_access: Some(vec![bad.to_owned()]),
            ..limited.clone()
        };
        assert!(scope.sign(key).is_err(), "{bad:?}");
    }
    assert!(InferenceScope {
        provider_access: Some(Vec::new()),
        ..limited
    }
    .sign(key)
    .is_ok());
}

#[test]
fn scoped_inference_credentials_expire() {
    let scope = InferenceScope {
        agent_id: "agent-a".into(),
        user_id: None,
        session_id: None,
        expires_at: unix_now().saturating_sub(1),
        provider_access: None,
    };
    assert!(scope.sign("core-only-signing-key").is_err());
}

fn box_scope(expires_at: u64) -> BoxInferenceScope {
    BoxInferenceScope {
        org_id: "org_1".into(),
        user_id: Some("user_1".into()),
        session_id: "conv_1".into(),
        box_id: "bx_0123456789abcdef0123456789abcdef".into(),
        lease_epoch: 3,
        expires_at,
        key_epoch: 0,
    }
}

#[test]
fn box_inference_scope_round_trips() {
    let now = 1_800_000_000;
    let scope = box_scope(now + BOX_INFERENCE_MAX_TTL_SECS);
    let token = scope.sign_at("core-proof-key", now).unwrap();
    assert!(token.starts_with("gwb1."));
    assert!(BoxInferenceScope::is_box_token(&token));
    assert_eq!(
        BoxInferenceScope::verify_at(&token, "core-proof-key", now).unwrap(),
        scope
    );
    // The wall-clock entry points agree for a live key.
    let live = box_scope(unix_now() + 600);
    let token = live.sign("core-proof-key").unwrap();
    assert_eq!(
        BoxInferenceScope::verify(&token, "core-proof-key").unwrap(),
        live
    );
}

#[test]
fn box_inference_scope_refuses_the_wrong_key() {
    let now = 1_800_000_000;
    let token = box_scope(now + 600).sign_at("org-a-key", now).unwrap();
    assert!(BoxInferenceScope::verify_at(&token, "org-b-key", now).is_err());
    assert!(BoxInferenceScope::verify_at(&token, "", now).is_err());
    assert!(box_scope(now + 600).sign_at("", now).is_err());
}

#[test]
fn box_inference_scope_expires() {
    let now = 1_800_000_000;
    let token = box_scope(now + 600).sign_at("core-proof-key", now).unwrap();
    assert!(BoxInferenceScope::verify_at(&token, "core-proof-key", now + 600).is_err());
    assert!(BoxInferenceScope::verify_at(&token, "core-proof-key", now + 599).is_ok());
    assert!(box_scope(now).sign_at("core-proof-key", now).is_err());
    let stale = box_scope(unix_now().saturating_sub(1));
    assert!(stale.sign("core-proof-key").is_err());
}

#[test]
fn box_inference_scope_refuses_a_ttl_over_twenty_minutes() {
    let now = 1_800_000_000;
    assert!(box_scope(now + BOX_INFERENCE_MAX_TTL_SECS + 1)
        .sign_at("core-proof-key", now)
        .is_err());
    // A key signed for a 20-minute life is refused by a verifier whose clock
    // says it would live longer (a far-future expiry forged with the key).
    let forged = box_scope(now + 24 * 3600);
    let payload = hex::encode(serde_json::to_vec(&forged).unwrap());
    let signed = format!("gwb1.{payload}");
    let mac = BoxInferenceScope::mac(&signed, "core-proof-key").unwrap();
    use hmac::Mac;
    let token = format!("{signed}.{}", hex::encode(mac.finalize().into_bytes()));
    assert!(BoxInferenceScope::verify_at(&token, "core-proof-key", now).is_err());
}

#[test]
fn box_inference_scope_rejects_a_tampered_payload_and_other_versions() {
    let now = 1_800_000_000;
    let scope = box_scope(now + 600);
    let token = scope.sign_at("core-proof-key", now).unwrap();
    let (_, signature) = token.rsplit_once('.').unwrap();
    for tamper in [
        BoxInferenceScope {
            box_id: "bx_other".into(),
            ..scope.clone()
        },
        BoxInferenceScope {
            org_id: "org_2".into(),
            ..scope.clone()
        },
        BoxInferenceScope {
            lease_epoch: 4,
            ..scope.clone()
        },
        BoxInferenceScope {
            session_id: "conv_2".into(),
            ..scope.clone()
        },
    ] {
        let payload = hex::encode(serde_json::to_vec(&tamper).unwrap());
        assert!(BoxInferenceScope::verify_at(
            &format!("gwb1.{payload}.{signature}"),
            "core-proof-key",
            now
        )
        .is_err());
    }
    // A gws1 token is never a gwb1 token, and vice versa.
    let gws1 = InferenceScope {
        agent_id: "agent".into(),
        user_id: None,
        session_id: None,
        expires_at: unix_now() + 600,
        provider_access: None,
    }
    .sign("core-proof-key")
    .unwrap();
    assert!(BoxInferenceScope::verify(&gws1, "core-proof-key").is_err());
    assert!(!BoxInferenceScope::is_box_token(&gws1));
    let gwb1 = box_scope(unix_now() + 600).sign("core-proof-key").unwrap();
    assert!(InferenceScope::verify(&gwb1, "core-proof-key").is_err());
    // Identity fields are validated like gws1's.
    let mut invalid = scope.clone();
    invalid.session_id = " padded".into();
    assert!(invalid.sign_at("core-proof-key", now).is_err());
    invalid.session_id = "conv\n".into();
    assert!(invalid.sign_at("core-proof-key", now).is_err());
    assert!(BoxInferenceScope::verify_at(&"a".repeat(5000), "core-proof-key", now).is_err());
}

#[test]
fn account_drain_override_inherits_zero_and_removal_restores_inheritance() {
    let mut policy: ProviderAccountPolicy =
        serde_json::from_value(serde_json::json!({"name":"Work","enabled":true,"priority":0}))
            .unwrap();
    assert_eq!(policy.effective_drain_threshold(80), 80);
    policy.drain_threshold_percent = Some(0);
    assert_eq!(policy.effective_drain_threshold(60), 0);
    let encoded = serde_json::to_vec(&policy).unwrap();
    assert_eq!(
        serde_json::from_slice::<ProviderAccountPolicy>(&encoded).unwrap(),
        policy
    );
    let removed: ProviderAccountPolicy =
        serde_json::from_value(serde_json::json!({"name":"Work","drain_threshold_percent":null}))
            .unwrap();
    assert_eq!(removed.effective_drain_threshold(60), 60);
    assert!(serde_json::to_value(removed)
        .unwrap()
        .get("drain_threshold_percent")
        .is_none());
    assert!(serde_json::from_value::<ProviderAccountPolicy>(
        serde_json::json!({"name":"Work","drain_threshold_percent":101}),
    )
    .is_err());
}
