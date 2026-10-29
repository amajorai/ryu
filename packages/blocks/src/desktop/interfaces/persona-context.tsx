import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ChevronRight, Plus, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { compactAge } from "./interface-renderer.ts";
import type { PersonaGoal, PersonaIdea, PersonaTab } from "./persona-model.ts";

/** How many rows each section previews before "See all". */
const PREVIEW_ROWS = 3;

/** Statuses that suggest a next step, most urgent first, with its verb. */
const NEXT_STEP: Partial<Record<ThreadStatus, { rank: number; verb: string }>> =
	{
		attention: { rank: 0, verb: "Check what stopped in" },
		"your-turn": { rank: 1, verb: "Reply in" },
		working: { rank: 2, verb: "Follow" },
	};

interface NextAction {
	key: string;
	label: string;
	status: ThreadStatus | null;
	threadId: string | null;
}

/**
 * Two or three suggested next steps from the persona's threads: whatever
 * failed, then replies waiting on you, then running work. Each one only
 * opens a thread (or starts an empty side chat); nothing is sent.
 */
export function personaNextActions(
	threads: readonly InterfaceThread[],
	activeThreadId: string | null
): NextAction[] {
	const actions: NextAction[] = [];
	const ranked = threads
		.filter((thread) => thread.id !== activeThreadId)
		.map((thread) => ({ status: threadStatus(thread), thread }))
		.filter(({ status }) => NEXT_STEP[status] !== undefined)
		.sort(
			(a, b) =>
				(NEXT_STEP[a.status]?.rank ?? 9) - (NEXT_STEP[b.status]?.rank ?? 9)
		);
	for (const { status, thread } of ranked.slice(0, PREVIEW_ROWS)) {
		actions.push({
			key: thread.id,
			label: `${NEXT_STEP[status]?.verb} ${thread.title || "Untitled"}`,
			status,
			threadId: thread.id,
		});
	}
	if (actions.length < 2) {
		actions.push({
			key: "new",
			label: "Start a side chat on something new",
			status: null,
			threadId: null,
		});
	}
	return actions;
}

const ROW =
	"flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring";

function Section({
	action,
	children,
	id,
	title,
}: {
	action?: ReactNode;
	children: ReactNode;
	id: string;
	title: string;
}) {
	return (
		<section aria-labelledby={id} className="flex flex-col gap-1">
			<div className="flex h-7 items-center justify-between px-2.5">
				<h2 className="leading-5" id={id}>
					<span className="font-sans font-semibold text-[13px] text-foreground">
						{title}
					</span>
				</h2>
				{action}
			</div>
			{children}
		</section>
	);
}

function SeeAll({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<button
			className="rounded-sm text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
			onClick={onClick}
			type="button"
		>
			{label}
		</button>
	);
}

/**
 * Chat's context column on wide windows: suggested next steps, the side
 * chats, and previews of Ideas and Goals. Every row opens a thread, starts an
 * empty side chat, or puts an idea in the box; nothing here sends.
 */
