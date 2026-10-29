"use client";
import { useLiteralMessages } from "@ryu/i18n/react";
import type { MotionStyle } from "motion/react";
import type { CSSProperties } from "react";
import css from "./todo-list.module.css";

interface Inline1Style extends MotionStyle {
	"--todo-list-1-transform-origin"?: MotionStyle["transformOrigin"];
}
interface Inline2Style extends CSSProperties {
	"--todo-list-2-max-height"?: CSSProperties["maxHeight"];
}

import { isNativeFunction } from "../../lib/native-primitive-observation.ts";

// beui.dev/components/agents/todo-list

import { AgentDisclosure } from "@ryu/ui/components/agents/agent-disclosure.tsx";
import { ActionSwapRollText } from "@ryu/ui/components/motion/action-swap-roll.tsx";
import { EASE_OUT, SPRING_LAYOUT, SPRING_SWAP } from "@ryu/ui/lib/ease.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { ChevronDown, ListTodo } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

export type TodoItemStatus =
	| "pending"
	| "in-progress"
	| "completed"
	| "cancelled";

export interface TodoItem {
	detail?: ReactNode;
	id: string;
	progress?: number;
	status?: TodoItemStatus;
	title: ReactNode;
}

export interface TodoListProps {
	className?: string;
	collapseOnComplete?: boolean;
	defaultOpen?: boolean;
	items: TodoItem[];
	maxHeight?: number;
	onOpenChange?: (open: boolean) => void;
	open?: boolean;
	title?: ReactNode;
}

function statusLabel(status: TodoItemStatus) {
	if (status === "in-progress") {
		return "In progress";
	}
	if (status === "completed") {
		return "Completed";
	}
	if (status === "cancelled") {
		return "Cancelled";
	}
	return "Pending";
}

function TodoHeaderIcon({ complete }: { complete: boolean }) {
	const reduce = useReducedMotion() ?? false;

	return (
		<span
			aria-hidden="true"
			className="relative grid size-6 shrink-0 place-items-center"
		>
			<AnimatePresence initial={false} mode="popLayout">
				{complete ? (
					<motion.svg
						animate={{ opacity: 1, scale: 1 }}
						className="absolute size-5.5 overflow-visible text-status-success"
						exit={{ opacity: 0 }}
						initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.72 }}
						key="complete"
						transition={reduce ? { duration: 0 } : SPRING_SWAP}
						viewBox="0 0 24 24"
					>
						<circle cx="12" cy="12" fill="currentColor" r="9" />
						<motion.path
							animate={{ pathLength: 1 }}
							d="M7.5 12.25 10.5 15.25 16.75 8.75"
							fill="none"
							initial={reduce ? { pathLength: 1 } : { pathLength: 0 }}
							stroke="white"
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth="2.25"
							transition={
								reduce ? { duration: 0 } : { duration: 0.24, ease: EASE_OUT }
							}
						/>
					</motion.svg>
				) : (
					<motion.span
						animate={{ opacity: 1, scale: 1 }}
						className="absolute grid place-items-center text-muted-foreground"
						exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.72 }}
						initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.8 }}
						key="todo"
						transition={reduce ? { duration: 0 } : SPRING_SWAP}
					>
						<ListTodo className="size-4" />
					</motion.span>
				)}
			</AnimatePresence>
		</span>
	);
}

