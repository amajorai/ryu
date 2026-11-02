use super::*;

#[tokio::test]
async fn the_file_on_disk_is_sealed_and_holds_no_sender_id() {
    let path = temp_pairing_path("sealed");
    let store = PairingStore::load(&path, test_seal()).await;
    store.approve("whatsapp", "+14155550177").await;
    let challenge = store.challenge("telegram", "tg-user-4242").await;
    let bytes = tokio::fs::read(&path).await.unwrap();
    let text = String::from_utf8(bytes).unwrap();
    assert!(text.starts_with("encb:v1:"), "pairing file is not sealed");
    for needle in ["+14155550177", "tg-user-4242", "whatsapp", "entries"] {
        assert!(!text.contains(needle), "{needle} is plaintext on disk");
    }
    if let Decision::Challenge(code) = challenge {
        assert!(
            !text.contains(&code),
            "the pairing code is plaintext on disk"
        );
    }
    // The body is bound to a logical id, not the path: a moved file opens.
    let moved = path.with_file_name("moved.json");
    tokio::fs::rename(&path, &moved).await.unwrap();
    let reopened = PairingStore::load(&moved, test_seal()).await;
    assert!(matches!(
        reopened.get("whatsapp", "+14155550177").await,
        Some(PairState::Paired { .. })
    ));
    let _ = tokio::fs::remove_dir_all(path.parent().unwrap()).await;
}

#[tokio::test]
async fn legacy_plaintext_is_read_and_resealed_on_load() {
    let path = temp_pairing_path("legacy");
    tokio::fs::create_dir_all(path.parent().unwrap())
        .await
        .unwrap();
    let legacy =
        r#"{"version":1,"entries":{"telegram:legacy-777":{"state":"paired","paired_at":1}}}"#;
    tokio::fs::write(&path, legacy).await.unwrap();
    let store = PairingStore::load(&path, test_seal()).await;
    assert!(matches!(
        store.get("telegram", "legacy-777").await,
        Some(PairState::Paired { .. })
    ));
    let text = tokio::fs::read_to_string(&path).await.unwrap();
    assert!(text.starts_with("encb:v1:"));
    assert!(!text.contains("legacy-777"));
    // Loading the sealed file again is a no-op that still finds the sender.
    let again = PairingStore::load(&path, test_seal()).await;
    assert!(again.get("telegram", "legacy-777").await.is_some());
    let _ = tokio::fs::remove_dir_all(path.parent().unwrap()).await;
}

#[tokio::test]
async fn a_file_sealed_under_another_key_is_moved_aside_not_overwritten() {
    let path = temp_pairing_path("wrong-key");
    let store = PairingStore::load(&path, test_seal()).await;
    store.approve("slack", "U123").await;
    let original = tokio::fs::read(&path).await.unwrap();
    let other = PairingSeal::Sealed(ContentCipher::from_root(&[6u8; 32], PAIRING_STORE));
    let fresh = PairingStore::load(&path, other).await;
    assert!(fresh.get("slack", "U123").await.is_none());
    let mut kept = None;
    let mut listing = tokio::fs::read_dir(path.parent().unwrap()).await.unwrap();
    while let Some(entry) = listing.next_entry().await.unwrap() {
        if entry.file_name().to_string_lossy().contains(".unreadable-") {
            kept = Some(tokio::fs::read(entry.path()).await.unwrap());
        }
    }
    assert_eq!(
        kept.as_deref(),
        Some(original.as_slice()),
        "sealed data was lost"
    );
    let _ = tokio::fs::remove_dir_all(path.parent().unwrap()).await;
}

