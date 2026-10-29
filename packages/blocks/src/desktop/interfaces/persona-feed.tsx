import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { compactAge } from "./interface-renderer.ts";
import { PersonaAvatar } from "./persona-avatar.tsx";
import { type FeedDay, fullTime } from "./persona-model.ts";
import {
	EmptyNote,
	PageColumn,
	PageIntro,
	Segmented,
} from "./persona-parts.tsx";

export type FeedScope = "everyone" | "persona";

function authorOf(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread,
	personaId: string | null
): InterfaceAgent | undefined {
	const ids =
		personaId && thread.agentIds.includes(personaId)
			? [personaId]
			: thread.agentIds;
	for (const id of ids) {
		const agent = snapshot.agents.find((item) => item.id === id);
		if (agent) {
			return agent;
		}
	}
	return undefined;
}

function FeedPost({
	author,
	onOpen,
	others,
	thread,
}: {
	author: InterfaceAgent | undefined;
	onOpen: (threadId: string) => void;
	others: number;
	thread: InterfaceThread;
}) {
	const status = threadStatus(thread);
	const fromUser = thread.lastMessageRole === "user";
	const title = thread.title || "Untitled";
	const tl = useLiteralMessages();
	return (
		<li>
			<article className="group/post relative -mx-3 flex gap-3 rounded-lg px-3 py-4 transition-colors hover:bg-muted/60">
				<PersonaAvatar
					agent={author}
					className="mt-0.5"
					name="You"
					showPresence
					size={40}
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<div className="flex items-baseline gap-2 text-sm">
						<span className="min-w-0 truncate">
							<span className="font-semibold">{author?.name ?? "You"}</span>
							{others > 0 ? (
								<span className="text-muted-foreground">
									{" "}
									{tl("and {others, plural, one {# other} other {# others}}", {
										others,
									})}
								</span>
							) : null}
						</span>
						<span className="ml-auto flex shrink-0 items-baseline gap-1.5 text-muted-foreground text-xs">
							<span
								className={cn(status === "attention" && "text-destructive")}
							>
								{THREAD_STATUS_LABELS[status]}
							</span>
							<span aria-hidden="true">·</span>
							<time
								className="tabular-nums"
								dateTime={thread.updatedAt}
								title={fullTime(thread.updatedAt)}
							>
								{compactAge(thread.updatedAt)}
							</time>
						</span>
					</div>
					<h3 className="text-sm">
						<button
							className="text-left font-medium text-foreground outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring"
							onClick={() => onOpen(thread.id)}
							type="button"
						>
							{title}
						</button>
					</h3>
					<p className="line-clamp-3 text-pretty text-foreground/80 text-sm leading-5">
						{fromUser ? (
							<span className="text-muted-foreground">You: </span>
						) : null}
						{thread.lastMessage}
					</p>
				</div>
			</article>
		</li>
	);
}

/**
 * Feed: what every agent has been saying, newest first, as posts grouped by
 * day. Each post is the latest message of a conversation and opens it.
 */
export function PersonaFeed({
	days,
	onOpen,
	onScopeChange,
	persona,
	scope,
	snapshot,
}: {
	days: FeedDay[];
	onOpen: (threadId: string) => void;
	onScopeChange: (scope: FeedScope) => void;
	persona: InterfaceAgent;
	scope: FeedScope;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	return (
		<PageColumn>
			<PageIntro
				action={
					<Segmented
						label="Whose updates"
						onChange={onScopeChange}
						options={[
							{ label: "Everyone", value: "everyone" },
							{ label: persona.name, value: "persona" },
						]}
						value={scope}
					/>
				}
				id="persona-feed-title"
				title="Feed"
			/>
			{days.length === 0 ? (
				<EmptyNote>
					{scope === "persona"
						? tl("No updates from {name} yet.", { name: persona.name })
						: "No updates yet. Messages from your agents show up here."}
				</EmptyNote>
			) : null}
			{days.map((day) => (
				<section aria-labelledby={`persona-feed-${day.key}`} key={day.key}>
					<h3
						className="sticky top-0 z-10 bg-background pt-8 pb-2 font-medium text-foreground/80 text-xs"
						id={`persona-feed-${day.key}`}
					>
						{day.label}
					</h3>
					<ul className="flex flex-col divide-y divide-border/60">
						{day.threads.map((thread) => {
							const author = authorOf(
								snapshot,
								thread,
								scope === "persona" ? persona.id : null
							);
							return (
								<FeedPost
									author={author}
									key={thread.id}
									onOpen={onOpen}
									others={Math.max(0, thread.agentIds.length - 1)}
									thread={thread}
								/>
							);
						})}
					</ul>
				</section>
			))}
		</PageColumn>
	);
}
