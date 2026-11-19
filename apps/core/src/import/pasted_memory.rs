//! Parse memories pasted from another AI assistant.
//!
//! Most assistants do not export saved memory, but they will write it out when
//! asked. The desktop hands the user a prompt that requests a fenced block of
//! category sections (`Instructions`, `Identity`, `Career`, `Projects`,
//! `Preferences`) with one `[YYYY-MM-DD] - entry` line per memory. This parser
//! reads that shape and degrades to bullets and paragraphs when a model
//! ignores it.

use ryu_memory::MemoryCategory;

/// Largest pasted text Core accepts, in bytes.
pub const MAX_PASTED_MEMORY_BYTES: usize = 256 * 1024;
/// Most entries one paste can add.
pub const MAX_PASTED_MEMORIES: usize = 500;
const MAX_ENTRY_CHARS: usize = 4000;

/// One memory read from pasted text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PastedMemory {
    pub content: String,
    pub category: MemoryCategory,
    pub importance: i32,
}

/// Read the memories in `text`. Only fenced blocks are read when the text has
/// any, so the assistant's own remarks around the block are left out.
pub fn parse_pasted_memories(text: &str) -> Vec<PastedMemory> {
    let mut parser = Parser::default();
    for line in fenced_lines(text) {
        parser.line(line);
    }
    parser.flush();
    parser.entries.truncate(MAX_PASTED_MEMORIES);
    parser.entries
}

fn fenced_lines(text: &str) -> Vec<&str> {
    if !text
        .lines()
        .any(|line| line.trim_start().starts_with("```"))
    {
        return text.lines().collect();
    }
    let mut inside = false;
    let mut lines = Vec::new();
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            inside = !inside;
        } else if inside {
            lines.push(line);
        }
    }
    lines
}

struct Parser {
    category: MemoryCategory,
    current: String,
    date: Option<String>,
    entries: Vec<PastedMemory>,
}

impl Default for Parser {
    fn default() -> Self {
        Self {
            category: MemoryCategory::UserFact,
            current: String::new(),
            date: None,
            entries: Vec::new(),
        }
    }
}