#[tokio::test]
async fn a_truncated_plaintext_file_is_quarantined_sealed_not_in_plaintext() {
    let path = temp_pairing_path("truncated");
    tokio::fs::create_dir_all(path.parent().unwrap())
        .await
        .unwrap();
    let truncated = r#"{"version":1,"entries":{"whatsapp:+14155550123":{"state":"pai"#;
    tokio::fs::write(&path, truncated).await.unwrap();
    let store = PairingStore::load(&path, test_seal()).await;
    assert!(store.get("whatsapp", "+14155550123").await.is_none());
    let mut kept = Vec::new();
    let mut listing = tokio::fs::read_dir(path.parent().unwrap()).await.unwrap();
    while let Some(entry) = listing.next_entry().await.unwrap() {
        if entry.file_name().to_string_lossy().contains(".unreadable-") {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = entry.metadata().await.unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o600);
            }
            kept.push(tokio::fs::read(entry.path()).await.unwrap());
        }
    }
    assert_eq!(kept.len(), 1, "the unreadable file was not kept");
    let copy = &kept[0];
    assert!(
        ContentCipher::is_sealed_bytes(copy),
        "quarantine copy is plaintext"
    );
    assert!(!String::from_utf8_lossy(copy).contains("+14155550123"));
    // A key recovery can still read what was set aside.
    let PairingSeal::Sealed(cipher) = test_seal() else {
        unreachable!()
    };
    let opened = cipher
        .open_bytes(copy, &ContentContext::for_id("file", QUARANTINE_FILE_ID))
        .unwrap();
    assert_eq!(opened.value, truncated.as_bytes());
    // Without a key the renamed copy is still narrowed to 0600.
    let unkeyed = temp_pairing_path("truncated-no-key");
    tokio::fs::create_dir_all(unkeyed.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&unkeyed, truncated).await.unwrap();
    PairingStore::load(&unkeyed, PairingSeal::Unavailable("test".into())).await;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut listing = tokio::fs::read_dir(unkeyed.parent().unwrap())
            .await
            .unwrap();
        while let Some(entry) = listing.next_entry().await.unwrap() {
            let mode = entry.metadata().await.unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "{:?}", entry.file_name());
        }
    }
    let _ = tokio::fs::remove_dir_all(path.parent().unwrap()).await;
    let _ = tokio::fs::remove_dir_all(unkeyed.parent().unwrap()).await;
}

#[tokio::test]
async fn without_a_key_the_store_is_memory_only_and_writes_nothing() {
    let path = temp_pairing_path("no-key");
    tokio::fs::create_dir_all(path.parent().unwrap())
        .await
        .unwrap();
    let legacy =
        r#"{"version":1,"entries":{"telegram:legacy-888":{"state":"paired","paired_at":1}}}"#;
    tokio::fs::write(&path, legacy).await.unwrap();
    let store = PairingStore::load(&path, PairingSeal::Unavailable("test".into())).await;
    assert!(store.get("telegram", "legacy-888").await.is_some());
    store.approve("telegram", "new-999").await;
    store.claim_delivery("telegram", "update-9").await.unwrap();
    assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), legacy);
    // A sealed file without a key is left untouched as well.
    let sealed_path = temp_pairing_path("no-key-sealed");
    PairingStore::load(&sealed_path, test_seal())
        .await
        .approve("slack", "U9")
        .await;
    let sealed = tokio::fs::read(&sealed_path).await.unwrap();
    let locked = PairingStore::load(&sealed_path, PairingSeal::Unavailable("test".into())).await;
    locked.approve("slack", "U10").await;
    assert_eq!(tokio::fs::read(&sealed_path).await.unwrap(), sealed);
    let _ = tokio::fs::remove_dir_all(path.parent().unwrap()).await;
    let _ = tokio::fs::remove_dir_all(sealed_path.parent().unwrap()).await;
}

#[test]
fn generated_code_uses_unambiguous_alphabet() {
    let code = generate_code("telegram", "42", 1);
    assert_eq!(code.len(), CODE_LEN);
    for ch in code.chars() {
        assert!(
            CODE_ALPHABET.contains(&(ch as u8)),
            "{ch} is not in the code alphabet"
        );
        assert!(!"01OI".contains(ch), "{ch} is visually ambiguous");
    }
}

#[tokio::test]
async fn unknown_sender_is_challenged_then_paired() {
    let store = PairingStore::ephemeral();
    let policy = AccessPolicy {
        dm: DmPolicy::Pairing,
        ..Default::default()
    };

    let first = policy.decide_dm(&store, "telegram", "u1").await;
    let Decision::Challenge(code) = first else {
        panic!("first contact must be challenged, got {first:?}");
    };

    // Messaging again re-serves the SAME code rather than minting a second.
    let second = policy.decide_dm(&store, "telegram", "u1").await;
    assert_eq!(second, Decision::Pending(code.clone()));

    assert_eq!(
        store.approve_code(&code).await.as_deref(),
        Some("telegram:u1")
    );
    assert_eq!(
        policy.decide_dm(&store, "telegram", "u1").await,
        Decision::Allow
    );
}

