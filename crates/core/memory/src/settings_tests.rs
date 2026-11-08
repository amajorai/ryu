//! Sensitive-topic consent setting and its effect on recall.

use super::*;

#[tokio::test]
async fn sensitive_memory_recall_is_off_until_user_consent() {
    let store = MemoryStore::open_in_memory().unwrap();
    store
        .record(LOCAL_USER, "agent-a", "User prefers short answers")
        .await
        .unwrap();
    store
        .record(LOCAL_USER, "agent-a", "User has a diabetes diagnosis")
        .await
        .unwrap();

    assert!(!store.include_sensitive_topics(LOCAL_USER).await.unwrap());
    let hidden = store
        .recall_with_sensitive(LOCAL_USER, "agent-a", 10, false)
        .await
        .unwrap();
    assert_eq!(hidden.len(), 1);
    assert_eq!(hidden[0].content, "User prefers short answers");

    store
        .set_include_sensitive_topics(LOCAL_USER, true)
        .await
        .unwrap();
    let visible = store
        .recall_with_sensitive(LOCAL_USER, "agent-a", 10, true)
        .await
        .unwrap();
    assert_eq!(visible.len(), 2);
    assert!(visible.iter().any(|entry| {
        entry
            .sensitive_topics
            .contains(&SensitiveTopic::HealthCondition)
    }));
}
