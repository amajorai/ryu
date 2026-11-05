//! Taking in provider SSE lines: parsing, envelope bookkeeping and the
//! concatenated scan text a frame contributes.

use std::borrow::Cow;
use std::collections::{BTreeMap, VecDeque};

use serde_json::Value;

use super::{
    envelope, lanes, reach, DlpOutput, HeldFrame, StreamingDlp, MAX_HELD_BYTES, OVERSIZED,
};
use crate::config::FirewallPolicy;
use crate::firewall::FirewallBackend;

impl StreamingDlp {
    pub(in crate::pipeline) fn new(policy: FirewallPolicy, enforce: bool) -> Self {
        Self {
            policy,
            enforce,
            line: Vec::new(),
            held: VecDeque::new(),
            held_wire_bytes: 0,
            frame_violation: None,
            buffer_remaining: false,
            text: String::new(),
            base: 0,
            released_end: 0,
            scan_from: 0,
            scanned_to: 0,
            saw_done: false,
            refusals: Vec::new(),
            refusal_bytes: 0,
            released_any: false,
            violation: None,
            sanitize: false,
            finished: false,
            envelope: envelope::EnvelopeLanes::default(),
            recent: VecDeque::new(),
            carried: None,
            carried_raw: None,
            last_space: 0,
            cut_memo: None,
            long_token: None,
            text_key: None,
            keep_alive: false,
            run: reach::Run::default(),
            fields: lanes::Fields::default(),
            released_fixed: BTreeMap::new(),
            released_runs: super::super::EnvelopeRuns::default(),
            released_half: false,
            envelope_memo: super::redact::EnvelopeMemo::default(),
            memo: super::records::StepMemo::default(),
        }
    }

    /// Feed provider bytes. Complete lines are parsed; frames are released once
    /// safe. An `Err` means the stream cannot be scanned and must be refused.
    pub(in crate::pipeline) fn push(
        &mut self,
        chunk: &[u8],
        scanner: &dyn FirewallBackend,
    ) -> Result<DlpOutput, String> {
        if self.finished {
            return Ok(DlpOutput::default());
        }
        let mut start = 0;
        while let Some(offset) = chunk[start..].iter().position(|byte| *byte == b'\n') {
            let index = start + offset;
            if self.line.is_empty() {
                // No earlier partial line: the line is a slice of the chunk.
                self.take_line(&chunk[start..index], scanner)?;
            } else {
                self.line.extend_from_slice(&chunk[start..index]);
                let mut line = std::mem::take(&mut self.line);
                let taken = self.take_line(&line, scanner);
                // Empty again either way, keeping the buffer's capacity.
                line.clear();
                self.line = line;
                taken?;
            }
            start = index + 1;
        }
        self.line.extend_from_slice(&chunk[start..]);
        // Other choices' text (`ChoiceTexts`) is held too.
        let text_bytes = self.text.len() + self.fields.choices.bytes();
        if self.held_wire_bytes.max(text_bytes) + self.refusal_bytes + self.line.len()
            > MAX_HELD_BYTES
        {
            return Err(OVERSIZED.to_owned());
        }
        let mut output = self.advance(false, scanner);
        if std::mem::take(&mut self.keep_alive) && output.bytes.is_empty() && !output.blocked {
            output.bytes.push_str(": keep-alive\n\n");
        }
        Ok(output)
    }

    /// End of the provider stream: release everything that is safe and close
    /// with `[DONE]` exactly as the buffered path does.
    pub(in crate::pipeline) fn finish(
        &mut self,
        scanner: &dyn FirewallBackend,
    ) -> Result<DlpOutput, String> {
        if self.finished {
            return Ok(DlpOutput::default());
        }
        let line = std::mem::take(&mut self.line);
        if !line.is_empty() {
            self.take_line(&line, scanner)?;
        }
        let mut output = self.advance(true, scanner);
        let done = self.saw_done || self.released_any;
        if !output.blocked {
            let refusals = std::mem::take(&mut self.refusals);
            output.bytes.push_str(&super::super::refusal_trailer(
                refusals,
                scanner,
                self.sanitize,
            ));
        }
        if !output.blocked && done {
            output.bytes.push_str("data: [DONE]\n\n");
        }
        self.finished = true;
        Ok(output)
    }

