import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceGroup,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import type { ReactNode, Ref } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { GameAgentCard } from "./game-hud.tsx";
import { GameSheet } from "./game-shell.tsx";
import { InterfaceComposer } from "./interface-composer.tsx";
import { compactAge } from "./interface-renderer.ts";
import {
	ACT_STATE_LABELS,
	threadContext,
	threadWorkerState,
	WORKER_STATE_LABELS,
	type WorkerState,
	type WorkerView,
} from "./workers-model.ts";
import { StatusLight } from "./workers-status.tsx";

/** The first worker with nothing running: who a new task goes to first. */
function freeWorker(workers: WorkerView[]): WorkerView | undefined {
	return workers.find((worker) => worker.state === "idle") ?? workers[0];
}

/** What the sheet shows: a worker's desk, an open task, or a new task. */
export type WorkersSheetView =
	| { kind: "new" }
	| {
			kind: "thread";
			thread: InterfaceThread | undefined;
			worker: WorkerView | undefined;
	  }
	| { kind: "worker"; worker: WorkerView };

/**
 * A task's light: its own status without acts; with acts only the task the
 * worker's act is about carries the worker's (act) light, in act words.
 */
function taskLight(
	thread: InterfaceThread,
	actWorker: WorkerView | null
): { label: string; state: WorkerState } | null {
	if (!actWorker) {
		const state = threadWorkerState(thread);
		return { label: WORKER_STATE_LABELS[state], state };
	}
	return thread.id === actWorker.current?.id
		? { label: ACT_STATE_LABELS[actWorker.state], state: actWorker.state }
		: null;
}

function TaskRow({
	active,
	actWorker,
	groups,
	onOpen,
	thread,
}: {
	active: boolean;
	/** With acts, the worker (its act state); no last-update ages then. */
	actWorker: WorkerView | null;
	groups: readonly InterfaceGroup[];
	onOpen: (threadId: string) => void;
	thread: InterfaceThread;
}) {
	const light = taskLight(thread, actWorker);
	return (
		<li>
			<button
				aria-current={active ? "true" : undefined}
				className={cn(
					"grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-3 rounded-lg px-3 py-2.5 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
					active && "bg-muted"
				)}
				data-testid="workers-task"
				onClick={() => onOpen(thread.id)}
				type="button"
			>
				<span className="flex h-5 items-center">
					{light ? <StatusLight state={light.state} /> : null}
				</span>
				<span className="flex min-w-0 flex-col gap-0.5">
					<span className="truncate font-medium text-foreground text-sm">
						{thread.title.trim() || "Untitled"}
					</span>
					<span className="truncate text-[13px] text-muted-foreground">
						{light ? `${light.label} · ` : null}
						{threadContext(thread, groups)}
					</span>
				</span>
				<span className="pt-0.5 text-[13px] text-muted-foreground tabular-nums">
					{actWorker ? null : compactAge(thread.updatedAt)}
				</span>
			</button>
		</li>
	);
}

/**
 * The kit's side sheet for Workers. A worker's sheet holds its card, its
 * tasks and a composer that starts a new task on its computer; an open task
 * shows the host's own conversation with Back to its worker; New task picks
 * a worker and starts one. Prompts are only ever what the user typed.
 */
