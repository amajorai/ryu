import {
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import type React from "react";
import {
	BookOpen,
	FolderSearch,
	GitBranch,
	Globe,
	ListTodo,
	LogOut,
	Pencil,
	Search,
	Sparkles,
	Terminal,
	XCircle,
} from "./tool-registry-icons.tsx";

export type ToolVariant = "simple" | "collapsible";

const THINKING_WORD_SPLIT_RE = /\s+/;

// Reasoning text a Thinking part carries, checking the streamed `input.thought`
// first, then a string output/result. Used for the nested-row size subtitle.
function getThoughtText(part: any): string {
	if (isNativeText(part.input?.thought)) {
		return part.input.thought;
	}
	if (isNativeText(part.output)) {
		return part.output;
	}
	if (isNativeText(part.result)) {
		return part.result;
	}
	return "";
}

export interface ToolMeta {
	icon: React.ComponentType<{ className?: string }>;
	subtitle?: (part: any) => string;
	title: (part: any) => string;
	variant: ToolVariant;
}

function getDisplayPath(filePath: string): string {
	if (!filePath) {
		return "";
	}
	const prefixes = [
		"/project/sandbox/repo/",
		"/project/sandbox/",
		"/project/",
		"/workspace/",
	];
	for (const prefix of prefixes) {
		if (filePath.startsWith(prefix)) {
			return filePath.slice(prefix.length);
		}
	}
	const worktreeMatch = filePath.match(
		/\.21st\/worktrees\/[^/]+\/[^/]+\/(.+)$/
	);
	if (worktreeMatch) {
		return worktreeMatch[1]!;
	}
	if (filePath.startsWith("/")) {
		const parts = filePath.split("/");
		const rootIndicators = ["apps", "packages", "src", "lib", "components"];
		const rootIndex = parts.findIndex((p) => rootIndicators.includes(p));
		if (rootIndex > 0) {
			return parts.slice(rootIndex).join("/");
		}
	}
	return filePath;
}

function calculateDiffStats(oldString: string, newString: string) {
	const oldLines = oldString.split("\n");
	const newLines = newString.split("\n");
	const maxLines = Math.max(oldLines.length, newLines.length);
	let addedLines = 0;
	let removedLines = 0;
	for (let i = 0; i < maxLines; i++) {
		if (oldLines[i] !== undefined && newLines[i] !== undefined) {
			if (oldLines[i] !== newLines[i]) {
				removedLines++;
				addedLines++;
			}
		} else if (oldLines[i] !== undefined) {
			removedLines++;
		} else if (newLines[i] !== undefined) {
			addedLines++;
		}
	}
	return { addedLines, removedLines };
}

/** Complete authored generic-tool metadata plus the existing mutable extension port.
 * ToolMeta's legacy callback input remains unchanged; this is not a full part DTO. */
export interface ToolMetadataRegistry {
	"tool-Agent": ToolMeta;
	"tool-Bash": ToolMeta;
	"tool-BashOutput": ToolMeta;
	"tool-cloning": ToolMeta;
	"tool-Edit": ToolMeta;
	"tool-ExitPlanMode": ToolMeta;
	"tool-Glob": ToolMeta;
	"tool-Grep": ToolMeta;
	"tool-KillShell": ToolMeta;
	"tool-NotebookEdit": ToolMeta;
	"tool-PlanWrite": ToolMeta;
	"tool-Read": ToolMeta;
	"tool-Skill": ToolMeta;
	"tool-Task": ToolMeta;
	"tool-Thinking": ToolMeta;
	"tool-TodoWrite": ToolMeta;
	"tool-WebFetch": ToolMeta;
	"tool-WebSearch": ToolMeta;
	"tool-Write": ToolMeta;
	[partType: string]: ToolMeta;
}

export const toolRegistry: ToolMetadataRegistry = {
	"tool-Task": {
		icon: Sparkles,
		title: (part) => {
			const isPending =
				part.state !== "output-available" && part.state !== "output-error";
			const subagentType = part.input?.subagent_type || "Agent";
			return isPending
				? `Running ${subagentType}`
				: `${subagentType} completed`;
		},
		subtitle: (part) => {
			const desc = part.input?.description || "";
			return desc.length > 50 ? `${desc.slice(0, 47)}…` : desc;
		},
		variant: "simple",
	},
	// Agent tool — renamed from "Task" in claude-agent-sdk 0.2.63+
	"tool-Agent": {
		icon: Sparkles,
		title: (part) => {
			const isPending =
				part.state !== "output-available" && part.state !== "output-error";
			const subagentType = part.input?.subagent_type || "Agent";
			return isPending
				? `Running ${subagentType}`
				: `${subagentType} completed`;
		},
		subtitle: (part) => {
			const desc = part.input?.description || "";
			return desc.length > 50 ? `${desc.slice(0, 47)}…` : desc;
		},
		variant: "simple",
	},
	"tool-Skill": {
		icon: Sparkles,
		title: () => "Skill",
		subtitle: (part) => part.input?.skill || "",
		variant: "simple",
	},
	"tool-Grep": {
		icon: Search,
		title: (part) => {
			const isPending =
				part.state !== "output-available" && part.state !== "output-error";
			if (isPending) {
				return "Grepping";
			}
			const numFiles =
				part.output?.numFiles || part.output?.output?.numFiles || 0;
			return numFiles > 0 ? `Grepped ${numFiles} files` : "No matches";
		},
		subtitle: (part) => {
			const pattern = part.input?.pattern || "";
			const path = part.input?.path || "";
			if (path) {
				const combined = `${pattern} in ${getDisplayPath(path)}`;
				return combined.length > 40 ? `${combined.slice(0, 37)}…` : combined;
			}
			return pattern.length > 40 ? `${pattern.slice(0, 37)}…` : pattern;
		},
		variant: "simple",
	},
	"tool-Glob": {
		icon: FolderSearch,
		title: (part) => {
			const isPending =
				part.state !== "output-available" && part.state !== "output-error";
			if (isPending) {
				return "Exploring files";
			}
			const numFiles =
				part.output?.numFiles || part.output?.output?.numFiles || 0;
			return numFiles > 0 ? `Found ${numFiles} files` : "No files found";
		},
		subtitle: (part) => {
			const pattern = part.input?.pattern || "";
			return pattern.length > 40 ? `${pattern.slice(0, 37)}…` : pattern;
		},
		variant: "simple",
	},
	"tool-Read": {
		icon: BookOpen,
		title: (part) => {
			const isPending =
				part.state !== "output-available" && part.state !== "output-error";
			return isPending ? "Reading" : "Read";
		},
		subtitle: (part) => {
			const filePath =
				part.input?.file_path || part.output?.path || part.result?.path || "";
			if (!filePath) {
				return "";
			}
			return getDisplayPath(filePath);
		},
		variant: "simple",
	},
	"tool-Edit": {
		icon: Pencil,
		title: (part) => {
			const filePath =
				part.input?.file_path || part.output?.path || part.result?.path || "";
			if (!filePath) {
				return "Edit";
			}
			return getDisplayPath(filePath).split("/").pop() || "Edit";
		},
		subtitle: (part) => {
			const isPending =
				part.state !== "output-available" && part.state !== "output-error";
			if (isPending) {
				return "";
			}
			const oldString = part.input?.old_string || "";
			const newString = part.input?.new_string || "";
			if (!(oldString || newString)) {
				return "";
			}
			if (oldString !== newString) {
				const { addedLines, removedLines } = calculateDiffStats(
					oldString,
					newString
				);
				return `+${addedLines} -${removedLines}`;
			}
			return "";
		},
		variant: "simple",
	},
	"tool-Write": {
		icon: Pencil,
		title: () => "Write",
		subtitle: (part) => {
			const filePath =
				part.input?.file_path || part.output?.path || part.result?.path || "";
			if (!filePath) {
				return "";
			}
			return getDisplayPath(filePath);
		},
		variant: "simple",
	},
	"tool-Bash": {
		icon: Terminal,
		title: (part) => {
			const isPending =
				part.state !== "output-available" && part.state !== "output-error";
			return isPending ? "Running command" : "Ran command";
		},
		subtitle: (part) => {
			const command = part.input?.command || "";
			if (!command) {
				return "";
			}
			let normalized = command.replace(/\\\s*\n\s*/g, " ").trim();
			normalized = normalized.replace(
				/\/(?:Users|home|root)\/[^\s"']+/g,
				(match: string) => getDisplayPath(match)
			);
			return normalized.length > 50
				? `${normalized.slice(0, 47)}…`
				: normalized;
		},
		variant: "simple",
	},
	"tool-WebFetch": {
		icon: Globe,
		title: (part) => {
			const isPending =
				part.state !== "output-available" && part.state !== "output-error";
			return isPending ? "Fetching" : "Fetched";
		},
		subtitle: (part) => {
			const url = part.input?.url || "";
			try {
				return new URL(url).hostname.replace("www.", "");
			} catch {
				return url.slice(0, 30);
			}
		},
		variant: "simple",
	},
	"tool-WebSearch": {
		icon: Globe,
		title: (part) => {
			const isPending =
				part.state !== "output-available" && part.state !== "output-error";
			return isPending ? "Searching web" : "Searched web";
		},
		subtitle: (part) => {
			const query = part.input?.query || "";
			return query.length > 40 ? `${query.slice(0, 37)}…` : query;
		},
		variant: "collapsible",
	},
	"tool-TodoWrite": {
		icon: ListTodo,
		title: (part) => {
			const isPending =
				part.state !== "output-available" && part.state !== "output-error";
			const action = part.input?.action || "update";
			if (isPending) {
				return action === "add" ? "Adding todo" : "Updating todos";
			}
			return action === "add" ? "Added todo" : "Updated todos";
		},
		subtitle: (part) => {
			const todos = part.input?.todos || [];
			if (todos.length === 0) {
				return "";
			}
			return `${todos.length} ${todos.length === 1 ? "item" : "items"}`;
		},
		variant: "simple",
	},
	"tool-PlanWrite": {
		icon: Sparkles,
		title: (part) => {
			const isPending =
				part.state !== "output-available" && part.state !== "output-error";
			const action = part.input?.action || "create";
			if (isPending) {
				if (action === "create") {
					return "Creating plan";
				}
				if (action === "approve") {
					return "Approving plan";
				}
				return "Updating plan";
			}
			const status = part.input?.plan?.status;
			if (status === "awaiting_approval") {
				return "Plan ready for review";
			}
			if (status === "approved") {
				return "Plan approved";
			}
			if (status === "completed") {
				return "Plan completed";
			}
			return action === "create" ? "Created plan" : "Updated plan";
		},
		variant: "simple",
	},
	"tool-ExitPlanMode": {
		icon: LogOut,
		title: (part) => {
			const isPending =
				part.state !== "output-available" && part.state !== "output-error";
			return isPending ? "Finishing plan" : "Plan complete";
		},
		variant: "simple",
	},
	"tool-NotebookEdit": {
		icon: Pencil,
		title: (part) => {
			const isPending =
				part.state !== "output-available" && part.state !== "output-error";
			return isPending ? "Editing notebook" : "Edited notebook";
		},
		subtitle: (part) => {
			const filePath = part.input?.file_path || "";
			if (!filePath) {
				return "";
			}
			return filePath.split("/").pop() || "";
		},
		variant: "simple",
	},
	"tool-BashOutput": {
		icon: Terminal,
		title: (part) => {
			const isPending =
				part.state !== "output-available" && part.state !== "output-error";
			return isPending ? "Getting output" : "Command output";
		},
		subtitle: (part) => {
			const output = part.output;
			if (isNativeText(output) && output.trim()) {
				return output.trim();
			}
			const command = part.input?.command || "";
			if (!command) {
				return "";
			}
			let normalized = command.replace(/\\\s*\n\s*/g, " ").trim();
			normalized = normalized.replace(
				/\/(?:Users|home|root)\/[^\s"']+/g,
				(match: string) => getDisplayPath(match)
			);
			return normalized.length > 50
				? `${normalized.slice(0, 47)}…`
				: normalized;
		},
		variant: "simple",
	},
	"tool-KillShell": {
		icon: XCircle,
		title: (part) => {
			const isPending =
				part.state !== "output-available" && part.state !== "output-error";
			return isPending ? "Stopping shell" : "Shell stopped";
		},
		subtitle: (part) => {
			const pid = part.input?.pid;
			return isNativeNumber(pid) ? `pid ${pid}` : "";
		},
		variant: "simple",
	},
	"tool-cloning": {
		icon: GitBranch,
		title: (part) => {
			const isPending =
				part.state !== "output-available" && part.state !== "output-error";
			return isPending ? "Cloning repo" : "Repo cloned";
		},
		subtitle: (part) => part.input?.repo ?? "",
		variant: "simple",
	},
	"tool-Thinking": {
		icon: Sparkles,
		title: (part) => {
			const isPending =
				part.state !== "output-available" && part.state !== "output-error";
			return isPending ? "Thinking…" : "Thought";
		},
		// Size hint for compact/nested Thinking rows (the full ThinkingTool card
		// renders its own richer duration + size badges). Reasoning-token count
		// isn't available on the raw part here, so fall back to a word count.
		subtitle: (part) => {
			const trimmed = getThoughtText(part).trim();
			if (!trimmed) {
				return "";
			}
			const words = trimmed
				.split(THINKING_WORD_SPLIT_RE)
				.filter(Boolean).length;
			return words > 0 ? `${words} words` : "";
		},
		variant: "collapsible",
	},
};

// MCP tool parsing lives in tool-mcp-name.ts; re-exported for stable imports.
export {
	formatToolDisplayName,
	type McpToolInfo,
	parseMcpToolType,
} from "./tool-mcp-name.ts";
