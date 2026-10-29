import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type {
	ClockOptions,
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { useId } from "react";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import { ActStatus } from "./interface-ask-card.tsx";
import { screenLabel } from "./workers-diorama.tsx";
import { WORKER_STATE_LABELS, type WorkerView } from "./workers-model.ts";
import { deskLabel, StatusLight, screenTitle } from "./workers-status.tsx";

/** The act layer for the desks' rows, when the host sends asks. */
export interface WorkersListActs {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	nowMs: number;
	onAsk: (askId: string, opener: HTMLElement) => void;
	onBlocker: (threadId: string, agentName: string, opener: HTMLElement) => void;
	snapshot: InterfaceSnapshot;
}

/**
 * The office as a plain list, for stages without WebGL (and tests): every
 * worker the diorama shows, with the same two controls (the worker opens
 * their desk; the screen opens the task it shows).
 */
export function WorkersList({
	actLayer = null,
	onOpenScreen,
	onOpenWorker,
	selectedId,
	workers,
}: {
	/** With acts each row says its act and carries its answer buttons. */
	actLayer?: WorkersListActs | null;
	onOpenScreen: (workerId: string) => void;
	onOpenWorker: (workerId: string) => void;
	selectedId: string | null;
	workers: readonly WorkerView[];
}) {
	const baseId = useId();
	const tl = useLiteralMessages();
	return (
		<div
			className={cn(
				"absolute inset-0 overflow-auto bg-(--gk-backdrop) px-4 pb-28",
				// With acts the blind-spot caption sits under the title plate.
				actLayer ? "pt-36" : "pt-24"
			)}
			data-testid="workers-list"
		>
			<ul aria-label="Desks" className="mx-auto flex max-w-3xl flex-col gap-3">
				{workers.map((worker, index) => {
					const act = actLayer?.acts.get(worker.id);
					const describedBy = `${baseId}-${index}`;
					return (
						<li
							className={cn(
								GAME_PLATE,
								"flex flex-wrap items-center gap-3 p-3"
							)}
							data-state={worker.state}
							key={worker.id}
						>
							{act ? (
								<span hidden id={describedBy}>
									{act.ariaLabel}
								</span>
							) : null}
							<button
								aria-current={selectedId === worker.id ? "true" : undefined}
								aria-describedby={act ? describedBy : undefined}
								aria-label={tl("{name}. Open their desk", {
									name: act ? worker.name : deskLabel(worker),
								})}
								className={cn(
									GAME_FOCUS,
									"gk-display flex items-center gap-2 rounded-lg px-2 py-1 text-[16px] hover:bg-(--gk-plate-sunk)"
								)}
								data-testid="workers-desk"
								data-worker-id={worker.id}
								onClick={() => onOpenWorker(worker.id)}
								type="button"
							>
								<StatusLight state={worker.state} />
								{worker.name}
							</button>
							{worker.current || act ? (
								<button
									aria-label={
										act
											? // The name holds what the button shows (WCAG 2.5.3).
												worker.current
												? tl("{name}'s screen: {taskTitle}. Open the task", {
														name: worker.name,
														taskTitle: screenTitle(worker),
													})
												: tl("{name}'s screen: No task open. Open their desk", {
														name: worker.name,
													})
											: screenLabel(worker)
									}
									className={cn(
										GAME_FOCUS,
										"flex min-w-0 flex-1 flex-col rounded-xl border-(--gk-plate-sunk) border-2 px-3 py-1.5 text-start text-[13px] hover:bg-(--gk-plate-sunk)"
									)}
									data-testid="workers-screen"
									onClick={() => onOpenScreen(worker.id)}
									type="button"
								>
									{/* With an act the row's ActStatus says what it is doing:
									    the screen names the task, with no second state word. */}
									<span className="truncate font-semibold">
										{act && !worker.current
											? "No task open"
											: screenTitle(worker)}
									</span>
									{act ? null : (
										<span className="text-(--gk-ink-muted)">
											{WORKER_STATE_LABELS[worker.state]}
										</span>
									)}
								</button>
							) : (
								<span className="text-(--gk-ink-muted) text-[13px]">
									No tasks yet
								</span>
							)}
							{act && actLayer ? (
								<div className="basis-full">
									<ActStatus
										act={act}
										clock={actLayer.clock}
										nowMs={actLayer.nowMs}
										onAsk={actLayer.onAsk}
										onBlocker={actLayer.onBlocker}
										snapshot={actLayer.snapshot}
									/>
								</div>
							) : null}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
