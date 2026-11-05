// Whole translated sentences for the cloud-environment runtime issues.
//
// `@ryuhq/protocol` returns a code plus values and stays English-free; this map
// owns the display copy so every sentence is a catalog key the extractor sees.
// The `switch` is exhaustive over the code union: a new code fails type-check
// here until it has a message.

import { formatList } from "@ryu/i18n";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { CloudEnvironmentIssue } from "@ryuhq/protocol/cloud-environments-issue";

export function cloudEnvironmentIssueMessage(
	tl: LiteralMessage,
	issue: CloudEnvironmentIssue,
	locale?: string | null
): string {
	switch (issue.code) {
		case "unsupported_backend":
			return tl("Choose a supported backend.");
		case "unsupported_agent":
			return tl("Choose a supported agent.");
		case "lifetime_out_of_range":
			return tl(
				"Session length must be a whole number of minutes from {min} to {max}.",
				{ min: issue.values.min, max: issue.values.max }
			);
		case "managed_agent_requires_box":
			return tl("Managed agents require the Fresh cloud box backend.");
		case "managed_agent_requires_internet":
			return tl("Managed agents require internet access.");
		case "box_rejects_tailscale":
			return tl(
				"Fresh cloud boxes do not support Tailscale VPN. Remove the VPN key."
			);
		case "box_rejects_network_secret":
			return tl(
				"Fresh cloud boxes do not support network secrets. Unselect {key}.",
				{ key: issue.values.key }
			);
		case "box_reserved_names":
			return tl(
				"Fresh cloud boxes reserve these variable names: {names}. Rename them.",
				{
					names: formatList(
						issue.values.names,
						"conjunction",
						locale ?? undefined
					),
				}
			);
		case "box_too_many_variables":
			return tl(
				"Fresh cloud boxes accept at most {max} variables. Unselect some.",
				{ max: issue.values.max }
			);
		default:
			return assertNever(issue);
	}
}

function assertNever(value: never): never {
	throw new Error(
		`Unhandled cloud environment issue: ${JSON.stringify(value)}`
	);
}
