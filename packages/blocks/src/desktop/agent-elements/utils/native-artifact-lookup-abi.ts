import type { DynamicToolUIPart } from "ai";
/** Native optional-property lookup protocol. This is neither an object brand
 * nor a decoded artifact: every observed slot remains the actual opaque SDK
 * value, and lookup may still invoke inherited/Proxy getters or throw. */
export interface NativeArtifactLookup {
	readonly artifact?: DynamicToolUIPart["input"] | DynamicToolUIPart["output"];
	readonly id?: DynamicToolUIPart["input"] | DynamicToolUIPart["output"];
	readonly mime?: DynamicToolUIPart["input"] | DynamicToolUIPart["output"];
	readonly space_id?: DynamicToolUIPart["input"] | DynamicToolUIPart["output"];
	readonly title?: DynamicToolUIPart["input"] | DynamicToolUIPart["output"];
	readonly url?: DynamicToolUIPart["input"] | DynamicToolUIPart["output"];
}
export function nativeArtifactLookup(
	value: DynamicToolUIPart["input"] | DynamicToolUIPart["output"]
): NativeArtifactLookup | null | undefined {
	// SAFETY: AI SDK input/output is opaque JavaScript. This erased ABI view only
	// permits the original native optional-property operation and returns opaque
	// slots; it claims no object brand, field presence/type or full Artifact DTO.
	// No boxing/validation/inspection occurs, preserving primitive/function/Proxy
	// receivers and native getter errors. Actual field consumers validate values.
	return value as NativeArtifactLookup | null | undefined;
}
