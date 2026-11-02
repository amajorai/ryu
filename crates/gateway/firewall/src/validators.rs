//! Post-match precision validators for the separator-tolerant / range-based
//! PII candidates (credit cards, IPv4).

/// Luhn checksum validation for a digit string (credit-card mod-10). Reduces the
/// false-positive rate of the broadened (separator-tolerant) card candidate: an
/// arbitrary 13–19 digit run only trips the detector when it actually checksums.
fn luhn_valid(digits: &str) -> bool {
    let mut sum = 0u32;
    let mut alt = false;
    let mut count = 0u32;
    for ch in digits.chars().rev() {
        let Some(d) = ch.to_digit(10) else {
            return false;
        };
        count += 1;
        let mut d = d;
        if alt {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
        alt = !alt;
    }
    count >= 12 && sum % 10 == 0
}

/// True when a `credit_card` candidate match (which may carry ` `/`-` group
/// separators) is a plausible card: 13–19 digits, a major-industry prefix (3/4/5/6),
/// and a valid Luhn checksum. Non-ASCII decimal digits (Arabic-Indic,
/// Devanagari, fullwidth, mathematical, …) count as their ASCII value, because
/// the candidate regex's `\d` matches them and they render as the same number.
pub fn is_credit_card_number(matched: &str) -> bool {
    let digits: String = matched
        .chars()
        .filter_map(|c| {
            if c.is_ascii_digit() {
                Some(c)
            } else {
                crate::fold_digit(c)
            }
        })
        .collect();
    let len = digits.len();
    if !(13..=19).contains(&len) {
        return false;
    }
    let first = digits.as_bytes()[0];
    if !matches!(first, b'3' | b'4' | b'5' | b'6') {
        return false;
    }
    luhn_valid(&digits)
}

/// True when an `ipv4` match is a public/routable address worth flagging as PII.
/// Excludes the benign-in-technical-output ranges the red-team flagged: loopback,
/// RFC1918 private, link-local, multicast/reserved, `0.0.0.0`, and the
/// all-ones/subnet-mask-shaped `255.x`. Keeps genuine public IPs (e.g. `8.8.8.8`).
pub fn is_public_ipv4(matched: &str) -> bool {
    let octets: Vec<u8> = matched.split('.').filter_map(|o| o.parse().ok()).collect();
    if octets.len() != 4 {
        return false;
    }
    let [a, b, ..] = octets[..] else {
        return false;
    };
    match a {
        0 | 10 | 127 => false,                  // this-network, RFC1918-10, loopback
        169 if b == 254 => false,               // link-local
        172 if (16..=31).contains(&b) => false, // RFC1918-172
        192 if b == 168 => false,               // RFC1918-192
        255 => false,                           // broadcast / subnet-mask shapes
        224..=255 => false,                     // multicast + reserved
        _ => true,
    }
}
