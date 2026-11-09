//! English sources for system notifications (app installs and updates, imports, delegated agents).
//!
//! Same shape as the templates in [`super`]: each `*_MESSAGE` is a
//! [`Template`](crate::i18n::Template) built with `format!` and one named
//! argument per placeholder, written as a whole sentence. They are re-exported
//! from [`super`], so callers keep using `i18n::messages::NAME_MESSAGE`.
//!
//! The server call sites still pass the English text; `events::system_text`
//! recognizes it against these sources and renders the node's language. A
//! count sentence has a `*_ONE_MESSAGE` form for a count of 1, since the
//! renderer has no ICU `plural` support. One sentence reads slightly
//! differently from the call-site English, which the extractor would skip.
#![allow(clippy::useless_format)]

use super::Template;

// ---- apps ---------------------------------------------------------------------

pub const NOTIFY_APP_UPDATED_TITLE_MESSAGE: Template = |_| format!("App updated");
pub const NOTIFY_APP_UPDATED_MESSAGE: Template = |arg| {
    format!(
        "{app} {version} is updated and ready.",
        app = arg("app"),
        version = arg("version")
    )
};
pub const NOTIFY_APP_INSTALLED_TITLE_MESSAGE: Template = |_| format!("App installed");
pub const NOTIFY_APP_INSTALLED_VERSION_MESSAGE: Template = |arg| {
    format!(
        "{app} {version} is installed and ready to enable.",
        app = arg("app"),
        version = arg("version")
    )
};
pub const NOTIFY_APP_INSTALLED_MESSAGE: Template =
    |arg| format!("{app} is installed and ready to enable.", app = arg("app"));

// ---- imports ------------------------------------------------------------------

pub const NOTIFY_THREAD_SYNCED_TITLE_MESSAGE: Template = |_| format!("Thread import updated");
pub const NOTIFY_THREAD_SYNCED_MESSAGE: Template = |arg| {
    format!(
        "{thread} synced {count} new messages from {engine}.",
        thread = arg("thread"),
        count = arg("count"),
        engine = arg("engine")
    )
};
pub const NOTIFY_THREAD_SYNCED_ONE_MESSAGE: Template = |arg| {
    format!(
        "{thread} synced {count} new message from {engine}.",
        thread = arg("thread"),
        count = arg("count"),
        engine = arg("engine")
    )
};
pub const NOTIFY_THREAD_IMPORTED_TITLE_MESSAGE: Template = |_| format!("Thread imported");
pub const NOTIFY_THREAD_IMPORTED_MESSAGE: Template = |arg| {
    format!(
        "{thread} was imported from {engine} and is ready.",
        thread = arg("thread"),
        engine = arg("engine")
    )
};
pub const NOTIFY_IMPORT_COMPLETE_TITLE_MESSAGE: Template = |_| format!("Import complete");
pub const NOTIFY_IMPORT_COMPLETE_MESSAGE: Template = |arg| {
    format!(
        "{imported} imported, {skipped} already present, {failed} failed from {source}.",
        imported = arg("imported"),
        skipped = arg("skipped"),
        failed = arg("failed"),
        source = arg("source")
    )
};
pub const NOTIFY_CHATS_IMPORTED_TITLE_MESSAGE: Template = |_| format!("Chats imported");
// `{label}` is the export's product name (`ChatGPT`, `Claude`). The project
// name is quoted with “ ” because an ICU `'` before `{` would quote the
// placeholder itself.
pub const NOTIFY_CHATS_IMPORTED_EXPORT_MESSAGE: Template = |arg| {
    format!(
        "Imported {label} chats: {created} new, {updated} updated.",
        label = arg("label"),
        created = arg("created"),
        updated = arg("updated")
    )
};
pub const NOTIFY_CHATS_IMPORTED_PROJECT_MESSAGE: Template = |arg| {
    format!(
        "Imported {label} project “{name}”: {created} new, {updated} updated.",
        label = arg("label"),
        name = arg("name"),
        created = arg("created"),
        updated = arg("updated")
    )
};

// ---- delegated agents -----------------------------------------------------------

pub const NOTIFY_AGENTS_FINISHED_TITLE_MESSAGE: Template = |_| format!("Other agents finished");
pub const NOTIFY_AGENTS_FINISHED_ISSUES_TITLE_MESSAGE: Template =
    |_| format!("Other agents finished with issues");
