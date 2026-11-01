//! Builder tags (Treg parity C6): the request's `x-ryu-tags`, parsed once.

use crate::pipeline::RequestContext;

tokio::task_local! {
    /// The tags of the request being served, parsed once by
    /// [`scope_spend_tags`] so authentication can attach them to the org
    /// limit context without every handler threading the header through.
    static SPEND_TAGS: Vec<String>;
}

/// The current request's builder tags; empty outside a tagged request.
pub fn current_spend_tags() -> Vec<String> {
    SPEND_TAGS.try_with(Clone::clone).unwrap_or_default()
}

/// Router middleware: parse `x-ryu-tags` (contract
/// `ryu_gw_contracts::spend_tags`) and serve the request inside it. A
/// malformed header is refused with `400` before anything runs, because a
/// silently dropped tag would escape its budget.
pub async fn scope_spend_tags(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<axum::response::Response, crate::error::GatewayError> {
    use ryu_gw_contracts::spend_tags::{parse_spend_tags, SPEND_TAGS_HEADER};
    let raw = match request.headers().get(SPEND_TAGS_HEADER) {
        None => None,
        Some(value) => Some(value.to_str().map_err(|_| {
            crate::error::GatewayError::BadRequest(format!("{SPEND_TAGS_HEADER} must be ASCII"))
        })?),
    };
    let tags = parse_spend_tags(raw).map_err(|problem| {
        crate::error::GatewayError::BadRequest(format!(
            "{SPEND_TAGS_HEADER} is not valid ({}): up to eight comma-separated tags of lowercase letters, digits and . _ : -",
            problem.as_str()
        ))
    })?;
    Ok(SPEND_TAGS.scope(tags, next.run(request)).await)
}

/// The builder tags of a request's org-limit context (what its debits carry).
pub fn tags_for(ctx: &RequestContext) -> Vec<String> {
    ctx.org_limits
        .as_deref()
        .map(|limit_ctx| limit_ctx.tags.clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::super::tests::context;
    use super::super::OrgLimits;
    use super::*;

    #[tokio::test]
    async fn tags_are_read_from_the_request_scope_only() {
        assert!(current_spend_tags().is_empty());
        let tags = SPEND_TAGS
            .scope(vec!["eu".to_owned()], async { current_spend_tags() })
            .await;
        assert_eq!(tags, ["eu"]);
    }

    #[test]
    fn a_context_reports_its_limit_tags() {
        let mut ctx = crate::pipeline::test_support::plain_request_context();
        assert!(tags_for(&ctx).is_empty());
        let mut limit_ctx = context(OrgLimits::default(), &[]);
        limit_ctx.tags = vec!["batch".to_owned()];
        ctx.org_limits = Some(Arc::new(limit_ctx));
        assert_eq!(tags_for(&ctx), ["batch"]);
    }
}
