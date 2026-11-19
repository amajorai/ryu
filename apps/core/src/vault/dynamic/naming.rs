//! Generated usernames and passwords shared by the database and cloud
//! providers.
//!
//! Every generated name is lowercase ASCII letters, digits, and the
//! separator, and every generated password is ASCII letters, digits, and `-`,
//! so both are safe inside the quoted identifiers and string literals the
//! providers' statement templates put them in.

use anyhow::{bail, Result};

use super::random_suffix;

/// Check a configured `usernamePrefix`: 1-16 lowercase letters, digits, or
/// underscores.
pub(crate) fn validate_prefix(prefix: Option<&str>) -> Result<()> {
    let Some(prefix) = prefix else {
        return Ok(());
    };
    if prefix.is_empty()
        || prefix.len() > 16
        || !prefix
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        bail!("usernamePrefix must be 1-16 lowercase letters, digits, or underscores");
    }
    Ok(())
}

/// `<prefix><sep><role><sep><random>` in at most `max_len` characters. The
/// role part keeps only lowercase letters and digits and is shortened first,
/// so the random part (10 characters) always survives.
pub(crate) fn generated_name(prefix: &str, role: &str, separator: char, max_len: usize) -> String {
    const RANDOM: usize = 10;
    let budget = max_len.saturating_sub(prefix.len() + RANDOM + 2).min(16);
    let role_part: String = role
        .bytes()
        .filter(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        .take(budget)
        .map(char::from)
        .collect();
    let name = if role_part.is_empty() {
        format!("{prefix}{separator}{}", random_suffix(RANDOM))
    } else {
        format!(
            "{prefix}{separator}{role_part}{separator}{}",
            random_suffix(RANDOM)
        )
    };
    name.chars().take(max_len).collect()
}

/// The username for a new lease: `usernameTemplate` rendered (see
/// [`super::username_template`]) or [`generated_name`] from the prefix. A
/// rendered name must look like a generated one (lowercase letters, digits,
/// `_`), since revocation re-checks it before it reaches a statement.
pub(crate) fn lease_username(
    template: Option<&str>,
    prefix: Option<&str>,
    (role, display_name): (&str, &str),
    max_len: usize,
) -> Result<String> {
    let Some(template) = template else {
        return Ok(generated_name(prefix.unwrap_or("ryu"), role, '_', max_len));
    };
    let context = super::username_template::TemplateContext {
        role_name: role.to_owned(),
        display_name: display_name.to_owned(),
    };
    super::username_template::render_username(template, &context, max_len, |name| {
        is_generated_name(name, b'_')
    })
}

/// Save-time check of `usernamePrefix` / `usernameTemplate`.
pub(crate) fn validate_username_settings(
    template: Option<&str>,
    prefix: Option<&str>,
    max_len: usize,
) -> Result<()> {
    validate_prefix(prefix)?;
    if template.is_some() {
        if prefix.is_some() {
            bail!("set usernamePrefix or usernameTemplate, not both");
        }
        lease_username(template, None, ("sample_role", "token"), max_len)?;
    }
    Ok(())
}

/// A 36-character password that meets the default complexity policies of
/// SQL Server, MySQL's `validate_password`, and cloud providers: it always
/// holds an uppercase letter, a lowercase letter, a digit, and a symbol.
pub(crate) fn strong_password() -> String {
    format!("Ry1-{}", random_suffix(32))
}

/// Whether `name` could have come from [`generated_name`] (checked before a
/// stored lease name is put back into a statement).
pub(crate) fn is_generated_name(name: &str, separator: u8) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == separator)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_fit_the_budget_and_keep_the_random_part() {
        let name = generated_name("ryu", "Reporting-Read Only", '_', 32);
        assert!(name.len() <= 32, "{name}");
        // Only lowercase letters and digits of the role survive.
        assert!(name.starts_with("ryu_eportingeadnly_"), "{name}");
        assert!(is_generated_name(&name, b'_'));
        // A long prefix leaves no room for the role, never for the suffix.
        let tight = generated_name("abcdefghijklmnop", "role", '_', 27);
        assert_eq!(tight.len(), 27);
        assert!(tight.starts_with("abcdefghijklmnop_"));
        let k8s = generated_name("ryu", "app", '-', 63);
        assert!(k8s.starts_with("ryu-app-"));
        assert!(is_generated_name(&k8s, b'-'));
    }

    #[test]
    fn passwords_meet_complexity_rules() {
        let password = strong_password();
        assert_eq!(password.len(), 36);
        assert!(password.bytes().any(|b| b.is_ascii_uppercase()));
        assert!(password.bytes().any(|b| b.is_ascii_lowercase()));
        assert!(password.bytes().any(|b| b.is_ascii_digit()));
        assert!(password.contains('-'));
        assert!(password
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-'));
    }

    #[test]
    fn prefixes_and_stored_names_are_checked() {
        assert!(validate_prefix(None).is_ok());
        assert!(validate_prefix(Some("svc_1")).is_ok());
        for bad in ["", "Upper", "has space", "seventeen_chars_x"] {
            assert!(validate_prefix(Some(bad)).is_err(), "{bad}");
        }
        assert!(!is_generated_name("x'; DROP USER root; --", b'_'));
        assert!(!is_generated_name("ryu-app", b'_'));
    }

    #[test]
    fn templates_render_within_the_provider_rules() {
        let name = lease_username(
            Some("v_{{.RoleName | lowercase}}_{{random 8}}"),
            None,
            ("Orders", "token"),
            32,
        )
        .unwrap();
        assert!(name.starts_with("v_orders_") && name.len() == 17, "{name}");
        // Without a template the prefix applies.
        assert!(lease_username(None, Some("svc"), ("db", "x"), 32)
            .unwrap()
            .starts_with("svc_db_"));
        // A rendered name with characters revocation would refuse fails.
        assert!(lease_username(Some("V-{{random 8}}"), None, ("db", "x"), 32).is_err());
        assert!(validate_username_settings(Some("x_{{random 4}}"), Some("svc"), 32).is_err());
        assert!(validate_username_settings(Some("x_{{random 4}}"), None, 32).is_ok());
        assert!(validate_username_settings(None, Some("svc"), 32).is_ok());
    }
}
