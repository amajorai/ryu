// apps/desktop/src/lib/api/double-check.ts
//
// Typed client for Core's double-check endpoint. When the chat composer's
// "Double-check" toggle is on, the client calls this once after each assistant
// turn completes: a separately-configured side model reviews the latest answer
// and returns a verdict + critique. Stateless — Core persists nothing; the
// reviewer model/effort live in preferences (see preferences.ts SideModelConfig).
// See apps/core/src/server/mod.rs `double_check_handler`.

import { type ApiTarget, request } from "./client.ts";

/** One double-check review result. */
export interface DoubleCheckResult {
	/** True when the reviewer found no issues; false flags a problem (fail-loud). */
	ok: boolean;
	/** The reviewer's short critique (what's wrong / how to fix, or "no issues"). */
	critique: string;
	/** The model id that performed the review (resolved server-side). */
	model: string;
}

/** Review the latest assistant answer in a conversation with the side model. */
export function doubleCheck(
	target: ApiTarget,
	conversationId: string,
	signal?: AbortSignal
): Promise<DoubleCheckResult> {
	return request<DoubleCheckResult>(
		target,
		`/api/conversations/${conversationId}/double-check`,
		{ method: "POST", signal }
	);
}
