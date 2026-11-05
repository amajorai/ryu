//! The keyword-padding form carried past the scan start (`keyword_tail`):
//! a keyword whose value has not arrived yet when it leaves the scan reach.

use super::reach::fold_case;

/// An open keyword-padding form at the end of normalized, case-folded text:
/// the character before the keyword (group 1, so `\b` judges the carried form
/// as it judges the full text), the keyword, and the padding the pattern
/// accepts.
fn open_form() -> &'static regex::Regex {
    static FORM: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    FORM.get_or_init(|| {
        regex::Regex::new(
            r"(?s)(?:^|(.))(?:passport[\s:#\-]*(?:(?:no|num|number)\.?[\s:#\-]*)?|bearer\s+|(?:api_key|apikey|api-key)\s*(?:[:=]\s*)?)$",
        )
        .unwrap_or_else(|_| regex::Regex::new("$^").expect("empty regex"))
    })
}

/// The open keyword-padding form left at the end of drained text, carried in
/// compact normalized form (`" passport no. #"`, `"bearer "`, `"api_key ="`).
/// `previous` is the form carried so far: the drained text continues it, so a
/// form drained over several steps (`passport`, then `no.`, then padding) is
/// judged whole. `None` once anything but the form's padding follows it.
pub(super) fn keyword_tail(drained: &str, previous: Option<String>) -> Option<String> {
    let previous = previous.unwrap_or_default();
    let normalized = ryu_gw_firewall::normalize_for_scan(drained);
    form_at_end(
        &format!("{previous}{}", fold_case(&normalized)),
        &format!("{previous}{normalized}"),
    )
}

/// The open form ending `folded`, its left character taken from `unfolded`
/// (the same text before case folding, which maps one character to one):
/// folding a non-ASCII left character (`K` Kelvin, `ſ`, `İ`) to an ASCII
/// letter would join it to the keyword and drop the word boundary
/// `(?-u:\b)` sees in the whole text.
fn form_at_end(folded: &str, unfolded: &str) -> Option<String> {
    let captures = open_form().captures(folded)?;
    let found = captures.get(0)?;
    let mut form = String::new();
    let rest = match captures.get(1) {
        Some(left) => {
            let index = folded[..left.start()].chars().count();
            form.push(unfolded.chars().nth(index)?);
            left.end()
        }
        None => found.start(),
    };
    form.push_str(&folded[rest..]);
    Some(compress_padding(&form))
}

/// The open form at the end of the drained text as written (case folded
/// only, nothing stripped or mapped), continuing `previous`, the form as
/// written carried so far. Detection joins it to the raw region and the raw
/// transform is judged with it, so each sees the left character and keyword
/// the whole text holds as written. `None` when the raw text holds no form
/// (a fullwidth or zero-width-split keyword only the folded text joins).
pub(super) fn raw_tail(drained: &str, previous: Option<String>) -> Option<String> {
    let previous = previous.unwrap_or_default();
    form_at_end(
        &format!("{previous}{}", fold_case(drained)),
        &format!("{previous}{drained}"),
    )
}

/// Collapse each run of padding to its distinct characters, in order. The
/// patterns accept any run of `[\s:#-]`, and `\s*[:=]\s*` keeps its one
/// separator, so the compact form matches exactly where the full one does.
fn compress_padding(form: &str) -> String {
    let mut out = String::with_capacity(form.len().min(64));
    let mut run: Vec<char> = Vec::new();
    for character in form.chars() {
        let padding = if character.is_whitespace() {
            Some(' ')
        } else {
            matches!(character, ':' | '#' | '-' | '=').then_some(character)
        };
        match padding {
            Some(character) => {
                if !run.contains(&character) {
                    run.push(character);
                    out.push(character);
                }
            }
            None => {
                run.clear();
                out.push(character);
            }
        }
    }
    out
}
