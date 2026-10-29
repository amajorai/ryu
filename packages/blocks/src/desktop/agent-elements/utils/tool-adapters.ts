import {
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import type { StepState, TimelineStep } from "../types/timeline.ts";
import { nativeSdkSchemaAdmits } from "./native-sdk-admission.ts";
import {
	type NativeSdkValue,
	nativeSdkObjectSchema,
} from "./native-sdk-observation.ts";

function calculateDiffStatsFromPatch(
	patches: Array<{ lines?: string[] }>
): string | undefined {
	let addedLines = 0;
	let removedLines = 0;

	for (const patch of patches) {
		if (!patch.lines) {
			continue;
		}
		for (const line of patch.lines) {
			if (line.startsWith("+")) {
				addedLines++;
			} else if (line.startsWith("-")) {
				removedLines++;
			}
		}
	}

	if (addedLines === 0 && removedLines === 0) {
		return undefined;
	}

	const parts: string[] = [];
	if (addedLines > 0) {
		parts.push(`+${addedLines}`);
	}
	if (removedLines > 0) {
		parts.push(`-${removedLines}`);
	}
	return parts.join(" ");
}

function getDiffLinesFromPatch(
	patches: Array<{ lines?: string[] }>
): { type: "add" | "remove" | "context"; content: string }[] {
	const result: { type: "add" | "remove" | "context"; content: string }[] = [];

	for (const patch of patches) {
		if (!patch.lines) {
			continue;
		}
		for (const line of patch.lines) {
			if (line.startsWith("+")) {
				result.push({ type: "add", content: line.slice(1) });
			} else if (line.startsWith("-")) {
				result.push({ type: "remove", content: line.slice(1) });
			} else if (line.startsWith(" ")) {
				result.push({ type: "context", content: line.slice(1) });
			}
		}
	}

	return result;
}

export function mapToolStateToStepState(
	aiState: "partial-call" | "call" | "result"
): StepState {
	return aiState === "result" ? "complete" : "animating";
}

export function mapToolNameToVariant(
	toolName: string
): "thinking" | "action" | "search" | undefined {
	const lower = toolName.toLowerCase();
	if (lower === "thinking" || lower === "reasoning") {
		return "thinking";
	}
	if (
		lower === "websearch" ||
		lower === "web_search" ||
		lower === "grep" ||
		lower === "glob" ||
		lower === "webfetch" ||
		lower === "web_fetch"
	) {
		return "search";
	}
	return undefined;
}

/** The argument cells read by timeline adaptation, not a whole tool-input DTO.
 * The genuine SDK owns opaque values; String coercion happens at the old sites. */
interface TimelineArgumentObservation {
	command?: NativeSdkValue;
	content?: NativeSdkValue;
	file_path?: NativeSdkValue;
	pattern?: NativeSdkValue;
	query?: NativeSdkValue;
	thought?: NativeSdkValue;
	url?: NativeSdkValue;
}

function extractToolDetail(
	toolName: string,
	args: TimelineArgumentObservation
): string {
	switch (toolName) {
		case "Bash":
			return args?.command ? String(args.command).slice(0, 80) : "";
		case "Edit":
		case "Write":
		case "Read":
			return args?.file_path
				? (String(args.file_path).split("/").pop() ?? "")
				: "";
		case "Grep":
			return args?.pattern ? String(args.pattern) : "";
		case "Glob":
			return args?.pattern ? String(args.pattern) : "";
		case "WebSearch":
		case "web_search":
			return args?.query ? String(args.query) : "";
		case "WebFetch":
		case "web_fetch":
			return args?.url ? String(args.url).slice(0, 60) : "";
		default:
			return "";
	}
}

export function mapToolInvocationToStep(
	toolCallId: string,
	toolInvocation: {
		toolName: string;
		args?: TimelineArgumentObservation;
		state: "partial-call" | "call" | "result";
		result?: any;
	}
): Extract<TimelineStep, { type: "tool-call" }> {
	const { toolName, args = {}, result } = toolInvocation;
	const displayToolName =
		toolName === "PlanWrite"
			? "Plan"
			: toolName === "TodoWrite"
				? "Todo"
				: toolName;
	const detail = extractToolDetail(toolName, args);

	const step: Extract<TimelineStep, { type: "tool-call" }> = {
		id: toolCallId,
		type: "tool-call",
		toolName: displayToolName,
		toolDetail: detail,
		duration: Number.MAX_SAFE_INTEGER,
		toolVariant: mapToolNameToVariant(toolName),
	};

	if (toolName === "Bash") {
		step.bashCommand = args?.command ? String(args.command) : undefined;
		if (toolInvocation.state === "result" && result) {
			if (isNativeText(result)) {
				step.bashOutput = result;
				step.bashSuccess = true;
			} else if (isNativeObjectLike(result)) {
				// Flatten output — may be a plain string, or an ACP array of content blocks.
				const rawOutput = result?.output ?? result?.stdout;
				const stdout = isNativeText(rawOutput)
					? rawOutput
					: Array.isArray(rawOutput)
						? rawOutput
								.map((item: NativeSdkValue) =>
									isNativeText(item)
										? item
										: nativeSdkSchemaAdmits(nativeSdkObjectSchema, item) &&
												"text" in item
											? String(item.text)
											: JSON.stringify(item)
								)
								.join("\n")
						: "";
				const stderr = isNativeText(result?.stderr) ? result.stderr : "";
				step.bashOutput = [stdout, stderr]
					.filter(Boolean)
					.join(stdout && stderr ? "\n" : "");
				// ACP uses a "status" string ("completed"/"failed"); native tools use exitCode.
				const exitCode = result?.exitCode ?? result?.exit_code;
				if (exitCode === undefined) {
					step.bashSuccess = result?.status !== "failed";
				} else {
					step.bashSuccess = exitCode === 0;
				}
			} else {
				step.bashOutput = JSON.stringify(result);
				step.bashSuccess = true;
			}
		}
	}

	if (toolName === "Edit" || toolName === "Write" || toolName === "Read") {
		step.filePath = args?.file_path
			? String(args.file_path)
			: result?.path
				? String(result.path)
				: undefined;
	}

	if (toolName === "Write") {
		const content = isNativeText(result?.content)
			? result.content
			: isNativeText(args?.content)
				? args.content
				: "";

		if (content) {
			const lines = content.split("\n");
			step.diffStats = `+${lines.length}`;
			step.diffLines = lines.map((line: string) => ({
				type: "add",
				content: line,
			}));
		}
	}

	if (toolName === "Edit" && Array.isArray(result?.structuredPatch)) {
		step.diffStats = calculateDiffStatsFromPatch(result.structuredPatch);
		step.diffLines = getDiffLinesFromPatch(result.structuredPatch);
	}

	if (
		toolName === "WebSearch" ||
		toolName === "web_search" ||
		toolName === "Grep" ||
		toolName === "Glob"
	) {
		step.searchQuery =
			(args?.query ?? args?.pattern)
				? String(args?.query ?? args?.pattern)
				: undefined;
		step.searchSource =
			toolName === "WebSearch" || toolName === "web_search" ? "web" : "code";
	}

	if (
		toolName.toLowerCase() === "thinking" ||
		toolName.toLowerCase() === "reasoning"
	) {
		step.thoughtContent = isNativeText(args?.thought)
			? args.thought
			: isNativeText(result)
				? result
				: undefined;
	}

	return step;
}
