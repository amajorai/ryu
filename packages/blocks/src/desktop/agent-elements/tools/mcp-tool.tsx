import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ToolResult,
	ToolResultOutput,
	type ToolResultOutputProps,
} from "@ryu/ui/components/agents/tool-result";
import {
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { memo, useMemo } from "react";
import { useChatDisplayPrefs } from "../chat-display-prefs.tsx";
import { areToolPropsEqual, getToolStatus } from "../utils/format-tool.ts";
import { unwrapMcpOutput } from "../utils/unwrap-mcp-output.ts";
import { ToolApprovalFooter } from "./tool-approval-footer.tsx";
import type { McpToolInfo } from "./tool-registry.ts";

export interface McpToolProps {
	chatStatus?: string;
	defaultOpen?: boolean;
	mcpInfo: McpToolInfo;
	part: any;
}

interface McpDisplayBlock {
	code: string;
	language: NonNullable<ToolResultOutputProps["language"]>;
}

const PRIORITY_ARGS = [
	"query",
	"question",
	"email",
	"name",
	"id",
	"customer",
	"url",
	"issue",
	"body",
	"summary",
	"title",
];

const ACTIVE_VERBS = new Map(
	Object.entries({
		List: "Listing",
		Get: "Getting",
		Create: "Creating",
		Update: "Updating",
		Delete: "Deleting",
		Search: "Searching",
		Fetch: "Fetching",
		Retrieve: "Retrieving",
		Send: "Sending",
		Generate: "Generating",
		Add: "Adding",
		Remove: "Removing",
		Modify: "Modifying",
		Draft: "Drafting",
		Manage: "Managing",
		Query: "Querying",
		Start: "Starting",
		Set: "Setting",
		Check: "Checking",
		Find: "Finding",
	})
);

const COMPLETED_VERBS = new Map(
	Object.entries({
		List: "Listed",
		Get: "Got",
		Create: "Created",
		Update: "Updated",
		Delete: "Deleted",
		Search: "Searched",
		Fetch: "Fetched",
		Retrieve: "Retrieved",
		Send: "Sent",
		Generate: "Generated",
		Add: "Added",
		Remove: "Removed",
		Modify: "Modified",
		Draft: "Drafted",
		Manage: "Managed",
		Query: "Queried",
		Start: "Started",
		Set: "Set",
		Check: "Checked",
		Find: "Found",
	})
);

function getActiveTitle(info: McpToolInfo): string {
	const words = info.displayName.split(" ");
	const verb = words[0];
	if (!verb) {
		return info.displayName;
	}
	const rest = words.slice(1).join(" ");
	const active = ACTIVE_VERBS.get(verb);
	if (active) {
		return rest ? `${active} ${rest}` : active;
	}
	return info.displayName;
}

function getCompletedTitle(info: McpToolInfo): string {
	const words = info.displayName.split(" ");
	const verb = words[0];
	if (!verb) {
		return info.displayName;
	}
	const rest = words.slice(1).join(" ");
	const completed = COMPLETED_VERBS.get(verb);
	return completed
		? rest
			? `${completed} ${rest}`
			: completed
		: info.displayName;
}

function formatMcpArgs(input: any): string {
	if (!(input && isNativeObjectLike(input))) {
		return "";
	}
	const entries = Object.entries(input).filter(
		([, v]) => v !== undefined && v !== null && v !== ""
	);
	if (entries.length === 0) {
		return "";
	}

	const sorted = [...entries].sort(([a], [b]) => {
		const ai = PRIORITY_ARGS.indexOf(a);
		const bi = PRIORITY_ARGS.indexOf(b);
		if (ai !== -1 && bi !== -1) {
			return ai - bi;
		}
		if (ai !== -1) {
			return -1;
		}
		if (bi !== -1) {
			return 1;
		}
		return 0;
	});

	const parts: string[] = [];
	for (const [key, value] of sorted) {
		if (parts.length >= 2) {
			break;
		}
		const val = isNativeText(value) ? value : JSON.stringify(value);
		const display = val.length > 30 ? `${val.slice(0, 27)}…` : val;
		parts.push(`${key}: ${display}`);
	}
	return parts.join("  ");
}

function formatOutputForDisplay(output: any): string {
	const unwrapped = unwrapMcpOutput(output);
	if (isNativeText(unwrapped)) {
		return unwrapped.length > 3000
			? `${unwrapped.slice(0, 3000)}\n…`
			: unwrapped;
	}
	const text = JSON.stringify(unwrapped, null, 2);
	return text.length > 3000 ? `${text.slice(0, 3000)}\n…` : text;
}

export const McpTool = memo(function McpTool({
	part,
	mcpInfo,
	chatStatus,
	defaultOpen,
}: McpToolProps) {
	const { isPending, isInterrupted } = getToolStatus(part, chatStatus);
	const { expandCodeBlocks } = useChatDisplayPrefs();
	const tl = useLiteralMessages();

	const title = useMemo(() => {
		if (part.state === "input-streaming") {
			return `Preparing ${mcpInfo.displayName}`;
		}
		if (isPending) {
			return getActiveTitle(mcpInfo);
		}
		return getCompletedTitle(mcpInfo);
	}, [part.state, isPending, mcpInfo]);

	const subtitle = useMemo(() => {
		if (part.state === "input-streaming") {
			return "";
		}
		return formatMcpArgs(part.input);
	}, [part.input, part.state]);

	const displayOutput = useMemo(() => {
		if (!part.output) {
			return null;
		}
		return formatOutputForDisplay(part.output);
	}, [part.output]);

	// An MCP result is a JSON payload or a plain string — never markdown. It used
	// to be wrapped in a fence and sent through the markdown renderer purely to
	// reach a highlighter; `ToolResultOutput` highlights it directly, so the
	// payload can no longer be reinterpreted as markup on the way to the screen.
	const outputBlock = useMemo<McpDisplayBlock | null>(() => {
		const trimmed = displayOutput?.trim();
		if (!(trimmed && displayOutput)) {
			return null;
		}
		const language =
			trimmed.startsWith("{") || trimmed.startsWith("[") ? "json" : "text";
		return { code: displayOutput, language };
	}, [displayOutput]);

	// The chat tool loop (DA7) attaches an `approval` object to the part input
	// when a requested tool needs the user's go-ahead. When present, render the
	// shared approval footer so the user can approve or skip the call.
	const approval = part.input?.approval ?? part.args?.approval;

	if (isInterrupted && !part.output) {
		return (
			<span className="text-muted-foreground text-sm">
				{tl("{displayName} interrupted", {
					displayName: mcpInfo.displayName,
				})}
			</span>
		);
	}

	return (
		<div>
			<ToolResult
				collapseOnComplete={!expandCodeBlocks}
				defaultOpen={defaultOpen ?? false}
				kind="request"
				meta={subtitle || undefined}
				status={isPending ? "running" : "success"}
				title={title}
				tool={mcpInfo.displayName}
			>
				{outputBlock && (
					<ToolResultOutput language={outputBlock.language}>
						{outputBlock.code}
					</ToolResultOutput>
				)}
			</ToolResult>
			{approval && <ToolApprovalFooter isPending={isPending} {...approval} />}
		</div>
	);
}, areToolPropsEqual);
