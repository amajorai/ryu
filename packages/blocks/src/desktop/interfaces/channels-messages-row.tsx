import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import {
	Check,
	ChevronRight,
	Copy,
	MessageSquareText,
	Pin,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ChannelsAvatar } from "./channels-avatar.tsx";
import { LINK_INK, MAX_THREAD_FACES } from "./channels-messages-constants.ts";
import { Highlighted } from "./channels-messages-search.tsx";
import { clockTime, lastReplyPhrase } from "./channels-time.ts";
import { agentById } from "./interface-renderer.ts";

/** How long the Copy action shows its confirmation. */
const COPIED_RESET_MS = 1600;

export interface MessageAuthor {
	agent?: InterfaceAgent;
	isAgent: boolean;
	key: string;
	name: string;
}

/** A run that ended without finishing: worth a word on the thread bar. */
type StoppedRun = "failed" | "interrupted" | null;

export function MessageRow({
	active,
	afterDivider,
	author,
	compact,
	highlight,
	now,
	onOpenThread,
	showAppTag,
	snapshot,
	thread,
}: {
	active: boolean;
	afterDivider: boolean;
	author: MessageAuthor;
	compact: boolean;
	/** The search text to mark in the message. */
	highlight: string | null;
	now: number;
	onOpenThread: (threadId: string) => void;
	showAppTag: boolean;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread;
}) {
	const time = clockTime(thread.updatedAt);
	const replies = Math.max(0, thread.messageCount - 1);
	const faces = thread.agentIds
		.map((agentId) => agentById(snapshot, agentId))
		.filter((agent): agent is InterfaceAgent => agent !== undefined)
		.slice(0, MAX_THREAD_FACES);
	const title = thread.title || "Untitled";
	const body =
		thread.lastMessage && thread.lastMessage.trim() !== title.trim()
			? thread.lastMessage
			: null;
	// Copy what the message shows: its title, then its latest text.
	const copyText = body ? `${title}\n${body}` : title;
	let stopped: StoppedRun = null;
	if (!thread.running && thread.runState === "failed") {
		stopped = "failed";
	} else if (!thread.running && thread.runState === "interrupted") {
		stopped = "interrupted";
	}
	return (
		<article
			aria-label={`${author.name}, ${time}: ${title}`}
			className={cn(
				"group relative flex flex-col px-5 transition-colors",
				compact ? "py-0.5" : "py-2",
				thread.pinned &&
					!active &&
					"bg-warning/5 hover:bg-warning/10 has-[:focus-visible]:bg-warning/10",
				active && "bg-primary/10",
				!(thread.pinned || active) &&
					"hover:bg-muted/60 has-[:focus-visible]:bg-muted/60"
			)}
		>
			{thread.pinned ? (
				// Its own row above the message, so the avatar still lines up
				// with the author line below it.
				<p className="flex gap-3 text-foreground/80 text-xs leading-5">
					<span className="flex w-9 shrink-0 items-center justify-end">
						<Pin aria-hidden="true" className="size-3 text-warning" />
					</span>
					Pinned by you
				</p>
			) : null}
			<div className="flex gap-3">
				<div className="flex w-9 shrink-0 justify-center">
					{compact ? (
						<span className="invisible whitespace-nowrap text-foreground/70 text-xs tabular-nums leading-6 group-hover:visible group-has-[:focus-visible]:visible">
							{time.replace(/\s?[AP]M$/, "")}
						</span>
					) : (
						<ChannelsAvatar
							agent={author.agent}
							className="mt-0.5"
							name={author.name}
							size={36}
						/>
					)}
				</div>
				<div className="min-w-0 flex-1">
					{compact ? null : (
						<p className="flex min-w-0 items-baseline gap-1.5">
							<span className="truncate font-bold text-foreground text-sm leading-6">
								{author.name}
							</span>
							{showAppTag ? (
								<span className="shrink-0 rounded-sm bg-muted px-1 font-semibold text-foreground/90 text-xs leading-4">
									App
								</span>
							) : null}
							<time
								className="shrink-0 whitespace-nowrap text-foreground/70 text-xs tabular-nums leading-6"
								dateTime={thread.updatedAt}
							>
								{time}
							</time>
						</p>
					)}
					<p className="max-w-[720px] whitespace-pre-wrap break-words font-semibold text-foreground text-sm leading-6">
						<Highlighted needle={highlight} text={title} />
					</p>
					{body ? (
						<p className="line-clamp-2 max-w-[720px] whitespace-pre-wrap break-words text-foreground text-sm leading-6">
							<Highlighted needle={highlight} text={body} />
						</p>
					) : null}
					{replies > 0 || thread.running || stopped ? (
						<ThreadBar
							faces={faces}
							now={now}
							onOpen={() => onOpenThread(thread.id)}
							replies={replies}
							running={thread.running}
							stopped={stopped}
							title={title}
							updatedAt={thread.updatedAt}
							workerName={faces[0]?.name}
						/>
					) : null}
				</div>
			</div>
			<div
				className={cn(
					"absolute right-5 z-20 flex rounded-lg border border-border bg-popover p-0.5 text-popover-foreground opacity-0 shadow-sm transition-opacity duration-100 motion-reduce:transition-none",
					"group-hover:opacity-100 group-has-[:focus-visible]:opacity-100",
					// Under a day divider the toolbar would sit on the rule.
					afterDivider ? "top-1" : "-top-4"
				)}
			>
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								aria-label="Reply in thread"
								className="text-foreground/70"
								data-message-action=""
								onClick={() => onOpenThread(thread.id)}
								size="icon-sm"
								variant="ghost-muted"
							/>
						}
					>
						<MessageSquareText aria-hidden="true" />
					</TooltipTrigger>
					<TooltipContent side="top">Reply in thread</TooltipContent>
				</Tooltip>
				<CopyMessageButton text={copyText} />
			</div>
		</article>
	);
}

