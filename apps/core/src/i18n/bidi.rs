//! Bidi isolation for the text arguments Core puts into rendered messages.
//!
//! Mirrors `packages/i18n/src/format-bidi.ts`. In a right-to-left sentence a
//! Latin argument (a path, an email, `@alice`, `#general`) lets its neutral
//! edge characters take the paragraph direction, so `@{handle}` shows as
//! `alice@`. For a right-to-left locale a text argument written wholly in
//! left-to-right letters is wrapped in FSI ... PDI (U+2068 ... U+2069), and a
//! `@` or `#` written just before it moves inside. Bare URLs and emails stay
//! unwrapped so plain-text linkifiers keep them whole. Every other locale
//! renders byte-for-byte as before; numbers and dates are never wrapped.
//!
//! A phone lock screen or a desktop toast has no `dir` attribute and picks a
//! body's direction from its first strong character, so a right-to-left body
//! that opens with a Latin name is laid out left to right. [`rtl_body`] gives
//! such plain-text bodies a leading U+200F (RIGHT-TO-LEFT MARK).

use super::locale;

/// U+2068 FIRST STRONG ISOLATE.
const FSI: char = '\u{2068}';
/// U+2069 POP DIRECTIONAL ISOLATE.
const PDI: char = '\u{2069}';
/// U+200F RIGHT-TO-LEFT MARK.
const RLM: char = '\u{200f}';

fn is_rtl(locale: &str) -> bool {
    locale::text_direction(locale) == "rtl"
}

fn is_rtl_script(c: char) -> bool {
    matches!(
        c,
        '\u{0590}'..='\u{08FF}'
            | '\u{FB1D}'..='\u{FDFF}'
            | '\u{FE70}'..='\u{FEFF}'
            | '\u{10800}'..='\u{10FFF}'
            | '\u{1E800}'..='\u{1EFFF}'
    )
}

/// Whether `text` is written wholly in left-to-right letters. Text holding
/// right-to-left letters was composed for the locale (a nested sentence, an
/// Arabic list) and flows with the sentence, and bare digits and separators
/// are laid out as numbers.
fn is_ltr_only(text: &str) -> bool {
    let mut letters = text.chars().filter(|c| c.is_alphabetic()).peekable();
    letters.peek().is_some() && letters.all(|c| !is_rtl_script(c))
}

/// A placeholder echo (`{app}`) passed on for a later fill, or a bare URL or
/// email: plain-text surfaces (Telegram, push, email) autolink those, and a
/// linkifier may take a trailing PDI into the link.
fn keeps_verbatim(text: &str) -> bool {
    if text.starts_with('{') && text.ends_with('}') {
        return true;
    }
    if text.chars().any(char::is_whitespace) {
        return false;
    }
    let lower = text.to_ascii_lowercase();
    let url = lower.starts_with("www.")
        || lower.split_once("://").is_some_and(|(scheme, rest)| {
            !rest.is_empty()
                && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
        });
    let email = text.split_once('@').is_some_and(|(local, domain)| {
        !local.is_empty() && domain.contains('.') && !domain.contains('@')
    });
    url || email
}

fn is_isolated(text: &str) -> bool {
    text.ends_with(PDI) && (text.starts_with(FSI) || text.starts_with('\u{2066}'))
}

/// Whether a text argument rendered for `locale` needs an isolate.
fn needs_isolate(text: &str, locale: &str) -> bool {
    !text.is_empty()
        && is_rtl(locale)
        && !is_isolated(text)
        && is_ltr_only(text)
        && !keeps_verbatim(text)
}

/// Append a text argument to `out` for `locale`; `whole` is a pattern that
/// is this argument alone, which stays unwrapped since nothing surrounds it.
pub(super) fn push_text_arg(out: &mut String, text: &str, locale: &str, whole: bool) {
    if whole || !needs_isolate(text, locale) {
        out.push_str(text);
        return;
    }
    let sigil = out.chars().next_back().filter(|c| matches!(c, '@' | '#'));
    if let Some(sigil) = sigil {
        out.pop();
        out.push(FSI);
        out.push(sigil);
    } else {
        out.push(FSI);
    }
    out.push_str(text);
    out.push(PDI);
}

