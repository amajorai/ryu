import { isNativeObjectLike } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import { nativeSdkSchemaAdmits } from "../utils/native-sdk-admission.ts";
import type { NativeSdkValue } from "../utils/native-sdk-observation.ts";

export interface ToolActivityPart {
	input?: NativeSdkValue;
	output?: NativeSdkValue;
	result?: NativeSdkValue;
	state?: string;
	toolCallId?: string;
	type: string;
}

export interface ToolGroupOptions {
	expandCommands: boolean;
	expandFileEdits: boolean;
}

const COMMAND_TOOL_TYPES = new Set(["tool-Bash", "tool-BashOutput"]);
const FILE_EDIT_TOOL_TYPES = new Set([
	"tool-Edit",
	"tool-NotebookEdit",
	"tool-Write",
]);
const GROUPABLE_TOOL_TYPES = new Set([
	"tool-Bash",
	"tool-BashOutput",
	"tool-Edit",
	"tool-Glob",
	"tool-Grep",
	"tool-KillShell",
	"tool-NotebookEdit",
	"tool-Read",
	"tool-Skill",
	"tool-WebFetch",
	"tool-Write",
	"tool-cloning",
]);

/** The success cell read by the grouping rule, not a complete tool result. */
interface ToolSuccessObservation {
	success?: NativeSdkValue;
}
const toolSuccessObservationSchema =
	z.custom<ToolSuccessObservation>(isNativeObjectLike);
function isRecord(value: NativeSdkValue): value is ToolSuccessObservation {
	return nativeSdkSchemaAdmits(toolSuccessObservationSchema, value);
}

export function isCommandToolType(type: string): boolean {
	return COMMAND_TOOL_TYPES.has(type) || type === "tool-KillShell";
}

export function isFileEditToolType(type: string): boolean {
	return FILE_EDIT_TOOL_TYPES.has(type);
}

/** Whether a tool can be represented by one compact AgentActivity trace row. */
export function isToolActivityGroupCandidate(
	part: ToolActivityPart,
	options: ToolGroupOptions
): boolean {
	if (!GROUPABLE_TOOL_TYPES.has(part.type)) {
		return false;
	}
	if (options.expandCommands && COMMAND_TOOL_TYPES.has(part.type)) {
		return false;
	}
	if (options.expandFileEdits && FILE_EDIT_TOOL_TYPES.has(part.type)) {
		return false;
	}
	if (part.state === "output-error") {
		return false;
	}
	return !(
		part.state === "output-available" &&
		isRecord(part.output) &&
		part.output.success === false
	);
}
