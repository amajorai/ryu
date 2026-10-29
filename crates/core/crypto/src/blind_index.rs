//! Blind indexes: keyed, deterministic tokens that let a store find rows by a
//! sealed value without storing the value.
//!
//! ```text
//! K_bi  = HKDF-SHA256(root, salt "ryu-blind-index-v1",
//!                     info "ryu-blind-index-v1:" || store || 0x00 || field)
//! token = "bi1:" + hex(HMAC-SHA256(K_bi, normalized value)[..16])   (equality)
//! term  =          hex(HMAC-SHA256(K_bi(field = "terms"), term)[..16]) (full text)
//! ```
//!
//! **Leakage** (state it in the store's docs row): tokens are deterministic per
//! install, store and field, so they reveal which rows share a value (or a word),
//! how often, and for terms the global term frequencies. Phrase, prefix and NEAR
//! queries are impossible over term tokens; stopword-only queries return nothing.
//!
//! The term tokenizer ([`tokenize_terms`]) is shared with the TypeScript and
//! Python helpers and pinned by the test vectors:
//! `NFKC(lowercase(NFKC(text)))`, split on every character whose Unicode general
//! category is not L*, M* or N*, keep terms of 2 or more code points truncated
//! to 64, drop [`STOPWORDS`], de-duplicate and sort by UTF-8 bytes.

use std::collections::BTreeSet;

use unicode_normalization::UnicodeNormalization;
use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};

use crate::content::hkdf32;
use crate::KEY_LEN;

/// Prefix of an equality token.
pub const BLIND_TOKEN_PREFIX: &str = "bi1:";
/// The field name full-text term indexes use for their key.
pub const TERMS_FIELD: &str = "terms";
const BLIND_KDF_SALT: &[u8] = b"ryu-blind-index-v1";
const BLIND_KDF_INFO_PREFIX: &[u8] = b"ryu-blind-index-v1:";
const MIN_TERM_CHARS: usize = 2;
const MAX_TERM_CHARS: usize = 64;

/// Fixed stopword list. Editing it changes every term index: rebuild them all.
pub const STOPWORDS: [&str; 52] = [
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has", "have", "he",
    "her", "his", "i", "if", "in", "into", "is", "it", "its", "me", "my", "no", "not", "of", "on",
    "or", "our", "she", "so", "that", "the", "their", "them", "there", "they", "this", "to", "was",
    "we", "were", "what", "when", "which", "who", "will", "with", "you", "your",
];

/// The keyed token generator for one `(store, field)`.
#[derive(Clone)]
pub struct BlindIndex {
    key: [u8; KEY_LEN],
    store: String,
    field: String,
}

impl std::fmt::Debug for BlindIndex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BlindIndex")
            .field("store", &self.store)
            .field("field", &self.field)
            .finish_non_exhaustive()
    }
}

impl BlindIndex {
    /// The blind index of `(store, field)` under an explicit root key (the same
    /// root a store's [`crate::ContentCipher`] uses).
    pub fn from_root(root: &[u8; KEY_LEN], store: &str, field: &str) -> Self {
        let key = hkdf32(
            root,
            BLIND_KDF_SALT,
            &[
                BLIND_KDF_INFO_PREFIX,
                store.as_bytes(),
                &[0u8],
                field.as_bytes(),
            ],
        );
        Self {
            key,
            store: store.to_owned(),
            field: field.to_owned(),
        }
    }

    /// The store name.
    pub fn store(&self) -> &str {
        &self.store
    }

    /// The field name.
    pub fn field(&self) -> &str {
        &self.field
    }

    fn mac16(&self, value: &str) -> String {
        use hmac::{Hmac, Mac};
        let mut mac = <Hmac<sha2::Sha256> as Mac>::new_from_slice(&self.key)
            .expect("HMAC accepts every key length");
        mac.update(value.as_bytes());
        hex::encode(&mac.finalize().into_bytes()[..16])
    }

    /// The equality token of an ALREADY NORMALIZED value: `"bi1:" + 32 hex`.
    /// Normalize first ([`casefold`], [`normalize_email`], or the store's own
    /// rule, for example CRM's `lower(trim())`) and use one rule per field.
    pub fn token(&self, normalized: &str) -> String {
        format!("{BLIND_TOKEN_PREFIX}{}", self.mac16(normalized))
    }

    /// [`Self::token`] of the [`casefold`] of `value`.
    pub fn token_casefold(&self, value: &str) -> String {
        self.token(&casefold(value))
    }

    /// The bare 32-hex token of one term (for full-text term indexes; the index
    /// should be built with `field = "terms"`).
    pub fn term_token(&self, term: &str) -> String {
        self.mac16(term)
    }

    /// The term tokens of `text`: [`tokenize_terms`], then [`Self::term_token`]
    /// each, in term order (de-duplicated).
    pub fn term_tokens(&self, text: &str) -> Vec<String> {
        tokenize_terms(text)
            .iter()
            .map(|term| self.term_token(term))
            .collect()
    }

    /// The content of an FTS5 row for `text`: the term tokens separated by single
    /// spaces, for a `fts5(terms, detail=none, tokenize='ascii')` table.
    pub fn fts_document(&self, text: &str) -> String {
        self.term_tokens(text).join(" ")
    }

