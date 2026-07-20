// apps/desktop/src/components/chat/PartInspector.tsx
//
// A LobeChat "portal"-style inspector for a single rendered message part, shown
// in the right panel. Pretty-prints the raw shape of whatever the transcript
// clicked — a tool call, a generated image/file part, or the sources/citations
// strip — so the user can read exactly what the agent sent and got back:
//
//   • Type / tool name / call id / state (the identity line).
//   • Arguments — the part's raw `input`.
//   • Result    — the part's raw `output` (or legacy `result`).
//   • Metadata  — any remaining fields (timing, provider metadata, citations …).
//
// The whole part copies as JSON with one click. Serialization is guarded for
// large and circular payloads so a pathological part never crashes the panel.

import {
	Analytics01Icon,
	Copy01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useState } from "react";

// A rendered part is an opaque AI-SDK shape; we read it defensively.
export type InspectedPart = unknown;

// Cap serialized output so a huge tool result (e.g. a full-file Read) can't lock
// up the panel; the tail is dropped with a visible marker.
const MAX_JSON_CHARS = 200_000;
const COPIED_RESET_MS = 2000;
const TOOL_PREFIX = "tool-";

const META_OWN_KEYS = new Set([
	"type",
	"input",
	"output",
	"result",
	"state",
	"toolCallId",
	"toolName",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

// JSON.stringify with a circular-reference guard, bigint coercion, and a length
// cap. Never throws — a non-serializable value degrades to a readable message.
function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	let json: string | undefined;
	try {
		json = JSON.stringify(
			value,
			(_key, val) => {
				if (typeof val === "bigint") {
					return val.toString();
				}
				if (typeof val === "function") {
					return "[Function]";
				}
				if (isRecord(val)) {
					if (seen.has(val)) {
						return "[Circular]";
					}
					seen.add(val);
				}
				return val;
			},
			2
		);
	} catch (err) {
		return `Unable to serialize: ${
			err instanceof Error ? err.message : String(err)
		}`;
	}
	if (json === undefined) {
		return String(value);
	}
	if (json.length > MAX_JSON_CHARS) {
		return `${json.slice(0, MAX_JSON_CHARS)}\n… (truncated, ${json.length} chars total)`;
	}
	return json;
}

interface PartFacts {
	args: unknown;
	metadata: Record<string, unknown> | null;
	result: unknown;
	state?: string;
	toolCallId?: string;
	toolName?: string;
	type: string;
}

function deriveFacts(part: InspectedPart): PartFacts {
	if (!isRecord(part)) {
		return {
			type: typeof part,
			args: undefined,
			result: undefined,
			metadata: null,
		};
	}
	const type = typeof part.type === "string" ? part.type : "unknown";
	let toolName: string | undefined;
	if (type === "dynamic-tool") {
		toolName =
			typeof part.toolName === "string" ? part.toolName : "dynamic-tool";
	} else if (type.startsWith(TOOL_PREFIX)) {
		toolName = type.slice(TOOL_PREFIX.length);
	}

	const metadataEntries = Object.entries(part).filter(
		([key, val]) => !META_OWN_KEYS.has(key) && val !== undefined
	);
	const metadata =
		metadataEntries.length > 0 ? Object.fromEntries(metadataEntries) : null;

	return {
		type,
		toolName,
		toolCallId:
			typeof part.toolCallId === "string" ? part.toolCallId : undefined,
		state: typeof part.state === "string" ? part.state : undefined,
		args: part.input,
		result: part.output ?? part.result,
		metadata,
	};
}

function CopyJsonButton({ value }: { value: string }) {
	const [copied, setCopied] = useState(false);
	const handleCopy = () => {
		navigator.clipboard
			.writeText(value)
			.then(() => {
				setCopied(true);
				window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
			})
			.catch(() => {
				/* clipboard denied — leave the button idle */
			});
	};
	return (
		<button
			className="flex shrink-0 items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted/60 hover:text-foreground"
			onClick={handleCopy}
			type="button"
		>
			<HugeiconsIcon
				className="size-3.5"
				icon={copied ? Tick02Icon : Copy01Icon}
			/>
			{copied ? "Copied" : "Copy JSON"}
		</button>
	);
}

function MetaChip({ label, value }: { label: string; value: string }) {
	return (
		<span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 font-mono text-[11px]">
			<span className="text-muted-foreground">{label}</span>
			<span className="text-foreground">{value}</span>
		</span>
	);
}

function JsonBlock({ value }: { value: unknown }) {
	return (
		<pre className="max-h-[40vh] overflow-auto rounded-md bg-muted/40 p-2.5 font-mono text-[12px] text-foreground leading-relaxed">
			{safeStringify(value)}
		</pre>
	);
}

function Section({
	title,
	children,
	empty,
}: {
	children: ReactNode;
	empty?: boolean;
	title: string;
}) {
	return (
		<section className="flex flex-col gap-1.5">
			<h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
				{title}
			</h3>
			{empty ? (
				<p className="text-muted-foreground text-xs italic">None</p>
			) : (
				children
			)}
		</section>
	);
}

export function PartInspector({ part }: { part: InspectedPart }) {
	const facts = deriveFacts(part);
	const title = facts.toolName ?? facts.type;
	const hasArgs = facts.args !== undefined && facts.args !== null;
	const hasResult = facts.result !== undefined && facts.result !== null;

	return (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 items-center gap-2 border-border/60 border-b px-3 py-2.5">
				<HugeiconsIcon
					aria-hidden
					className="size-4 shrink-0 text-muted-foreground"
					icon={Analytics01Icon}
				/>
				<span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
					{title}
				</span>
				<CopyJsonButton value={safeStringify(part)} />
			</div>

			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
				<div className="flex flex-wrap items-center gap-1.5">
					<MetaChip label="type" value={facts.type} />
					{facts.state && <MetaChip label="state" value={facts.state} />}
					{facts.toolCallId && <MetaChip label="id" value={facts.toolCallId} />}
				</div>

				<Section empty={!hasArgs} title="Arguments">
					<JsonBlock value={facts.args} />
				</Section>

				<Section empty={!hasResult} title="Result">
					<JsonBlock value={facts.result} />
				</Section>

				{facts.metadata && (
					<Section title="Metadata">
						<JsonBlock value={facts.metadata} />
					</Section>
				)}
			</div>
		</div>
	);
}
