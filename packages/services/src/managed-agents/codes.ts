// packages/services/src/managed-agents/codes.ts
//
// Ryu Managed Agents HTTP error codes, copied (not imported: the published SDK
// never depends on packages/protocol) from the keys of
// `MANAGED_AGENTS_ERROR_STATUS` in packages/protocol/src/managed-agents.ts.
// test/conformance/managed-agents.test.ts fails when the server adds a code
// this list lacks. New codes can appear in v1, so branch on an unknown code by
// its HTTP status.

/** Every Managed Agents HTTP error code (§4.8.1 of the contract). */
export const MANAGED_AGENTS_ERROR_CODES = [
	"invalid_request",
	"invalid_cursor",
	"invalid_idempotency_key",
	"organization_required",
	"unauthenticated",
	"insufficient_credits",
	"api_key_spend_cap_reached",
	"forbidden",
	"organization_mismatch",
	"org_access_denied",
	"feature_disabled",
	"step_up_required",
	"not_found",
	"version_conflict",
	"revision_conflict",
	"name_taken",
	"agent_archived",
	"environment_archived",
	"limit_reached",
	"idempotency_key_reused",
	"idempotency_in_progress",
	"session_closed",
	"session_running",
	"session_not_terminal",
	"tool_result_required",
	"unknown_tool_use",
	"tool_result_already_submitted",
	"session_budget_exhausted",
	"event_log_full",
	"payload_too_large",
	"unsupported_for_backend",
	"unsupported_content",
	"model_not_priced",
	"credential_unavailable",
	"platform_credentials_disabled",
	"node_not_found",
	"node_unreachable",
	"node_forbidden",
	"rate_limited",
	"session_limit_reached",
	"stream_limit_reached",
	"internal_error",
	"backend_not_implemented",
	"vendor_error",
	"managed_agents_disabled",
	"backend_disabled",
	"billing_unavailable",
	"event_append_contended",
	"service_unavailable",
] as const;

/** A Managed Agents HTTP error code known to this SDK version. */
export type ManagedAgentsErrorCode =
	(typeof MANAGED_AGENTS_ERROR_CODES)[number];

/** The public page that explains how the Managed Agents preview is turned on. */
export const MANAGED_AGENTS_PREVIEW_DOCS =
	"https://docs.ryuhq.com/docs/standalone/managed-agents";

/**
 * Codes that mean the preview is off, with the hint the SDK attaches to them.
 * `managed_agents_disabled` (503) is the deployment; `feature_disabled` (403)
 * is the organization or member.
 */
export const MANAGED_AGENTS_PREVIEW_HINTS: Readonly<
	Partial<Record<ManagedAgentsErrorCode, string>>
> = {
	managed_agents_disabled: `This Ryu deployment does not offer the Managed Agents preview. See ${MANAGED_AGENTS_PREVIEW_DOCS}`,
	feature_disabled: `Managed Agents is a preview that is off until an organization owner or feature manager turns it on in Organization > Features (and for the member making the request). See ${MANAGED_AGENTS_PREVIEW_DOCS}`,
};

/** The preview hint for `code`, or null. */
export function managedAgentsPreviewHint(code: string): string | null {
	return (
		(MANAGED_AGENTS_PREVIEW_HINTS as Readonly<Record<string, string>>)[code] ??
		null
	);
}
