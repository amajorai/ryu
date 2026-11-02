//! The wire shape of one context-breakdown row, and the structured detail
//! (`detailKey` + `counts`) the desktop localizes instead of Core's English.

use serde::Serialize;

/// One category of the context window. `kind` is a STABLE id the desktop maps
/// to a palette colour and an icon — renaming one changes the UI, so treat it
/// as API.
///
/// `label` and `detail` are English fallbacks. The desktop renders its own
/// localized copy from `labelKey`, `detailKey` and `counts` (see
/// [`SegmentDetail`]), and falls back to the English text only for a key it
/// does not know — so a newer Core never shows an empty row.
#[derive(Debug, Clone, Serialize)]
pub struct ContextSegment {
    /// The numbers behind `detail` ("24 tools across 5 servers" →
    /// `{tools: 24, servers: 5}`), so the client can pluralize them itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub counts: Option<SegmentCounts>,
    /// English sub-label ("24 tools across 5 servers"), shown under the row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Stable id of the `detail` sentence: `messages` | `images` | `tools` |
    /// `skills` | `replayed_turns`.
    #[serde(rename = "detailKey", skip_serializing_if = "Option::is_none")]
    pub detail_key: Option<&'static str>,
    /// Stable category id: `system` | `instructions` | `skills` | `memory` |
    /// `recall` | `persona` | `compact` | `tools` | `messages` | `documents` |
    /// `images` | `output`.
    pub kind: &'static str,
    /// English row label.
    pub label: String,
    /// Stable id of `label` (see [`label_key`]), absent for a label Core has
    /// not assigned one.
    #[serde(rename = "labelKey", skip_serializing_if = "Option::is_none")]
    pub label_key: Option<&'static str>,
    /// Estimated tokens this category occupies.
    pub tokens: usize,
}

/// Structured numbers behind a segment's `detail`. Only the fields the detail
/// uses are set.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct SegmentCounts {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub servers: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skills: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<usize>,
}

/// What a segment's sub-label says. Sent as data (`detailKey` + `counts`) so
/// the desktop can render and pluralize it in the reader's language; the
/// English text is kept only as a fallback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentDetail {
    /// Images attached across the counted messages.
    Images(usize),
    /// Messages in the charged history.
    Messages(usize),
    /// ACP short-term replay of earlier turns.
    ReplayedTurns,
    /// Skills enabled in the injected skills block.
    Skills(usize),
    /// Tool definitions offered, and the distinct servers they came from.
    Tools { servers: usize, tools: usize },
}

impl SegmentDetail {
    pub(super) fn key(self) -> &'static str {
        match self {
            Self::Images(_) => "images",
            Self::Messages(_) => "messages",
            Self::ReplayedTurns => "replayed_turns",
            Self::Skills(_) => "skills",
            Self::Tools { .. } => "tools",
        }
    }

    pub(super) fn counts(self) -> Option<SegmentCounts> {
        let counts = match self {
            Self::Images(n) => SegmentCounts {
                images: Some(n),
                ..SegmentCounts::default()
            },
            Self::Messages(n) => SegmentCounts {
                messages: Some(n),
                ..SegmentCounts::default()
            },
            Self::ReplayedTurns => return None,
            Self::Skills(n) => SegmentCounts {
                skills: Some(n),
                ..SegmentCounts::default()
            },
            Self::Tools { servers, tools } => SegmentCounts {
                servers: Some(servers),
                tools: Some(tools),
                ..SegmentCounts::default()
            },
        };
        Some(counts)
    }

    /// English fallback text for clients that predate the structured fields.
    pub(super) fn english(self) -> String {
        match self {
            Self::Images(n) => plural(n, "image", "images"),
            Self::Messages(n) => plural(n, "message", "messages"),
            Self::ReplayedTurns => "replayed turns".to_owned(),
            Self::Skills(n) => format!("{n} enabled"),
            Self::Tools { servers, tools } => format!(
                "{} across {}",
                plural(tools, "tool", "tools"),
                plural(servers, "server", "servers")
            ),
        }
    }
}

/// Stable id for a known English segment label. The desktop maps these to its
/// own translated copy; a label missing here still renders, in English.
pub fn label_key(label: &str) -> Option<&'static str> {
    Some(match label {
        "Agent instructions" => "agent_instructions",
        "Attached documents" => "attached_documents",
        "Auto-recall" => "auto_recall",
        "Brief replies" => "brief_replies",
        "Compacted summary" => "compacted_summary",
        "Conversation history" => "conversation_history",
        "Generative UI screen" => "generative_ui_screen",
        "Goals" => "goals",
        "Handoff summary" => "handoff_summary",
        "Images" => "images",
        "Long-term memory" => "long_term_memory",
        "Memory" => "memory",
        "Organization-managed instructions" => "organization_managed_instructions",
        "Output style" => "output_style",
        "Persona" => "persona",
        "Project instructions" => "project_instructions",
        "Referenced chats" => "referenced_chats",
        "Ryu docs" => "ryu_docs",
        "Ryu everyday setup guide" => "ryu_everyday_setup_guide",
        "Skills" => "skills",
        "Tool definitions" => "tool_definitions",
        "Working memory" => "working_memory",
        _ => return None,
    })
}

fn plural(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}
