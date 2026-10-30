import {
	AlertCircleIcon,
	Clock01Icon,
	ZapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { InlineErrorRow } from "@/src/components/chat/InlineErrorRow.tsx";
import type { RunSpan } from "@/src/lib/api/runs.ts";
import { spanDuration } from "./AgentObservabilityView-audit.ts";

export function SummaryCard({
	label,
	value,
	detail,
	tone,
}: {
	label: string;
	value: string;
	detail?: string;
	tone?: string;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<span className="text-detail text-muted-foreground">{label}</span>
			<span className={cn("font-medium text-xl tabular-nums", tone)}>
				{value}
			</span>
			{detail ? (
				<span className="text-muted-foreground/70 text-xs tabular-nums">
					{detail}
				</span>
			) : null}
		</div>
	);
}

export function TraceRow({ span }: { span: RunSpan }) {
	const tl = useLiteralMessages();
	const failed = Boolean(span.error);
	const model = span.kind === "model-call";
	return (
		<div className="flex items-start gap-2 border-border border-t py-2 text-sm first:border-t-0">
			<HugeiconsIcon
				aria-hidden="true"
				className={cn(
					"mt-0.5 size-4 shrink-0",
					failed ? "text-status-destructive" : "text-muted-foreground"
				)}
				icon={failed ? AlertCircleIcon : model ? ZapIcon : Clock01Icon}
			/>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-medium">{span.name}</span>
					<span className="text-muted-foreground text-xs">{span.kind}</span>
					<span className="text-muted-foreground/70 text-xs tabular-nums">
						{spanDuration(span)}
					</span>
				</div>
				{failed ? (
					<InlineErrorRow
						className="h-6"
						details={span.error}
						message="This span failed."
					/>
				) : (
					<p className="mt-0.5 text-detail text-muted-foreground">
						{span.argsHash
							? tl("tool input fingerprint {fingerprint}…", {
									fingerprint: span.argsHash.slice(0, 12),
								})
							: "Completed without a persisted payload"}
					</p>
				)}
			</div>
		</div>
	);
}