#[tokio::test]
async fn exact_reply_links_survive_restart() {
    let path = std::env::temp_dir().join(format!(
        "ryu-channel-reply-links-{}-{}.json",
        std::process::id(),
        unix_now()
    ));
    let store = PairingStore::load(&path, test_seal()).await;
    store
        .bind_reply_messages(
            "telegram",
            "channel:bot:chat",
            &["provider-42".to_owned()],
            &["assistant-98".to_owned(), "assistant-99".to_owned()],
        )
        .await;
    drop(store);

    let restored = PairingStore::load(&path, test_seal()).await;
    assert_eq!(
        restored
            .reply_message("telegram", "channel:bot:chat", "provider-42")
            .await,
        Some(vec!["assistant-98".to_owned(), "assistant-99".to_owned()])
    );
    let _ = tokio::fs::remove_file(path).await;
}

#[tokio::test]
async fn reply_links_stay_within_the_hard_limit() {
    let store = PairingStore::ephemeral();
    for index in 0..=MAX_REPLY_LINKS {
        store
            .bind_reply_messages(
                "telegram",
                "channel:bot:chat",
                &[format!("provider-{index}")],
                &[format!("assistant-{index}")],
            )
            .await;
    }

    assert_eq!(store.inner.read().await.reply_links.len(), MAX_REPLY_LINKS);
}

#[tokio::test]
async fn delivery_claims_suppress_duplicates_until_completion() {
    let store = PairingStore::ephemeral();
    assert_eq!(
        store
            .claim_delivery("telegram", "bot-a:update-42")
            .await
            .unwrap(),
        DeliveryClaim::Claimed
    );
    assert_eq!(
        store
            .claim_delivery("telegram", "bot-a:update-42")
            .await
            .unwrap(),
        DeliveryClaim::InFlight
    );

    store
        .complete_delivery("telegram", "bot-a:update-42")
        .await
        .unwrap();
    assert_eq!(
        store
            .claim_delivery("telegram", "bot-a:update-42")
            .await
            .unwrap(),
        DeliveryClaim::Completed
    );

    // Provider ids are scoped by platform, so equal-looking ids on two
    // transports remain independent deliveries.
    assert_eq!(
        store
            .claim_delivery("whatsapp", "bot-a:update-42")
            .await
            .unwrap(),
        DeliveryClaim::Claimed
    );
}

#[tokio::test]
async fn failed_delivery_can_be_reclaimed_and_survives_restart() {
    let path = std::env::temp_dir().join(format!(
        "ryu-channel-deliveries-{}-{}.json",
        std::process::id(),
        unix_nanos()
    ));
    let store = PairingStore::load(&path, test_seal()).await;
    store
        .claim_delivery("whatsapp", "bot-a:wamid-1")
        .await
        .unwrap();
    store
        .fail_delivery("whatsapp", "bot-a:wamid-1")
        .await
        .unwrap();
    assert_eq!(
        store
            .claim_delivery("whatsapp", "bot-a:wamid-1")
            .await
            .unwrap(),
        DeliveryClaim::Claimed
    );
    store
        .complete_delivery("whatsapp", "bot-a:wamid-1")
        .await
        .unwrap();
    drop(store);

    let restored = PairingStore::load(&path, test_seal()).await;
    assert_eq!(
        restored
            .claim_delivery("whatsapp", "bot-a:wamid-1")
            .await
            .unwrap(),
        DeliveryClaim::Completed
    );
    let _ = tokio::fs::remove_file(path).await;
}

#[test]
fn delivery_identity_rejects_empty_and_unbounded_provider_ids() {
    assert!(delivery_key("telegram", "").is_err());
    assert!(delivery_key("", "update-1").is_err());
    assert!(delivery_key("telegram", &"x".repeat(513)).is_err());
    assert_eq!(
        delivery_key("telegram", "update-1").unwrap(),
        "telegram\0update-1"
    );
}

#[tokio::test]
async fn blocked_sender_never_gets_a_new_code() {
    let store = PairingStore::ephemeral();
    let policy = AccessPolicy::default();
    store.block("telegram", "spammer").await;
    assert_eq!(
        policy.decide_dm(&store, "telegram", "spammer").await,
        Decision::Deny
    );
    // …and forgetting them restores the enrolment path.
    store.forget("telegram", "spammer").await;
    assert!(matches!(
        policy.decide_dm(&store, "telegram", "spammer").await,
        Decision::Challenge(_)
    ));
}

