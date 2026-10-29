import type { ArtifactHostValue } from "@ryu/blocks/desktop/agent-elements/artifact-host-context.tsx";
import type { DynamicToolUIPart } from "ai";
import type { ApiTarget } from "./api/client.ts";
/** Types for the original native operation's raw SDK argument forwarding only.
 * The actual caller retains the unchanged callee/receiver and consuming reads.
 * These do not validate data or claim any raw slot is a path/string/DTO. */
export type NativeArtifactFollowUpOperation = Omit<
	ArtifactHostValue,
	"submitFollowUp"
> & { submitFollowUp: (label: DynamicToolUIPart["input"]) => void };
export type NativeArtifactEditorPathOperation = (
	path: DynamicToolUIPart["input"]
) => void;
export type NativeArtifactContentFetchOperation = (
	target: ApiTarget,
	url: DynamicToolUIPart["input"]
) => Promise<string | null>;
