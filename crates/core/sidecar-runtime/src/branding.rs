//! "Powered by Ryu" — the badge Ryu stamps on public pages an app sidecar serves.
//!
//! The Rust twin of `packages/sidecar-runtime/src/branding.ts`: same env var, same
//! markup, same fail-safe. Core injects [`ENV_BRANDING_REMOVABLE`] into every
//! sidecar from the plan the desktop last reported; unset or unreadable stays
//! branded, so a headless node or a missed sync never unbrands a free member.

/// Env var Core injects into every sidecar: `1` when the owner's plan drops the badge.
pub const ENV_BRANDING_REMOVABLE: &str = "RYU_BRANDING_REMOVABLE";

const BADGE_MARKER: &str = "data-ryu-powered-by";

/// Whether a raw `RYU_BRANDING_REMOVABLE` value drops the badge.
pub fn branding_removable_from(value: Option<&str>) -> bool {
    matches!(
        value.map(|raw| raw.trim().to_ascii_lowercase()).as_deref(),
        Some("1" | "true" | "on" | "yes")
    )
}

/// Whether this process's owner is on a plan that drops the badge.
pub fn branding_removable() -> bool {
    branding_removable_from(std::env::var(ENV_BRANDING_REMOVABLE).ok().as_deref())
}

/// The visible badge text: one ICU-style catalog message whose `<b>` marks the name.
pub const POWERED_BY_RYU_LABEL: &str = "Powered by <b>Ryu</b>";
/// The badge link's accessible name.
pub const POWERED_BY_RYU_ARIA_LABEL: &str = "Powered by Ryu — make your own";

/// The badge copy in the visitor's language, mirroring the TypeScript
/// `PoweredByRyuCopy`. The serving app resolves the locale (the badge has no
/// localizer of its own) and passes the translated `label` and `aria_label`
/// plus the page direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoweredByRyuCopy<'a> {
    /// The translated visible text ([`POWERED_BY_RYU_LABEL`]).
    pub label: &'a str,
    /// The translated accessible name ([`POWERED_BY_RYU_ARIA_LABEL`]).
    pub aria_label: &'a str,
    /// `"rtl"` or `"ltr"`; anything else is treated as `"ltr"`.
    pub dir: &'a str,
}

impl PoweredByRyuCopy<'static> {
    /// The English badge copy.
    pub const ENGLISH: Self = Self {
        label: POWERED_BY_RYU_LABEL,
        aria_label: POWERED_BY_RYU_ARIA_LABEL,
        dir: "ltr",
    };
}

