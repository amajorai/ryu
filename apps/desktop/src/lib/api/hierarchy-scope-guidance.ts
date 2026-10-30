import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";

/**
 * One scope's prompt guidance (Core's `scope_guidance`): an optional goal and
 * an optional brief-replies toggle. Core injects both into the system prompt of
 * every thread in the scope, so a change is a one-time prompt-cache miss for
 * those threads; confirm with `promptEditCacheWarning` before saving.
 */
export interface ScopeGuidance {
	/** `null`/absent inherits (brief replies are on by default). */
	briefReplies?: boolean | null;
	goal: string;
}

const scopeGuidanceResponseSchema = z.looseObject({
	guidance: z
		.looseObject({
			briefReplies: z.boolean().nullish(),
			goal: z.string().optional(),
		})
		.optional(),
});
const scopeGuidanceWriteSchema = z.looseObject({
	promptChanged: z.boolean().optional(),
});

/** Keep opaque scope keys within the guidance route during URL parsing. */
function scopeGuidancePath(scope: string): string {
	if (scope === "." || scope === "..") {
		throw new Error("Scope cannot be a URL dot segment");
	}
	return `/api/scope-guidance/${encodeURIComponent(scope)}`;
}

/** Read one scope's guidance (empty when unset). */
export async function fetchScopeGuidance(
	target: ApiTarget,
	scope: string
): Promise<ScopeGuidance> {
	const response = await request(
		target,
		scopeGuidancePath(scope),
		undefined,
		scopeGuidanceResponseSchema
	);
	return {
		briefReplies: response.guidance?.briefReplies ?? null,
		goal: response.guidance?.goal ?? "",
	};
}

/**
 * Write one scope's guidance. Omitted fields keep their stored value. Resolves
 * to whether the system prompt actually changed (and so whether the scope's
 * threads take a cache miss on their next turn).
 */
export async function setScopeGuidance(
	target: ApiTarget,
	scope: string,
	value: Partial<ScopeGuidance>
): Promise<boolean> {
	const response = await request(
		target,
		scopeGuidancePath(scope),
		{ method: "PUT", body: value },
		scopeGuidanceWriteSchema
	);
	return response.promptChanged ?? true;
}
