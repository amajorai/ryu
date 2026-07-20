import { Badge } from "@ryu/ui/components/badge";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ryu/ui/components/collapsible";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs";
import { cn } from "@ryu/ui/lib/utils";
import { IconChevronRight, IconCode } from "@tabler/icons-react";
import { memo, useMemo, useState } from "react";
import { Markdown } from "../markdown.tsx";
import { unwrapMcpOutput } from "../utils/unwrap-mcp-output.ts";

type SandboxStatus = "running" | "completed" | "error";

const STATUS_LABEL: Record<SandboxStatus, string> = {
	running: "Running",
	completed: "Completed",
	error: "Error",
};

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

function extractCode(part: any): string {
	const input = (part.input ?? part.args ?? {}) as Record<string, unknown>;
	const raw = input.code ?? input.command ?? input.script ?? input.source;
	return typeof raw === "string" ? raw : "";
}

function extractLogs(output: unknown): string {
	if (output == null) {
		return "";
	}
	const unwrapped = unwrapMcpOutput(output);
	if (typeof unwrapped === "string") {
		return unwrapped;
	}
	if (typeof unwrapped === "object") {
		const record = unwrapped as Record<string, unknown>;
		const logs = Array.isArray(record.logs)
			? record.logs.join("\n")
			: typeof record.logs === "string"
				? record.logs
				: "";
		const result = record.result ?? record.value ?? record.returnValue;
		const segments: string[] = [];
		if (logs) {
			segments.push(logs);
		}
		if (result !== undefined && result !== null) {
			segments.push(
				typeof result === "string" ? result : JSON.stringify(result, null, 2)
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

function StatusBadge({ status }: { status: SandboxStatus }) {
	const variant =
		status === "error"
			? "destructive"
			: status === "completed"
				? "secondary"
				: "outline";
	return (
		<Badge
			className={cn(
				"h-5 px-2 text-[11px]",
				status === "running" && "text-amber-600 dark:text-amber-400",
				status === "completed" && "text-emerald-600 dark:text-emerald-400"
			)}
			variant={variant}
		>
			{status === "running" ? (
				<svg
					aria-hidden="true"
					className="mr-1 size-2.5 animate-spin"
					fill="none"
					viewBox="0 0 16 16"
				>
					<circle
						cx="8"
						cy="8"
						r="6"
						stroke="currentColor"
						strokeDasharray="28"
						strokeDashoffset="7"
						strokeLinecap="round"
						strokeWidth="1.5"
					/>
				</svg>
			) : null}
			{STATUS_LABEL[status]}
		</Badge>
	);
}

export interface SandboxToolProps {
	chatStatus?: string;
	language?: string;
	part: any;
	title?: string;
}

/**
 * Renders an AI-generated code program alongside its execution output, mirroring
 * the AI SDK "Sandbox" element. The producer is a code-execution tool part —
 * Core's programmatic-tool-calling `execute` (input.code + logs) or any tool
 * carrying `input.code`/`input.command` and an output. Code and output each
 * render through the shared Markdown code plugin for syntax highlighting + copy.
 */
export const SandboxTool = memo(function SandboxTool({
	part,
	chatStatus,
	title,
	language = "js",
}: SandboxToolProps) {
	const status = deriveStatus(part, chatStatus);
	const code = useMemo(() => clampCode(extractCode(part)), [part]);
	const logs = useMemo(() => extractLogs(part.output), [part.output]);
	const hasLogs = logs.trim().length > 0;
	const [open, setOpen] = useState(status !== "completed");

	const headerTitle =
		title ?? ((part.input?.filename as string | undefined) || "Code sandbox");

	return (
		<Collapsible
			className="w-full overflow-hidden rounded-[var(--radius)] border border-border bg-muted/40"
			onOpenChange={setOpen}
			open={open}
		>
			<CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left">
				<IconCode className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground">
					{headerTitle}
				</span>
				<StatusBadge status={status} />
				<IconChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-panel-open:rotate-90" />
			</CollapsibleTrigger>
			<CollapsibleContent
				className={cn(
					"overflow-hidden",
					"transition-all duration-150 ease-out",
					"data-ending-style:h-0 data-starting-style:h-0",
					"[&[hidden]:not([hidden='until-found'])]:hidden"
				)}
			>
				<div className="border-border border-t">
					<Tabs className="gap-0" defaultValue="code">
						<TabsList className="mx-3 mt-2 h-8" variant="line">
							<TabsTrigger className="text-xs" value="code">
								Code
							</TabsTrigger>
							<TabsTrigger className="text-xs" value="output">
								Output
							</TabsTrigger>
						</TabsList>
						<TabsContent className="px-3 pb-2" value="code">
							<div className="max-h-[360px] overflow-auto text-[12px]">
								<Markdown content={`\`\`\`${language}\n${code}\n\`\`\``} />
							</div>
						</TabsContent>
						<TabsContent className="px-3 pb-2" value="output">
							{hasLogs ? (
								<div className="max-h-[360px] overflow-auto text-[12px]">
									<Markdown content={`\`\`\`text\n${logs}\n\`\`\``} />
								</div>
							) : (
								<div className="py-3 text-muted-foreground text-xs">
									{status === "running" ? "Waiting for output…" : "No output"}
								</div>
							)}
						</TabsContent>
					</Tabs>
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
});
