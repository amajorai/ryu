import { Plus } from "lucide-react";
import { GAME_PLATE, GameAction } from "./game-hud.tsx";

/** The empty street: no projects or teams yet. */
export function MarketEmptyState({ onStart }: { onStart: () => void }) {
	return (
		<div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
			<div
				className={`${GAME_PLATE} pointer-events-auto flex max-w-sm flex-col items-start gap-4 p-5`}
			>
				<div className="flex flex-col gap-1.5">
					<h2 className="gk-display text-(--gk-ink) text-[22px] leading-7">
						No shops on this street yet
					</h2>
					<p className="text-pretty font-medium text-(--gk-ink-muted) text-[15px] leading-6">
						Projects open here as shops and teams as market stalls.
					</p>
				</div>
				<GameAction
					icon={<Plus strokeWidth={2.75} />}
					label="Start a conversation"
					onClick={onStart}
				/>
			</div>
		</div>
	);
}
