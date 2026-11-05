use super::*;
use crate::config::{CustomPattern, CustomPatternKind, FirewallConfig, FirewallPolicy};

/// Sentinels from each private-use range the stream DLP uses.
const SENTINELS: [char; 6] = [
    '\u{E000}',
    '\u{F8FF}',
    '\u{F0000}',
    '\u{FFFFD}',
    '\u{100000}',
    '\u{10FFFD}',
];

const TOKENS: &[&str] = &[
    "user@example.com",
    "(555) 123-4567",
    "+1 555-123-4567",
    "555.123.4567",
    "123-45-6789",
    "123 45 6789",
    "4111 1111 1111 1111",
    "4111-1111-1111-1112",
    "8.8.8.8",
    "192.168.1.1",
    "Passport No. X12345678",
    "PASSPORT#C1234567",
    "GB29 NWBK 6016 1331 9268 19",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_11ABCDEFG0123456789_abcdefghij",
    "sk-abcdefghijklmnopqrstuvwxyz",
    "sk-ant-api03-abcdefghijklmnopqrstuv",
    "AKIAABCDEFGHIJKLMNOP",
    "Bearer abcdefghijklmnopqrstuvwx==",
    "token=abcdefgh1234",
    "api_key=ABCDEFGH12345678",
    "password=hunter22",
    "SECRET=topsecretvalue",
    "EMP-123456",
    "mongodb://admin:pw@db",
];

const GLUE: &[&str] = &[
    "",
    " ",
    "\n",
    "_",
    "-",
    ".",
    "=",
    "a",
    "Z",
    "9",
    ":",
    "\"",
    "\u{E000}",
    "\u{F8FF}",
    "1\u{E001}",
    "\u{E002}z",
    "\u{10FFFD}",
];

/// A small xorshift generator, so the corpus is the same on every run.
struct Rng(u64);

impl Rng {
    fn below(&mut self, bound: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        usize::try_from(self.0 % bound as u64).unwrap_or(0)
    }
}

/// Dense PII and keys with glue, sentinels inside tokens, and case flips.
fn haystack(rng: &mut Rng) -> String {
    let mut text = String::new();
    for _ in 0..=rng.below(10) {
        text.push_str(GLUE[rng.below(GLUE.len())]);
        let mut token: Vec<char> = TOKENS[rng.below(TOKENS.len())].chars().collect();
        match rng.below(4) {
            0 => token.insert(rng.below(token.len() + 1), SENTINELS[rng.below(6)]),
            1 => token.iter_mut().for_each(|c| {
                if rng.below(2) == 0 {
                    *c = c.to_ascii_uppercase();
                }
            }),
            2 => token.truncate(rng.below(token.len() + 1)),
            _ => {}
        }
        text.extend(token);
    }
    text
}

fn scanner() -> FirewallScanner {
    let custom = |name: &str, regex: &str, kind| CustomPattern {
        name: name.to_owned(),
        regex: regex.to_owned(),
        kind,
    };
    FirewallScanner::new_scoped(FirewallConfig {
        policy: FirewallPolicy::Sanitize,
        custom_patterns: vec![
            custom("employee_id", r"\bEMP-\d{6}\b", CustomPatternKind::Pii),
            custom("k\u{FC}rzel", r"\b[a-z]{3}\d\b", CustomPatternKind::Pii),
            custom("internal", r"INT_[A-Z0-9]{10}", CustomPatternKind::Secret),
        ],
        ..FirewallConfig::default()
    })
}

/// The same scanner with every twin removed, so every pattern runs as written.
fn without_twins() -> FirewallScanner {
    let mut scanner = scanner();
    scanner.pii_twins.fill(None);
    scanner.outbound_twins.fill(None);
    // The gated set holds the twins, so it goes with them.
    scanner.outbound_agree = None;
    scanner
}

#[test]
fn twins_cover_curated_patterns_and_never_custom_ones() {
    let scanner = scanner();
    assert_eq!(scanner.pii_twins.len(), scanner.pii_patterns.len());
    assert_eq!(
        scanner.outbound_twins.len(),
        scanner.outbound_patterns.len()
    );
    // The two custom PII patterns follow the curated set and keep no twin.
    let custom = scanner.pii_patterns.len() - 2;
    let curated = scanner
        .pii_patterns
        .iter()
        .zip(&scanner.pii_twins)
        .take(custom);
    for ((name, _), twin) in curated {
        assert_eq!(twin.is_some(), name != "email", "{name}");
    }
    assert_eq!(scanner.pii_patterns[custom].0, "employee_id");
    assert!(scanner.pii_twins[custom..].iter().all(Option::is_none));
    assert!(scanner.outbound_twins.iter().all(Option::is_some));
}

