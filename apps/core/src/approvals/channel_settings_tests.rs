use super::super::store::ApprovalStore;
use super::*;

fn pair(platform: &str, sender: &str) -> (String, String) {
    (platform.to_owned(), sender.to_owned())
}

async fn engine(directory: &tempfile::TempDir) -> ApprovalEngine {
    crate::crypto_host::install();
    let preferences =
        crate::server::preferences::PreferencesStore::open(directory.path().join("preferences.db"))
            .unwrap();
    ApprovalEngine::new(
        ApprovalStore::open_in_memory().unwrap(),
        reqwest::Client::new(),
    )
    .with_preferences(preferences)
}

#[tokio::test]
async fn a_connection_is_off_until_someone_turns_it_on() {
    let directory = tempfile::tempdir().unwrap();
    let engine = engine(&directory).await;
    let settings = engine.channel_approval_settings("chan_1").await;
    assert_eq!(settings, ChannelApprovalSettings::default());
    assert!(!settings.offers_buttons());

    // On with nobody named still offers nothing.
    let on = engine
        .save_channel_approval_settings("chan_1", true, &[], "user-1")
        .await
        .unwrap();
    assert!(on.enabled);
    assert!(!on.offers_buttons());

    let named = engine
        .save_channel_approval_settings("chan_1", true, &[pair("Telegram", " 111 ")], "user-1")
        .await
        .unwrap();
    assert!(named.offers_buttons());
    assert!(named.decider("chan_1", "telegram", "111").is_some());
    // Another connection, platform or account is not named.
    assert!(named.decider("chan_2", "telegram", "111").is_none());
    assert!(named.decider("chan_1", "slack", "111").is_none());
    assert!(named.decider("chan_1", "telegram", "112").is_none());
    assert_eq!(engine.channel_approval_settings("chan_1").await, named);
    assert!(!engine
        .channel_approval_settings("chan_2")
        .await
        .offers_buttons());
}

#[tokio::test]
async fn a_new_account_is_linked_to_the_caller_and_a_kept_one_keeps_its_link() {
    let directory = tempfile::tempdir().unwrap();
    let engine = engine(&directory).await;
    engine
        .save_channel_approval_settings("chan_1", true, &[pair("telegram", "111")], "user-1")
        .await
        .unwrap();
    let both = engine
        .save_channel_approval_settings(
            "chan_1",
            true,
            &[
                pair("telegram", "111"),
                pair("slack", "U222"),
                pair("slack", "U222"),
            ],
            "user-2",
        )
        .await
        .unwrap();
    assert_eq!(both.deciders.len(), 2, "a repeated account is named once");
    assert_eq!(
        both.decider("chan_1", "telegram", "111").unwrap().user_id,
        "user-1"
    );
    assert_eq!(
        both.decider("chan_1", "slack", "U222").unwrap().user_id,
        "user-2"
    );

    // Leaving an account out removes it.
    let one = engine
        .save_channel_approval_settings("chan_1", true, &[pair("slack", "U222")], "user-1")
        .await
        .unwrap();
    assert!(one.decider("chan_1", "telegram", "111").is_none());
    assert_eq!(
        one.decider("chan_1", "slack", "U222").unwrap().user_id,
        "user-2"
    );
}

#[tokio::test]
async fn bad_input_is_refused_and_stores_nothing() {
    let directory = tempfile::tempdir().unwrap();
    let engine = engine(&directory).await;
    let too_many: Vec<(String, String)> = (0..=MAX_DECIDERS)
        .map(|index| pair("telegram", &index.to_string()))
        .collect();
    let long_sender = "9".repeat(65);
    let attempts: [(&str, Vec<(String, String)>, &str); 6] = [
        ("", vec![pair("telegram", "111")], "user-1"),
        ("chan 1", vec![pair("telegram", "111")], "user-1"),
        ("chan_1", vec![pair("whatsapp", "111")], "user-1"),
        ("chan_1", vec![pair("telegram", "1 1")], "user-1"),
        ("chan_1", vec![pair("telegram", &long_sender)], "user-1"),
        ("chan_1", vec![pair("telegram", "111")], " "),
    ];
    for (connection, wanted, user) in attempts {
        assert!(
            engine
                .save_channel_approval_settings(connection, true, &wanted, user)
                .await
                .is_err(),
            "{connection:?} {wanted:?} {user:?}"
        );
    }
    assert!(engine
        .save_channel_approval_settings("chan_1", true, &too_many, "user-1")
        .await
        .is_err());
    assert_eq!(
        engine.channel_approval_settings("chan_1").await,
        ChannelApprovalSettings::default()
    );
}

#[tokio::test]
async fn without_a_preferences_store_the_setting_is_off_and_cannot_be_saved() {
    crate::crypto_host::install();
    let engine = ApprovalEngine::new(
        ApprovalStore::open_in_memory().unwrap(),
        reqwest::Client::new(),
    );
    assert!(!engine
        .channel_approval_settings("chan_1")
        .await
        .offers_buttons());
    assert!(engine
        .save_channel_approval_settings("chan_1", true, &[pair("telegram", "111")], "user-1")
        .await
        .is_err());
}

#[test]
fn the_sender_key_is_bound_to_connection_and_platform() {
    let key = sender_key("chan_1", "telegram", "111");
    assert_eq!(key.len(), 64);
    assert_eq!(key, sender_key("chan_1", "telegram", " 111 "));
    assert_ne!(key, sender_key("chan_2", "telegram", "111"));
    assert_ne!(key, sender_key("chan_1", "discord", "111"));
    assert!(valid_connection("telegram"));
    assert!(valid_connection("chan_1:eu.2-a"));
    assert!(!valid_connection("chan/1"));
    assert!(!valid_connection(&"c".repeat(129)));
}