export function PersonaContext({
	activeThreadId,
	goals,
	ideas,
	now,
	onNewSideChat,
	onOpen,
	onSelectTab,
	onSuggest,
	sides,
	threads,
}: {
	activeThreadId: string | null;
	goals: readonly PersonaGoal[];
	ideas: readonly PersonaIdea[];
	now: number;
	onNewSideChat: () => void;
	onOpen: (threadId: string) => void;
	onSelectTab: (tab: PersonaTab) => void;
	onSuggest: (prompt: string) => void;
	sides: readonly InterfaceThread[];
	threads: readonly InterfaceThread[];
}) {
	const actions = personaNextActions(threads, activeThreadId);
	const tl = useLiteralMessages();
	return (
		<aside
			aria-label="Context"
			className="@min-[1280px]:flex hidden w-80 shrink-0 flex-col gap-6 overflow-y-auto border-border border-l px-3 py-5"
			data-testid="persona-context"
		>
			<Section id="persona-context-next" title="Suggested next">
				<ul className="flex flex-col gap-1.5 px-1">
					{actions.map((action) => (
						<li key={action.key}>
							<button
								className="flex w-full min-w-0 items-start gap-2.5 rounded-xl border border-border bg-background px-3 py-2.5 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
								onClick={() =>
									action.threadId ? onOpen(action.threadId) : onNewSideChat()
								}
								type="button"
							>
								<span className="flex h-5 shrink-0 items-center">
									{action.status ? (
										<BoardStatusDot status={action.status} />
									) : (
										<Plus
											aria-hidden="true"
											className="size-3.5 text-muted-foreground"
										/>
									)}
								</span>
								<span className="line-clamp-2 min-w-0 flex-1">
									{action.label}
								</span>
								<ChevronRight
									aria-hidden="true"
									className="mt-0.5 size-4 shrink-0 text-muted-foreground"
								/>
							</button>
						</li>
					))}
				</ul>
			</Section>
			<Section id="persona-context-sides" title="Side chats">
				{sides.length > 0 ? (
					<ul className="flex flex-col">
						{sides.slice(0, PREVIEW_ROWS + 1).map((thread) => {
							const status = threadStatus(thread);
							const selected = thread.id === activeThreadId;
							return (
								<li key={thread.id}>
									<button
										aria-current={selected ? "true" : undefined}
										aria-label={`${thread.title || "Untitled"}, ${THREAD_STATUS_LABELS[status]}`}
										className={cn(ROW, selected && "bg-muted font-medium")}
										onClick={() => onOpen(thread.id)}
										type="button"
									>
										<BoardStatusDot status={status} />
										<span className="min-w-0 flex-1 truncate">
											{thread.title || "Untitled"}
										</span>
										<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
											{compactAge(thread.updatedAt, now)}
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				) : (
					<p className="px-2.5 text-muted-foreground text-sm">
						No side chats yet.
					</p>
				)}
			</Section>
			{ideas.length > 0 ? (
				<Section
					action={
						<SeeAll label="All ideas" onClick={() => onSelectTab("ideas")} />
					}
					id="persona-context-ideas"
					title="Ideas"
				>
					<ul className="flex flex-col">
						{ideas.slice(0, PREVIEW_ROWS).map((idea) => (
							<li key={idea.id}>
								<button
									className={cn(ROW, "items-start")}
									onClick={() => onSuggest(idea.prompt)}
									title="Start a side chat with this in the box"
									type="button"
								>
									<Sparkles
										aria-hidden="true"
										className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
									/>
									<span className="line-clamp-2 min-w-0 flex-1">
										{idea.prompt}
									</span>
								</button>
							</li>
						))}
					</ul>
				</Section>
			) : null}
			{goals.length > 0 ? (
				<Section
					action={
						<SeeAll label="All goals" onClick={() => onSelectTab("goals")} />
					}
					id="persona-context-goals"
					title="Goals"
				>
					<ul className="flex flex-col">
						{goals.slice(0, PREVIEW_ROWS).map((goal) => {
							const latest = goal.threads.reduce<InterfaceThread | undefined>(
								(newest, thread) =>
									!newest || thread.updatedAt > newest.updatedAt
										? thread
										: newest,
								undefined
							);
							const done = goal.total === 0 ? 0 : goal.answered / goal.total;
							return (
								<li key={goal.group.id}>
									<button
										className={cn(ROW, "flex-col items-stretch gap-1.5")}
										onClick={() =>
											latest ? onOpen(latest.id) : onSelectTab("goals")
										}
										title={
											latest
												? tl("Open {threadTitle}", {
														threadTitle:
															latest.title || "the latest conversation",
													})
												: "Show goals"
										}
										type="button"
									>
										<span className="flex min-w-0 items-baseline gap-2">
											<span className="min-w-0 flex-1 truncate font-medium">
												{goal.group.name}
											</span>
											<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
												{goal.answered}/{goal.total}
											</span>
										</span>
										<span
											aria-hidden="true"
											className="h-1 overflow-hidden rounded-full bg-muted"
										>
											<span
												className="block h-full rounded-full bg-primary"
												style={{ width: `${Math.round(done * 100)}%` }}
											/>
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				</Section>
			) : null}
		</aside>
	);
}
