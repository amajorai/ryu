//! Every id the Gateway can build passes Core's rule, decodes back to its
//! input, and is never shared by two different inputs.

use std::collections::HashMap;

use serde_json::Value;

use super::*;

/// The cases Core's handler test and the cloud-bot's twin also read.
const CASES: &str =
    include_str!("../../../../contracts/fixtures/channel-conversation-id-cases-v1.json");

type Input = (Option<String>, String);

fn cases() -> Value {
    serde_json::from_str(CASES).expect("the shared cases parse")
}

/// Undo `E`. `None` when `part` is not something `E` writes.
fn unescape(part: &str) -> Option<String> {
    let bytes = part.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'_' {
            let hex = part.get(index + 1..index + 3)?;
            if !hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'A'..=b'F')) {
                return None;
            }
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Read a reversible id back into its input. `None` for a hashed id.
fn decode(id: &str) -> Option<Input> {
    match id.strip_prefix(STORE_PREFIX) {
        Some(rest) => {
            // `E` never writes `__`, so the first one is the separator.
            let (bot, target) = rest.split_once(SEPARATOR)?;
            Some((Some(unescape(bot)?), unescape(target)?))
        }
        None => Some((None, unescape(id)?)),
    }
}

fn is_hashed(id: &str) -> bool {
    id.rsplit_once(HASH_MARK).is_some_and(|(_, digest)| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// Check one input against every promise the mapping makes and record its id.
fn check(seen: &mut HashMap<String, Input>, channel_id: Option<&str>, target: &str) {
    let input: Input = (channel_id.map(str::to_owned), target.to_owned());
    let id = core_conversation_id(channel_id, target);
    assert!(
        is_core_conversation_id(&id),
        "Core would refuse {id:?}, built from {input:?}"
    );
    match decode(&id) {
        Some(decoded) => assert_eq!(decoded, input, "{id:?} decodes to another input"),
        None => assert!(is_hashed(&id), "{id:?} is neither reversible nor hashed"),
    }
    if let Some(other) = seen.insert(id.clone(), input.clone()) {
        assert_eq!(other, input, "{id:?} is shared by two inputs");
    }
}

/// A fixed pseudo-random sequence, so a failure reproduces.
struct Sequence(u64);

impl Sequence {
    fn pick(&mut self, below: usize) -> usize {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((self.0 >> 33) as usize) % below
    }

    fn text(&mut self, max_parts: usize) -> String {
        const PARTS: &[&str] = &[
            "a", "Z", "0", "9", "3A", "5F", "h", ".", "-", "_", "__", "_h", ":", "+", ";", " ",
            "@", "/", "%", "\n", "\0", "é", "日", "😀", "channel", "target",
        ];
        let count = self.pick(max_parts + 1);
        (0..count).map(|_| PARTS[self.pick(PARTS.len())]).collect()
    }
}

#[test]
fn the_shared_cases_give_the_expected_ids() {
    let cases = cases();
    assert_eq!(cases["version"], 1);
    let ids = cases["ids"].as_array().unwrap();
    assert!(ids.len() > 20, "the shared cases went missing");
    for case in ids {
        let name = case["name"].as_str().unwrap();
        let expected = case["expected"].as_str().unwrap();
        assert_eq!(
            core_conversation_id(
                case["channel_id"].as_str(),
                case["target"].as_str().unwrap()
            ),
            expected,
            "{name}"
        );
        assert!(is_core_conversation_id(expected), "{name}");
    }
}

#[test]
fn the_mirrored_rule_matches_the_shared_cases() {
    let cases = cases();
    for case in cases["rule"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        assert_eq!(
            is_core_conversation_id(id),
            case["valid"].as_bool().unwrap(),
            "{id:?}"
        );
    }
}

#[test]
fn every_id_the_gateway_can_build_passes_cores_rule() {
    let long_ascii = "9".repeat(4_000);
    let long_unicode = "日本語".repeat(300);
    let targets = [
        "",
        "123456789",
        "-1001234567890",
        "-1001234567890:42",
        "C0123ABCD:1700000000.000100",
        "111222333444555666:777888999000111222",
        "+15551234567",
        "iMessage;-;+15551234567",
        "iMessage;+;chat123456789012345678",
        "15551234567@c.us",
        "120363012345678901@g.us",
        "a b",
        "a_b",
        "a__b",
        "a_3Ab",
        "a:b",
        "caf\u{e9}",
        "日本",
        "😀",
        "tab\there",
        "line\nbreak",
        "nul\0byte",
        "$(whoami)",
        "x;whoami",
        "../../etc/passwd",
        "channel:bot-a:123",
        "channel__bot-a__123",
        "target_h0000",
        long_ascii.as_str(),
        long_unicode.as_str(),
    ];
    let long_bot = "b".repeat(300);
    let bots = [
        None,
        Some(""),
        Some("bot-a"),
        Some("65f0c1d2e3a4b5c6d7e8f901"),
        Some("team:bot_1"),
        Some("bot a"),
        Some("b\u{f6}t"),
        Some("h"),
        Some(long_bot.as_str()),
    ];
    let mut seen = HashMap::new();
    for bot in bots {
        for target in targets {
            check(&mut seen, bot, target);
            // The same chat with a thread packed on, as `pack_thread` does.
            check(
                &mut seen,
                bot,
                &crate::pack_thread(target, Some("1700000000.000100")),
            );
        }
    }
    assert_eq!(seen.len(), bots.len() * targets.len() * 2);

    let mut sequence = Sequence(0x5eed);
    for _ in 0..20_000 {
        let bot = match sequence.pick(3) {
            0 => None,
            _ => Some(sequence.text(4)),
        };
        // Mostly short, so near-identical inputs meet; sometimes long enough to hash.
        let max_parts = if sequence.pick(8) == 0 { 90 } else { 5 };
        let target = sequence.text(max_parts);
        check(&mut seen, bot.as_deref(), &target);
    }
}

#[test]
fn inputs_that_look_alike_never_share_an_id() {
    let digest = "0".repeat(64);
    let hashed_look_alike = format!("target_h{digest}");
    let long_a = format!("{}a", "x".repeat(200));
    let long_b = format!("{}b", "x".repeat(200));
    let inputs: [(Option<&str>, &str); 16] = [
        // The separator moved by one escape.
        (Some("a"), "3Ab:"),
        (Some("a:b"), "3A"),
        // A raw target that spells the escaped form of another.
        (None, "a:b"),
        (None, "a_3Ab"),
        // A raw target that spells a store-backed id.
        (Some("bot-a"), "123"),
        (None, "channel__bot-a__123"),
        (None, "channel:bot-a:123"),
        // The same text on a bot with and without a store id.
        (None, "123"),
        (Some(""), "123"),
        // Long targets that differ in their last byte only.
        (None, long_a.as_str()),
        (None, long_b.as_str()),
        (Some("bot-a"), long_a.as_str()),
        (Some("bot-b"), long_a.as_str()),
        // A raw target that spells a hashed id, and the empty target.
        (None, hashed_look_alike.as_str()),
        (None, ""),
        (Some("bot-a"), ""),
    ];
    let mut seen = HashMap::new();
    for (bot, target) in inputs {
        check(&mut seen, bot, target);
    }
    assert_eq!(seen.len(), inputs.len());
}

#[test]
fn a_plain_target_without_a_store_id_keeps_its_id() {
    // These ids reach Core unchanged today, so their stored history continues.
    for target in ["123456789", "-1001234567890", "C0123ABCD", "17.5", "a-b.c"] {
        assert_eq!(core_conversation_id(None, target), target);
    }
}

#[test]
fn a_long_id_ends_in_a_hash_and_keeps_the_bot_while_it_fits() {
    let target = "t".repeat(500);
    let digest_len = 64;

    let plain = core_conversation_id(None, &target);
    assert!(plain.starts_with("target_h") && plain.len() == 8 + digest_len);

    let store = core_conversation_id(Some("bot-a"), &target);
    assert!(store.starts_with("channel__bot-a_h"), "{store}");
    assert_eq!(store.len(), 16 + digest_len);

    let widest = "c".repeat(53);
    let kept = core_conversation_id(Some(widest.as_str()), &target);
    assert!(kept.starts_with(&format!("channel__{widest}_h")), "{kept}");
    assert_eq!(kept.len(), MAX_CORE_CONVERSATION_ID_LEN);

    let too_wide = "c".repeat(54);
    let dropped = core_conversation_id(Some(too_wide.as_str()), &target);
    assert!(dropped.starts_with("channel_h") && dropped.len() == 9 + digest_len);

    // The longest reversible id is exactly 128 bytes; one more byte hashes.
    let edge = core_conversation_id(Some("bot-a"), &"t".repeat(112));
    assert_eq!(edge, format!("channel__bot-a__{}", "t".repeat(112)));
    assert!(is_hashed(&core_conversation_id(
        Some("bot-a"),
        &"t".repeat(113)
    )));
}
