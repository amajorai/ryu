use crate::server::{merge_mcp_secret_map, MCP_MASKED_SECRET};
use std::collections::BTreeMap;

#[test]
fn masked_values_keep_existing_secrets_and_omitted_rows_are_removed() {
    let current = BTreeMap::from([
        ("API_KEY".to_owned(), "old-secret".to_owned()),
        ("REMOVE_ME".to_owned(), "discard-me".to_owned()),
    ]);
    let incoming = BTreeMap::from([
        ("API_KEY".to_owned(), MCP_MASKED_SECRET.to_owned()),
        ("NEW_KEY".to_owned(), "new-secret".to_owned()),
        ("BLANK".to_owned(), "   ".to_owned()),
    ]);

    assert_eq!(
        merge_mcp_secret_map(&current, incoming),
        BTreeMap::from([
            ("API_KEY".to_owned(), "old-secret".to_owned()),
            ("NEW_KEY".to_owned(), "new-secret".to_owned()),
        ])
    );
}
