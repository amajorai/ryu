import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { compactAge } from "./interface-renderer.ts";
import { fullTime } from "./persona-model.ts";

/**
 * The one column every part of Persona lines up on: the profile header, the
 * side-chat strip, the chat and each section share its left edge.
 */
export const PERSONA_COLUMN = "mx-auto w-full max-w-3xl @min-[640px]:px-8 px-4";

/** The heading block at the top of Feed, Ideas, Goals and Activity. */
export function PageIntro({
	action,
	description,
	id,
	title,
}: {
	action?: ReactNode;
	description?: string;
	id: string;
	title: string;
}) {
	return (
		<div className="flex items-start justify-between gap-4">
			<div className="flex min-w-0 flex-col">
				<h2 className="font-semibold text-lg leading-8 tracking-tight" id={id}>
					{title}
				</h2>
				{description ? (
					<p className="text-muted-foreground text-sm">{description}</p>
				) : null}
			</div>
			{action}
		</div>
	);
}

/** A quiet label over a group of rows. */
export function SectionLabel({
	children,
	count,
	id,
}: {
	children: ReactNode;
	count?: number;
	id?: string;
}) {
	return (
		<h3
			className="flex items-center gap-2 pt-8 pb-2 font-medium text-foreground/80 text-xs"
			id={id}
		>
			{children}
			{count === undefined ? null : (
				<span className="font-normal text-muted-foreground tabular-nums">
					{count}
				</span>
			)}
		</h3>
	);
}

/** A one-line empty note inside a section that has nothing to list. */
export function EmptyNote({ children }: { children: ReactNode }) {
	return <p className="py-3 text-muted-foreground text-sm">{children}</p>;
}

/** Two- or three-way segmented control (pressed buttons, not tabs). */
export function Segmented<Value extends string>({
	label,
	onChange,
	options,
	value,
}: {
	label: string;
	onChange: (value: Value) => void;
	options: { label: string; value: Value }[];
	value: Value;
}) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: a fieldset would add a legend and border to a toolbar control.
		<div
			aria-label={label}
			className="inline-flex shrink-0 rounded-lg bg-muted p-0.5"
			role="group"
		>
			{options.map((option) => (
				<button
					aria-pressed={option.value === value}
					className={cn(
						"h-7 rounded-md px-3 font-medium text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
						option.value === value
							? "bg-background text-foreground shadow-xs"
							: "text-foreground/70 hover:text-foreground"
					)}
					key={option.value}
					onClick={() => onChange(option.value)}
					type="button"
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

/** One thread as a compact row: status, title, state, age. Opens the thread. */
export function ThreadLine({
	meta,
	onOpen,
	thread,
}: {
	/** Replaces the status label (e.g. the agent's name). */
	meta?: string;
	onOpen: (threadId: string) => void;
	thread: InterfaceThread;
}) {
	const status = threadStatus(thread);
	return (
		<li>
			<button
				className="-mx-2 flex h-9 w-[calc(100%+1rem)] items-center gap-3 rounded-md px-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
				onClick={() => onOpen(thread.id)}
				type="button"
			>
				<BoardStatusDot status={status} />
				<span className="min-w-0 flex-1 truncate text-sm">
					{thread.title || "Untitled"}
				</span>
				<span
					className={cn(
						"@max-[639px]:hidden shrink-0 text-xs",
						status === "attention"
							? "text-destructive"
							: "text-muted-foreground"
					)}
				>
					{meta ?? THREAD_STATUS_LABELS[status]}
				</span>
				<time
					className="w-8 shrink-0 text-right text-muted-foreground text-xs tabular-nums"
					dateTime={thread.updatedAt}
					title={fullTime(thread.updatedAt)}
				>
					{compactAge(thread.updatedAt)}
				</time>
			</button>
		</li>
	);
}

/** The scrolling column every non-chat section sits in. */
export function PageColumn({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div
				className={cn(
					PERSONA_COLUMN,
					"flex flex-col @min-[640px]:py-8 py-5",
					className
				)}
			>
				{children}
			</div>
		</div>
	);
}
