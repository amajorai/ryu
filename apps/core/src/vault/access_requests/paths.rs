//! Glob reasoning for access requests: whether an approval policy's path
//! covers a requested path, and whether two globs may reach a common key.
//!
//! Both answers err toward the safe side. [`covers`] says yes only when every
//! key the request could reach is reached by the policy glob, so a request is
//! never approved under a policy narrower than what it grants. [`may_overlap`]
//! says yes whenever it cannot rule a common key out, so a stricter policy
//! that touches part of a request always joins its approval chain.

use anyhow::{bail, Result};

use super::super::policy::{wildcard_matches, MAX_GLOB_LEN};

/// Whether `segment` carries any glob or template syntax.
fn is_pattern(segment: &str) -> bool {
    segment.contains(['*', '?', '{', '}'])
}

/// Validate a glob an access policy or request names: non-empty, bounded, no
/// empty or traversal segment, no identity template. A requested path also
/// starts with a valid literal environment (never the reserved `sys`, whose
/// keys gate system capabilities) and carries no `?` (a request names a
/// prefix-shaped reach, which [`covers`] can reason about exactly).
pub fn validate_glob(path: &str, requested: bool) -> Result<()> {
    if path.is_empty() || path.len() > MAX_GLOB_LEN {
        bail!("path must be 1-{MAX_GLOB_LEN} characters");
    }
    if path.contains("{{") || path.contains("}}") {
        bail!("path `{path}` cannot carry identity templates");
    }
    if path.chars().any(char::is_control) {
        bail!("path `{path}` has a control character");
    }
    let segments: Vec<&str> = path.split('/').collect();
    if segments
        .iter()
        .any(|s| s.is_empty() || *s == "." || *s == "..")
    {
        bail!("path `{path}` has an empty or traversal segment");
    }
    if requested {
        if path.contains('?') {
            bail!("a requested path cannot use `?`");
        }
        if !crate::vault::is_valid_environment(segments[0]) {
            bail!("a requested path must start with a literal environment, not `sys` or a glob");
        }
        if segments.len() < 2 {
            bail!("a requested path needs an environment and a key glob, such as `prod/**`");
        }
    }
    Ok(())
}

/// Whether policy segment `pattern` matches every name request segment
/// `requested` could stand for.
fn segment_covers(pattern: &str, requested: &str) -> bool {
    if requested == "**" {
        return false;
    }
    if !requested.contains('*') {
        return wildcard_matches(pattern, requested);
    }
    if pattern == "*" || pattern == requested {
        return true;
    }
    // `API_*` covers `API_KEY*`: a literal prefix then one trailing star.
    pattern
        .strip_suffix('*')
        .is_some_and(|prefix| !is_pattern(prefix) && requested.starts_with(prefix))
}

/// Run `step` over every `(i, j)` pair with memoization, so globs with many
/// `**` segments stay polynomial.
struct Memo {
    width: usize,
    cells: Vec<Option<bool>>,
}

impl Memo {
    fn new(left: usize, right: usize) -> Self {
        Self {
            width: right + 1,
            cells: vec![None; (left + 1) * (right + 1)],
        }
    }

    fn get(&self, i: usize, j: usize) -> Option<bool> {
        self.cells[i * self.width + j]
    }

    fn set(&mut self, i: usize, j: usize, value: bool) -> bool {
        self.cells[i * self.width + j] = Some(value);
        value
    }
}

/// Whether policy glob `policy` reaches every key requested glob `requested`
/// can reach.
pub fn covers(policy: &str, requested: &str) -> bool {
    fn walk(p: &[&str], r: &[&str], i: usize, j: usize, memo: &mut Memo) -> bool {
        if let Some(known) = memo.get(i, j) {
            return known;
        }
        let result = match p.get(i) {
            None => j == r.len(),
            Some(&"**") => (j..=r.len()).any(|skip| walk(p, r, i + 1, skip, memo)),
            Some(head) => {
                j < r.len() && segment_covers(head, r[j]) && walk(p, r, i + 1, j + 1, memo)
            }
        };
        memo.set(i, j, result)
    }
    let p: Vec<&str> = policy.split('/').collect();
    let r: Vec<&str> = requested.split('/').collect();
    let mut memo = Memo::new(p.len(), r.len());
    walk(&p, &r, 0, 0, &mut memo)
}