#[tokio::test]
async fn approve_code_rejects_unknown_and_expired_codes() {
    let store = PairingStore::ephemeral();
    assert!(store.approve_code("ZZZZZZ").await.is_none());

    // An expired pending entry is not approvable. Age the entry by rewriting
    // its `issued_at`, then RELEASE the lock before calling `approve_code` —
    // it takes the same write lock, so holding one across the call deadlocks.
    store.challenge("telegram", "u2").await;
    let key = entry_key("telegram", "u2");
    let stale = {
        let mut map = store.inner.write().await;
        let code = match map.entries.get(&key) {
            Some(PairState::Pending { code, .. }) => code.clone(),
            other => panic!("expected pending, got {other:?}"),
        };
        map.entries.insert(
            key.clone(),
            PairState::Pending {
                code: code.clone(),
                issued_at: unix_now() - CODE_TTL.as_secs() - 1,
            },
        );
        code
    };
    assert!(
        store.approve_code(&stale).await.is_none(),
        "an expired code must not be approvable"
    );
    // The entry is left pending rather than silently consumed.
    assert!(matches!(
        store.get("telegram", "u2").await,
        Some(PairState::Pending { .. })
    ));
}

#[tokio::test]
async fn dm_policies_gate_as_documented() {
    let store = PairingStore::ephemeral();

    let open = AccessPolicy {
        dm: DmPolicy::Open,
        ..Default::default()
    };
    assert_eq!(open.decide_dm(&store, "t", "x").await, Decision::Allow);

    let disabled = AccessPolicy {
        dm: DmPolicy::Disabled,
        ..Default::default()
    };
    assert_eq!(disabled.decide_dm(&store, "t", "x").await, Decision::Deny);

    // Allowlist admits only listed senders and offers no enrolment path.
    let listed = AccessPolicy {
        dm: DmPolicy::Allowlist,
        dm_allowlist: vec!["known".into()],
        ..Default::default()
    };
    assert_eq!(
        listed.decide_dm(&store, "t", "known").await,
        Decision::Allow
    );
    assert_eq!(listed.decide_dm(&store, "t", "other").await, Decision::Deny);
}

#[test]
fn group_policies_gate_as_documented() {
    let allow = AccessPolicy {
        group: GroupPolicy::Allowlist,
        group_allowlist: vec!["-100".into()],
        ..Default::default()
    };
    assert_eq!(allow.decide_group("-100"), Decision::Allow);
    assert_eq!(allow.decide_group("-200"), Decision::Deny);

    let open = AccessPolicy {
        group: GroupPolicy::Open,
        ..Default::default()
    };
    assert_eq!(open.decide_group("anything"), Decision::Allow);

    let off = AccessPolicy {
        group: GroupPolicy::Disabled,
        ..Default::default()
    };
    assert_eq!(off.decide_group("-100"), Decision::Deny);
}

#[test]
fn group_sender_allowlist_is_an_additive_fast_path() {
    let policy = AccessPolicy {
        group: GroupPolicy::Allowlist,
        group_allowlist: vec!["room-1".into()],
        group_sender_allowlist: vec!["trusted-user".into()],
        ..Default::default()
    };
    assert_eq!(
        policy.decide_group_for_sender("unlisted-room", Some("trusted-user")),
        Decision::Allow
    );
    assert_eq!(
        policy.decide_group_for_sender("unlisted-room", Some("other-user")),
        Decision::Deny
    );
    assert_eq!(
        policy.decide_group_for_sender("room-1", Some("other-user")),
        Decision::Allow
    );
}

#[tokio::test]
async fn store_round_trips_through_a_file() {
    // Unique per process and per call so concurrent test binaries never
    // share (and then delete) one another's directory.
    let dir = std::env::temp_dir().join(format!(
        "ryu-pairing-test-{}-{}",
        std::process::id(),
        unix_nanos()
    ));
    let path = dir.join("pairing.json");
    let store = PairingStore::load(&path, test_seal()).await;
    store.approve("telegram", "u9").await;
    store
        .claim_delivery("telegram", "update-1")
        .await
        .expect("claim persists");

    let reloaded = PairingStore::load(&path, test_seal()).await;
    assert!(matches!(
        reloaded.get("telegram", "u9").await,
        Some(PairState::Paired { .. })
    ));
    // Every write is renamed into place; no temporary file is left behind.
    let mut leftovers = Vec::new();
    let mut listing = tokio::fs::read_dir(&dir).await.expect("list dir");
    while let Some(entry) = listing.next_entry().await.expect("dir entry") {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.contains(".tmp-") {
            leftovers.push(name);
        }
    }
    assert!(leftovers.is_empty(), "temporary files left: {leftovers:?}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = tokio::fs::metadata(&path)
            .await
            .expect("pairing file metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0, "pairing file must be owner-only");
    }
    let _ = tokio::fs::remove_dir_all(&dir).await;
}