    /// One line, with the same rules as `rewrite_sse_for_dlp` (which splits with
    /// `str::lines`, so a trailing `\r` is dropped).
    pub(super) fn take_line(
        &mut self,
        raw: &[u8],
        scanner: &dyn FirewallBackend,
    ) -> Result<(), String> {
        let raw = raw.strip_suffix(b"\r").unwrap_or(raw);
        let line = match std::str::from_utf8(raw) {
            Ok(text) => Cow::Borrowed(text),
            Err(_) => String::from_utf8_lossy(raw),
        };
        // Blank lines end events; `:` lines are SSE comments (OpenRouter sends
        // `: OPENROUTER PROCESSING` keep-alives) and carry no payload.
        if line.trim().is_empty() {
            return Ok(());
        }
        if line.starts_with(':') {
            // Forwarded as a fixed keep-alive (never the provider's text), so
            // a client waiting on a slow upstream still hears from us.
            self.keep_alive = true;
            return Ok(());
        }
        let Some(data) = line.strip_prefix("data:") else {
            return Err("provider stream contained an unscannable event frame".to_owned());
        };
        let data = data.trim();
        if data.is_empty() {
            return Ok(());
        }
        if data == "[DONE]" {
            self.saw_done = true;
            return Ok(());
        }
        let mut value = serde_json::from_str::<Value>(data)
            .map_err(|error| format!("provider stream frame is not valid JSON: {error}"))?;
        // The standing guard's own refusal frame is not model text: joined to
        // a held tail it could form a match and get the envelope masked. It
        // is judged on its own at the end (`refusal_trailer`).
        // The guard sends one and ends the stream, so only the first is set
        // apart, and its bytes count towards the held limit (`push`).
        if self.refusals.is_empty() && crate::standing::refusal_frame_error(&value).is_some() {
            self.refusal_bytes += raw.len();
            self.refusals.push(value);
            return Ok(());
        }
        super::envelope::normalize_padding(&mut value);
        // A delta that ends the reasoning and starts the answer (vLLM's
        // reasoning parsers) is two frames, reasoning then answer, on both
        // paths, so the answer keeps streaming.
        // Envelope lanes see the provider frame once, and the pair waits for
        // the next provider frame as one (`EnvelopeLanes::take_fresh`).
        self.buffer_remaining |= self.envelope.observe(&value);
        let fresh = self.envelope.take_fresh();
        // Only the newest provider frame waits; both halves of a split one
        // wait together.
        // Fresh frames are always the tail of `held`.
        for frame in self.held.iter_mut().rev() {
            if !frame.fresh {
                break;
            }
            frame.fresh = false;
        }
        // A frame is split only when it carries no token mirrors, and its
        // halves only lose keys, so neither half carries any.
        let mirrors = super::super::has_token_mirrors(&value);
        match super::super::split_boundary_with(&value, Some(mirrors)) {
            Some([reasoning, answer]) => {
                let half = raw.len() / 2;
                self.take_value(reasoning, half, fresh, true, false, scanner);
                self.take_value(answer, raw.len() - half, fresh, false, false, scanner);
            }
            None => self.take_value(value, raw.len(), fresh, false, mirrors, scanner),
        }
        Ok(())
    }

