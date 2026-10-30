import { useLiteralMessages, useRichLiteralMessages } from "@ryu/i18n/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type InterfaceAgent,
	type InterfaceThread,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ChevronDown, ChevronsUpDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { agentHandle, compactAge } from "./interface-renderer.ts";
import { PersonaAvatar } from "./persona-avatar.tsx";
import {
	agoLabel,
	countLabel,
	dayTime,
	fullTime,
	type PersonaStatus,
	STEP_LABELS,
	type StatusDepth,
} from "./persona-model.ts";
import { PERSONA_COLUMN } from "./persona-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

const EASE = [0.2, 0, 0, 1] as const;
const MAX_STEPS = 4;

function StatusMark({ status }: { status: PersonaStatus["status"] }) {
	if (status === "idle") {
		return (
			<span
				aria-hidden="true"
				className="inline-block size-2 shrink-0 rounded-full bg-muted-foreground/40"
			/>
		);
	}
	return <BoardStatusDot status={status} />;
}

function StepDetail({ thread }: { thread: InterfaceThread }) {
	const tlRich = useRichLiteralMessages();
	return (
		<span className="flex flex-col gap-0.5 text-muted-foreground text-xs">
			<span className="tabular-nums">
				{tlRich(
					"{messageCount, plural, one {{messageCountText} message} other {{messageCountText} messages}} · last activity <time>{lastActivity}</time>",
					{
						lastActivity: dayTime(thread.updatedAt),
						messageCount: thread.messageCount,
						messageCountText: String(thread.messageCount),
					},
					{
						time: (chunks) => (
							<time
								dateTime={thread.updatedAt}
								title={fullTime(thread.updatedAt)}
							>
								{chunks}
							</time>
						),
					}
				)}
			</span>
			{thread.lastMessage ? (
				<span className="line-clamp-2 text-foreground/80">
					{thread.lastMessageRole === "user" ? "You: " : ""}
					{thread.lastMessage}
				</span>
			) : null}
		</span>
	);
}

function StepRow({
	depth,
	onOpen,
	thread,
}: {
	depth: StatusDepth;
	onOpen: (threadId: string) => void;
	thread: InterfaceThread;
}) {
	const status = threadStatus(thread);
	return (
		<li>
			<button
				className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
				onClick={() => onOpen(thread.id)}
				type="button"
			>
				<span className="flex h-5 w-2 shrink-0 items-center">
					<BoardStatusDot status={status} />
				</span>
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="flex min-w-0 items-baseline text-sm">
						<span className="min-w-0 truncate">
							{thread.title || "Untitled"}
						</span>
						<span
							className={cn(
								"shrink-0 whitespace-pre",
								status === "attention"
									? "text-destructive"
									: "text-muted-foreground"
							)}
						>
							{` · ${STEP_LABELS[status]}`}
						</span>
						<time
							className="shrink-0 whitespace-pre text-muted-foreground tabular-nums"
							dateTime={thread.updatedAt}
							title={fullTime(thread.updatedAt)}
						>
							{` · ${compactAge(thread.updatedAt)}`}
						</time>
					</span>
					{depth === 2 ? <StepDetail thread={thread} /> : null}
				</span>
			</button>
		</li>
	);
}

/**
 * The status line under the persona's name. Layer one is the essential
 * one-liner (the lead task, then its state); activating it reveals the
 * other steps (the persona's threads in motion); "Show details" adds
 * message counts and last activity for each.
 */
