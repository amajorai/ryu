import {
	ArrowRight01Icon,
	Message01Icon,
	RoboticIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { formatTime } from "@ryu/ui/lib/timezone.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type HistoryEntry,
	relativeTime,
	statusMeta,
} from "@/src/components/agents/AgentRunHistoryView-entries.ts";
import { conversationRunStatusMeta } from "@/src/lib/conversation-run-status.ts";

function HistoryRow({
	entry,
	onOpen,
}: {
	entry: HistoryEntry;
	onOpen: (id: string) => void;
}) {
	const tl = useLiteralMessages();
	const status = statusMeta(entry.runStatus);
	return (
		<button
			className={cn(
				"group flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors duration-150",
				"hover:bg-muted hover:duration-0"
			)}
			onClick={() => onOpen(entry.id)}
			type="button"
		>
			<HugeiconsIcon
				className="size-4 shrink-0 text-muted-foreground"
				icon={entry.automated ? RoboticIcon : Message01Icon}
			/>
			<div className="flex min-w-0 flex-1 items-baseline gap-2">
				<span className="min-w-0 truncate text-sm" title={entry.title}>
					{entry.title}
				</span>
				<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
					{relativeTime(entry.updatedAt)}
					{entry.messageCount == null
						? ""
						: ` ${tl("· {messageCount} messages", { messageCount: String(entry.messageCount) })}`}
				</span>
			</div>
			{status ? (
				<Badge
					title={conversationRunStatusMeta(entry.runStatus)?.description}
					variant={status.variant}
				>
					<HugeiconsIcon
						className={cn("size-3.5", status.spin && "animate-spin")}
						icon={status.icon}
					/>
					{status.label}
				</Badge>
			) : null}
			<HugeiconsIcon
				className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
				icon={ArrowRight01Icon}
			/>
		</button>
	);
}

export function HistorySection({
	title,
	entries,
	onOpen,
}: {
	title: string;
	entries: HistoryEntry[];
	onOpen: (id: string) => void;
}) {
	if (entries.length === 0) {
		return null;
	}
	return (
		<section className="flex flex-col gap-1">
			<h4 className="flex h-7 items-center px-2 text-detail text-muted-foreground">
				{title} · {entries.length}
			</h4>
			{entries.map((entry) => (
				<HistoryRow entry={entry} key={entry.id} onOpen={onOpen} />
			))}
		</section>
	);
}

export function CompactHistoryRow({
	entry,
	onOpen,
}: {
	entry: HistoryEntry;
	onOpen: (id: string) => void;
}) {
	const tl = useLiteralMessages();
	const status = statusMeta(entry.runStatus);
	return (
		<button
			aria-label={tl("Open {title}", { title: entry.title })}
			className="group flex w-full items-start gap-3 border-border border-b px-1 py-3 text-left transition-colors duration-150 last:border-b-0 hover:bg-muted hover:duration-0"
			onClick={() => onOpen(entry.id)}
			type="button"
		>
			<HugeiconsIcon
				className="mt-0.5 size-4 shrink-0 text-muted-foreground"
				icon={status?.icon ?? (entry.automated ? RoboticIcon : Message01Icon)}
			/>
			<span className="min-w-0 flex-1">
				<span className="flex items-center justify-between gap-2">
					<span className="truncate font-medium text-sm" title={entry.title}>
						{entry.title}
					</span>
					<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
						{formatTime(entry.updatedAt, {
							hour: "numeric",
							minute: "2-digit",
						})}
					</span>
				</span>
				{entry.preview ? (
					<span className="mt-0.5 line-clamp-2 block text-detail text-muted-foreground">
						{entry.preview}
					</span>
				) : null}
				{status ? (
					<span className="mt-0.5 block text-muted-foreground text-xs">
						{status.label}
					</span>
				) : null}
			</span>
		</button>
	);
}
