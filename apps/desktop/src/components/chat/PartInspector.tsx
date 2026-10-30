import {
	isNativeBigInt,
	isNativeFunction,
	isNativeObjectReceiver,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
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
import { MorphIconSwap } from "@ryu/ui/components/morph-icon.tsx";
import { type ReactNode, useState } from "react";
import { z } from "zod";

// Inspector input stays opaque; each displayed field is observed defensively.

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

const inspectedPartSchema = z.looseObject({
	type: z.unknown(),
	toolName: z.unknown(),
	toolCallId: z.unknown(),
	state: z.unknown(),
	input: z.unknown(),
	output: z.unknown(),
	result: z.unknown(),
});
const primitiveKinds = [
	[z.string(), "string"],
	[z.number(), "number"],
	[z.nan(), "number"],
	[z.literal(Number.POSITIVE_INFINITY), "number"],
	[z.literal(Number.NEGATIVE_INFINITY), "number"],
	[z.boolean(), "boolean"],
	[z.bigint(), "bigint"],
	[z.symbol(), "symbol"],
	[z.function(), "function"],
	[z.undefined(), "undefined"],
] as const;

// JSON.stringify with a circular-reference guard, bigint coercion, and a length
// cap. Never throws — a non-serializable value degrades to a readable message.
function safeStringify<TValue>(value: TValue): string {
	const seen = new WeakSet<object>();
	let json: string | undefined;
	try {
		json = JSON.stringify(
			value,
			(_key, val) => {
				if (isNativeBigInt(val)) {
					return val.toString();
				}
				if (isNativeFunction(val)) {
					return "[Function]";
				}
				if (isNativeObjectReceiver(val)) {
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

function deriveFacts<TPart>(value: TPart) {
	const parsed = inspectedPartSchema.safeParse(value);
	if (!parsed.success) {
		return {
			type:
				primitiveKinds.find(
					([schema]) => schema.safeParse(value).success
				)?.[1] ?? "object",
			args: undefined,
			result: undefined,
			metadata: null,
		};
	}
	const part = parsed.data;
	const type = isNativeText(part.type) ? part.type : "unknown";
	let toolName: string | undefined;
	if (type === "dynamic-tool") {
		toolName = isNativeText(part.toolName) ? part.toolName : "dynamic-tool";
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
		toolCallId: isNativeText(part.toolCallId) ? part.toolCallId : undefined,
		state: isNativeText(part.state) ? part.state : undefined,
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
			className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted/60 hover:text-foreground"
			onClick={handleCopy}
			type="button"
		>
			<MorphIconSwap
				a={Copy01Icon}
				b={Tick02Icon}
				className="size-3.5"
				state={copied ? "b" : "a"}
			/>
			{copied ? "Copied" : "Copy JSON"}
		</button>
	);
}

function MetaChip({ label, value }: { label: string; value: string }) {
	return (
		<span className="inline-flex items-center gap-1 rounded-lg bg-muted/60 px-2 py-0.5 font-mono text-xs">
			<span className="text-muted-foreground">{label}</span>
			<span className="text-foreground">{value}</span>
		</span>
	);
}

function JsonBlock({ value }: { value: unknown }) {
	return (
		<pre className="max-h-[40vh] overflow-auto rounded-lg bg-muted/40 p-2.5 font-mono text-foreground text-xs leading-relaxed">
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
			<h3 className="font-semibold text-foreground text-sm">{title}</h3>
			{empty ? (
				<p className="text-muted-foreground text-xs italic">None</p>
			) : (
				children
			)}
		</section>
	);
}

export function PartInspector({ part }: { part: unknown }) {
	const facts = deriveFacts(part);
	const title = facts.toolName ?? facts.type;
	const hasArgs = facts.args !== undefined && facts.args !== null;
	const hasResult = facts.result !== undefined && facts.result !== null;

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-10 shrink-0 items-center gap-2 border-border border-b px-3">
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

			<div className="scroll-fade flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
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
