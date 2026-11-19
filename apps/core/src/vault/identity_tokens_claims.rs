//! Identity token roles and claims: issuer and role validation and the
//! single-pass claim template renderer.

use super::*;

/// Validate an issuer URL: http(s), no query, fragment, or trailing slash.
pub fn validate_issuer(issuer: &str) -> Result<()> {
    let ok = (issuer.starts_with("https://") || issuer.starts_with("http://"))
        && issuer.len() <= 512
        && !issuer.ends_with('/')
        && !issuer.contains(['?', '#', ' '])
        && issuer
            .split("://")
            .nth(1)
            .is_some_and(|rest| !rest.is_empty());
    if ok {
        Ok(())
    } else {
        Err(invalid(
            "issuer must be an http(s) URL without a query, fragment, or trailing slash",
        ))
    }
}

/// JSON-escape `value` for use inside a JSON string literal.
fn escape_in_string(value: &str) -> String {
    let quoted = serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned());
    quoted[1..quoted.len() - 1].to_owned()
}

/// Render a role template for `subject` into a claims object.
pub(super) fn render_template(
    template: &str,
    subject: &IdentitySubject,
) -> Result<Map<String, Value>> {
    let policies = serde_json::to_string(&subject.policies)?;
    // Single pass over the template: substituted values are never rescanned,
    // so subject attributes containing `{{` are inserted verbatim.
    let mut rendered = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        rendered.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after
            .find("}}")
            .ok_or_else(|| invalid("template uses an unknown placeholder"))?;
        let value = match &after[..end] {
            "identity.policies" => policies.clone(),
            "identity.id" => escape_in_string(&subject.id),
            "identity.name" => escape_in_string(&subject.name),
            "identity.kind" => escape_in_string(&subject.kind),
            _ => return Err(invalid("template uses an unknown placeholder")),
        };
        rendered.push_str(&value);
        rest = &after[end + 2..];
    }
    rendered.push_str(rest);
    let value: Value = serde_json::from_str(&rendered)
        .map_err(|_| invalid("template must render to a JSON object"))?;
    let Value::Object(claims) = value else {
        return Err(invalid("template must render to a JSON object"));
    };
    if let Some(reserved) = RESERVED_CLAIMS.iter().find(|c| claims.contains_key(**c)) {
        return Err(invalid(format!(
            "template may not set the reserved claim `{reserved}`"
        )));
    }
    Ok(claims)
}

pub(super) fn validate_role(role: &IdentityRole) -> Result<()> {
    if !crate::vault::transit::is_valid_key_name(&role.name) {
        return Err(invalid("role names must match ^[a-z0-9][a-z0-9_-]{0,63}$"));
    }
    let audience = role.audience.trim();
    if audience.is_empty() || audience.len() > 256 {
        return Err(invalid("audience must be 1-256 characters"));
    }
    if !(MIN_TOKEN_TTL_SECS..=MAX_TOKEN_TTL_SECS).contains(&role.ttl_secs) {
        return Err(invalid(format!(
            "ttlSecs must be between {MIN_TOKEN_TTL_SECS} and {MAX_TOKEN_TTL_SECS}"
        )));
    }
    if let Some(template) = &role.template {
        if template.len() > MAX_TEMPLATE_BYTES {
            return Err(invalid("template is too large"));
        }
        let sample = IdentitySubject {
            kind: "machine".into(),
            id: "id".into(),
            name: "name".into(),
            policies: vec!["policy".into()],
        };
        render_template(template, &sample)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_values_are_substituted_once() {
        let tricky = IdentitySubject {
            kind: "machine".into(),
            id: "{{identity.kind}}".into(),
            name: "{{unknown}}".into(),
            policies: Vec::new(),
        };
        let claims = render_template(
            r#"{"id": "{{identity.id}}", "name": "{{identity.name}}"}"#,
            &tricky,
        )
        .unwrap();
        assert_eq!(claims["id"], "{{identity.kind}}");
        assert_eq!(claims["name"], "{{unknown}}");
        assert!(render_template(r#"{"x": "{{identity.id"}"#, &tricky).is_err());
    }

    #[test]
    fn issuers_and_roles_are_validated() {
        validate_issuer("https://node.example.com/api/vault/identity").unwrap();
        assert!(validate_issuer("https://x/").is_err());
        let role = IdentityRole {
            name: "r".into(),
            audience: " ".into(),
            ttl_secs: 300,
            template: None,
        };
        assert!(validate_role(&role).is_err(), "blank audience");
    }
}
