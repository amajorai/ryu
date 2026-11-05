use super::*;

/// Private-use sentinels from each range the stream DLP draws from, edges
/// included.
const SENTINELS: [char; 7] = [
    '\u{E000}',
    '\u{E001}',
    '\u{F8FF}',
    '\u{F0000}',
    '\u{FFFFD}',
    '\u{100000}',
    '\u{10FFFD}',
];

/// Dense PII, secrets and keywords, in several cases and spacings.
const TOKENS: &[&str] = &[
    "user@example.com",
    "John.Doe+tag@mail.example.co.uk",
    "a@b.io",
    "(555) 123-4567",
    "+1 555-123-4567",
    "1-555-123-4567",
    "555.123.4567",
    "555 123 4567",
    "123-45-6789",
    "123 45 6789",
    "4111 1111 1111 1111",
    "4111-1111-1111-1111",
    "4111111111111111",
    "5500 0000 0000 0004",
    "1234567890123456789012",
    "8.8.8.8",
    "203.0.113.9",
    "192.168.1.1",
    "255.255.255.0",
    "999.1.1.1",
    "passport: AB1234567",
    "Passport No. X12345678",
    "PASSPORT#C1234567",
    "pAsSpOrT number 123456",
    "passport-number:zz123456",
    "GB29 NWBK 6016 1331 9268 19",
    "DE89370400440532013000",
    "gb29nwbk60161331926819",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "gho_abcdefghijklmnopqrstuvwx",
    "GHP_ABCDEFGHIJKLMNOPQRSTUVWX",
    "github_pat_11ABCDEFG0123456789_abcdefghij",
    "sk-abcdefghijklmnopqrstuvwxyz",
    "sk-proj-AbC_dEf-1234567890abcdef",
    "sk-ant-api03-abcdefghijklmnopqrstuv",
    "AKIAABCDEFGHIJKLMNOP",
    "akiaabcdefghijklmnop",
    "Bearer abcdefghijklmnopqrstuvwx==",
    "bearer  ABCDEFGHIJKLMNOP1234",
    "BEARER x",
    "token=abcdefgh1234",
    "TOKEN=abc",
    "api_key=ABCDEFGH12345678",
    "Api-Key=xyz12345678",
    "access_token=abc.def~ghi",
    "password=hunter22",
    "Passwd=s3cr3t!",
    "SECRET=topsecretvalue",
    "secret=ab",
];

/// What may sit between tokens: nothing, separators, word characters and
/// every sentinel.
const GLUE: &[&str] = &[
    "",
    "",
    " ",
    " ",
    "\n",
    "\t",
    "_",
    "-",
    ".",
    "@",
    "=",
    "a",
    "Z",
    "9",
    "0",
    "x1",
    "(",
    ")",
    ":",
    "#",
    "+",
    "/",
    "&",
    "\"",
    "'",
    "\u{E000}",
    "\u{F8FF}",
    "\u{F0000}",
    "\u{10FFFD}",
    "1\u{E001}",
    "\u{E002}z",
    " \u{FFFFD} ",
    "\u{100000}\u{100001}",
];

/// The alphabet random mixes draw from.
const ALPHABET: &str = "0123456789 abcdefghijkpsorstuvwxyzABCDEFGHIKPSZ_-.@+()=:#/&\n";

/// A small xorshift generator, so the corpus is the same on every run.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, bound: usize) -> usize {
        usize::try_from(self.next() % bound as u64).unwrap_or(0)
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

/// `token` with random case flips, a sentinel inserted inside it, or cut short.
fn mutate(rng: &mut Rng, token: &str) -> String {
    let mut chars: Vec<char> = token.chars().collect();
    match rng.below(6) {
        0 => {
            for c in &mut chars {
                if rng.below(3) == 0 {
                    *c = if c.is_ascii_uppercase() {
                        c.to_ascii_lowercase()
                    } else {
                        c.to_ascii_uppercase()
                    };
                }
            }
        }
        1 => {
            let at = rng.below(chars.len() + 1);
            chars.insert(at, *rng.pick(&SENTINELS));
        }
        2 => chars.truncate(rng.below(chars.len() + 1)),
        _ => {}
    }
    chars.into_iter().collect()
}

