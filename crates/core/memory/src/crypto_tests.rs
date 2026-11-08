//! Encryption at rest of memory payloads.

use rusqlite::params;

use super::*;

#[test]
fn stored_ciphertext_is_not_plaintext() {
    // The encrypt step must not leave the content readable.
    let store = MemoryStore::open_in_memory().unwrap();
    let secret = b"super secret memory";
    let (nonce, ciphertext) = store.encrypt(secret).unwrap();
    assert_ne!(ciphertext.as_slice(), secret);
    let decrypted = store.decrypt(&nonce, &ciphertext).unwrap();
    assert_eq!(decrypted, secret);
}

#[tokio::test]
async fn a_zero_updated_at_reads_back_as_the_creation_time() {
    let store = MemoryStore::open_in_memory().unwrap();
    let id = store
        .record("local", "agent-a", "prefers dark mode")
        .await
        .unwrap()
        .unwrap();
    // Simulate a row written before `updated_at` existed.
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE memory_entries SET updated_at = 0 WHERE id = ?1",
            params![id],
        )
        .unwrap();
    }
    let entry = store.get(&id).await.unwrap().unwrap();
    assert_eq!(entry.scope, MemoryScope::User);
    assert_eq!(entry.lifecycle, MemoryLifecycle::Active);
    // A zero `updated_at` reads back as the creation time, never as 1970.
    assert_eq!(entry.updated_at, entry.created_at);
}