fn escape_html(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

/// The escaped visible label, with its one `<b>…</b>` span rendered bold.
fn label_html(label: &str) -> String {
    let escaped = escape_html(label);
    let (open, close) = ("&lt;b&gt;", "&lt;/b&gt;");
    let Some(start) = escaped.find(open) else {
        return escaped;
    };
    let inner_start = start + open.len();
    let Some(inner_len) = escaped[inner_start..].find(close) else {
        return escaped;
    };
    let inner_end = inner_start + inner_len;
    format!(
        "{}<strong style=\"font-weight:700\">{}</strong>{}",
        &escaped[..start],
        &escaped[inner_start..inner_end],
        &escaped[inner_end + close.len()..]
    )
}

/// The fixed-corner badge in English. `source` is a short lowercase slug naming the surface.
pub fn powered_by_ryu_badge_html(source: &str) -> String {
    powered_by_ryu_badge_html_with(source, &PoweredByRyuCopy::ENGLISH)
}

/// The fixed-corner badge with `copy` in the visitor's language, placed at the
/// inline end of the page direction.
pub fn powered_by_ryu_badge_html_with(source: &str, copy: &PoweredByRyuCopy<'_>) -> String {
    assert!(
        !source.is_empty()
            && source.len() <= 40
            && source
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
        "badge source must be a short lowercase slug"
    );
    let dir = if copy.dir == "rtl" { "rtl" } else { "ltr" };
    let aria_label = escape_html(copy.aria_label);
    let label = label_html(copy.label);
    format!(
        "<a {BADGE_MARKER}=\"{source}\" href=\"https://ryuhq.com/?utm_source={source}&amp;utm_medium=powered_by&amp;utm_campaign=badge\" \
target=\"_blank\" rel=\"noopener\" dir=\"{dir}\" aria-label=\"{aria_label}\" \
style=\"position:fixed;inset-inline-end:12px;bottom:12px;z-index:2147483647;display:inline-flex;align-items:center;gap:6px;\
padding-block:6px;padding-inline:8px 10px;border-radius:999px;background:rgba(17,17,20,.88);color:#fff;\
font:500 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-decoration:none;letter-spacing:0;\
box-shadow:0 1px 2px rgba(0,0,0,.2),0 4px 14px rgba(0,0,0,.18);backdrop-filter:blur(8px)\">\
<svg aria-hidden=\"true\" width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\">\
<path d=\"M13 2 4 14h7l-1 8 9-12h-7l1-8Z\" fill=\"#facc15\"/></svg>\
<span>{label}</span></a>"
    )
}

/// Stamp the English badge into a full HTML document just before `</body>` (or
/// at the end). A document that already carries one is returned unchanged.
pub fn inject_powered_by_ryu(html: &str, source: &str) -> String {
    inject_powered_by_ryu_with(html, source, &PoweredByRyuCopy::ENGLISH)
}

/// [`inject_powered_by_ryu`] with the badge copy in the visitor's language.
pub fn inject_powered_by_ryu_with(html: &str, source: &str, copy: &PoweredByRyuCopy<'_>) -> String {
    if html.contains(BADGE_MARKER) {
        return html.to_owned();
    }
    let badge = powered_by_ryu_badge_html_with(source, copy);
    match html.to_ascii_lowercase().rfind("</body>") {
        Some(at) => format!("{}{badge}{}", &html[..at], &html[at..]),
        None => format!("{html}{badge}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stays_branded_unless_the_plan_drops_it() {
        assert!(!branding_removable_from(None));
        assert!(!branding_removable_from(Some("0")));
        assert!(!branding_removable_from(Some("maybe")));
        assert!(branding_removable_from(Some(" TRUE ")));
        assert!(branding_removable_from(Some("1")));
    }

    #[test]
    fn injects_once_before_the_closing_body() {
        let html = inject_powered_by_ryu("<html><body><h1>Hi</h1></BODY></html>", "feedback-board");
        assert!(html.find(BADGE_MARKER).unwrap() < html.find("</BODY>").unwrap());
        assert!(html.contains("utm_source=feedback-board"));
        assert_eq!(inject_powered_by_ryu(&html, "feedback-board"), html);
        assert!(inject_powered_by_ryu("<p>bare</p>", "rooms").starts_with("<p>bare</p><a "));
    }

    #[test]
    fn the_english_wrapper_keeps_the_english_copy_at_the_inline_end() {
        let html = powered_by_ryu_badge_html("feedback-board");
        assert_eq!(
            html,
            powered_by_ryu_badge_html_with("feedback-board", &PoweredByRyuCopy::ENGLISH)
        );
        assert!(html.contains("aria-label=\"Powered by Ryu — make your own\""));
        assert!(
            html.contains("<span>Powered by <strong style=\"font-weight:700\">Ryu</strong></span>")
        );
        assert!(html.contains("dir=\"ltr\""));
        assert!(html.contains("inset-inline-end:12px"));
        assert!(!html.contains("right:12px"));
    }

    #[test]
    fn translated_copy_is_escaped_and_carries_its_direction() {
        let copy = PoweredByRyuCopy {
            label: "مدعوم من <b>Ryu</b>",
            aria_label: "مدعوم من Ryu — \"أنشئ\" <x>",
            dir: "rtl",
        };
        let html = inject_powered_by_ryu_with("<body></body>", "feedback-board", &copy);
        assert!(html.contains("dir=\"rtl\""));
        assert!(
            html.contains("<span>مدعوم من <strong style=\"font-weight:700\">Ryu</strong></span>")
        );
        assert!(html.contains("aria-label=\"مدعوم من Ryu — &quot;أنشئ&quot; &lt;x&gt;\""));
        let odd = PoweredByRyuCopy {
            label: "<i>x</i>",
            aria_label: "a",
            dir: "sideways",
        };
        let html = powered_by_ryu_badge_html_with("rooms", &odd);
        assert!(html.contains("<span>&lt;i&gt;x&lt;/i&gt;</span>"));
        assert!(html.contains("dir=\"ltr\""));
    }

    #[test]
    #[should_panic(expected = "lowercase slug")]
    fn rejects_a_source_that_could_break_the_attribute() {
        powered_by_ryu_badge_html("x\" onclick=\"");
    }
}