function TodoStatusIcon({
	status,
	progress,
}: {
	status: TodoItemStatus;
	progress?: number;
}) {
	const reduce = useReducedMotion() ?? false;
	const normalizedProgress =
		progress === undefined ? 0.68 : Math.min(100, Math.max(0, progress)) / 100;

	const inline1Style: Inline1Style = {
		"--todo-list-1-transform-origin": "12px 12px",
	};
	return (
		<motion.svg
			animate={false}
			aria-hidden="true"
			className={cn(
				"mx-0.5 size-5 shrink-0 overflow-visible text-muted-foreground",
				status === "in-progress" && "text-foreground",
				status === "cancelled" && "text-status-destructive"
			)}
			initial={false}
			viewBox="0 0 24 24"
		>
			<motion.circle
				animate={{ fillOpacity: status === "completed" ? 0.06 : 0 }}
				className={cn(status === "in-progress" && "opacity-20")}
				cx="12"
				cy="12"
				fill="currentColor"
				initial={false}
				r="9"
				stroke="currentColor"
				strokeDasharray={status === "pending" ? "2 3" : undefined}
				strokeLinecap="round"
				strokeWidth="1.5"
				transition={
					reduce ? { duration: 0 } : { duration: 0.18, ease: EASE_OUT }
				}
			/>
			<motion.circle
				animate={{
					pathLength: status === "in-progress" ? normalizedProgress : 0,
					opacity: status === "in-progress" ? 1 : 0,
					rotate:
						status === "in-progress" && progress === undefined && !reduce
							? 360
							: -90,
				}}
				className={css.inline1}
				cx="12"
				cy="12"
				fill="none"
				initial={false}
				pathLength="1"
				r="9"
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth="2"
				style={inline1Style}
				transition={
					status === "in-progress" && progress === undefined && !reduce
						? {
								rotate: {
									duration: 1.1,
									repeat: Number.POSITIVE_INFINITY,
									ease: "linear",
								},
							}
						: reduce
							? { duration: 0 }
							: SPRING_LAYOUT
				}
			/>
			<motion.path
				animate={{
					pathLength: status === "completed" ? 1 : 0,
					opacity: status === "completed" ? 1 : 0,
				}}
				d="M7.5 12.25 10.5 15.25 16.75 8.75"
				fill="none"
				initial={false}
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="2"
				transition={
					reduce ? { duration: 0 } : { duration: 0.24, ease: EASE_OUT }
				}
			/>
			<motion.path
				animate={{
					pathLength: status === "cancelled" ? 1 : 0,
					opacity: status === "cancelled" ? 1 : 0,
				}}
				d="M8.5 8.5 15.5 15.5M15.5 8.5 8.5 15.5"
				fill="none"
				initial={false}
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth="2"
				transition={
					reduce ? { duration: 0 } : { duration: 0.2, ease: EASE_OUT }
				}
			/>
		</motion.svg>
	);
}

