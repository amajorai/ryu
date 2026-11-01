//! The project this gateway runs for (`RYU_PROJECT_ID`), sent as
//! `x-project-id` on every `/gateway/resolve` use.
//!
//! The control plane validates it against the credential (in the org, inside a
//! team key's team) and echoes it as `credential.projectId`, which keys the
//! org's per-project caps. It also scopes the resolved policy to the project's
//! layers, so it was first sent only on node-control resolves; relay and web
//! resolves need it too, or project caps would never see hosted traffic.
//!
//! The value is process-wide, so the resolve cache (keyed by operation and
//! token) still maps one key to one answer.

/// Env naming the project this gateway runs for.
const ENV_PROJECT_ID: &str = "RYU_PROJECT_ID";
/// Header carrying it on a resolve.
pub(super) const PROJECT_HEADER: &str = "x-project-id";

/// The configured project id, trimmed, or `None` when unset or blank.
pub(super) fn configured_project_id() -> Option<String> {
    project_id_from(std::env::var(ENV_PROJECT_ID).ok())
}

fn project_id_from(raw: Option<String>) -> Option<String> {
    raw.map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::super::{CredentialUse, ResolveResponse};
    use super::*;
    use crate::org_limits::FundingSource;

    #[test]
    fn a_blank_or_missing_project_sends_no_header() {
        assert_eq!(project_id_from(None), None);
        assert_eq!(project_id_from(Some("   ".into())), None);
        assert_eq!(
            project_id_from(Some(" proj_1 ".into())).as_deref(),
            Some("proj_1")
        );
    }

    fn relay(extra: serde_json::Value) -> super::super::ResolvedOrg {
        let mut body = serde_json::json!({
            "organization": { "id": "org1" },
            "credential": {
                "id": "cred1",
                "purpose": "gateway_relay",
                "allowedOperations": ["gateway.inference"]
            }
        });
        if let (Some(target), Some(source)) = (body.as_object_mut(), extra.as_object()) {
            for (key, value) in source {
                if key == "credential" {
                    if let (Some(credential), Some(fields)) =
                        (target["credential"].as_object_mut(), value.as_object())
                    {
                        credential.extend(fields.clone());
                    }
                } else {
                    target.insert(key.clone(), value.clone());
                }
            }
        }
        serde_json::from_value::<ResolveResponse>(body)
            .unwrap()
            .into_resolved(CredentialUse::GatewayRelay)
            .unwrap()
    }

    #[test]
    fn resolve_parses_the_credential_project_and_funding_draw_source() {
        let resolved = relay(serde_json::json!({
            "credential": { "projectId": "proj_1" },
            "fundingDrawSource": "api"
        }));
        assert_eq!(resolved.project_id.as_deref(), Some("proj_1"));
        assert_eq!(resolved.funding_draw_source, Some(FundingSource::Api));

        let subscription = relay(serde_json::json!({
            "fundingDrawSource": "subscription"
        }));
        assert_eq!(
            subscription.funding_draw_source,
            Some(FundingSource::Subscription)
        );
    }

    #[test]
    fn legacy_null_blank_or_unknown_values_read_as_none() {
        let legacy = relay(serde_json::json!({}));
        assert_eq!(legacy.project_id, None);
        assert_eq!(legacy.funding_draw_source, None);

        let odd = relay(serde_json::json!({
            "credential": { "projectId": "" },
            "fundingDrawSource": "gift"
        }));
        assert_eq!(odd.project_id, None);
        assert_eq!(odd.funding_draw_source, None);

        let nulls = relay(serde_json::json!({
            "credential": { "projectId": null },
            "fundingDrawSource": null
        }));
        assert_eq!(nulls.project_id, None);
        assert_eq!(nulls.funding_draw_source, None);

        let numeric = relay(serde_json::json!({ "fundingDrawSource": 7 }));
        assert_eq!(numeric.funding_draw_source, None);
    }
}
