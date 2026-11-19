use super::super::{mint, prune, revoke, MintRequest, MAX_HISTORY_ROWS, TTL_NEVER};
use super::*;
use crate::plugin_secrets::PluginSecretStore;

fn request(label: &str) -> MintRequest {
    MintRequest {
        environment: "default".into(),
        services: vec!["openai".into()],
        label: label.into(),
        ttl_secs: None,
        minted_by: "user:u1".into(),
        not_after: None,
        minted_token: None,
        minter_scope: None,
    }
}

#[tokio::test]
async fn history_keeps_ended_sessions_with_their_status() {
    let store = PluginSecretStore::in_memory().unwrap();
    let conn = store.conn.lock().await;
    let (_, live) = mint(&conn, request("ci")).unwrap();
    let (_, revoked) = mint(&conn, request("ci")).unwrap();
    let (_, expired) = mint(&conn, request("laptop")).unwrap();
    revoke(&conn, &revoked.id).unwrap();
    conn.execute(
        "UPDATE vault_broker_sessions SET expires_at = 1 WHERE id = ?1",
        params![expired.id],
    )
    .unwrap();
    // Maintenance no longer deletes ended sessions.
    assert_eq!(prune(&conn, now_millis()).unwrap(), 0);

    let all = list(&conn, &HistoryFilter::default()).unwrap();
    let status = |id: &str| all.iter().find(|e| e.session.id == id).unwrap().status;
    assert_eq!(all.len(), 3);
    assert_eq!(status(&live.id), SessionStatus::Live);
    assert_eq!(status(&revoked.id), SessionStatus::Revoked);
    assert_eq!(status(&expired.id), SessionStatus::Expired);

    let ci = HistoryFilter {
        label: Some("ci".into()),
        ..HistoryFilter::default()
    };
    assert_eq!(list(&conn, &ci).unwrap().len(), 2);
    let revoked_only = HistoryFilter {
        status: Some(SessionStatus::Revoked),
        ..HistoryFilter::default()
    };
    let rows = list(&conn, &revoked_only).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].session.id, revoked.id);
    let page = HistoryFilter {
        limit: Some(1),
        ..HistoryFilter::default()
    };
    assert_eq!(list(&conn, &page).unwrap().len(), 1);
    // The live listing has only the live one, and its JSON carries the status.
    let current = super::live(&conn, None).unwrap();
    assert_eq!(current.len(), 1);
    let json = serde_json::to_value(&current[0]).unwrap();
    assert_eq!(json["status"], "live");
    assert_eq!(json["neverExpires"], false);
    assert_eq!(json["id"], live.id.as_str());
    assert!(super::live(&conn, Some("laptop")).unwrap().is_empty());
}

#[tokio::test]
async fn history_is_trimmed_only_past_the_cap() {
    let store = PluginSecretStore::in_memory().unwrap();
    let conn = store.conn.lock().await;
    let (_, keep) = mint(&conn, request("x")).unwrap();
    conn.execute_batch("BEGIN").unwrap();
    for value in 1..=MAX_HISTORY_ROWS + 5 {
        conn.execute(
            "INSERT INTO vault_broker_sessions
                (id, token_hash, environment, services, label, minted_by, created_at, expires_at)
             VALUES (?1, ?2, 'default', '[]', '', 'operator', ?3, 1)",
            params![format!("old_{value}"), format!("hash_{value}"), value],
        )
        .unwrap();
    }
    conn.execute_batch("COMMIT").unwrap();
    assert_eq!(prune(&conn, now_millis()).unwrap(), 5);
    let oldest: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM vault_broker_sessions WHERE id IN ('old_1', 'old_5')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(oldest, 0);
    assert!(super::super::live(&conn, &keep.id).unwrap().is_some());
}

#[tokio::test]
async fn never_expiring_sessions_are_for_people_only() {
    let store = PluginSecretStore::in_memory().unwrap();
    let conn = store.conn.lock().await;
    let mut forever = request("forever");
    forever.ttl_secs = Some(TTL_NEVER);
    let (_, session) = mint(&conn, forever).unwrap();
    assert_eq!(session.expires_at, NEVER_EXPIRES_AT);
    let rows = list(&conn, &HistoryFilter::default()).unwrap();
    assert!(rows[0].never_expires);
    assert_eq!(rows[0].status, SessionStatus::Live);

    let mut machine = request("m");
    machine.ttl_secs = Some(TTL_NEVER);
    machine.not_after = Some(now_millis() + 60_000);
    let error = mint(&conn, machine).unwrap_err();
    assert_eq!(
        error.downcast_ref::<VaultError>().unwrap().code(),
        "vault_invalid_request"
    );
    let mut token_minted = request("m");
    token_minted.ttl_secs = Some(TTL_NEVER);
    token_minted.minted_token = Some("acc_1".into());
    assert!(mint(&conn, token_minted).is_err());
}

#[tokio::test]
async fn labels_change_and_are_checked() {
    let store = PluginSecretStore::in_memory().unwrap();
    let conn = store.conn.lock().await;
    let (_, session) = mint(&conn, request("old")).unwrap();
    assert!(relabel(&conn, &session.id, "new").unwrap());
    assert!(!relabel(&conn, "bvs_missing", "new").unwrap());
    assert!(relabel(&conn, &session.id, &"x".repeat(MAX_LABEL_LEN + 1)).is_err());
    assert!(relabel(&conn, &session.id, "a\nb").is_err());
    let filter = HistoryFilter {
        label: Some("new".into()),
        ..HistoryFilter::default()
    };
    assert_eq!(list(&conn, &filter).unwrap()[0].session.id, session.id);
}
