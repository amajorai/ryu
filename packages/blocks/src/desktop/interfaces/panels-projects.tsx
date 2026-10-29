import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { Plus } from "lucide-react";
import { useId } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { BoardStatusDot } from "./board-status.tsx";
import { compactAge } from "./interface-renderer.ts";
import {
	buildTopics,
	type PanelsTopic,
	threadAgents,
	threadExcerpt,
} from "./panels-model.ts";
import { PanelsPageHeader } from "./panels-parts.tsx";

const MEMBER_LIMIT = 4;

function TopicRow({
	now,
	onOpenThread,
	snapshot,
	thread,
}: {
	now: number;
	onOpenThread: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread;
}) {
	const lead = threadAgents(snapshot, thread)[0];
	const status = threadStatus(thread);
	return (
		<li>
			<button
				className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-md px-2 py-2.5 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
				onClick={() => onOpenThread(thread.id)}
				type="button"
			>
				<span
					className="flex w-2 shrink-0 justify-center"
					title={THREAD_STATUS_LABELS[status]}
				>
					<BoardStatusDot status={status} />
					<span className="sr-only">{THREAD_STATUS_LABELS[status]}: </span>
				</span>
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="truncate font-medium text-foreground text-sm">
						{thread.title}
					</span>
					<span className="truncate text-muted-foreground text-sm">
						{threadExcerpt(thread)}
					</span>
				</span>
				<span className="flex shrink-0 items-center gap-3 text-muted-foreground text-xs tabular-nums">
					<span className="@3xl:flex hidden w-24 items-center gap-2">
						{lead ? (
							<>
								<BoardAvatar agent={lead} name={lead.name} size={20} />
								<span className="min-w-0 truncate text-foreground/80">
									{lead.name}
								</span>
							</>
						) : null}
					</span>
					<span className="@lg:inline hidden w-20 text-right">
						{thread.messageCount}{" "}
						{thread.messageCount === 1 ? "message" : "messages"}
					</span>
					<span className="w-8 text-right">
						{compactAge(thread.updatedAt, now)}
					</span>
				</span>
			</button>
		</li>
	);
}

function TopicSection({
	now,
	onOpenThread,
	onStart,
	snapshot,
	topic,
}: {
	now: number;
	onOpenThread: (threadId: string) => void;
	onStart: (topic: PanelsTopic) => void;
	snapshot: InterfaceSnapshot;
	topic: PanelsTopic;
}) {
	const tl = useLiteralMessages();
	const headingId = useId();
	const kind = topic.group?.kind;
	const shown = topic.members.slice(0, MEMBER_LIMIT);
	const memberNames = topic.members.map((agent) => agent.name).join(", ");
	return (
		<section
			aria-labelledby={headingId}
			className="flex flex-col"
			data-testid="panels-topic"
			data-topic-id={topic.id}
		>
			<header className="mb-2 flex h-8 items-center gap-3">
				<div className="flex min-w-0 flex-1 items-baseline gap-2">
					<h2
						className="truncate font-semibold text-base text-foreground"
						id={headingId}
					>
						{topic.name}
					</h2>
					<span className="shrink-0 text-muted-foreground text-xs">
						{kind === "project" ? "Project" : null}
						{kind === "team" ? "Team" : null}
						{kind ? " · " : null}
						{topic.threads.length}{" "}
						{topic.threads.length === 1 ? "conversation" : "conversations"}
					</span>
				</div>
				{shown.length > 0 ? (
					<span
						className="@lg:flex hidden shrink-0 items-center -space-x-1.5"
						title={memberNames}
					>
						<span className="sr-only">
							{tl("Members: {memberNames}", { memberNames })}
						</span>
						{shown.map((agent) => (
							<BoardAvatar
								agent={agent}
								className="ring-2 ring-background"
								key={agent.id}
								name={agent.name}
								size={20}
							/>
						))}
					</span>
				) : null}
				{topic.group ? (
					<Button
						aria-label={tl("New conversation in {name}", { name: topic.name })}
						className="text-muted-foreground"
						onClick={() => onStart(topic)}
						size="tiny"
						title={tl("New conversation in {name}", { name: topic.name })}
						type="button"
						variant="ghost"
					>
						<Plus aria-hidden="true" className="size-3.5" />
						New
					</Button>
				) : null}
			</header>
			{topic.threads.length > 0 ? (
				<ul className="flex flex-col divide-y divide-border border-border border-t">
					{topic.threads.map((thread) => (
						<TopicRow
							key={thread.id}
							now={now}
							onOpenThread={onOpenThread}
							snapshot={snapshot}
							thread={thread}
						/>
					))}
				</ul>
			) : (
				<p className="border-border border-t py-3 text-muted-foreground text-sm">
					No conversations here yet.
				</p>
			)}
		</section>
	);
}

/**
 * Projects: every project and team as a topic, each listing its own
 * conversations, with loose conversations gathered at the end.
 */
export function PanelsProjects({
	now,
	onOpenThread,
	onStart,
	snapshot,
}: {
	now: number;
	onOpenThread: (threadId: string) => void;
	onStart: (topic: PanelsTopic) => void;
	snapshot: InterfaceSnapshot;
}) {
	const topics = buildTopics(snapshot);
	const groupCount = snapshot.groups.length;
	return (
		<div
			className="mx-auto flex w-full max-w-[66rem] flex-col gap-12 @2xl:px-8 px-4 @2xl:pt-16 pt-12 pb-16"
			data-testid="panels-projects"
		>
			<PanelsPageHeader
				description={
					groupCount > 0
						? "Each project and team, with the conversations filed under it."
						: "Conversations filed under a project or team show up here."
				}
				title="Projects"
			/>
			{topics.length === 0 ? (
				<p className="border-border border-t py-4 text-muted-foreground text-sm">
					No projects or conversations yet.
				</p>
			) : (
				topics.map((topic) => (
					<TopicSection
						key={topic.id}
						now={now}
						onOpenThread={onOpenThread}
						onStart={onStart}
						snapshot={snapshot}
						topic={topic}
					/>
				))
			)}
		</div>
	);
}