function StatusLine({
	depth,
	onDepthChange,
	onOpenThread,
	status,
}: {
	depth: StatusDepth;
	onDepthChange: (depth: StatusDepth) => void;
	onOpenThread: (threadId: string) => void;
	status: PersonaStatus;
}) {
	const reduceMotion = useReducedMotion();
	const stepsId = useId();
	const lead = status.steps[0];
	const others = status.steps.slice(1);
	const shown = others.slice(0, MAX_STEPS);
	const hidden = others.length - shown.length;
	const expandable = lead !== undefined;
	const { lastActiveAt, messages, threads } = status.totals;
	const tl = useLiteralMessages();

	return (
		<div className="flex w-full max-w-lg flex-col">
			<button
				aria-controls={expandable ? stepsId : undefined}
				aria-expanded={expandable ? depth > 0 : undefined}
				className="-mx-2 flex h-8 max-w-[calc(100%+1rem)] items-center gap-2 self-start rounded-md px-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring enabled:hover:bg-muted disabled:cursor-default"
				disabled={!expandable}
				onClick={() => onDepthChange(depth === 0 ? 1 : 0)}
				type="button"
			>
				<StatusMark status={status.status} />
				<span className="flex min-w-0 items-baseline">
					<span className="min-w-0 truncate">
						{lead ? lead.title || "Untitled" : status.headline}
					</span>
					{status.label ? (
						<span
							className={cn(
								"shrink-0 whitespace-pre",
								status.status === "attention"
									? "text-destructive"
									: "text-muted-foreground"
							)}
						>
							{` · ${status.label}`}
						</span>
					) : null}
					{others.length > 0 ? (
						<span className="@max-[639px]:hidden shrink-0 whitespace-pre text-muted-foreground">
							{tl(" · {count} more", { count: others.length })}
						</span>
					) : null}
				</span>
				{expandable ? (
					<ChevronDown
						aria-hidden="true"
						className={cn(
							"size-4 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
							depth > 0 && "rotate-180"
						)}
					/>
				) : null}
			</button>
			<AnimatePresence initial={false}>
				{depth > 0 && lead ? (
					<motion.div
						animate={{ height: "auto", opacity: 1 }}
						className="-mx-2 overflow-hidden"
						exit={{ height: 0, opacity: 0 }}
						initial={{ height: 0, opacity: 0 }}
						key="steps"
						transition={{ duration: reduceMotion ? 0 : 0.2, ease: EASE }}
					>
						<div
							className="flex @max-[639px]:max-h-44 flex-col gap-1 overflow-y-auto pt-1"
							id={stepsId}
						>
							{depth === 2 ? (
								<div className="flex gap-2 px-2 pb-1">
									<span aria-hidden="true" className="w-2 shrink-0" />
									<StepDetail thread={lead} />
								</div>
							) : null}
							{shown.length > 0 ? (
								<ol aria-label="Also in progress" className="flex flex-col">
									{shown.map((thread) => (
										<StepRow
											depth={depth}
											key={thread.id}
											onOpen={onOpenThread}
											thread={thread}
										/>
									))}
								</ol>
							) : (
								<p className="px-2 py-1.5 text-muted-foreground text-sm">
									Nothing else in progress
								</p>
							)}
							<div className="flex flex-wrap items-center gap-x-1.5 px-2 pb-1 text-muted-foreground text-xs">
								{depth === 2 ? (
									<span className="tabular-nums">
										{countLabel(threads, "chat")} ·{" "}
										{countLabel(messages, "message")}
										{lastActiveAt
											? tl(" · active {ago}", { ago: agoLabel(lastActiveAt) })
											: ""}
									</span>
								) : null}
								{depth !== 2 && hidden > 0 ? (
									<span>{tl("{hidden} more in Chat", { hidden })}</span>
								) : null}
								{depth === 2 || hidden > 0 ? (
									<span aria-hidden="true">·</span>
								) : null}
								<button
									aria-expanded={depth === 2}
									className="rounded-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
									onClick={() => onDepthChange(depth === 2 ? 1 : 2)}
									type="button"
								>
									{depth === 2 ? "Hide details" : "Show details"}
								</button>
							</div>
						</div>
					</motion.div>
				) : null}
			</AnimatePresence>
		</div>
	);
}

function PersonaSwitcher({
	agent,
	agents,
	onSelect,
}: {
	agent: InterfaceAgent;
	agents: InterfaceAgent[];
	onSelect: (agentId: string) => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label="Switch persona"
				className="flex @min-[1024px]:hidden size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-muted data-[popup-open]:text-foreground"
			>
				<ChevronsUpDown aria-hidden="true" className="size-4" />
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				className="w-64"
				drawerLabel="Switch persona"
			>
				<DropdownMenuGroup>
					<DropdownMenuLabel>Switch persona</DropdownMenuLabel>
					<DropdownMenuRadioGroup
						onValueChange={(value: unknown) => {
							if (typeof value === "string" && value !== agent.id) {
								onSelect(value);
							}
						}}
						value={agent.id}
					>
						{agents.map((item) => (
							<DropdownMenuRadioItem key={item.id} value={item.id}>
								<PersonaAvatar agent={item} size={20} />
								<span className="min-w-0 flex-1 truncate">{item.name}</span>
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * The persona's profile: a large face, its name and role, and the
 * three-layer status line.
 */
export function PersonaHeader({
	agent,
	agents,
	compact = false,
	depth,
	joined = false,
	onDepthChange,
	onOpenThread,
	onSelectPersona,
	status,
}: {
	agent: InterfaceAgent;
	agents: InterfaceAgent[];
	/** A thread is open: a smaller face so the conversation gets the room. */
	compact?: boolean;
	depth: StatusDepth;
	/** The side-chat strip follows directly: share its band, no rule between. */
	joined?: boolean;
	onDepthChange: (depth: StatusDepth) => void;
	onOpenThread: (threadId: string) => void;
	onSelectPersona: (agentId: string) => void;
	status: PersonaStatus;
}) {
	return (
		<header
			className={cn(
				"shrink-0",
				joined ? "bg-muted/30" : "border-border border-b"
			)}
		>
			<div
				className={cn(
					PERSONA_COLUMN,
					"flex",
					compact
						? "gap-3 py-3"
						: "@min-[640px]:gap-5 gap-3 @min-[640px]:pt-7 pt-4 @min-[640px]:pb-5 pb-3"
				)}
			>
				<PersonaAvatar
					agent={agent}
					className={compact ? undefined : "@max-[639px]:size-12"}
					showPresence
					size={compact ? 48 : 72}
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<div className="flex items-start gap-3">
						<div className="flex min-w-0 flex-1 flex-col">
							<div className="flex items-center gap-1">
								<h1
									className={cn(
										"truncate font-semibold tracking-tight",
										compact ? "text-lg" : "@min-[640px]:text-2xl text-xl"
									)}
								>
									{agent.name}
								</h1>
								{agents.length > 1 ? (
									<PersonaSwitcher
										agent={agent}
										agents={agents}
										onSelect={onSelectPersona}
									/>
								) : null}
							</div>
							<p className="truncate text-muted-foreground text-sm">
								{agentHandle(agent.name)}
								{agent.description ? ` · ${agent.description}` : ""}
							</p>
						</div>
					</div>
					<StatusLine
						depth={depth}
						onDepthChange={onDepthChange}
						onOpenThread={onOpenThread}
						status={status}
					/>
				</div>
			</div>
		</header>
	);
}
