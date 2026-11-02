//! Locale-aware decimal formatting for notification arguments, matching what
//! `Intl.NumberFormat` prints for the catalog's locales (Latin digits).

/// `value` with `min_fraction..=max_fraction` decimals, grouped and separated
/// the way `locale` writes numbers.
pub(super) fn format(locale: &str, value: f64, min_fraction: u8, max_fraction: u8) -> String {
    if !value.is_finite() {
        return value.to_string();
    }
    let symbols = Symbols::for_locale(locale);
    let max = usize::from(max_fraction.min(6));
    let min = usize::from(min_fraction).min(max);
    let fixed = format!("{:.*}", max, value.abs());
    let (whole, fraction) = fixed.split_once('.').unwrap_or((fixed.as_str(), ""));
    let mut fraction = fraction.to_owned();
    while fraction.len() > min && fraction.ends_with('0') {
        fraction.pop();
    }
    let negative =
        value < 0.0 && (whole.bytes().any(|b| b != b'0') || fraction.bytes().any(|b| b != b'0'));
    let mut out = String::new();
    if negative {
        out.push_str(symbols.minus);
    }
    out.push_str(&group(whole, &symbols));
    if !fraction.is_empty() {
        out.push_str(symbols.decimal);
        out.push_str(&fraction);
    }
    out
}

struct Symbols {
    decimal: &'static str,
    group: &'static str,
    minus: &'static str,
    /// Digits a number needs before it is grouped at all (`1234` stays
    /// ungrouped in Spanish and Italian).
    min_grouping: usize,
    /// Indian grouping: thousands, then every two digits (`12,34,567`).
    indian: bool,
}

impl Symbols {
    fn for_locale(locale: &str) -> Self {
        let base = Self {
            decimal: ".",
            group: ",",
            minus: "-",
            min_grouping: 4,
            indian: false,
        };
        match super::locale::resolve(locale) {
            "de" | "pt-BR" => Self {
                decimal: ",",
                group: ".",
                ..base
            },
            "es" | "it" => Self {
                decimal: ",",
                group: ".",
                min_grouping: 5,
                ..base
            },
            "fr" => Self {
                decimal: ",",
                group: "\u{202f}",
                ..base
            },
            "ru" => Self {
                decimal: ",",
                group: "\u{a0}",
                ..base
            },
            "hi" => Self {
                indian: true,
                ..base
            },
            "ar" => Self {
                minus: "\u{200e}-",
                ..base
            },
            _ => base,
        }
    }
}

fn group(digits: &str, symbols: &Symbols) -> String {
    if digits.len() < symbols.min_grouping {
        return digits.to_owned();
    }
    let mut groups: Vec<&str> = Vec::new();
    let mut end = digits.len();
    let mut size = 3;
    while end > size {
        groups.push(&digits[end - size..end]);
        end -= size;
        if symbols.indian {
            size = 2;
        }
    }
    groups.push(&digits[..end]);
    groups.reverse();
    groups.join(symbols.group)
}
