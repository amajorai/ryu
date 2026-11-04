use crate::server::*;

#[test]
fn transient_embedding_input_is_bounded_and_non_empty() {
    assert!(validate_embedding_inputs(&["query".to_owned()]).is_ok());
    assert_eq!(
        validate_embedding_inputs(&[]),
        Err("input must contain at least one text")
    );
    assert_eq!(
        validate_embedding_inputs(&["  ".to_owned()]),
        Err("input texts must not be empty")
    );
    assert_eq!(
        validate_embedding_inputs(
            &(0..=MAX_EMBEDDING_INPUTS)
                .map(|_| "x".to_owned())
                .collect::<Vec<_>>()
        ),
        Err("input may contain at most 64 texts")
    );
    assert_eq!(
        validate_embedding_inputs(&["x".repeat(MAX_EMBEDDING_TEXT_CHARS + 1)]),
        Err("each input text may contain at most 8192 characters")
    );
}

#[test]
fn transient_embedding_input_enforces_the_combined_byte_cap() {
    let inputs = vec!["a".repeat(MAX_EMBEDDING_TEXT_CHARS / 2 + 1); MAX_EMBEDDING_INPUTS];
    assert_eq!(
        validate_embedding_inputs(&inputs),
        Err("combined input text may not exceed 256 KiB")
    );
}
