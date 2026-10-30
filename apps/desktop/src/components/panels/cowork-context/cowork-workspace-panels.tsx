import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
	formatToolDuration,
	useToolElapsed,
} from "@ryu/blocks/desktop/agent-elements/tools/tool-timing.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useEffect, useMemo, useState } from "react";
import { MessageList } from "@/components/agent-elements/message-list.tsx";
import { SubagentAvatar } from "@/src/components/panels/subagent-identity.tsx";
import { compactAge } from "@/src/lib/time.ts";
import { SourceItemRow } from "./cowork-rows.tsx";
import { extractSources } from "./cowork-sources.ts";
import { extractSubagents, type SubagentSummary } from "./cowork-subagents.ts";
import type { CoworkContextPanelProps } from "./cowork-types.ts";

function WorkspaceListHeading({
	count,
	icon,
	title,
}: {
	count: number;
	icon: IconSvgElement;
	title: string;
}) {
	return (
		<div className="flex items-center gap-2 px-1 text-muted-foreground text-xs">
			<HugeiconsIcon aria-hidden className="size-4" icon={icon} />
			<span>{title}</span>
			<span>· {count}</span>
		</div>
	);
}

const COLLAPSED_ACTIVE_SUBAGENTS = 4;

function SubagentGroupHeading({
	count,
	title,
}: {
	count: number;
	title: string;
}) {
	return (
		<h2 className="px-1 text-muted-foreground text-xs">
			{title} <span aria-hidden>·</span> {count}
		</h2>
	);
}

function completedAge(completedAt: number | undefined): string {
	if (completedAt === undefined) {
		return "";
	}
	const age = compactAge(completedAt);
	return age === "now" ? age : `${age} ago`;
}

function SubagentRosterRow({
	onOpen,
	subagent,
}: {
	onOpen: (subagent: SubagentSummary) => void;
	subagent: SubagentSummary;
}) {
	const tl = useLiteralMessages();
	const running = subagent.status === "running";
	const elapsed = useToolElapsed(running, subagent.timing?.startedAt);
	const time = running
		? elapsed === null
			? ""
			: formatToolDuration(elapsed)
		: completedAge(subagent.timing?.completedAt);
	const state = running ? "Working" : subagent.errored ? "Failed" : "";

	return (
		<li>
			<button
				aria-label={tl("Open {title}", { title: subagent.title })}
				className="flex min-h-14 w-full min-w-0 items-start gap-3 rounded-lg px-1 py-2 text-left transition-colors duration-150 hover:bg-muted/50 active:scale-[0.99] motion-reduce:transition-none"
				onClick={() => onOpen(subagent)}
				type="button"
			>
				<SubagentAvatar
					animate={false}
					className="mt-0.5 size-5"
					seed={subagent.id}
				/>
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span
						className="truncate font-medium text-foreground text-sm"
						title={subagent.title}
					>
						{subagent.title}
					</span>
					{state && (
						<span
							className="truncate text-muted-foreground text-xs"
							title={state}
						>
							{state}
						</span>
					)}
				</span>
				{time && (
					<span className="shrink-0 pt-0.5 text-muted-foreground/70 text-xs tabular-nums">
						{time}
					</span>
				)}
			</button>
		</li>
	);
}

function SubagentTranscript({
	onBack,
	subagent,
}: {
	onBack: () => void;
	subagent: SubagentSummary;
}) {
	const running = subagent.status === "running";
	const messages = useMemo(() => {
		const last = subagent.transcript.at(-1);
		return (last?.parts?.length ?? 0) === 0
			? subagent.transcript.slice(0, -1)
			: subagent.transcript;
	}, [subagent]);
	const empty = messages.length < subagent.transcript.length;

	return (
		<div className="flex h-full flex-col" data-testid="subagent-detail">
			<div className="flex h-12 shrink-0 items-center gap-2 border-border border-b px-3">
				<button
					aria-label="Back to subagents"
					className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground active:scale-95 motion-reduce:transition-none"
					onClick={onBack}
					type="button"
				>
					<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
				</button>
				<SubagentAvatar animate={false} className="size-5" seed={subagent.id} />
				<h2
					className="min-w-0 flex-1 truncate font-medium text-foreground text-sm"
					title={subagent.title}
				>
					{subagent.title}
				</h2>
			</div>
			<div className="min-h-0 flex-1 overflow-hidden">
				<MessageList
					initialScrollBehavior="top"
					messages={messages}
					status={running ? "streaming" : "ready"}
				/>
			</div>
			{empty && (
				<div className="shrink-0 border-border border-t px-3 py-2 text-muted-foreground text-xs">
					{running
						? "No steps reported yet. The answer appears here when the task finishes."
						: subagent.errored
							? "This task ended in an error with no output to show."
							: "This task finished without returning any output."}
				</div>
			)}
		</div>
	);
}

