//! The host API method table, kept in ordered parts so no file outgrows the
//! repository's size limits.
//!
//! [`ALL`] is a `const` array joined from the parts in order by [`concat`], so
//! [`super::HOST_API_METHODS`] (and `schemas/host-api.json`, which serialises
//! it) keeps exactly the order the single table had.

use super::HostApiMethod;

pub(super) mod part_1;
pub(super) mod part_2;
pub(super) mod part_3;
pub(super) mod part_4;
pub(super) mod part_5;

/// The parts, in table order.
const PARTS: &[&[HostApiMethod]] = &[
    part_1::ROWS,
    part_2::ROWS,
    part_3::ROWS,
    part_4::ROWS,
    part_5::ROWS,
];

/// The number of rows in every part together.
const LEN: usize = total_len(PARTS);

// `concat` seeds its output from the first row of the first part.
const _: () = assert!(
    !PARTS[0].is_empty(),
    "the first host API part must not be empty"
);

/// Every host API method row, in table order.
pub(super) const ALL: [HostApiMethod; LEN] = concat(PARTS);

const fn total_len(parts: &[&[HostApiMethod]]) -> usize {
    let mut len = 0;
    let mut index = 0;
    while index < parts.len() {
        len += parts[index].len();
        index += 1;
    }
    len
}

/// Join `parts` in order into one array of exactly `N` rows. The output is
/// seeded with the first row of the first non-empty part (`HostApiMethod` is
/// `Copy`), then every row is copied over it in sequence; a length that does
/// not match `N` fails const evaluation.
pub(super) const fn concat<const N: usize>(parts: &[&[HostApiMethod]]) -> [HostApiMethod; N] {
    let mut seed = 0;
    while parts[seed].is_empty() {
        seed += 1;
    }
    let mut out = [parts[seed][0]; N];
    let mut written = 0;
    let mut part = 0;
    while part < parts.len() {
        let rows = parts[part];
        let mut row = 0;
        while row < rows.len() {
            out[written] = rows[row];
            written += 1;
            row += 1;
        }
        part += 1;
    }
    assert!(
        written == N,
        "host API parts do not add up to the table length"
    );
    out
}