fn dense(rng: &mut Rng) -> String {
    let mut text = String::new();
    for _ in 0..=rng.below(12) {
        text.push_str(rng.pick(GLUE));
        let token = rng.pick(TOKENS);
        text.push_str(&mutate(rng, token));
    }
    text.push_str(rng.pick(GLUE));
    text
}

fn random_mix(rng: &mut Rng) -> String {
    let alphabet: Vec<char> = ALPHABET.chars().collect();
    (0..rng.below(96))
        .map(|_| {
            if rng.below(5) == 0 {
                *rng.pick(&SENTINELS)
            } else {
                *rng.pick(&alphabet)
            }
        })
        .collect()
}

/// Fixed edge cases followed by generated dense and random haystacks, all
/// made only of ASCII and private-use characters.
fn corpus() -> Vec<String> {
    let mut hays: Vec<String> = [
        "",
        "\u{E000}",
        "\u{E000}\u{F8FF}\u{10FFFD}",
        "\u{E000}123-45-6789\u{E001}",
        "4111\u{E000}1111 1111 1111",
        "sk-\u{E000}abcdefghijklmnopqrstuvwxyz",
        "\u{F8FF}sk-abcdefghijklmnopqrstuvwxyz\u{F8FF}",
        "x\u{E000}ghp_abcdefghijklmnopqrstuvwxyz0123456789\u{E000}9",
        "passport\u{E000}AB1234567",
        "\u{E000}passport AB1234567\u{E000}",
        "8.8.8.8\u{F0000}8",
    ]
    .iter()
    .map(|text| (*text).to_owned())
    .collect();
    for token in TOKENS {
        for sentinel in SENTINELS {
            hays.push(format!("{sentinel}{token}{sentinel}"));
            hays.push(format!("a{sentinel}{token}{sentinel}0"));
        }
    }
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for round in 0..4000 {
        hays.push(if round % 3 == 2 {
            random_mix(&mut rng)
        } else {
            dense(&mut rng)
        });
    }
    hays
}

fn spans(re: &Regex, text: &str) -> Vec<std::ops::Range<usize>> {
    re.find_iter(text).map(|found| found.range()).collect()
}

/// Each `(name, original, twin)` entry of every curated twinned set.
fn twinned() -> Vec<(String, Regex, Regex)> {
    let pii = build_pii_patterns_with_twins().into_iter();
    let outbound = build_outbound_patterns_with_twins()
        .into_iter()
        .map(|(marker, re, twin)| (marker.to_owned(), re, twin));
    pii.chain(outbound)
        .filter_map(|(name, re, twin)| Some((name, re, twin?)))
        .collect()
}

#[test]
fn twins_find_the_original_spans_on_gated_haystacks() {
    let patterns = twinned();
    assert_eq!(patterns.len(), 13, "every pattern but email has a twin");
    let hays = corpus();
    let mut matched = 0;
    for text in &hays {
        assert!(ascii_boundaries_agree(text), "{text:?} must pass the gate");
        for (name, original, twin) in &patterns {
            let expected = spans(original, text);
            assert_eq!(spans(twin, text), expected, "{name} on {text:?}");
            assert_eq!(twin.is_match(text), original.is_match(text), "{name}");
            matched += usize::from(!expected.is_empty());
        }
    }
    // The corpus exercises the patterns rather than missing them all.
    assert!(matched > hays.len(), "only {matched} matching cases");
}

#[test]
fn twins_exist_exactly_for_either_boundary_patterns() {
    let pii = build_pii_patterns_with_twins();
    let outbound = build_outbound_patterns_with_twins();
    assert_eq!(pii.len(), PII_PATTERNS.len());
    assert_eq!(outbound.len(), OUTBOUND_PATTERNS.len());
    let all = pii
        .iter()
        .map(|(name, re, twin)| (name.as_str(), re, twin))
        .chain(outbound.iter().map(|(name, re, twin)| (*name, re, twin)));
    for (name, original, twin) in all {
        let source = original.as_str();
        assert_eq!(twin.is_some(), source.contains(EITHER_BOUNDARY), "{name}");
        let Some(twin) = twin else { continue };
        assert_eq!(
            twin.as_str(),
            source.replace(EITHER_BOUNDARY, ASCII_BOUNDARY)
        );
        let rest = twin.as_str().replace(ASCII_BOUNDARY, "");
        assert!(!rest.contains(r"\b"), "{name} keeps a Unicode \\b: {rest}");
        assert!(!rest.contains(r"\B"), "{name} keeps a \\B: {rest}");
    }
}