impl Parser {
    fn line(&mut self, line: &str) {
        let trimmed = line.trim();
        if trimmed.is_empty() || is_rule(trimmed) {
            self.flush();
            return;
        }
        if let Some(category) = section_category(trimmed) {
            self.flush();
            self.category = category;
            return;
        }
        if trimmed.starts_with('#') {
            self.flush();
            self.category = MemoryCategory::UserFact;
            return;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        // An indented sub-bullet continues the entry above it.
        let (bulleted, rest) = match strip_bullet(trimmed) {
            Some(rest) => (!indented || self.current.is_empty(), rest),
            None => (false, trimmed),
        };
        let (date, rest) = match strip_date(rest) {
            Some((date, rest)) => (Some(date), rest),
            None => (None, rest),
        };
        if is_placeholder(rest.trim()) {
            self.flush();
            return;
        }
        if bulleted || date.is_some() {
            self.flush();
            self.date = date.flatten();
        } else if !self.current.is_empty() {
            self.current.push(' ');
        }
        self.current.push_str(rest.trim());
    }

    fn flush(&mut self) {
        let text = std::mem::take(&mut self.current);
        let date = self.date.take();
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        // Rules and tastes stay verbatim; facts that change over time keep the
        // date they were true on.
        let content = match (&date, self.category) {
            (Some(date), MemoryCategory::UserFact | MemoryCategory::ProjectContext) => {
                format!("As of {date}: {text}")
            }
            _ => text.to_owned(),
        };
        let importance = match self.category {
            MemoryCategory::Directive | MemoryCategory::Preference => 4,
            _ => ryu_memory::DEFAULT_IMPORTANCE,
        };
        self.entries.push(PastedMemory {
            content: content.chars().take(MAX_ENTRY_CHARS).collect(),
            category: self.category,
            importance,
        });
    }
}

/// The category a section heading names: `## Instructions`, `**Career**`,
/// `1. **Projects**:` or `Preferences:`.
fn section_category(line: &str) -> Option<MemoryCategory> {
    let heading = line.starts_with('#');
    let mut name = line.trim_start_matches('#').trim();
    if let Some(rest) = strip_bullet(name) {
        name = rest;
    }
    let bold = name.starts_with("**");
    let name = name
        .trim_end_matches(':')
        .trim_matches('*')
        .trim_end_matches(':');
    if !(heading || bold || line.ends_with(':')) || name.len() > 40 {
        return None;
    }
    // "Projects (current)" names the same section as "Projects".
    let name = name.split('(').next().unwrap_or(name).trim();
    let category = match name.to_ascii_lowercase().as_str() {
        "instructions" | "instruction" | "rules" => MemoryCategory::Directive,
        "identity" | "about me" | "career" | "work" => MemoryCategory::UserFact,
        "projects" | "project" => MemoryCategory::ProjectContext,
        "preferences" | "preference" => MemoryCategory::Preference,
        _ => return None,
    };
    Some(category)
}

fn strip_bullet(line: &str) -> Option<&str> {
    for marker in ["- ", "* ", "+ ", "• "] {
        if let Some(rest) = line.strip_prefix(marker) {
            return Some(rest);
        }
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    line[digits..]
        .strip_prefix(". ")
        .or_else(|| line[digits..].strip_prefix(") "))
}

/// `[2024-05-01] - text` or `[unknown] - text`: the date (`None` when unknown)
/// and the text after the separator.
fn strip_date(line: &str) -> Option<(Option<String>, &str)> {
    let inner_end = line.strip_prefix('[')?.find(']')? + 1;
    let inner = line[1..inner_end].trim();
    let date = if inner.eq_ignore_ascii_case("unknown") {
        None
    } else if chrono::NaiveDate::parse_from_str(inner, "%Y-%m-%d").is_ok() {
        Some(inner.to_owned())
    } else {
        return None;
    };
    let rest = line[inner_end + 1..].trim_start();
    let rest = ["- ", "– ", "— ", ": "]
        .iter()
        .find_map(|sep| rest.strip_prefix(sep))
        .unwrap_or(rest);
    Some((date, rest))
}

fn is_rule(line: &str) -> bool {
    line.len() >= 3 && line.chars().all(|c| matches!(c, '-' | '*' | '_' | '='))
}

fn is_placeholder(text: &str) -> bool {
    let text = text
        .trim_matches(|c: char| c == '(' || c == ')' || c == '.' || c == '_' || c == '*')
        .to_ascii_lowercase();
    matches!(
        text.as_str(),
        "none" | "n/a" | "na" | "nothing" | "no entries" | "none recorded" | "none stored"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXPORT: &str = "Here is your export:\n\n```\n## Instructions\n[2024-03-02] - Always answer in British English.\n[unknown] - Never use emoji.\n\n## Identity\n[2023-11-20] - Name is Jia Wei, lives in Singapore.\n\n## Career\n[unknown] - Staff engineer at Acme.\n\n## Projects\n[2025-01-10] - Ryu: a local-first AI desktop app, in beta.\n  Chose Rust for the core.\n\n## Preferences\n[2024-06-01] - Prefers concise answers.\n- None\n```\n\nThis is the complete set.";

    fn parsed(text: &str) -> Vec<(String, MemoryCategory, i32)> {
        parse_pasted_memories(text)
            .into_iter()
            .map(|m| (m.content, m.category, m.importance))
            .collect()
    }

    #[test]
    fn reads_the_requested_export_shape() {
        assert_eq!(
            parsed(EXPORT),
            vec![
                (
                    "Always answer in British English.".to_owned(),
                    MemoryCategory::Directive,
                    4
                ),
                ("Never use emoji.".to_owned(), MemoryCategory::Directive, 4),
                (
                    "As of 2023-11-20: Name is Jia Wei, lives in Singapore.".to_owned(),
                    MemoryCategory::UserFact,
                    3
                ),
                ("Staff engineer at Acme.".to_owned(), MemoryCategory::UserFact, 3),
                (
                    "As of 2025-01-10: Ryu: a local-first AI desktop app, in beta. Chose Rust for the core."
                        .to_owned(),
                    MemoryCategory::ProjectContext,
                    3
                ),
                ("Prefers concise answers.".to_owned(), MemoryCategory::Preference, 4),
            ]
        );
    }

    #[test]
    fn accepts_bold_and_colon_headings_and_bullets() {
        let text = "1. **Instructions**:\n- Use metric units.\n\n**Preferences**\n* Likes dark mode\n  - especially at night\n\nPreferences of note:\nnot a heading line";
        assert_eq!(
            parsed(text),
            vec![
                ("Use metric units.".to_owned(), MemoryCategory::Directive, 4),
                (
                    "Likes dark mode especially at night".to_owned(),
                    MemoryCategory::Preference,
                    4
                ),
                (
                    "Preferences of note: not a heading line".to_owned(),
                    MemoryCategory::Preference,
                    4
                ),
            ]
        );
    }

    #[test]
    fn falls_back_to_paragraphs_without_sections() {
        let text = "Lives in Berlin.\n\nHas two cats\nnamed Mo and Jo.";
        assert_eq!(
            parsed(text),
            vec![
                ("Lives in Berlin.".to_owned(), MemoryCategory::UserFact, 3),
                (
                    "Has two cats named Mo and Jo.".to_owned(),
                    MemoryCategory::UserFact,
                    3
                ),
            ]
        );
    }

    #[test]
    fn unknown_headings_reset_to_facts_and_bad_dates_stay_text() {
        let text = "## Preferences\n- Tea over coffee\n## Misc\n[soon] - kept as written";
        assert_eq!(
            parsed(text),
            vec![
                ("Tea over coffee".to_owned(), MemoryCategory::Preference, 4),
                (
                    "[soon] - kept as written".to_owned(),
                    MemoryCategory::UserFact,
                    3
                ),
            ]
        );
    }

    #[test]
    fn caps_entry_length_and_count() {
        let long = "x".repeat(MAX_ENTRY_CHARS + 50);
        assert_eq!(parsed(&long)[0].0.chars().count(), MAX_ENTRY_CHARS);
        let many: String = (0..MAX_PASTED_MEMORIES + 5)
            .map(|i| format!("- fact {i}\n"))
            .collect();
        assert_eq!(parse_pasted_memories(&many).len(), MAX_PASTED_MEMORIES);
    }

    #[test]
    fn empty_or_placeholder_text_yields_nothing() {
        assert!(parse_pasted_memories("```\n## Career\n(none)\nN/A\n```").is_empty());
        assert!(parse_pasted_memories("   ").is_empty());
    }
}
