import {
	CodeBlock,
	type CodeBlockProps,
} from "@ryu/ui/components/agents/code-block";
import {
	ToolResult,
	ToolResultOutput,
} from "@ryu/ui/components/agents/tool-result";
import {
	isNativeObjectReceiver,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { memo, useMemo } from "react";
import type { NativeSdkValue } from "../utils/native-sdk-observation.ts";
import { unwrapMcpOutput } from "../utils/unwrap-mcp-output.ts";

type SandboxStatus = "running" | "completed" | "error";

function deriveStatus(part: any, chatStatus?: string): SandboxStatus {
	if (part.state === "output-error") {
		return "error";
	}
	if (part.state === "output-available") {
		return "completed";
	}
	if (chatStatus === "streaming" || part.state === "input-streaming") {
		return "running";
	}
	return part.output ? "completed" : "running";
}

/** Opaque cells read by the legacy code renderer, not a decoded tool-input DTO. */
interface SandboxCodeObservation {
	readonly code?: NativeSdkValue;
	readonly command?: NativeSdkValue;
	readonly script?: NativeSdkValue;
	readonly source?: NativeSdkValue;
}

function extractCode(part: any): string {
	// SAFETY: the existing nullish fallback supplies a non-nil receiver. These
	// optional cells describe native property reads/boxing only, with no claim
	// that any field exists or contains a decoded string; raw getters stay live.
	const input = (part.input ?? part.args ?? {}) as SandboxCodeObservation;
	const raw = input.code ?? input.command ?? input.script ?? input.source;
	return isNativeText(raw) ? raw : "";
}

function extractLogs(output: NativeSdkValue): string {
	if (output == null) {
		return "";
	}
	const unwrapped = unwrapMcpOutput(output);
	if (isNativeText(unwrapped)) {
		return unwrapped;
	}
	if (isNativeObjectReceiver(unwrapped) || unwrapped === null) {
		const record = unwrapped;
		const logs = Array.isArray(record.logs)
			? record.logs.join("\n")
			: isNativeText(record.logs)
				? record.logs
				: "";
		const result = record.result ?? record.value ?? record.returnValue;
		const segments: string[] = [];
		if (logs) {
			segments.push(logs);
		}
		if (result !== undefined && result !== null) {
			segments.push(
				isNativeText(result) ? result : JSON.stringify(result, null, 2)
			);
		}
		if (segments.length > 0) {
			return segments.join("\n");
		}
		return JSON.stringify(unwrapped, null, 2);
	}
	return String(unwrapped);
}

const MAX_DISPLAY_CHARS = 6000;

function clampCode(code: string): string {
	return code.length > MAX_DISPLAY_CHARS
		? `${code.slice(0, MAX_DISPLAY_CHARS)}\n…`
		: code;
}

export interface SandboxToolProps {
	chatStatus?: string;
	language?: CodeBlockProps["language"];
	part: any;
	title?: string;
}

/**
 * Renders an AI-generated code program alongside its execution output, mirroring
 * the AI SDK "Sandbox" element. The producer is a code-execution tool part —
 * Core's programmatic-tool-calling `execute` (input.code + logs) or any tool
 * carrying `input.code`/`input.command` and an output. Code renders through the
 * beUI CodeBlock, output through the beUI ToolResult disclosure.
 */
export const SandboxTool = memo(function SandboxTool({
	part,
	chatStatus,
	title,
	language = "typescript",
}: SandboxToolProps) {
	const status = deriveStatus(part, chatStatus);
	const code = useMemo(() => clampCode(extractCode(part)), [part]);
	const logs = useMemo(() => extractLogs(part.output), [part.output]);
	const hasLogs = logs.trim().length > 0;

	const headerTitle = title ?? (part.input?.filename || "Code sandbox");

	return (
		<div>
			<ToolResult
				collapseOnComplete={false}
				kind="terminal"
				status={
					status === "error"
						? "error"
						: status === "running"
							? "running"
							: "success"
				}
				title={headerTitle}
				tool="sandbox"
			>
				<div className="flex flex-col gap-2">
					{code ? (
						<CodeBlock
							code={code}
							filename={headerTitle}
							language={language}
							maxHeight={360}
							status={status === "running" ? "streaming" : "complete"}
							wrap
						/>
					) : null}
					{hasLogs ? (
						<div className="overflow-hidden rounded-xl bg-muted/80">
							<div className="p-3">
								<ToolResultOutput language="text">{logs}</ToolResultOutput>
							</div>
						</div>
					) : status === "running" ? (
						<p className="py-1 text-muted-foreground text-xs">
							Waiting for output…
						</p>
					) : null}
				</div>
			</ToolResult>
		</div>
	);
});