#[test]
fn plain_builders_keep_the_original_patterns() {
    let pii = build_pii_patterns();
    let twinned = build_pii_patterns_with_twins();
    let names = |set: &[(String, Regex)]| -> Vec<String> {
        set.iter()
            .map(|(name, re)| format!("{name} {re}"))
            .collect()
    };
    let expected: Vec<(String, Regex)> = twinned.into_iter().map(|(n, re, _)| (n, re)).collect();
    assert_eq!(names(&pii), names(&expected));
    let outbound = build_outbound_patterns();
    for ((marker, re), (raw_marker, raw)) in outbound.iter().zip(OUTBOUND_PATTERNS) {
        assert_eq!((*marker, re.as_str()), (raw_marker, raw));
    }
    assert_eq!(outbound.len(), OUTBOUND_PATTERNS.len());
}

#[test]
fn gate_accepts_ascii_and_private_use_only() {
    assert!(ascii_boundaries_agree(""));
    assert!(ascii_boundaries_agree("plain ascii 123_x"));
    for sentinel in SENTINELS {
        assert!(
            ascii_boundaries_agree(&format!("a{sentinel}1")),
            "{sentinel:?}"
        );
    }
    for rejected in [
        '\u{E9}',    // é, a Unicode word character
        '\u{17F}',   // ſ, folds to s
        '\u{212A}',  // Kelvin sign, folds to k
        '\u{200B}',  // zero-width space
        '\u{A0}',    // non-breaking space
        '\u{663}',   // Arabic-Indic digit three
        '\u{5BC6}',  // CJK ideograph
        '\u{1F600}', // emoji
        '\u{F900}',
        '\u{FFFD}',
        '\u{EFFFF}',
        '\u{FFFFE}',
        '\u{10FFFE}',
    ] {
        assert!(
            !ascii_boundaries_agree(&format!("ok{rejected}")),
            "{rejected:?}"
        );
        assert!(!ascii_boundaries_agree(&format!("\u{E000}{rejected}")));
    }
}

/// Why the gate is needed: next to a non-ASCII word character the two
/// boundaries disagree, and the twin would miss what the original finds.
#[test]
fn twins_diverge_where_the_gate_rejects() {
    let (_, ssn, twin) = twinned()
        .into_iter()
        .find(|(name, _, _)| name == "ssn")
        .expect("ssn has a twin");
    let text = "123-45-678\u{663} ";
    assert!(!ascii_boundaries_agree(text));
    assert!(ssn.is_match(text));
    assert!(!twin.is_match(text));
}

/// The `ascii_boundaries_agree` body before its eight-byte skip.
fn agree_by_chars(text: &str) -> bool {
    text.is_ascii()
        || text.chars().all(|c| {
            c.is_ascii()
                || matches!(
                    u32::from(c),
                    0xE000..=0xF8FF | 0xF_0000..=0xF_FFFD | 0x10_0000..=0x10_FFFD
                )
        })
}

/// The word-at-a-time gate answers as the per-character one for every
/// boundary character at every offset of ASCII runs that straddle words.
#[test]
fn gate_skips_words_without_changing_its_answer() {
    let probes = [
        '\u{E000}',
        '\u{F8FF}',
        '\u{F900}',
        '\u{F0000}',
        '\u{FFFFD}',
        '\u{FFFFE}',
        '\u{10FFFD}',
        '\u{10FFFE}',
        'é',
        '中',
    ];
    let mut checked = 0;
    for run in 0..=24 {
        let ascii: String = (0..run)
            .map(|i| char::from(b'a' + (i % 26) as u8))
            .collect();
        assert_eq!(ascii_boundaries_agree(&ascii), agree_by_chars(&ascii));
        for offset in 0..=17.min(run) {
            for probe in probes {
                let mut text = ascii.clone();
                text.insert(offset, probe);
                assert_eq!(
                    ascii_boundaries_agree(&text),
                    agree_by_chars(&text),
                    "{text:?}"
                );
                for second in probes {
                    let mut pair = text.clone();
                    pair.push(second);
                    assert_eq!(ascii_boundaries_agree(&pair), agree_by_chars(&pair));
                }
                checked += 1;
            }
        }
    }
    assert!(checked > 1_000);
    for text in corpus() {
        assert_eq!(ascii_boundaries_agree(&text), agree_by_chars(&text));
    }
}
