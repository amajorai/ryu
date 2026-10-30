import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { type InterfaceThread, threadStatus } from "@ryuhq/protocol/interfaces";
import { ArrowLeft, Check, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId } from "react";
import { BoardAvatar, BoardAvatarStack } from "./board-avatar.tsx";
import { BoardStatusDot, BoardStatusLabel } from "./board-status.tsx";
import { agentById, compactAge } from "./interface-renderer.ts";
import type { SeasonCopy, SeasonDoor } from "./seasonal-model.ts";

export { GiftCard } from "./seasonal-parts-gift-card.tsx";
export { BoardSkeleton, Legend } from "./seasonal-parts-legend.tsx";

function TagString() {
	return (
		<svg
			aria-hidden="true"
			className="pointer-events-none absolute top-1/2 -translate-y-1/2 overflow-visible text-(--gk-gold)"
			data-tag-string=""
			height={48}
			style={{ right: "calc(100% - 9px)" }}
			viewBox="0 0 26 48"
			width={26}
		>
			<path
				d="M0 20 C8 30 18 31 26 24"
				fill="none"
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth={1.5}
			/>
		</svg>
	);
}

/** A paper gift tag with a punched hole, carrying the door number. */
export function GiftTag({ number }: { number: number }) {
	return (
		<span className="relative inline-flex h-6 shrink-0 items-center rounded-e-[4px] bg-muted ps-4 pe-2 font-mono font-semibold text-foreground text-xs tabular-nums [clip-path:polygon(9px_0,100%_0,100%_100%,9px_100%,0_50%)]">
			<span
				aria-hidden="true"
				className="absolute start-1.5 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-background"
			/>
			{number}
		</span>
	);
}

function PanelHeader({
	children,
	closeLabel,
	onClose,
	stacked,
}: {
	children: ReactNode;
	closeLabel: string;
	onClose: () => void;
	stacked: boolean;
}) {
	return (
		<div className="flex h-12 shrink-0 items-center gap-2 border-border border-b ps-4 pe-2">
			{stacked ? (
				<Button
					aria-label={closeLabel}
					className="-ms-2"
					onClick={onClose}
					size="icon-sm"
					variant="ghost"
				>
					<ArrowLeft aria-hidden="true" className="size-4" />
				</Button>
			) : null}
			{children}
			{stacked ? null : (
				<Button
					aria-label={closeLabel}
					className="ms-auto"
					onClick={onClose}
					size="icon-sm"
					variant="ghost"
				>
					<X aria-hidden="true" className="size-4" />
				</Button>
			)}
		</div>
	);
}

/**
 * The open conversation, hung from a gift tag: the door's number and facts on
 * top, and the host's own conversation surface below.
 */
export function GiftTagPanel({
	acts = false,
	door,
	now,
	onClose,
	snapshot,
	headless = false,
	stacked,
	thread,
	threadView,
}: {
	/** The act layer is on: no last-activity age. */
	acts?: boolean;
	door: SeasonDoor | null;
	now: number;
	onClose: () => void;
	snapshot: InterfaceSnapshot;
	/** Inside the game sheet, which carries its own header. */
	headless?: boolean;
	stacked: boolean;
	thread: InterfaceThread | null;
	threadView: ReactNode;
}) {
	const agents = thread
		? thread.agentIds
				.map((id) => agentById(snapshot, id))
				.filter((agent) => agent !== undefined)
		: [];
	return (
		<>
			{headless ? null : (
				<PanelHeader
					closeLabel="Close conversation"
					onClose={onClose}
					stacked={stacked}
				>
					{door ? (
						<span className="relative flex shrink-0">
							{stacked ? null : <TagString />}
							<GiftTag number={door.number} />
						</span>
					) : null}
					<h2 className="min-w-0 truncate font-semibold text-sm leading-5">
						{thread?.title || "New conversation"}
					</h2>
				</PanelHeader>
			)}
			{thread ? (
				<div className="flex h-10 shrink-0 items-center gap-3 border-border border-b px-4">
					<BoardAvatarStack agents={agents} />
					<span className="ms-auto shrink-0">
						{acts ? (
							<span
								className="text-muted-foreground text-xs leading-4"
								data-act-words=""
							>
								{door?.actWords ?? ""}
							</span>
						) : (
							<BoardStatusLabel status={threadStatus(thread)} />
						)}
					</span>
					{acts ? null : (
						<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
							{compactAge(thread.updatedAt, now)}
						</span>
					)}
				</div>
			) : null}
			<div className="flex min-h-0 flex-1 flex-col" data-seasonal-thread="">
				{threadView}
			</div>
		</>
	);
}

