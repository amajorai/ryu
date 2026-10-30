import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	useId,
	useState,
} from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { plural, wikiAgent, wikiAgo, wikiThreadTitle } from "./wiki-model.ts";
import { Dot } from "./wiki-pages-marks.tsx";
import { LINK, WikiFooter } from "./wiki-parts.tsx";

// ---------------------------------------------------------------------------
// Talk pages (agents, groups, main page): topics plus "Add topic"
// ---------------------------------------------------------------------------

export function TopicForm({
	agents,
	className,
	label,
	onSubmit,
	placeholder,
	submitLabel = "Add topic",
}: {
	/** Offer a recipient picker when more than one agent could answer. */
	agents?: InterfaceAgent[];
	className?: string;
	label: string;
	onSubmit: (input: { agentId?: string; prompt: string }) => void;
	placeholder: string;
	submitLabel?: string;
}) {
	const fieldId = useId();
	const pickerId = useId();
	const [prompt, setPrompt] = useState("");
	const [agentId, setAgentId] = useState("");
	const trimmed = prompt.trim();
	const pick = agents && agents.length > 1;
	const recipient = agents?.some((agent) => agent.id === agentId)
		? agentId
		: undefined;
	const submit = () => {
		if (!trimmed) {
			return;
		}
		onSubmit({ agentId: recipient, prompt: trimmed });
		setPrompt("");
	};
	const onFormSubmit = (event: FormEvent) => {
		event.preventDefault();
		submit();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (
			event.key === "Enter" &&
			!event.shiftKey &&
			!event.nativeEvent.isComposing
		) {
			event.preventDefault();
			submit();
		}
	};
	return (
		<form
			className={cn("flex flex-col gap-2", className)}
			onSubmit={onFormSubmit}
		>
			<label className="font-semibold text-sm leading-6" htmlFor={fieldId}>
				{label}
			</label>
			<textarea
				className="min-h-24 w-full resize-y rounded-[2px] border border-input bg-background px-3 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground hover:border-ring/60 focus:border-ring focus:ring-1 focus:ring-ring"
				id={fieldId}
				maxLength={8000}
				onChange={(event) => setPrompt(event.target.value)}
				onKeyDown={onKeyDown}
				placeholder={placeholder}
				value={prompt}
			/>
			<div className="flex flex-wrap items-center justify-between gap-2">
				{pick ? (
					<span className="flex items-center gap-2 text-sm">
						<label className="text-muted-foreground" htmlFor={pickerId}>
							Ask
						</label>
						<select
							className="h-8 rounded-[2px] border border-input bg-background px-2 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
							id={pickerId}
							onChange={(event) => setAgentId(event.target.value)}
							value={recipient ?? ""}
						>
							<option value="">Any agent</option>
							{agents.map((agent) => (
								<option key={agent.id} value={agent.id}>
									{agent.name}
								</option>
							))}
						</select>
					</span>
				) : (
					<span className="text-muted-foreground text-xs leading-5">
						Enter to send, Shift+Enter for a new line
					</span>
				)}
				<button
					className="h-8 cursor-pointer rounded-[2px] bg-primary px-4 font-medium text-primary-foreground text-sm outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:bg-primary/80 disabled:cursor-default disabled:opacity-50"
					disabled={!trimmed}
					type="submit"
				>
					{submitLabel}
				</button>
			</div>
		</form>
	);
}

export function TalkPage({
	agents,
	intro,
	now,
	onOpenThread,
	onStart,
	pageTitle,
	snapshot,
	threads,
}: {
	agents?: InterfaceAgent[];
	intro: ReactNode;
	now: number;
	onOpenThread: (threadId: string) => void;
	onStart: (input: { agentId?: string; prompt: string }) => void;
	pageTitle: string;
	snapshot: InterfaceSnapshot;
	threads: InterfaceThread[];
}) {
	const tl = useLiteralMessages();
	return (
		<div className="pt-4">
			<div className="border border-border bg-muted/40 px-3 py-2 text-sm leading-6">
				{intro}
			</div>
			<TopicForm
				agents={agents}
				className="mt-4"
				label="Add a topic"
				onSubmit={onStart}
				placeholder={tl("Start a new thread about {pageTitle}", { pageTitle })}
			/>
			{threads.length > 0 ? (
				<ul className="mt-2">
					{threads.map((thread) => (
						<TopicItem
							key={thread.id}
							now={now}
							onOpen={() => onOpenThread(thread.id)}
							snapshot={snapshot}
							thread={thread}
						/>
					))}
				</ul>
			) : (
				<p className="mt-6 text-muted-foreground text-sm italic leading-6">
					There are no topics on this page yet.
				</p>
			)}
			<WikiFooter edited={null} />
		</div>
	);
}

function TopicItem({
	now,
	onOpen,
	snapshot,
	thread,
}: {
	now: number;
	onOpen: () => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread;
}) {
	const tl = useLiteralMessages();
	const status = threadStatus(thread);
	const author =
		thread.lastMessageRole === "user"
			? "You"
			: (wikiAgent(snapshot, thread.agentIds[0])?.name ?? "Agent");
	return (
		<li className="pt-4">
			<h2 className="border-border border-b pb-1 font-normal font-serif text-[22px] leading-8">
				<button
					className={cn(LINK, "cursor-pointer text-left")}
					onClick={onOpen}
					type="button"
				>
					{wikiThreadTitle(thread)}
				</button>
			</h2>
			<p className="mt-1 flex flex-wrap items-center gap-x-2 text-[13px] text-muted-foreground leading-5">
				<span>
					{tl("Latest comment: {ago}", { ago: wikiAgo(thread.updatedAt, now) })}
				</span>
				<Dot />
				<span>{plural(thread.messageCount, "comment")}</span>
				<Dot />
				<span className="inline-flex items-center gap-1.5">
					<BoardStatusDot status={status} />
					{THREAD_STATUS_LABELS[status]}
				</span>
			</p>
			{thread.lastMessage ? (
				<p className="mt-2 line-clamp-2 text-sm leading-6">
					{thread.lastMessage}{" "}
					<span className="text-muted-foreground">
						&mdash; {author}, {wikiAgo(thread.updatedAt, now)}
					</span>
				</p>
			) : null}
		</li>
	);
}
