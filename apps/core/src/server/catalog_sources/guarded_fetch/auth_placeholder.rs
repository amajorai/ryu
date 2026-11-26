//! Which environment variables a custom source's credential may name.
//!
//! A custom marketplace's bearer and header values may hold `${NAME}`
//! placeholders. Core fills them from its own process environment when it
//! fetches the source, and sends the result to the source's URL. Core keeps
//! secrets of its own in that environment (it sets `RYU_TOKEN` to the node token
//! at startup, and the Gateway tokens on a fleet node), so a placeholder that
//! names one of them would hand that secret to whoever runs the source.
//!
//! The rule is by prefix, not by a list of names: every variable whose name
//! starts with `RYU_` is Ryu's. Core and its sidecars set and read dozens of
//! them, a list would go stale with the next one, and no documented source
//! needs one. The comparison ignores case, because Windows does too when it
//! looks a variable up.

use crate::catalog_source::SourceAuth;

/// The prefix of the variables Ryu owns.
const OWN_PREFIX: &str = "RYU_";

/// Whether `name` is one of Ryu's own environment variables.
fn is_own_variable(name: &str) -> bool {
    name.get(..OWN_PREFIX.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(OWN_PREFIX))
}

/// The names of Ryu's own variables that the `${NAME}` placeholders of `value`
/// refer to. Parsed exactly as the fetch-time interpolation parses them: a name
/// is the trimmed text between `${` and the next `}`, and scanning goes on
/// after that `}`. An unterminated `${` ends the scan (the fetch refuses it).
pub(super) fn own_variable_placeholders(value: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            break;
        };
        let name = after[..end].trim();
        if is_own_variable(name) {
            found.push(name.to_owned());
        }
        rest = &after[end + 1..];
    }
    found
}

/// Why a custom source's credential may not be saved, or `None` when it may.
/// Names the variable, never a value: nothing is read from the environment.
pub(super) fn source_auth_refusal(auth: &SourceAuth) -> Option<String> {
    let name = auth
        .bearer
        .iter()
        .chain(auth.headers.values())
        .flat_map(|value| own_variable_placeholders(value))
        .next()?;
    Some(format!(
        "the source's credential names the environment variable '{name}'. Variables that start \
         with RYU_ belong to Ryu and may hold its own secrets, so a source may not use them. \
         Put the token in a variable with another name"
    ))
}

#[cfg(test)]
mod tests;
