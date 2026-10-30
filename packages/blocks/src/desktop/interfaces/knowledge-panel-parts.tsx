import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { agentById, compactAge } from "./interface-renderer.ts";
import type { KnowledgeNode } from "./knowledge-model.ts";
import {
	agentColor,
	cssColor,
	type KnowledgePalette,
} from "./knowledge-palette.ts";
import { KnowledgeStatusDot } from "./knowledge-parts.tsx";
import { nodeColor } from "./knowledge-stage.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/** Presentational pieces of the knowledge side panel. */

export function Swatch({
	node,
	palette,
	snapshot,
}: {
	node: KnowledgeNode;
	palette: KnowledgePalette;
	snapshot: InterfaceSnapshot;
}) {
	if (node.kind === "agent") {
		return (
			<BoardAvatar
				agent={agentById(snapshot, node.refId)}
				name={node.label}
				size={20}
			/>
		);
	}
	if (node.kind === "conversation" && node.status) {
		return (
			<span className="flex size-5 items-center justify-center">
				<KnowledgeStatusDot palette={palette} status={node.status} />
			</span>
		);
	}
	return (
		<span
			aria-hidden="true"
			className="flex size-5 items-center justify-center"
		>
			<span
				className="size-2.5 rounded-full"
				style={{ backgroundColor: cssColor(nodeColor(node, palette)) }}
			/>
		</span>
	);
}

/**
 * The header's mark beside the name: an agent's avatar ringed in its node
 * colour (so the face and the node read as one), otherwise the node's dot.
 */
export function NodeMark({
	agent,
	node,
	palette,
}: {
	agent: InterfaceAgent | undefined;
	node: KnowledgeNode;
	palette: KnowledgePalette;
}) {
	if (node.kind === "agent") {
		return (
			<span
				aria-hidden="true"
				className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full"
				data-knowledge-agent-ring=""
				style={{
					boxShadow: `inset 0 0 0 2px ${cssColor(agentColor(node.label, palette))}`,
				}}
			>
				<BoardAvatar agent={agent} name={node.label} size={24} />
			</span>
		);
	}
	return (
		<span
			aria-hidden="true"
			className="mt-0.5 flex size-8 shrink-0 items-center justify-center"
		>
			<span
				className="size-3 rounded-full"
				style={{ backgroundColor: cssColor(nodeColor(node, palette)) }}
			/>
		</span>
	);
}

export function ThreadRow({
	note,
	now,
	onOpen,
	palette,
	thread,
}: {
	/** Why the row is here, when its title does not say (topic panels). */
	note?: string;
	now: number;
	onOpen: (threadId: string) => void;
	palette: KnowledgePalette;
	thread: InterfaceThread;
}) {
	const tl = useLiteralMessages();
	const status = threadStatus(thread);
	if (note) {
		return (
			<li>
				<button
					aria-label={tl("Open {title}, {status}, {note}", {
						note: note.toLowerCase(),
						status: THREAD_STATUS_LABELS[status],
						title: thread.title,
					})}
					className="group flex w-full items-start gap-2.5 px-4 py-2 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
					onClick={() => onOpen(thread.id)}
					type="button"
				>
					<span className="flex size-5 shrink-0 items-center justify-center">
						<KnowledgeStatusDot palette={palette} status={status} />
					</span>
					<span className="flex min-w-0 flex-1 flex-col gap-0.5">
						<span className="truncate text-foreground text-sm leading-5">
							{thread.title}
						</span>
						<span className="text-muted-foreground text-xs leading-4">
							{note}
						</span>
					</span>
					<time
						className="shrink-0 text-muted-foreground text-xs tabular-nums leading-5"
						dateTime={thread.updatedAt}
					>
						{compactAge(thread.updatedAt, now)}
					</time>
				</button>
			</li>
		);
	}
	return (
		<li>
			<button
				aria-label={tl("Open {title}, {status}", {
					status: THREAD_STATUS_LABELS[status],
					title: thread.title,
				})}
				className="group flex h-9 w-full items-center gap-2.5 px-4 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
				onClick={() => onOpen(thread.id)}
				type="button"
			>
				<span className="flex size-5 shrink-0 items-center justify-center">
					<KnowledgeStatusDot palette={palette} status={status} />
				</span>
				<span className="min-w-0 flex-1 truncate text-foreground text-sm">
					{thread.title}
				</span>
				<time
					className="shrink-0 text-muted-foreground text-xs tabular-nums"
					dateTime={thread.updatedAt}
				>
					{compactAge(thread.updatedAt, now)}
				</time>
			</button>
		</li>
	);
}

export function SectionHeading({
	children,
	count,
}: {
	children: ReactNode;
	count: number;
}) {
	return (
		<h4 className="flex h-8 items-center gap-2 px-4 font-medium text-muted-foreground text-xs">
			{children}
			<span className="tabular-nums">{count}</span>
		</h4>
	);
}

export function PanelFrame({
	children,
	label,
	testId,
	wide,
}: {
	children: ReactNode;
	label: string;
	testId: string;
	wide: boolean;
}) {
	const reduced = useReducedMotion();
	return (
		<motion.aside
			animate={{ opacity: 1, transform: "translateX(0px)" }}
			aria-label={label}
			className={cn(
				"absolute @min-[900px]/knowledge:relative inset-y-0 right-0 z-30 flex w-full min-w-0 flex-col border-border bg-background @min-[900px]/knowledge:shadow-none shadow-lg sm:w-[360px] sm:border-l",
				wide && "@min-[1200px]/knowledge:w-[480px] sm:w-[440px]"
			)}
			data-testid={testId}
			initial={reduced ? false : { opacity: 0, transform: "translateX(12px)" }}
			transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
		>
			{children}
		</motion.aside>
	);
}
