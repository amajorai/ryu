use super::*;
use crate::i18n::{messages, tests::install_japanese_pairing, tests::with_translation};

#[tokio::test]
async fn local_help_and_the_pairing_prompt_use_the_owners_language() {
    with_translation(
        "ja",
        messages::NO_COMMANDS_MESSAGE,
        "現在利用できるコマンドはありません。",
    );
    install_japanese_pairing();
    let open = crate::pairing::AccessPolicy {
        dm: crate::pairing::DmPolicy::Open,
        ..Default::default()
    };
    let (sent, _) = dispatch_help_with_store(open, false, PairingStore::ephemeral(), "ja").await;
    assert_eq!(
        sent,
        vec!["現在利用できるコマンドはありません。".to_owned()]
    );

    let pairing = crate::pairing::AccessPolicy {
        dm: crate::pairing::DmPolicy::Pairing,
        ..Default::default()
    };
    let (sent, turns) =
        dispatch_help_with_store(pairing, false, PairingStore::ephemeral(), "ja").await;
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert!(
        sent[0].starts_with("🔒 このアシスタントは非公開です。"),
        "{sent:?}"
    );
    assert_eq!(turns, 0);

    // A language the catalog does not have is English.
    let (sent, _) = dispatch_help_with_store(
        crate::pairing::AccessPolicy {
            dm: crate::pairing::DmPolicy::Open,
            ..Default::default()
        },
        false,
        PairingStore::ephemeral(),
        "tlh",
    )
    .await;
    assert_eq!(
        sent,
        vec!["No commands are available right now.".to_owned()]
    );
}