/**
 * Copies the message text to the clipboard and confirms in place (icon,
 * tooltip and a polite live announcement), or says so when the clipboard
 * is unavailable.
 */
function CopyMessageButton({ text }: { text: string }) {
	const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
	useEffect(() => {
		if (state === "idle") {
			return;
		}
		const timer = window.setTimeout(() => setState("idle"), COPIED_RESET_MS);
		return () => window.clearTimeout(timer);
	}, [state]);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setState("copied");
		} catch {
			setState("failed");
		}
	};
	let label = "Copy message";
	if (state === "copied") {
		label = "Copied";
	} else if (state === "failed") {
		label = "Couldn't copy";
	}
	return (
		<>
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							aria-label="Copy message"
							className={cn(
								"text-foreground/70",
								state === "copied" && "text-success hover:text-success"
							)}
							data-message-action=""
							onClick={copy}
							size="icon-sm"
							variant="ghost-muted"
						/>
					}
				>
					{state === "copied" ? (
						<Check aria-hidden="true" />
					) : (
						<Copy aria-hidden="true" />
					)}
				</TooltipTrigger>
				<TooltipContent side="top">{label}</TooltipContent>
			</Tooltip>
			<span aria-live="polite" className="sr-only">
				{state === "idle" ? "" : label}
			</span>
		</>
	);
}

function ThreadBar({
	faces,
	now,
	onOpen,
	replies,
	running,
	stopped,
	title,
	updatedAt,
	workerName,
}: {
	faces: InterfaceAgent[];
	now: number;
	onOpen: () => void;
	replies: number;
	running: boolean;
	stopped: StoppedRun;
	title: string;
	updatedAt: string;
	workerName?: string;
}) {
	const tl = useLiteralMessages();
	const stoppedLabel = stopped === "failed" ? "Run failed" : "Run interrupted";
	const repliesLabel = replies === 1 ? "1 reply" : `${replies} replies`;
	const last = lastReplyPhrase(updatedAt, now);
	const workingLabel = workerName
		? tl("{workerName} is working…", { workerName })
		: "Working…";
	let summary =
		replies > 0
			? tl("{repliesLabel}, last reply {last}", { last, repliesLabel })
			: workingLabel;
	if (stopped) {
		summary =
			replies > 0
				? `${repliesLabel}, ${stoppedLabel.toLowerCase()}`
				: stoppedLabel;
	}
	return (
		<button
			aria-label={`${summary}: ${title}`}
			className="group/bar mt-1 -ml-1 flex w-full max-w-[728px] items-center gap-2 rounded-md p-1 text-left outline-hidden transition-colors hover:bg-background hover:ring-1 hover:ring-border focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring"
			data-message-action=""
			onClick={onOpen}
			type="button"
		>
			{faces.length > 0 ? (
				// Separate tiles with a hairline gap, as a team chat lays out
				// the faces of a thread's participants.
				<span className="flex gap-1">
					{faces.map((face) => (
						<ChannelsAvatar
							agent={face}
							key={face.id}
							name={face.name}
							size={20}
						/>
					))}
				</span>
			) : null}
			{replies > 0 ? (
				<span
					className={cn(
						"shrink-0 whitespace-nowrap font-semibold text-xs underline-offset-2 group-hover/bar:underline",
						LINK_INK
					)}
				>
					{repliesLabel}
				</span>
			) : null}
			{running ? (
				<span className="flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap text-foreground text-xs">
					<span
						aria-hidden="true"
						className="size-2 shrink-0 rounded-full bg-success"
					/>
					{workingLabel}
				</span>
			) : null}
			{stopped ? (
				<span className="shrink-0 whitespace-nowrap font-semibold text-destructive text-xs">
					{stoppedLabel}
				</span>
			) : null}
			{replies > 0 ? (
				<span className="@max-[420px]/channel:hidden min-w-0 truncate text-foreground/70 text-xs group-hover/bar:hidden group-focus-visible/bar:hidden">
					{tl("Last reply {last}", { last })}
				</span>
			) : null}
			<span className="ml-auto hidden shrink-0 items-center gap-0.5 whitespace-nowrap pr-1 text-foreground/70 text-xs group-hover/bar:flex group-focus-visible/bar:flex">
				View thread
				<ChevronRight aria-hidden="true" className="size-4" />
			</span>
		</button>
	);
}