/// Whether globs `left` and `right` may both match some key. Any segment
/// with glob or template syntax is assumed to match the other side.
pub fn may_overlap(left: &str, right: &str) -> bool {
    fn walk(a: &[&str], b: &[&str], i: usize, j: usize, memo: &mut Memo) -> bool {
        if let Some(known) = memo.get(i, j) {
            return known;
        }
        let result = match (a.get(i), b.get(j)) {
            (None, None) => true,
            (Some(&"**"), _) => {
                walk(a, b, i + 1, j, memo) || (j < b.len() && walk(a, b, i, j + 1, memo))
            }
            (_, Some(&"**")) => {
                walk(a, b, i, j + 1, memo) || (i < a.len() && walk(a, b, i + 1, j, memo))
            }
            (None, _) | (_, None) => false,
            (Some(x), Some(y)) => {
                (is_pattern(x) || is_pattern(y) || x == y) && walk(a, b, i + 1, j + 1, memo)
            }
        };
        memo.set(i, j, result)
    }
    let a: Vec<&str> = left.split('/').collect();
    let b: Vec<&str> = right.split('/').collect();
    let mut memo = Memo::new(a.len(), b.len());
    walk(&a, &b, 0, 0, &mut memo)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covers_only_when_every_requested_key_is_reached() {
        assert!(covers("prod/**", "prod/**"));
        assert!(covers("prod/**", "prod/api/KEY"));
        assert!(covers("prod/*/API_*", "prod/*/API_KEY*"));
        assert!(covers("prod/*", "prod/a*"));
        assert!(covers("**", "staging/**"));
        assert!(covers("prod/**/KEY", "prod/**/KEY"));
        assert!(covers("prod/a/**", "prod/a"));
        // A narrower policy never covers a wider request.
        assert!(!covers("prod/*/*", "prod/**"));
        assert!(!covers("prod/*/API_*", "prod/*/*"));
        assert!(!covers("prod/ab*", "prod/a*"));
        assert!(!covers("prod/?", "prod/*"));
        assert!(!covers("prod/a?", "prod/a*"));
        assert!(!covers("prod/*/KEY", "prod/**/KEY"));
        assert!(!covers("prod/**", "staging/KEY"));
        assert!(!covers("prod/a", "prod/a/b"));
    }

    #[test]
    fn overlap_is_conservative() {
        assert!(may_overlap("prod/payments/**", "prod/**"));
        assert!(may_overlap("prod/*/A", "prod/x/*"));
        assert!(may_overlap("**", "dev/KEY"));
        assert!(may_overlap("prod/{{identity.user.id}}/*", "prod/alice/KEY"));
        assert!(may_overlap("a/**/**/**/**/z", "a/b/c/d/e/f/g/h/z"));
        assert!(!may_overlap("prod/payments/**", "prod/api/*"));
        assert!(!may_overlap("prod/**", "staging/**"));
        assert!(!may_overlap("prod/a", "prod/a/b"));
    }

    #[test]
    fn requested_paths_are_literal_environments_without_question_marks() {
        assert!(validate_glob("prod/**", true).is_ok());
        assert!(validate_glob("prod/api/KEY_*", true).is_ok());
        assert!(validate_glob("*/KEY", true).is_err());
        assert!(validate_glob("prod/KE?", true).is_err());
        assert!(validate_glob("prod", true).is_err());
        assert!(validate_glob("prod//KEY", true).is_err());
        assert!(validate_glob("prod/../KEY", true).is_err());
        assert!(validate_glob("prod/{{identity.user.id}}", true).is_err());
        assert!(validate_glob("prod/{{identity.user.id}}", false).is_err());
        assert!(validate_glob("*/KE?", false).is_ok());
    }

    #[test]
    fn requested_paths_never_start_in_the_reserved_system_prefix() {
        assert!(validate_glob("sys/**", true).is_err());
        assert!(validate_glob("sys/broker/github", true).is_err());
        assert!(validate_glob("Prod/**", true).is_err());
        assert!(validate_glob("sys/**", false).is_ok());
    }
}