/** Complete Codex-style run roster shown in a dedicated workspace tab. */
export function SubagentsWorkspacePanel({
	messages,
	onClearRequestedSubagent,
	requestedSubagent,
}: Pick<CoworkContextPanelProps, "messages"> & {
	onClearRequestedSubagent?: () => void;
	requestedSubagent?: { id: string; nonce: number } | null;
}) {
	const tl = useLiteralMessages();
	const subagents = useMemo(() => extractSubagents(messages), [messages]);
	const [selectedId, setSelectedId] = useState<string | null>(
		requestedSubagent?.id ?? null
	);
	const [showAllActive, setShowAllActive] = useState(false);

	useEffect(() => {
		setSelectedId(requestedSubagent?.id ?? null);
	}, [requestedSubagent]);

	const selected = selectedId
		? subagents.find((subagent) => subagent.id === selectedId)
		: undefined;
	if (selected) {
		return (
			<SubagentTranscript
				onBack={() => {
					setSelectedId(null);
					onClearRequestedSubagent?.();
				}}
				subagent={selected}
			/>
		);
	}
	const active = subagents.filter((subagent) => subagent.status === "running");
	const done = subagents.filter((subagent) => subagent.status === "done");
	const shownActive = showAllActive
		? active
		: active.slice(0, COLLAPSED_ACTIVE_SUBAGENTS);
	const hiddenActive = active.length - shownActive.length;

	if (subagents.length === 0) {
		return (
			<div className="flex h-full items-center justify-center p-4 text-center text-muted-foreground text-xs">
				Subagents will appear here when this chat delegates work.
			</div>
		);
	}

	return (
		<div
			className="h-full overflow-y-auto px-4 py-5"
			data-testid="subagents-roster"
		>
			<div className="flex flex-col gap-6">
				{active.length > 0 && (
					<section className="flex flex-col gap-2">
						<SubagentGroupHeading count={active.length} title="Active" />
						<ul className="flex flex-col gap-0.5">
							{shownActive.map((subagent) => (
								<SubagentRosterRow
									key={subagent.id}
									onOpen={(next) => setSelectedId(next.id)}
									subagent={subagent}
								/>
							))}
							{hiddenActive > 0 && (
								<li>
									<button
										className="ml-8 rounded-lg px-1 py-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground"
										onClick={() => setShowAllActive(true)}
										type="button"
									>
										{tl("Show {count} more", { count: String(hiddenActive) })}
									</button>
								</li>
							)}
						</ul>
					</section>
				)}
				{done.length > 0 && (
					<section className="flex flex-col gap-2">
						<SubagentGroupHeading count={done.length} title="Done" />
						<ul className="flex flex-col gap-0.5">
							{done.map((subagent) => (
								<SubagentRosterRow
									key={subagent.id}
									onOpen={(next) => setSelectedId(next.id)}
									subagent={subagent}
								/>
							))}
						</ul>
					</section>
				)}
			</div>
		</div>
	);
}

/** Complete source inventory; unlike the pinned summary, no rows are capped. */
export function SourcesWorkspacePanel({
	messages,
}: Pick<CoworkContextPanelProps, "messages">) {
	const sources = useMemo(() => extractSources(messages), [messages]);
	if (sources.length === 0) {
		return (
			<div className="flex h-full items-center justify-center p-4 text-center text-muted-foreground text-xs">
				Sources will appear here as this chat reads files, links and connectors.
			</div>
		);
	}

	return (
		<div className="h-full overflow-y-auto px-4 py-5">
			<div className="flex flex-col">
				{sources.map((source, index) => (
					<section
						className={cn(
							"flex flex-col gap-2 py-4 first:pt-0 last:pb-0",
							index > 0 && "border-border border-t"
						)}
						key={source.id}
					>
						<WorkspaceListHeading
							count={source.items.length}
							icon={source.icon}
							title={source.label}
						/>
						{source.items.length > 0 && (
							<ul className="flex flex-col gap-0.5">
								{source.items.map((item) => (
									<SourceItemRow item={item} key={item.id} />
								))}
							</ul>
						)}
					</section>
				))}
			</div>
		</div>
	);
}