#[test]
fn sanitize_and_redact_outbound_match_with_twins_on_and_off() {
    let (on, off) = (scanner(), without_twins());
    let mut hays: Vec<String> = [
        "",
        "\u{E000}123-45-6789\u{E001} and \u{F8FF}sk-abcdefghijklmnopqrstuvwxyz\u{F8FF}",
        "x\u{E000}ghp_abcdefghijklmnopqrstuvwxyz0123456789\u{E000}9",
        // Not gated: these always run the originals.
        "caf\u{E9} 123-45-6789 \u{E000} john@example.com",
        "123-45-678\u{663} and \u{212A}AKIAABCDEFGHIJKLMNOP",
        "pa\u{17F}\u{17F}port AB1234567\u{200B}\u{A0}token=abcdefgh",
    ]
    .iter()
    .map(|text| (*text).to_owned())
    .collect();
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    hays.extend((0..1500).map(|_| haystack(&mut rng)));
    let mut changed = 0;
    for text in &hays {
        let sanitized = on.sanitize(text);
        assert_eq!(sanitized, off.sanitize(text), "sanitize on {text:?}");
        let redacted = on.redact_outbound(text);
        assert_eq!(redacted, off.redact_outbound(text), "redact on {text:?}");
        let both = on.sanitize(&redacted.0);
        assert_eq!(both, off.sanitize(&redacted.0), "both on {text:?}");
        changed += usize::from(sanitized != *text) + usize::from(redacted.0 != *text);
    }
    assert!(changed > hays.len(), "only {changed} rewrites");
}

#[test]
fn outbound_agree_members_are_the_gated_first_pass() {
    let scanner = scanner();
    let set = scanner.outbound_agree.expect("the curated set compiles");
    assert_eq!(set.len(), scanner.outbound_patterns.len());
    let gated = scanner
        .outbound_patterns
        .iter()
        .zip(&scanner.outbound_twins);
    for (member, ((_, original), twin)) in set.patterns().iter().zip(gated) {
        assert_eq!(member, pick(original, twin, true).as_str());
    }
}

#[test]
fn redact_outbound_matches_with_the_gated_set_on_and_off() {
    let on = scanner();
    let mut off = scanner();
    off.outbound_agree = None;
    let mut hays: Vec<String> = [
        "",
        "plain prose with no secrets at all",
        "ghp_abcdefghijklmnopqrstuvwxyz0123456789 and sk-abcdefghijklmnopqrstuvwxyz",
        "\u{E000}ghp_abcdefghijklmnopqrstuvwxyz0123456789\u{E001}",
        "sk-abc\u{E000}defghijklmnopqrstuvwxyz",
        "\u{F8FF}password=hunter22\u{F8FF} and token=abcdefgh1234",
        "x\u{E000}AKIAABCDEFGHIJKLMNOP9",
        "\u{5BC6}\u{94A5}sk-abcdefghijklmnopqrstuvwxyz",
        "\u{30AD}ghp_abcdefghijklmnopqrstuvwxyz0123456789\u{30AD}",
        "caf\u{E9} Bearer abcdefghijklmnopqrstuvwx==",
    ]
    .iter()
    .map(|text| (*text).to_owned())
    .collect();
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    hays.extend((0..1500).map(|_| haystack(&mut rng)));
    let mut hit = 0;
    for text in &hays {
        let redacted = on.redact_outbound(text);
        assert_eq!(redacted, off.redact_outbound(text), "redact on {text:?}");
        hit += usize::from(!redacted.1.is_empty());
    }
    assert!(hit > hays.len() / 4, "only {hit} hits");
}

#[test]
fn redact_outbound_ignores_every_config_gate() {
    let gated = scanner();
    let open = FirewallScanner::new_scoped(FirewallConfig {
        enabled: false,
        scan_outbound: false,
        redact_pii: false,
        redact_secrets: false,
        ..FirewallConfig::default()
    });
    let secrets = [
        "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "github_pat_11ABCDEFG0123456789_abcdefghij",
        "sk-proj-abcdefghijklmnopqrstuvwx",
        "AKIAABCDEFGHIJKLMNOP",
        "Bearer abcdefghijklmnopqrstuvwx==",
        "password=hunter22",
    ];
    let mut hays: Vec<String> = secrets.iter().map(|s| format!("x {s} y")).collect();
    hays.push("plain prose with no secrets at all".to_owned());
    hays.push("\u{5BC6}\u{94A5}sk-abcdefghijklmnopqrstuvwxyz".to_owned());
    hays.push("custom INT_ABCDEF1234 stays".to_owned());
    for text in &hays {
        assert_eq!(
            gated.redact_outbound(text),
            open.redact_outbound(text),
            "{text:?}"
        );
    }
    for (secret, text) in secrets.iter().zip(&hays) {
        let (redacted, hits) = open.redact_outbound(text);
        assert!(!redacted.contains(secret), "{redacted:?}");
        assert!(redacted.contains("[REDACTED:"), "{redacted:?}");
        assert_eq!(hits.len(), 1, "{text:?}");
    }
    let (cjk, _) = open.redact_outbound(&hays[7]);
    assert_eq!(cjk, "\u{5BC6}\u{94A5}[REDACTED:openai_key]");
    // Custom patterns never join the outbound scrub.
    let custom = "custom INT_ABCDEF1234 stays";
    assert_eq!(
        gated.redact_outbound(custom),
        (custom.to_owned(), Vec::new())
    );
    let both = format!("{} {}", secrets[0], secrets[1]);
    assert_eq!(gated.redact_outbound(&both).1, ["gh_pat", "gh_pat"]);
}
