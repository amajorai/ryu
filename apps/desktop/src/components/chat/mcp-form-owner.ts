import type { ApiTarget } from "@/src/lib/api/client.ts";

export interface McpFormOwner {
	conversationId: string | null;
	target: ApiTarget;
}

/** A parent owns forms only for the same conversation and authenticated actor. */
export function ownsMcpForms(
	owner: McpFormOwner | null,
	target: ApiTarget,
	conversationId: string | null | undefined
): boolean {
	return Boolean(
		conversationId &&
			owner?.conversationId === conversationId &&
			owner.target.url === target.url &&
			owner.target.token === target.token &&
			(owner.target.userJwt ?? null) === (target.userJwt ?? null)
	);
}
