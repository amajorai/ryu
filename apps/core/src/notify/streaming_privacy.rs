//! The placeholder that stands in for a connected-app suggestion while
//! Streaming is on.
//!
//! Core persists the English text ([`super::CONNECT_SUGGESTION_PRIVACY_TITLE`]
//! and [`super::CONNECT_SUGGESTION_PRIVACY_BODY`], the workflow checkpoint and
//! the inbox row keep it), and renders it in the node's language wherever it
//! reaches a reader: the inbox list, the notification stream and the toast.

use super::{CONNECT_SUGGESTION_PRIVACY_BODY, CONNECT_SUGGESTION_PRIVACY_TITLE};
use crate::i18n::messages::{
    CONNECT_SUGGESTION_PRIVACY_BODY_MESSAGE, CONNECT_SUGGESTION_PRIVACY_TITLE_MESSAGE,
};
use crate::i18n::Message;

/// The placeholder title and body in `locale`.
pub fn privacy_placeholder(locale: &str) -> (String, String) {
    (
        Message::new(CONNECT_SUGGESTION_PRIVACY_TITLE_MESSAGE).render(locale),
        Message::new(CONNECT_SUGGESTION_PRIVACY_BODY_MESSAGE).render(locale),
    )
}

/// Whether a title and body are the persisted English placeholder.
pub fn is_privacy_placeholder(title: &str, body: Option<&str>) -> bool {
    title == CONNECT_SUGGESTION_PRIVACY_TITLE && body == Some(CONNECT_SUGGESTION_PRIVACY_BODY)
}

/// Render a persisted English placeholder in `locale`; other text is unchanged.
pub fn localize_privacy_placeholder(title: &mut String, body: &mut Option<String>, locale: &str) {
    if is_privacy_placeholder(title, body.as_deref()) {
        let (localized_title, localized_body) = privacy_placeholder(locale);
        *title = localized_title;
        *body = Some(localized_body);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_persisted_english_is_the_catalog_source() {
        assert_eq!(
            privacy_placeholder("en"),
            (
                CONNECT_SUGGESTION_PRIVACY_TITLE.to_owned(),
                CONNECT_SUGGESTION_PRIVACY_BODY.to_owned()
            )
        );
    }

    #[test]
    fn only_the_english_placeholder_is_localized() {
        for locale in ["de", "ja", "ar"] {
            let mut title = CONNECT_SUGGESTION_PRIVACY_TITLE.to_owned();
            let mut body = Some(CONNECT_SUGGESTION_PRIVACY_BODY.to_owned());
            localize_privacy_placeholder(&mut title, &mut body, locale);
            let (expected_title, expected_body) = privacy_placeholder(locale);
            assert_eq!(title, expected_title);
            assert_eq!(body.as_deref(), Some(expected_body.as_str()));
        }
        let mut title = "Password reset requested".to_owned();
        let mut body = Some(CONNECT_SUGGESTION_PRIVACY_BODY.to_owned());
        localize_privacy_placeholder(&mut title, &mut body, "de");
        assert_eq!(title, "Password reset requested");
    }
}