/**
 * Who starts the new conversation: every agent as a row, one picked. A radio
 * group, so arrow keys move the pick.
 */
function AgentPicker({
	agents,
	onPick,
	picked,
}: {
	agents: InterfaceAgent[];
	onPick: (agentId: string) => void;
	picked: string | undefined;
}) {
	const labelId = useId();
	const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		const step: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };
		const delta = step[event.key];
		if (delta === undefined) {
			return;
		}
		event.preventDefault();
		const index = agents.findIndex((agent) => agent.id === picked);
		const next = agents[(index + delta + agents.length) % agents.length];
		if (next) {
			onPick(next.id);
			const list = event.currentTarget.parentElement;
			list
				?.querySelector<HTMLButtonElement>(`[data-agent="${next.id}"]`)
				?.focus();
		}
	};
	return (
		<section aria-labelledby={labelId} className="flex flex-col gap-1">
			<h3
				className="px-2 font-medium text-muted-foreground text-xs leading-4"
				id={labelId}
			>
				Agent
			</h3>
			<div
				aria-labelledby={labelId}
				className="flex flex-col"
				role="radiogroup"
			>
				{agents.map((agent) => {
					const checked = agent.id === picked;
					return (
						<button
							aria-checked={checked}
							className={cn(
								"flex items-center gap-3 rounded-md px-2 py-2 text-start outline-none transition-colors",
								"hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
								checked && "bg-muted"
							)}
							data-agent={agent.id}
							key={agent.id}
							onClick={() => onPick(agent.id)}
							onKeyDown={onKeyDown}
							role="radio"
							tabIndex={checked ? 0 : -1}
							type="button"
						>
							<BoardAvatar agent={agent} name={agent.name} size={24} />
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="truncate font-medium text-sm leading-5">
									{agent.name}
								</span>
								{agent.description ? (
									<span className="truncate text-muted-foreground text-xs leading-4">
										{agent.description}
									</span>
								) : null}
							</span>
							{agent.status === "working" ? (
								<span className="shrink-0 text-muted-foreground text-xs leading-4">
									Working
								</span>
							) : null}
							<Check
								aria-hidden="true"
								className={cn(
									"size-4 shrink-0 text-foreground",
									!checked && "invisible"
								)}
							/>
						</button>
					);
				})}
			</div>
		</section>
	);
}

export function ComposerPanel({
	agents,
	children,
	copy,
	nextNumber,
	onClose,
	onPick,
	picked,
	headless = false,
	stacked,
}: {
	agents: InterfaceAgent[];
	children: ReactNode;
	copy: SeasonCopy;
	nextNumber: number | null;
	onClose: () => void;
	onPick: (agentId: string) => void;
	picked: string | undefined;
	/** Inside the game sheet, which carries its own header. */
	headless?: boolean;
	stacked: boolean;
}) {
	return (
		<>
			{headless ? null : (
				<PanelHeader closeLabel="Cancel" onClose={onClose} stacked={stacked}>
					{nextNumber ? <GiftTag number={nextNumber} /> : null}
					<h2 className="font-semibold text-sm leading-5">{copy.add}</h2>
				</PanelHeader>
			)}
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
				<div className="flex flex-col gap-2">
					<p className="text-muted-foreground text-sm leading-5">
						New conversations are numbered by urgency.
					</p>
					{children}
				</div>
				{agents.length > 1 ? (
					<div className="-mx-2">
						<AgentPicker agents={agents} onPick={onPick} picked={picked} />
					</div>
				) : null}
			</div>
		</>
	);
}

