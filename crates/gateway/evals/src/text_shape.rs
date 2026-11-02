//! Shape detectors and string metrics the deterministic assertions share.

use std::sync::OnceLock;

use regex::Regex;

pub(crate) fn is_html_like(value: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?is)<[a-z][^>]*>.*</[a-z][^>]*>").expect("valid html regex"))
        .is_match(value.trim())
}

pub(crate) fn is_xml_like(value: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?s)^<[A-Za-z_][\w:.-]*(?:\s[^>]*)?>.*</[A-Za-z_][\w:.-]*>$")
            .expect("valid xml regex")
    })
    .is_match(value.trim())
}

pub(crate) fn is_sql_like(value: &str) -> bool {
    let upper = value.trim_start().to_uppercase();
    [
        "SELECT ", "INSERT ", "UPDATE ", "DELETE ", "WITH ", "CREATE ", "ALTER ", "DROP ",
    ]
    .iter()
    .any(|prefix| upper.starts_with(prefix))
}

pub(crate) fn normalized_levenshtein(left: &str, right: &str) -> f32 {
    let left: Vec<char> = left.chars().collect();
    let right: Vec<char> = right.chars().collect();
    if left.is_empty() && right.is_empty() {
        return 1.0;
    }
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let mut previous: Vec<usize> = (0..=right.len()).collect();
    for (left_index, left_char) in left.iter().enumerate() {
        let mut current = vec![left_index + 1; right.len() + 1];
        for (right_index, right_char) in right.iter().enumerate() {
            current[right_index + 1] = if left_char == right_char {
                previous[right_index]
            } else {
                1 + previous[right_index]
                    .min(previous[right_index + 1])
                    .min(current[right_index])
            };
        }
        previous = current;
    }
    1.0 - previous[right.len()] as f32 / left.len().max(right.len()) as f32
}

pub(crate) fn comma_values(value: &str) -> Vec<&str> {
    value
        .split(',')
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shape_detectors_and_metrics() {
        assert!(is_html_like("<p>hi</p>"));
        assert!(!is_html_like("plain text"));
        assert!(is_xml_like("<a><b>1</b></a>"));
        assert!(!is_xml_like("x <a></a>"));
        assert!(is_sql_like("SELECT id FROM users"));
        assert!(!is_sql_like("please select one"));
        assert!((normalized_levenshtein("kitten", "kitten") - 1.0).abs() < 1e-6);
        assert!(normalized_levenshtein("kitten", "sitting") < 1.0);
        assert_eq!(comma_values(" a, ,b ,"), vec!["a", "b"]);
    }
}