/// A plain-text notification body for `locale`: a right-to-left locale gets a
/// leading RIGHT-TO-LEFT MARK so the OS lays it out right to left even when
/// it opens with a Latin name; other locales are unchanged.
pub fn rtl_body(body: String, locale: &str) -> String {
    if body.is_empty() || !is_rtl(locale) || body.starts_with(RLM) {
        return body;
    }
    let mut marked = String::with_capacity(body.len() + RLM.len_utf8());
    marked.push(RLM);
    marked.push_str(&body);
    marked
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arg(prefix: &str, text: &str, locale: &str) -> String {
        let mut out = prefix.to_owned();
        push_text_arg(&mut out, text, locale, false);
        out
    }

    #[test]
    fn latin_arguments_are_isolated_only_in_rtl_locales() {
        assert_eq!(
            arg("فتح ", "Release v2.4", "ar"),
            "فتح \u{2068}Release v2.4\u{2069}"
        );
        assert_eq!(arg("Open ", "Release v2.4", "en"), "Open Release v2.4");
        assert_eq!(arg("Öffnen ", "Release v2.4", "de"), "Öffnen Release v2.4");
    }

    #[test]
    fn a_sigil_moves_inside_the_isolate() {
        assert_eq!(
            arg("إرسال إلى @", "alice", "ar"),
            "إرسال إلى \u{2068}@alice\u{2069}"
        );
        assert_eq!(
            arg("مراسلة #", "general", "ar"),
            "مراسلة \u{2068}#general\u{2069}"
        );
    }

    #[test]
    fn rtl_text_digits_and_isolated_text_stay_as_they_are() {
        assert_eq!(arg("عن ", "الكواكب", "ar"), "عن الكواكب");
        assert_eq!(arg("رقم ", "12.50", "ar"), "رقم 12.50");
        let isolated = "\u{2068}alice\u{2069}";
        assert_eq!(arg("", isolated, "ar"), isolated);
        let mut out = String::new();
        push_text_arg(&mut out, "alice", "ar", true);
        assert_eq!(out, "alice");
    }

    #[test]
    fn substitute_isolates_text_but_not_numbers_in_arabic() {
        use super::super::render::{substitute, Arg};
        let args = [
            ("handle".to_owned(), Arg::Text("alice".to_owned())),
            (
                "count".to_owned(),
                Arg::Number {
                    value: 3.0,
                    min_fraction: 0,
                    max_fraction: 0,
                },
            ),
        ];
        let arabic = substitute("@{handle} محجوز ({count})", "ar", &args).unwrap();
        assert_eq!(
            arabic,
            format!(
                "\u{2068}@alice\u{2069} محجوز ({})",
                super::super::number::format("ar", 3.0, 0, 0)
            )
        );
        let english = substitute("@{handle} is reserved ({count})", "en", &args).unwrap();
        assert_eq!(english, "@alice is reserved (3)");
        let german = substitute("@{handle} ist reserviert", "de", &args).unwrap();
        assert_eq!(german, "@alice ist reserviert");
        // A pattern that is the argument alone stays as written.
        assert_eq!(substitute("{handle}", "ar", &args).unwrap(), "alice");
    }

    #[test]
    fn a_message_renders_isolated_in_arabic_only() {
        let wire = serde_json::json!({
            "message": "Send to @{name} at {path}",
            "args": { "name": "alice", "path": "./agents" },
        });
        let message = super::super::Message::from_wire(&wire).unwrap();
        assert_eq!(message.render("en"), "Send to @alice at ./agents");
        assert_eq!(
            message.render("ar"),
            "Send to \u{2068}@alice\u{2069} at \u{2068}./agents\u{2069}"
        );
    }

    #[test]
    fn urls_emails_rtl_sentences_and_echoes_stay_verbatim() {
        let url = "https://ryuhq.com/pricing";
        assert_eq!(arg("من ", url, "ar"), format!("من {url}"));
        assert_eq!(arg("إلى ", "a@b.co", "ar"), "إلى a@b.co");
        assert_eq!(arg("خطأ: ", "رفض Ryu Core", "ar"), "خطأ: رفض Ryu Core");
        assert_eq!(arg("حول ", "{app}", "ar"), "حول {app}");
        assert_eq!(arg("(", "@a_bot و@b_bot", "ar"), "(@a_bot و@b_bot");
    }

    #[test]
    fn rtl_bodies_get_a_leading_mark_once() {
        assert_eq!(
            rtl_body("Ada أنهى الرد".to_owned(), "ar"),
            "\u{200f}Ada أنهى الرد"
        );
        assert_eq!(rtl_body("\u{200f}x".to_owned(), "ar"), "\u{200f}x");
        assert_eq!(rtl_body("Ada finished".to_owned(), "en"), "Ada finished");
        assert_eq!(rtl_body(String::new(), "ar"), "");
    }
}