export function TodoList({
	items,
	title = "To-dos",
	open,
	defaultOpen = true,
	onOpenChange,
	collapseOnComplete = true,
	maxHeight = 248,
	className,
}: TodoListProps) {
	const tl = useLiteralMessages();
	const reduce = useReducedMotion() ?? false;
	const baseId = useId();
	const triggerId = `${baseId}-trigger`;
	const contentId = `${baseId}-content`;
	const viewportRef = useRef<HTMLDivElement>(null);
	const previousComplete = useRef(false);
	const [internalOpen, setInternalOpen] = useState(defaultOpen);
	const currentOpen = open ?? internalOpen;
	const completed = items.filter((item) => item.status === "completed").length;
	const allComplete = items.length > 0 && completed === items.length;
	const itemCount = items.length;

	const setOpen = useCallback(
		(next: boolean) => {
			if (open === undefined) {
				setInternalOpen(next);
			}
			onOpenChange?.(next);
		},
		[onOpenChange, open]
	);

	useEffect(() => {
		if (previousComplete.current && !allComplete) {
			setOpen(true);
		}
		if (!previousComplete.current && allComplete && collapseOnComplete) {
			setOpen(false);
		}
		previousComplete.current = allComplete;
	}, [allComplete, collapseOnComplete, setOpen]);

	useLayoutEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport || itemCount === 0) {
			return;
		}

		const frame = requestAnimationFrame(() => {
			if (viewport.scrollHeight <= viewport.clientHeight) {
				return;
			}
			if (isNativeFunction(viewport.scrollTo)) {
				viewport.scrollTo({
					top: viewport.scrollHeight,
					behavior: reduce ? "auto" : "smooth",
				});
			} else {
				viewport.scrollTop = viewport.scrollHeight;
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [itemCount, reduce]);

	const inline2Style: Inline2Style = {
		"--todo-list-2-max-height":
			maxHeight === undefined ? undefined : `${maxHeight}px`,
	};
	return (
		<section
			aria-label="Agent task list"
			className={cn(
				"w-full overflow-hidden rounded-2xl border border-border/70",
				className
			)}
		>
			<button
				aria-controls={contentId}
				aria-expanded={currentOpen}
				className="group flex h-11 w-full items-center gap-2.5 rounded-2xl px-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
				id={triggerId}
				onClick={() => setOpen(!currentOpen)}
				type="button"
			>
				<TodoHeaderIcon complete={allComplete} />
				<h3 className="min-w-0 flex-1 truncate font-medium text-foreground/90 text-sm">
					{title}
				</h3>
				<span
					className={cn(
						"shrink-0 font-medium text-muted-foreground text-xs tabular-nums",
						allComplete && "text-status-success"
					)}
				>
					<span className="sr-only">
						{tl("{completed} of {total} tasks completed", {
							completed,
							total: items.length,
						})}
					</span>
					<span aria-hidden="true" className="inline-flex">
						<ActionSwapRollText value={String(completed)}>
							{completed}
						</ActionSwapRollText>
						<span>/</span>
						<span>{items.length}</span>
					</span>
				</span>
				<motion.span
					animate={{ rotate: currentOpen ? 180 : 0 }}
					aria-hidden="true"
					className="text-muted-foreground/50 transition-colors group-hover:text-muted-foreground"
					transition={reduce ? { duration: 0 } : SPRING_SWAP}
				>
					<ChevronDown className="size-3.5" />
				</motion.span>
			</button>

			<AgentDisclosure
				aria-labelledby={triggerId}
				id={contentId}
				open={currentOpen}
				role="region"
			>
				<div
					className={[
						css.inline2,
						"scroll-fade scrollbar-hide overflow-y-auto px-2 pb-2",
					].join(" ")}
					ref={viewportRef}
					style={inline2Style}
				>
					{items.length ? (
						<ol aria-live="polite" className="space-y-0">
							<AnimatePresence initial={false} mode="popLayout">
								{items.map((item) => {
									const status = item.status ?? "pending";
									return (
										<motion.li
											animate={{ opacity: 1, y: 0 }}
											className="flex min-h-9 items-center gap-2.5 rounded-xl px-1.5 py-1"
											exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3 }}
											initial={reduce ? { opacity: 1 } : { opacity: 0, y: 6 }}
											key={item.id}
											layout="position"
											transition={
												reduce
													? { duration: 0 }
													: {
															opacity: { duration: 0.18, ease: EASE_OUT },
															y: SPRING_LAYOUT,
															layout: SPRING_LAYOUT,
														}
											}
										>
											<TodoStatusIcon
												progress={item.progress}
												status={status}
											/>
											<span className="sr-only">{statusLabel(status)}: </span>
											<span
												className={cn(
													"min-w-0 flex-1 truncate text-sm leading-5",
													status === "pending" && "text-muted-foreground/65",
													status === "in-progress" && "text-foreground",
													status === "completed" && "text-muted-foreground/60",
													status === "cancelled" && "text-muted-foreground/55"
												)}
											>
												<span className="relative inline-block max-w-full">
													{item.title}
													<motion.span
														animate={{
															scaleX: status === "completed" ? 1 : 0,
															opacity: status === "completed" ? 1 : 0,
														}}
														aria-hidden="true"
														className="absolute inset-x-0 top-1/2 h-px origin-left bg-current"
														initial={false}
														transition={
															reduce
																? { duration: 0 }
																: {
																		duration: 0.28,
																		ease: EASE_OUT,
																		delay: 0.06,
																	}
														}
													/>
												</span>
											</span>
											{item.detail ? (
												<span className="shrink-0 text-muted-foreground/55 text-sm">
													{item.detail}
												</span>
											) : null}
										</motion.li>
									);
								})}
							</AnimatePresence>
						</ol>
					) : (
						<p className="px-1.5 py-2 text-muted-foreground text-sm">
							No tasks yet
						</p>
					)}
				</div>
			</AgentDisclosure>
		</section>
	);
}
