use super::*;

mod part1;
mod part2;

fn test_seal() -> PairingSeal {
    PairingSeal::Sealed(ContentCipher::from_root(&[5u8; 32], PAIRING_STORE))
}

fn temp_pairing_path(tag: &str) -> PathBuf {
    std::env::temp_dir()
        .join(format!(
            "ryu-pairing-{tag}-{}-{}",
            std::process::id(),
            unix_nanos()
        ))
        .join("channel-pairing.json")
}

/// Rewrite a pending entry's `issued_at` so it is past [`CODE_TTL`]. The
/// write lock is released before returning.
async fn age_pending(store: &PairingStore, platform: &str, sender_id: &str) {
    let key = entry_key(platform, sender_id);
    let mut map = store.inner.write().await;
    let code = match map.entries.get(&key) {
        Some(PairState::Pending { code, .. }) => code.clone(),
        other => panic!("expected pending, got {other:?}"),
    };
    map.entries.insert(
        key,
        PairState::Pending {
            code,
            issued_at: unix_now() - CODE_TTL.as_secs() - 1,
        },
    );
}