pub const NOTIFY_AGENTS_COMPLETED_MESSAGE: Template = |arg| {
    format!(
        "{completed} of {total} delegated tasks completed.",
        completed = arg("completed"),
        total = arg("total")
    )
};
pub const NOTIFY_AGENTS_COMPLETED_ONE_MESSAGE: Template = |arg| {
    format!(
        "{completed} of {total} delegated task completed.",
        completed = arg("completed"),
        total = arg("total")
    )
};

// ---- email -------------------------------------------------------------------

pub const EMAIL_TEST_SUBJECT_MESSAGE: Template = |_| format!("Ryu test email");
pub const EMAIL_TEST_BODY_MESSAGE: Template =
    |_| format!("This is a test email from your Ryu node. Your SMTP transport is working.");

/// The SMTP test email (`POST /api/email/test`) as `(subject, body)` in
/// `locale`. The handler passes the node's locale, like real alert emails.
pub fn email_test_text(locale: &str) -> (String, String) {
    (
        crate::i18n::Message::new(EMAIL_TEST_SUBJECT_MESSAGE).render(locale),
        crate::i18n::Message::new(EMAIL_TEST_BODY_MESSAGE).render(locale),
    )
}

// ---- Streaming privacy (inbox, toast and Island) --------------------------------

/// Stands in for a connected-app suggestion while Streaming is on. The English
/// text is also `crate::notify::CONNECT_SUGGESTION_PRIVACY_TITLE`, which Core
/// persists; readers render it in the node's language.
pub const CONNECT_SUGGESTION_PRIVACY_TITLE_MESSAGE: Template =
    |_| format!("Private connected-app activity");
pub const CONNECT_SUGGESTION_PRIVACY_BODY_MESSAGE: Template = |_| {
    format!("A connected-app event was hidden during Streaming. Review it in the source app when you’re ready.")
};

/// Every template in this module, for the catalog round-trip test; add each
/// new `*_MESSAGE` here too.
#[cfg(test)]
pub(super) const ALL: &[Template] = &[
    NOTIFY_APP_UPDATED_TITLE_MESSAGE,
    NOTIFY_APP_UPDATED_MESSAGE,
    NOTIFY_APP_INSTALLED_TITLE_MESSAGE,
    NOTIFY_APP_INSTALLED_VERSION_MESSAGE,
    NOTIFY_APP_INSTALLED_MESSAGE,
    NOTIFY_THREAD_SYNCED_TITLE_MESSAGE,
    NOTIFY_THREAD_SYNCED_MESSAGE,
    NOTIFY_THREAD_SYNCED_ONE_MESSAGE,
    NOTIFY_THREAD_IMPORTED_TITLE_MESSAGE,
    NOTIFY_THREAD_IMPORTED_MESSAGE,
    NOTIFY_IMPORT_COMPLETE_TITLE_MESSAGE,
    NOTIFY_IMPORT_COMPLETE_MESSAGE,
    NOTIFY_CHATS_IMPORTED_TITLE_MESSAGE,
    NOTIFY_CHATS_IMPORTED_EXPORT_MESSAGE,
    NOTIFY_CHATS_IMPORTED_PROJECT_MESSAGE,
    NOTIFY_AGENTS_FINISHED_TITLE_MESSAGE,
    NOTIFY_AGENTS_FINISHED_ISSUES_TITLE_MESSAGE,
    NOTIFY_AGENTS_COMPLETED_MESSAGE,
    NOTIFY_AGENTS_COMPLETED_ONE_MESSAGE,
    EMAIL_TEST_SUBJECT_MESSAGE,
    EMAIL_TEST_BODY_MESSAGE,
    CONNECT_SUGGESTION_PRIVACY_TITLE_MESSAGE,
    CONNECT_SUGGESTION_PRIVACY_BODY_MESSAGE,
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::Message;

    /// The test email renders through the catalog for the locale it is given
    /// (the handler passes `node_locale()`), with English as the fallback.
    #[test]
    fn email_test_text_renders_in_the_given_locale() {
        assert_eq!(
            email_test_text("en"),
            (
                "Ryu test email".to_owned(),
                "This is a test email from your Ryu node. Your SMTP transport is working."
                    .to_owned()
            )
        );
        assert_eq!(email_test_text("xx"), email_test_text("en"));
        for locale in ["ja", "ar", "de", "fr", "zh-CN"] {
            let (subject, body) = email_test_text(locale);
            assert_eq!(
                subject,
                Message::new(EMAIL_TEST_SUBJECT_MESSAGE).render(locale)
            );
            assert_eq!(body, Message::new(EMAIL_TEST_BODY_MESSAGE).render(locale));
        }
        assert_eq!(email_test_text("ja-JP"), email_test_text("ja"));
    }
}
