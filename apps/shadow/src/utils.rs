/// Strip markdown fences and extract the first complete JSON object from `text`.
pub(crate) fn extract_json(text: &str) -> Option<String> {
    let stripped = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let start = stripped.find('{')?;
    let end = stripped.rfind('}')?;
    if end >= start {
        Some(stripped[start..=end].to_string())
    } else {
        None
    }
}

pub(crate) fn wall_micros() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as u64
}