export function WorkersPanel({
	actMode = false,
	freeId,
	activeThreadId,
	groups,
	headingRef,
	onBack,
	onClose,
	onOpenThread,
	onOpenWorker,
	onStart,
	threadView,
	view,
	workers,
}: {
	/**
	 * With acts the workers' states are their acts' (and their words the act
	 * layer's), and no task shows a last-update age.
	 */
	actMode?: boolean;
	/**
	 * With acts, who a new task goes to first: the first truly idle agent
	 * (never a limited, blocked, delivering or waiting one).
	 */
	freeId?: string;
	activeThreadId: string | null;
	groups: readonly InterfaceGroup[];
	headingRef: Ref<HTMLHeadingElement>;
	onBack: (() => void) | undefined;
	onClose: () => void;
	onOpenThread: (threadId: string) => void;
	onOpenWorker: (workerId: string) => void;
	onStart: (input: { agentId?: string; prompt: string }) => void;
	threadView: ReactNode;
	view: WorkersSheetView;
	workers: WorkerView[];
}) {
	const tl = useLiteralMessages();
	if (view.kind === "thread") {
		const { thread, worker } = view;
		const light = thread
			? taskLight(thread, actMode && worker ? worker : null)
			: null;
		return (
			<GameSheet
				backLabel={
					worker ? tl("Back to {name}", { name: worker.name }) : undefined
				}
				closeLabel="Close task"
				data-testid="workers-sheet"
				eyebrow={
					worker ? tl("{name}'s computer", { name: worker.name }) : "New task"
				}
				headingRef={headingRef}
				label={tl("Task: {title}", { title: thread?.title ?? "New task" })}
				leading={
					worker ? (
						<BoardAvatar agent={worker.agent} name={worker.name} size={28} />
					) : undefined
				}
				onBack={worker ? onBack : undefined}
				onClose={onClose}
				sheetKey={`thread:${activeThreadId ?? "new"}`}
				subtitle={
					light ? (
						<>
							<StatusLight className="size-2" state={light.state} />
							{light.label}
						</>
					) : undefined
				}
				title={thread?.title.trim() || "New task"}
			>
				{threadView}
			</GameSheet>
		);
	}
	if (view.kind === "new") {
		return (
			<GameSheet
				closeLabel="Close"
				data-testid="workers-sheet"
				eyebrow="Start a worker"
				headingRef={headingRef}
				label="New task"
				onClose={onClose}
				sheetKey="new"
				title="New task"
			>
				<div className="min-h-0 flex-1 overflow-y-auto">
					<div className="flex flex-col gap-3 border-border border-b p-4">
						<p className="text-pretty text-muted-foreground text-sm leading-6">
							Pick a worker and describe the task. It starts on their computer
							as soon as you send it.
						</p>
						<InterfaceComposer
							agents={workers.map((worker) => worker.agent)}
							defaultAgentId={freeId ?? freeWorker(workers)?.id}
							label="Task"
							onSubmit={onStart}
							placeholder="Describe the task"
							submitLabel="Start task"
						/>
					</div>
					{workers.length > 0 ? (
						<section aria-label="Desks" className="p-2">
							<h3 className="px-3 pt-2 pb-1 font-medium text-[13px] text-muted-foreground">
								At their desks
							</h3>
							<ul className="flex flex-col">
								{workers.map((worker) => (
									<li key={worker.id}>
										<button
											className="grid w-full grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
											onClick={() => onOpenWorker(worker.id)}
											type="button"
										>
											<BoardAvatar
												agent={worker.agent}
												name={worker.name}
												size={28}
											/>
											<span className="flex min-w-0 flex-col gap-0.5">
												<span className="truncate font-medium text-foreground text-sm">
													{worker.name}
												</span>
												<span className="truncate text-[13px] text-muted-foreground">
													{worker.current
														? worker.current.title.trim() || "Untitled"
														: "No tasks yet"}
												</span>
											</span>
											<span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
												<StatusLight className="size-2" state={worker.state} />
												{
													(actMode ? ACT_STATE_LABELS : WORKER_STATE_LABELS)[
														worker.state
													]
												}
											</span>
										</button>
									</li>
								))}
							</ul>
						</section>
					) : null}
				</div>
			</GameSheet>
		);
	}
	const { worker } = view;
	return (
		<GameSheet
			closeLabel="Close"
			data-testid="workers-sheet"
			eyebrow="Worker"
			footer={
				<InterfaceComposer
					agents={[worker.agent]}
					defaultAgentId={worker.id}
					key={worker.id}
					label={tl("New task for {name}", { name: worker.name })}
					onSubmit={onStart}
					placeholder={tl("Give {name} a task", { name: worker.name })}
					submitLabel="Start task"
				/>
			}
			headingRef={headingRef}
			label={tl("{name}'s desk", { name: worker.name })}
			leading={
				<BoardAvatar agent={worker.agent} name={worker.name} size={28} />
			}
			onClose={onClose}
			sheetKey={`worker:${worker.id}`}
			subtitle={
				<>
					<StatusLight className="size-2" state={worker.state} />
					{(actMode ? ACT_STATE_LABELS : WORKER_STATE_LABELS)[worker.state]}
				</>
			}
			title={worker.name}
		>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<GameAgentCard
					description={worker.agent.description || undefined}
					stats={[
						{ key: "tasks", label: "Tasks", value: worker.threads.length },
						{ key: "needs", label: "Waiting on you", value: worker.needsYou },
						{
							key: "live",
							label: "Running",
							value: worker.threads.filter((thread) => thread.running).length,
						},
					]}
				/>
				{worker.threads.length > 0 ? (
					<section
						aria-label={tl("{name}'s tasks", { name: worker.name })}
						className="p-2"
					>
						<h3 className="px-3 pt-2 pb-1 font-medium text-[13px] text-muted-foreground">
							Tasks
						</h3>
						<ul className="flex flex-col">
							{worker.threads.map((thread) => (
								<TaskRow
									active={thread.id === activeThreadId}
									actWorker={actMode ? worker : null}
									groups={groups}
									key={thread.id}
									onOpen={onOpenThread}
									thread={thread}
								/>
							))}
						</ul>
					</section>
				) : (
					<p className="text-pretty px-4 py-6 text-muted-foreground text-sm leading-6">
						{tl(
							"No tasks yet. Give {name} one below and it starts on their computer.",
							{ name: worker.name }
						)}
					</p>
				)}
			</div>
		</GameSheet>
	);
}
