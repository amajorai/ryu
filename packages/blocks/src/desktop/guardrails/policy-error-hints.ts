// Short sentences for the refusal codes the named-policy API returns.

/**
 * A short sentence for a refusal code the policy API returns, or `null` to
 * show the server's own message.
 */
export function policyErrorHint(code: string | null): string | null {
	switch (code) {
		case "version_conflict":
			return "Someone else saved this policy first. Reload it to see their changes, then reapply yours.";
		case "policy_assigned":
			return "Remove every assignment of this policy before archiving it.";
		case "scope_already_assigned":
			return "That scope already has a policy. Replace it or remove it first.";
		case "invalid_regex_pattern":
			return "A custom pattern is not allowed. Patterns cannot use lookarounds, backreferences or a repeated group that already repeats.";
		case "invalid_permission_pattern":
			return "Permission resources may use only * and ? as wildcards.";
		case "glob_not_supported":
			return "Model permissions take an exact model id or *.";
		case "agent_scope_unsupported":
			return "An agent assignment carries firewall settings and evaluators only.";
		case "scope_not_found":
			return "That scope was not found in this organization.";
		default:
			return null;
	}
}
