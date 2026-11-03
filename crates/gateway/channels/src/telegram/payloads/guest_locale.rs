//! The Telegram app language of each pending guest query.
//!
//! A guest (inline-mode) answer goes back through `answerGuestQuery`, keyed on
//! the query id alone, so the send path no longer has the guest's
//! `from.language_code`. The inbound side records it here and the reply takes
//! it back out, so the answer card's title reads in the guest's language. The
//! map is bounded: a query that is never answered falls out after
//! [`CAPACITY`] newer ones.

use std::collections::VecDeque;
use std::sync::Mutex;

/// Pending guest queries remembered at once.
const CAPACITY: usize = 256;

static PENDING: Mutex<Pending> = Mutex::new(Pending(VecDeque::new()));

/// `(query id, language_code)`, oldest first.
struct Pending(VecDeque<(String, String)>);

impl Pending {
    fn remember(&mut self, query_id: &str, language_code: &str) {
        self.0.retain(|(id, _)| id != query_id);
        if self.0.len() == CAPACITY {
            self.0.pop_front();
        }
        self.0
            .push_back((query_id.to_owned(), language_code.to_owned()));
    }

    fn take(&mut self, query_id: &str) -> Option<String> {
        let index = self.0.iter().position(|(id, _)| id == query_id)?;
        self.0.remove(index).map(|(_, language)| language)
    }
}

/// Remember the language a guest query was sent in.
pub(in crate::telegram) fn remember(query_id: &str, language_code: &str) {
    if let Ok(mut pending) = PENDING.lock() {
        pending.remember(query_id, language_code);
    }
}

/// The language a guest query was sent in, forgotten once read.
pub(in crate::telegram) fn take(query_id: &str) -> Option<String> {
    PENDING.lock().ok()?.take(query_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_language_is_read_once() {
        let mut pending = Pending(VecDeque::new());
        pending.remember("q", "ja");
        pending.remember("q", "ko");
        assert_eq!(pending.take("q").as_deref(), Some("ko"));
        assert_eq!(pending.take("q"), None);
    }

    #[test]
    fn the_map_stays_bounded() {
        let mut pending = Pending(VecDeque::new());
        pending.remember("oldest", "de");
        for index in 0..CAPACITY {
            pending.remember(&format!("fill-{index}"), "fr");
        }
        assert_eq!(pending.0.len(), CAPACITY);
        assert_eq!(pending.take("oldest"), None);
        assert_eq!(pending.take("fill-0").as_deref(), Some("fr"));
    }
}
