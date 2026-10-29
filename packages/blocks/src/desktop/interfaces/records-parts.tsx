import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { BoardStatusDot } from "./board-status.tsx";
import { initials } from "./interface-renderer.ts";
import {
	type RecordsRow,
	recordsStatusLabel,
	recordsThreadAgents,
	recordsThreadTitle,
} from "./records-model.ts";
import { useReducedMotion } from "./reduced-motion.ts";

export type RecordsMarkSize = 20 | 24 | 40;

const GROUP_SIZE: Record<RecordsMarkSize, string> = {
	20: "size-5 rounded-[5px] text-[10px]",
	24: "size-6 rounded-md text-[11px]",
	40: "size-10 rounded-lg text-sm",
};

const AGENT_SIZE: Record<RecordsMarkSize, string> = {
	20: "",
	24: "",
	40: "size-10",
};

/**
 * A record's picture: an agent's avatar (round), or a square initials tile for
 * a team or project, the way CRMs tell people apart from companies at a
 * glance. Decorative: the record's name always sits beside it.
 */
export function RecordsMark({
	agent,
	className,
	name,
	size,
}: {
	agent: InterfaceAgent | null;
	className?: string;
	name: string;
	size: RecordsMarkSize;
}) {
	if (agent) {
		return (
			<BoardAvatar
				agent={agent}
				className={cn(AGENT_SIZE[size], className)}
				name={name}
				size={size === 40 ? 28 : size}
			/>
		);
	}
	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-flex shrink-0 select-none items-center justify-center bg-muted font-semibold text-foreground/75 ring-1 ring-border ring-inset",
				GROUP_SIZE[size],
				className
			)}
		>
			{initials(name)}
		</span>
	);
}

const STATUS_TEXT: Record<ThreadStatus, string> = {
	attention: "text-destructive",
	quiet: "text-muted-foreground",
	waiting: "text-muted-foreground",
	working: "text-foreground",
	"your-turn": "text-foreground",
};

/** Dot plus label, the one way a stage is shown in cells and attributes. */
export function RecordsStatus({
	className,
	dot = true,
	label,
	status,
}: {
	className?: string;
	/** False where the dot already sits nearby, e.g. on a timeline rail. */
	dot?: boolean;
	label?: string;
	status: ThreadStatus;
}) {
	return (
		<span
			className={cn(
				"inline-flex min-w-0 items-center gap-2",
				STATUS_TEXT[status],
				className
			)}
		>
			{dot ? <BoardStatusDot status={status} /> : null}
			<span className="truncate">{label ?? THREAD_STATUS_LABELS[status]}</span>
		</span>
	);
}

/** A record's stage, reading "No threads" for a record with none. */
export function RecordsRowStatus({
	className,
	row,
}: {
	className?: string;
	row: RecordsRow;
}) {
	return (
		<RecordsStatus
			className={className}
			label={recordsStatusLabel(row)}
			status={row.status}
		/>
	);
}

/** Overlapping member faces, used for team and project members. */
export function RecordsFaces({
	agents,
	limit = 4,
}: {
	agents: readonly InterfaceAgent[];
	limit?: number;
}) {
	const shown = agents.slice(0, limit);
	const extra = agents.length - shown.length;
	return (
		<span aria-hidden="true" className="flex shrink-0 -space-x-1">
			{shown.map((agent) => (
				<BoardAvatar
					agent={agent}
					className="ring-2 ring-background"
					key={agent.id}
					name={agent.name}
					size={20}
				/>
			))}
			{extra > 0 ? (
				<span className="z-10 flex size-5 items-center justify-center rounded-full bg-muted font-medium text-[10px] text-muted-foreground tabular-nums ring-2 ring-background">
					+{extra}
				</span>
			) : null}
		</span>
	);
}

/**
 * The open thread docked beside the records: a slim header over the host's
 * real conversation surface. Floats over the content at narrow widths.
 */
export function RecordsThreadPanel({
	floating,
	onClose,
	snapshot,
	thread,
	threadView,
}: {
	floating: boolean;
	onClose: () => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const title = thread ? recordsThreadTitle(thread) : "New thread";
	const agents = thread ? recordsThreadAgents(snapshot, thread) : [];
	const status = thread ? threadStatus(thread) : null;
	return (
		<motion.aside
			animate={{ opacity: 1, x: 0 }}
			aria-label={tl("Thread: {title}", { title })}
			className={cn(
				"flex min-h-0 shrink-0 flex-col border-border border-l bg-background",
				floating
					? "absolute inset-y-0 right-0 z-30 w-[min(480px,100%)] shadow-xl"
					: "w-[clamp(380px,40%,560px)]"
			)}
			data-testid="records-thread-panel"
			initial={reduceMotion ? false : { opacity: 0, x: 12 }}
			transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
		>
			<header
				className="flex h-12 shrink-0 items-center gap-3 border-border border-b ps-4 pe-2"
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						onClose();
					}
				}}
			>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<h2 className="truncate font-medium text-[13px] text-foreground leading-4">
						{title}
					</h2>
					{status ? (
						<p className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs leading-4">
							<RecordsStatus status={status} />
							{agents.length > 0 ? (
								<>
									<span aria-hidden="true">·</span>
									<span className="truncate">
										{agents.map((agent) => agent.name).join(", ")}
									</span>
								</>
							) : null}
						</p>
					) : null}
				</div>
				<Button
					aria-label="Close thread"
					onClick={onClose}
					size="icon-sm"
					title="Close thread (Esc)"
					type="button"
					variant="ghost"
				>
					<X aria-hidden="true" />
				</Button>
			</header>
			<div className="min-h-0 flex-1">{threadView}</div>
		</motion.aside>
	);
}
