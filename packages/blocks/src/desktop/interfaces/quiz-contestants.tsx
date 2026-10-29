import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { type ReactNode, useId } from "react";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import { QuizAvatar } from "./quiz-avatar.tsx";
import type { Contestant } from "./quiz-model.ts";

/**
 * The contestants without WebGL (and in tests): a row of kit plates, each
 * the same control as a podium villager's name plate in the studio. It
 * opens the final question with that contestant already picked.
 */
export function QuizContestants({
	acts,
	contestants,
	onAsk,
}: {
	/**
	 * The act layer's rows (a snapshot with `asks`): each contestant's act
	 * sentence (its row's description) and status line, and the agents off
	 * the podiums as a list.
	 */
	acts?: {
		offStage: ReactNode;
		row: (agentId: string) => { label: string; status: ReactNode } | null;
	};
	contestants: Contestant[];
	onAsk: (agentId: string) => void;
}) {
	const tl = useLiteralMessages();
	const baseId = useId();
	return (
		<section
			aria-label="Contestants"
			className="mx-auto w-full max-w-[min(100%,64rem)] shrink-0 px-3 pb-4"
		>
			<ol className="grid @max-[40rem]/game:grid-cols-2 grid-cols-4 gap-3">
				{contestants.map(({ agent, score, working }) => {
					const row = acts?.row(agent.id) ?? null;
					const describedBy = `${baseId}-act-${agent.id}`;
					const counts = {
						agentName: agent.name,
						count: score,
						countLabel: String(score),
					};
					let label = tl("Ask {agentName} the final question.", {
						agentName: agent.name,
					});
					if (!row) {
						label = working
							? tl(
									"Ask {agentName} the final question. Working, {count, plural, one {{countLabel} message} other {{countLabel} messages}}.",
									counts
								)
							: tl(
									"Ask {agentName} the final question. Idle, {count, plural, one {{countLabel} message} other {{countLabel} messages}}.",
									counts
								);
					}
					return (
						<li
							className={cn("flex min-w-0", row && "flex-col gap-1")}
							key={agent.id}
						>
							<button
								aria-describedby={row ? describedBy : undefined}
								aria-label={label}
								className={cn(
									GAME_PLATE,
									GAME_FOCUS,
									"flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-start transition-colors hover:bg-(--gk-plate-sunk)"
								)}
								onClick={() => onAsk(agent.id)}
								type="button"
							>
								<QuizAvatar agent={agent} className="size-8" />
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="gk-display truncate text-[16px] leading-5">
										{agent.name}
									</span>
									{/* With acts the status line below says what they are doing. */}
									{row ? null : (
										<span
											className={cn(
												"font-semibold text-[12px] leading-4",
												working ? "text-(--gk-good)" : "text-(--gk-ink-muted)"
											)}
										>
											{working ? "Working" : "Idle"}
										</span>
									)}
								</span>
								{row ? null : (
									<span className="gk-display text-[20px] tabular-nums">
										{score}
									</span>
								)}
							</button>
							{row ? (
								<>
									<span className="sr-only" id={describedBy}>
										{row.label}
									</span>
									<div className="px-1 text-(--gk-ink)">{row.status}</div>
								</>
							) : null}
						</li>
					);
				})}
			</ol>
			{acts?.offStage}
		</section>
	);
}