    /// One parsed frame of `wire_bytes` provider bytes; `mirrors` is
    /// `has_token_mirrors(&value)`.
    fn take_value(
        &mut self,
        value: Value,
        wire_bytes: usize,
        fresh: bool,
        reasoning_half: bool,
        mirrors: bool,
        scanner: &dyn FirewallBackend,
    ) {
        self.buffer_remaining |= !super::super::simple_content_delta(&value);
        // vLLM's token ids run ahead of the text it holds back for a stop
        // string, so they may encode a value not judged yet: hold the rest
        // and judge every frame's mirrors at the end (`release`). Token ids
        // are themselves token mirrors.
        self.buffer_remaining |= mirrors && super::super::token_ids_ahead(&value);
        // `scan_outbound` is a no-op unless outbound scanning is on; skip
        // building the projection for it. The projection is built in a
        // buffer reused across frames.
        if self.violation.is_none() && self.frame_violation.is_none() && scanner.outbound_enabled()
        {
            let mut projection = std::mem::take(&mut self.memo.projection);
            projection.clear();
            super::super::json_string_projection_into(&value, &mut projection);
            debug_assert_eq!(projection, super::super::json_string_projection(&value));
            self.frame_violation = scanner.scan_outbound(&projection);
            if projection.capacity() <= 64 * 1024 {
                self.memo.projection = projection;
            }
        }
        // A change of text lane (reasoning to answer, the answer to a tool
        // call's arguments, one call to another: `TextLane`) is a hard text
        // boundary, as the two are separate strings in a non-streamed
        // response: `FIELD_SEPARATOR` keeps every pattern from running across
        // it, and is dropped again, by position, when the text is mapped back.
        // `self.text` is choice 0's (the primary lane's) text alone: each other
        // choice is its own lane (`ChoiceTexts`), judged at the end.
        // A delta with reasoning and answer text starts in the one and ends
        // in the other (`primary_text_keys`), with its own separator between
        // them: such a frame is never simple, so it is held to the final step
        // and only its scan text (built alike everywhere) reads the inner one.
        let keys = super::super::primary_text_keys(&value);
        let lanes = super::super::primary_text_lanes(&value);
        let separated =
            lanes.is_some_and(|(start, _)| self.text_key.is_some_and(|lane| lane != start));
        // The field the frame's text ends in.
        let key = keys.map(|(_, end)| end);
        debug_assert!(lanes.is_none_or(|(start, end)| start == end) || self.buffer_remaining);
        if let Some((_, end)) = lanes {
            self.text_key = Some(end);
        }
        let appended = self.text.len();
        if separated {
            self.text.push_str(super::super::FIELD_SEPARATOR);
        }
        self.fields.choices.push_frame(&value, &mut self.text);
        // Another choice's frame is never simple, so it holds the stream
        // whole: none of its text goes out before the final step.
        debug_assert!(self.fields.choices.is_empty() || self.buffer_remaining);
        // A field returning after another: hold the rest and check the field
        // as one lane at the end (see `lanes::Fields`). The frame's scan text
        // is what was just appended, after the separator (choice 0's only).
        let scan_len = self.text.len()
            - appended
            - if separated {
                super::super::FIELD_SEPARATOR.len()
            } else {
                0
            };
        // The frame's text fields, read once for both observers.
        let text_fields = super::lanes::text_fields(&value);
        self.buffer_remaining |= self
            .fields
            .observe(&value, &text_fields, separated, scan_len);
        // A copy of the text elsewhere in the frame that stops copying it
        // exactly: hold the rest and judge the copy as its own lane.
        if super::lanes::first_choice(&value) {
            self.buffer_remaining |= self.fields.mirrors.observe(&value, &text_fields, key);
        }
        // The last release boundary: after ASCII whitespace, or after a CJK
        // character (`reach::is_script_boundary`).
        let boundary = self.text[appended..]
            .char_indices()
            .rev()
            .find(|(_, character)| {
                character.is_ascii_whitespace() || super::reach::is_script_boundary(*character)
            })
            .map(|(index, character)| appended + index + character.len_utf8());
        // Whether anything the scan sees follows the boundary yet (a run of
        // zero-width characters is skipped without rescanning it).
        let after = &self.text[boundary.unwrap_or(appended)..];
        let visible = after
            .chars()
            .any(|character| !super::digits::is_ignorable(character));
        self.run.visible_after_space =
            visible || (boundary.is_none() && self.run.visible_after_space);
        if let Some(boundary) = boundary {
            self.last_space = self.base + boundary;
        }
        self.track_run(appended);
        let end = self.len();
        self.held_wire_bytes += wire_bytes;
        self.held.push_back(HeldFrame {
            value,
            end,
            wire_bytes,
            fresh,
            separated,
            key,
            reasoning_half,
            mirrors,
        });
    }
}
