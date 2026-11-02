use super::stores::*;
use ryu_workspace::source_history::SourceHistoryState;

/// A store left on its legacy Git history is reported as plaintext with
/// the recorded reason, not silently counted as sealed.
#[test]
fn source_history_left_on_git_is_reported_with_its_reason() {
    let entry = source_history_entry(&SourceHistoryState::LegacyGit(
        "not enough free space".to_owned(),
    ));
    assert_eq!(entry["status"], PLAINTEXT);
    assert_eq!(
        entry["warning"],
        "Source history still stored unencrypted: not enough free space"
    );
    let sealed = source_history_entry(&SourceHistoryState::Sealed);
    assert_eq!(sealed["status"], SEALED);
    assert!(sealed["warning"].is_null());
    assert!(entry["detail"]
        .as_str()
        .is_some_and(|detail| detail.contains("not enough free space")));
}

fn finished_spaces_seal() -> ryu_spaces::SealStatus {
    ryu_spaces::SealStatus {
        unreadable_rows: 0,
        writable: true,
        migration: "sealed".to_owned(),
        blobs_sealed: 3,
        blobs_total: 3,
        blobs_pending: None,
    }
}

fn coverage(spaces_seal: ryu_spaces::SealStatus, agents_unreadable: u64) -> StoreCoverage {
    StoreCoverage {
        chat_sealed: 4,
        chat_total: 4,
        memory_total: 2,
        spaces_seal,
        agents_unreadable,
        history: SourceHistoryState::Sealed,
    }
}

fn status_of(stores: &serde_json::Value, id: &str) -> String {
    stores
        .as_array()
        .and_then(|stores| stores.iter().find(|store| store["id"] == id))
        .and_then(|store| store["status"].as_str())
        .unwrap_or_else(|| panic!("no store entry `{id}`"))
        .to_owned()
}

/// Every store the node seals is listed, and none of them reads as
/// plaintext while its seal is healthy.
#[test]
fn sealed_stores_are_listed_and_never_reported_as_plaintext() {
    let stores = store_entries(&coverage(finished_spaces_seal(), 0));
    for id in [
        "spaces",
        "approvals",
        "safe-actions",
        "prompt-evals",
        "agents",
        "workflows",
        "alert-delivery",
        "catalog-sources",
        "source-history",
    ] {
        assert_eq!(status_of(&stores, id), SEALED, "{id}");
    }
    let entries = stores.as_array().expect("an array of stores");
    let spaces = entries
        .iter()
        .find(|store| store["id"] == "spaces")
        .expect("spaces entry");
    assert!(!spaces["detail"]
        .as_str()
        .unwrap_or_default()
        .contains("in the clear"));
    assert_eq!(spaces["sealed"], 3);
    assert_eq!(spaces["total"], 3);
    for store in entries {
        assert_ne!(store["status"], PLAINTEXT, "{}", store["id"]);
    }
}

/// Spaces is partial, with the reason, until its seal is complete and
/// writable under the current key; unreadable agent rows make agents partial.
#[test]
fn spaces_and_agents_report_partial_while_their_seal_is_incomplete() {
    let cases = [
        ryu_spaces::SealStatus {
            writable: false,
            ..finished_spaces_seal()
        },
        ryu_spaces::SealStatus {
            unreadable_rows: 2,
            ..finished_spaces_seal()
        },
        ryu_spaces::SealStatus {
            migration: "sealing".to_owned(),
            ..finished_spaces_seal()
        },
        ryu_spaces::SealStatus {
            migration: "error: disk full".to_owned(),
            ..finished_spaces_seal()
        },
        ryu_spaces::SealStatus {
            blobs_sealed: 1,
            blobs_pending: Some("low disk space".to_owned()),
            ..finished_spaces_seal()
        },
    ];
    for seal in cases {
        let entry = spaces_entry(&seal);
        assert_eq!(entry["status"], PARTIAL, "{seal:?}");
        assert!(entry["detail"]
            .as_str()
            .is_some_and(|detail| detail.contains("Not complete yet")));
    }
    let stores = store_entries(&coverage(finished_spaces_seal(), 1));
    assert_eq!(status_of(&stores, "agents"), PARTIAL);
    assert_eq!(status_of(&stores, "approvals"), SEALED);
}

/// Clients localize the rows by id, so every runtime fact in the English
/// detail is also sent as a value: the source-history reason, the record
/// store's unreadable count and the Spaces partial reasons as codes.
#[test]
fn rows_carry_the_values_their_english_detail_interpolates() {
    let legacy = source_history_entry(&SourceHistoryState::LegacyGit("disk full".to_owned()));
    assert_eq!(legacy["reason"], "disk full");
    assert!(source_history_entry(&SourceHistoryState::Sealed)["reason"].is_null());

    let stores = store_entries(&coverage(finished_spaces_seal(), 3));
    let entry = |id: &str| {
        stores
            .as_array()
            .and_then(|stores| stores.iter().find(|store| store["id"] == id))
            .cloned()
            .unwrap_or_else(|| panic!("no store entry `{id}`"))
    };
    assert_eq!(entry("agents")["unreadableCount"], 3);
    assert_eq!(entry("approvals")["unreadableCount"], 0);
    assert_eq!(entry("spaces")["partialReasons"], serde_json::json!([]));

    let spaces = spaces_entry(&ryu_spaces::SealStatus {
        writable: false,
        unreadable_rows: 2,
        migration: "sealing".to_owned(),
        blobs_sealed: 1,
        blobs_total: 3,
        blobs_pending: Some("low disk space".to_owned()),
    });
    assert_eq!(
        spaces["partialReasons"],
        serde_json::json!([
            { "code": "key-not-held" },
            { "code": "unreadable-values", "count": 2 },
            { "code": "sealing-running", "state": "sealing" },
            { "code": "files-unsealed", "sealed": 1, "total": 3, "pending": "low disk space" },
        ])
    );
    // The English fallback still lists every reason.
    assert!(
        spaces["detail"].as_str().is_some_and(
            |detail| detail.contains("1 of 3 uploaded files are sealed (low disk space)")
        )
    );
}
