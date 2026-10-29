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

/// The fixed-corner badge. `source` is a short lowercase slug naming the surface.
pub fn powered_by_ryu_badge_html(source: &str) -> String {
    assert!(
        !source.is_empty()
            && source.len() <= 40
            && source
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
        "badge source must be a short lowercase slug"
    );
    format!(
        "<a {BADGE_MARKER}=\"{source}\" href=\"https://ryuhq.com/?utm_source={source}&amp;utm_medium=powered_by&amp;utm_campaign=badge\" \
target=\"_blank\" rel=\"noopener\" aria-label=\"Powered by Ryu — make your own\" \
style=\"position:fixed;right:12px;bottom:12px;z-index:2147483647;display:inline-flex;align-items:center;gap:6px;\
padding:6px 10px 6px 8px;border-radius:999px;background:rgba(17,17,20,.88);color:#fff;\
font:500 12px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-decoration:none;letter-spacing:0;\
box-shadow:0 1px 2px rgba(0,0,0,.2),0 4px 14px rgba(0,0,0,.18);backdrop-filter:blur(8px)\">\
<svg aria-hidden=\"true\" width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\">\
<path d=\"M13 2 4 14h7l-1 8 9-12h-7l1-8Z\" fill=\"#facc15\"/></svg>\
<span>Powered by <strong style=\"font-weight:700\">Ryu</strong></span></a>"
    )
}

/// Stamp the badge into a full HTML document just before `</body>` (or at the end).
/// A document that already carries one is returned unchanged.
pub fn inject_powered_by_ryu(html: &str, source: &str) -> String {
    if html.contains(BADGE_MARKER) {
        return html.to_owned();
    }
    let badge = powered_by_ryu_badge_html(source);
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
    #[should_panic(expected = "lowercase slug")]
    fn rejects_a_source_that_could_break_the_attribute() {
        powered_by_ryu_badge_html("x\" onclick=\"");
    }
}