    /// The FTS5 `MATCH` expression that finds rows containing every term of
    /// `query` (`tok1 AND tok2 ...`), or `None` when the query has no indexable
    /// term (empty, or stopwords only): such a query returns nothing.
    pub fn fts_query(&self, query: &str) -> Option<String> {
        let tokens = self.term_tokens(query);
        if tokens.is_empty() {
            return None;
        }
        Some(tokens.join(" AND "))
    }
}

/// The case-folded normalization for equality tokens:
/// `NFKC(lowercase(NFKC(trim(value))))`.
pub fn casefold(value: &str) -> String {
    let first: String = value.trim().nfkc().collect();
    first.to_lowercase().nfkc().collect()
}

/// The normalization for email addresses (the [`casefold`] of the address).
pub fn normalize_email(value: &str) -> String {
    casefold(value)
}

fn is_term_char(ch: char) -> bool {
    matches!(
        ch.general_category_group(),
        GeneralCategoryGroup::Letter | GeneralCategoryGroup::Mark | GeneralCategoryGroup::Number
    )
}

/// The shared term tokenizer (see the module docs). Returns the sorted,
/// de-duplicated terms.
pub fn tokenize_terms(text: &str) -> Vec<String> {
    let first: String = text.nfkc().collect();
    let normalized: String = first.to_lowercase().nfkc().collect();
    let mut terms: BTreeSet<Vec<u8>> = BTreeSet::new();
    for raw in normalized.split(|ch: char| !is_term_char(ch)) {
        if raw.chars().count() < MIN_TERM_CHARS {
            continue;
        }
        let term: String = raw.chars().take(MAX_TERM_CHARS).collect();
        if STOPWORDS.contains(&term.as_str()) {
            continue;
        }
        terms.insert(term.into_bytes());
    }
    terms
        .into_iter()
        .map(|bytes| String::from_utf8(bytes).expect("terms are built from UTF-8"))
        .collect()
}

/// The blind index of `(store, field)` in a process that holds the master key
/// (Core). Fails closed without a key.
pub fn blind_index(store: &str, field: &str) -> anyhow::Result<BlindIndex> {
    let (root, _) = crate::content::process_root_and_retired()?;
    Ok(BlindIndex::from_root(&root, store, field))
}

/// The blind index of `(store, field)` for a plugin or app satellite's own
/// process, rooted at its plugin subkey. Fails closed.
pub fn plugin_blind_index_for_process(
    plugin_id: &str,
    store: &str,
    field: &str,
) -> anyhow::Result<BlindIndex> {
    Ok(crate::plugin_cipher_for_process(plugin_id)?.blind_index(store, field))
}

/// The blind index of `(store, field)` for a first-party component's own process.
pub fn component_blind_index_for_process(
    component: &str,
    store: &str,
    field: &str,
) -> anyhow::Result<BlindIndex> {
    Ok(crate::component_cipher_for_process(component)?.blind_index(store, field))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_deterministic_and_separated_by_store_and_field() {
        let a = BlindIndex::from_root(&[1; KEY_LEN], "crm.db", "email");
        assert_eq!(a.token("x@y.z"), a.token("x@y.z"));
        assert!(a.token("x@y.z").starts_with(BLIND_TOKEN_PREFIX));
        assert_eq!(a.token("x@y.z").len(), 4 + 32);
        let other_field = BlindIndex::from_root(&[1; KEY_LEN], "crm.db", "phone");
        let other_store = BlindIndex::from_root(&[1; KEY_LEN], "mail.db", "email");
        let other_root = BlindIndex::from_root(&[2; KEY_LEN], "crm.db", "email");
        for other in [other_field, other_store, other_root] {
            assert_ne!(a.token("x@y.z"), other.token("x@y.z"));
        }
        assert_eq!(a.token_casefold("  X@Y.Z "), a.token("x@y.z"));
        assert!(!a.token("secret").contains("secret"));
    }

    #[test]
    fn the_tokenizer_drops_short_terms_and_stopwords_and_truncates() {
        assert_eq!(
            tokenize_terms("The cat, the CAT and a dog!"),
            vec!["cat".to_owned(), "dog".to_owned()]
        );
        assert!(tokenize_terms("the and of").is_empty());
        let long = "x".repeat(100);
        assert_eq!(tokenize_terms(&long), vec!["x".repeat(64)]);
        assert_eq!(
            tokenize_terms("snake_case kebab-case"),
            vec!["case", "kebab", "snake"]
        );
    }

    #[test]
    fn fts_queries_and_documents_use_the_same_tokens() {
        let index = BlindIndex::from_root(&[3; KEY_LEN], "message-fts.db", TERMS_FIELD);
        let document = index.fts_document("Quarterly revenue report");
        let query = index.fts_query("REVENUE report").unwrap();
        for token in query.split(" AND ") {
            assert!(document.split(' ').any(|t| t == token));
        }
        assert!(!document.contains("revenue"));
        assert!(index.fts_query("the of").is_none());
        assert!(index.fts_query("").is_none());
    }
}
