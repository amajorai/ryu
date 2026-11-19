//! Schema and value validation for items.
// test-exempt: moved verbatim out of vault/items/mod.rs; covered by items/tests.rs, cards_tests.rs and add_field_tests.rs.

use super::*;

/// Validate and normalize a submitted schema.
pub fn normalize_fields(fields: &[FieldDefInput]) -> Result<Vec<FieldDef>> {
    if fields.is_empty() || fields.len() > MAX_FIELDS {
        return Err(invalid(format!("an item has 1 to {MAX_FIELDS} fields")));
    }
    let mut seen = BTreeSet::new();
    let mut out = Vec::with_capacity(fields.len());
    for field in fields {
        if !is_valid_field_name(&field.name) {
            return Err(invalid(format!(
                "invalid field name `{}` (a letter, then letters, digits, `_`, or `-`; at most 64)",
                field.name
            )));
        }
        if !seen.insert(field.name.to_ascii_lowercase()) {
            return Err(invalid(format!("duplicate field `{}`", field.name)));
        }
        let label = field
            .label
            .as_deref()
            .map(str::trim)
            .filter(|label| !label.is_empty())
            .map(str::to_owned);
        if label
            .as_deref()
            .is_some_and(|label| label.chars().count() > MAX_LABEL_LEN)
        {
            return Err(invalid(format!(
                "field `{}` label exceeds {MAX_LABEL_LEN} characters",
                field.name
            )));
        }
        let always = field.field_type.always_sensitive();
        let sensitive = match field.sensitive {
            Some(false) if always => {
                return Err(invalid(format!(
                    "field `{}`: password and totp fields are always sensitive",
                    field.name
                )));
            }
            Some(value) => value,
            None => always,
        };
        out.push(FieldDef {
            name: field.name.clone(),
            label,
            field_type: field.field_type,
            required: field.required,
            sensitive,
        });
    }
    Ok(out)
}

/// Validate one value against its field type and return the stored form.
/// A TOTP field accepts a Base32 seed or an `otpauth://totp/...` URI and
/// stores the normalized seed.
pub fn normalize_value(field: &FieldDef, value: &str) -> Result<String> {
    if value.is_empty() {
        return Err(invalid(format!(
            "field `{}`: use null to clear a value",
            field.name
        )));
    }
    if value.len() > MAX_VALUE_BYTES {
        return Err(invalid(format!(
            "field `{}` exceeds {MAX_VALUE_BYTES} bytes",
            field.name
        )));
    }
    let single_line = || {
        if value.contains(['\n', '\r', '\0']) {
            Err(invalid(format!("field `{}` must be one line", field.name)))
        } else {
            Ok(())
        }
    };
    match field.field_type {
        FieldType::Note => Ok(value.to_owned()),
        FieldType::Text | FieldType::Password => {
            single_line()?;
            Ok(value.to_owned())
        }
        FieldType::Email => {
            let trimmed = value.trim();
            let valid = trimmed.len() <= 320
                && !trimmed.chars().any(char::is_whitespace)
                && trimmed.split_once('@').is_some_and(|(local, domain)| {
                    !local.is_empty()
                        && !domain.is_empty()
                        && !domain.contains('@')
                        && !domain.starts_with('.')
                        && !domain.ends_with('.')
                });
            if valid {
                Ok(trimmed.to_owned())
            } else {
                Err(invalid(format!(
                    "field `{}` is not an email address",
                    field.name
                )))
            }
        }
        FieldType::Url => {
            single_line()?;
            let parsed = url::Url::parse(value.trim())
                .map_err(|_| invalid(format!("field `{}` is not a URL", field.name)))?;
            if !matches!(parsed.scheme(), "https" | "http") || parsed.host_str().is_none() {
                return Err(invalid(format!(
                    "field `{}` must be an http(s) URL",
                    field.name
                )));
            }
            Ok(parsed.to_string())
        }
        FieldType::Totp => normalize_totp_seed(value)
            .ok_or_else(|| invalid(format!("field `{}` is not a Base32 TOTP seed", field.name))),
    }
}

/// Normalize a Base32 TOTP seed or extract it from an `otpauth://totp/` URI.
/// Returns uppercase, unpadded Base32 of at least 16 characters (80 bits).
pub fn normalize_totp_seed(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let raw = if trimmed
        .get(..10)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("otpauth://"))
    {
        let parsed = url::Url::parse(trimmed).ok()?;
        if !parsed.host_str()?.eq_ignore_ascii_case("totp") {
            return None;
        }
        parsed
            .query_pairs()
            .find(|(name, _)| name == "secret")
            .map(|(_, secret)| secret.into_owned())?
    } else {
        trimmed.to_owned()
    };
    let seed: String = raw
        .chars()
        .filter(|c| !matches!(c, ' ' | '-'))
        .collect::<String>()
        .trim_end_matches('=')
        .to_ascii_uppercase();
    let valid = (16..=128).contains(&seed.len())
        && seed
            .bytes()
            .all(|b| b.is_ascii_uppercase() || (b'2'..=b'7').contains(&b));
    valid.then_some(seed)
}