/** One conversation as a plain row, for the overflow list and narrow screens. */
export function DoorRow({
	active,
	acts = false,
	actWords,
	flush = false,
	label,
	now,
	number,
	onOpen,
	snapshot,
	thread,
}: {
	active: boolean;
	/** The act layer is on: its words, no status dot and no last-activity age. */
	acts?: boolean;
	/** What the act layer says of the conversation. */
	actWords?: string;
	/** Rounded rows that line up with the board's edge instead of the screen's. */
	flush?: boolean;
	label: string;
	now: number;
	number: number;
	onOpen: () => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread;
}) {
	const status = threadStatus(thread);
	const agents = thread.agentIds
		.map((id) => agentById(snapshot, id)?.name)
		.filter(Boolean)
		.join(", ");
	return (
		<li>
			<button
				aria-current={active ? "true" : undefined}
				aria-label={label}
				className={cn(
					"flex w-full items-center gap-3 py-2 text-start outline-none transition-colors",
					flush ? "rounded-md px-2" : "px-4",
					"hover:bg-muted/60 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
					active && "bg-muted"
				)}
				onClick={onOpen}
				type="button"
			>
				<span className="w-6 shrink-0 text-end font-mono text-muted-foreground text-xs tabular-nums">
					{number}
				</span>
				{acts ? null : <BoardStatusDot status={status} />}
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="truncate font-medium text-sm leading-5">
						{thread.title || "Untitled"}
					</span>
					<span className="truncate text-muted-foreground text-xs leading-4">
						{agents || "No agent"}
						{acts && actWords ? ` · ${actWords}` : ""}
					</span>
				</span>
				{acts ? null : (
					<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
						{compactAge(thread.updatedAt, now)}
					</span>
				)}
			</button>
		</li>
	);
}

export function OverflowPanel({
	activeThreadId,
	acts = false,
	copy,
	now,
	onClose,
	onOpen,
	snapshot,
	headless = false,
	stacked,
	threads,
}: {
	activeThreadId: string | null;
	/** The act layer is on: no last-activity ages. */
	acts?: boolean;
	copy: SeasonCopy;
	now: number;
	onClose: () => void;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
	/** Inside the game sheet, which carries its own header. */
	headless?: boolean;
	stacked: boolean;
	threads: InterfaceThread[];
}) {
	const tl = useLiteralMessages();
	return (
		<>
			{headless ? null : (
				<PanelHeader
					closeLabel={tl("Close {more}", { more: copy.more.toLowerCase() })}
					onClose={onClose}
					stacked={stacked}
				>
					<h2 className="font-semibold text-sm leading-5">{copy.more}</h2>
					<span className="text-muted-foreground text-xs tabular-nums">
						{threads.length}
					</span>
				</PanelHeader>
			)}
			<p className="px-4 pt-3 pb-2 text-muted-foreground text-xs leading-4">
				{tl("Conversations past the 24th {door}, most urgent first.", {
					door: copy.door,
				})}
			</p>
			<ul className="min-h-0 flex-1 overflow-y-auto pb-2">
				{threads.map((thread, index) => (
					<DoorRow
						active={thread.id === activeThreadId}
						acts={acts}
						key={thread.id}
						label={thread.title || "Untitled"}
						now={now}
						number={25 + index}
						onOpen={() => onOpen(thread.id)}
						snapshot={snapshot}
						thread={thread}
					/>
				))}
			</ul>
		</>
	);
}

/** Shown over an empty board: what it will hold and how to start. */
export function EmptyNote({
	copy,
	onAdd,
}: {
	copy: SeasonCopy;
	onAdd: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-4">
			<section
				aria-labelledby="seasonal-empty-title"
				className="pointer-events-auto flex w-full max-w-sm flex-col gap-3 rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg"
			>
				<div className="flex items-center gap-2">
					<GiftTag number={1} />
					<h2
						className="font-semibold text-base leading-6"
						id="seasonal-empty-title"
					>
						No conversations yet
					</h2>
				</div>
				<p className="text-muted-foreground text-sm leading-5">
					{tl(
						"Each conversation gets a numbered {door}. The ones that need you take the lowest numbers.",
						{ door: copy.door }
					)}
				</p>
				<Button className="self-start" onClick={onAdd} size="sm">
					{copy.add}
				</Button>
			</section>
		</div>
	);
}
