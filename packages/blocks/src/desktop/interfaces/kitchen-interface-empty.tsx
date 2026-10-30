import { Button } from "@ryu/ui/components/button.tsx";
import { SquarePen } from "lucide-react";
import { motion } from "motion/react";
import { GamePlate } from "./game-hud.tsx";
import type { IsoInsets } from "./game3d-stage.tsx";

/** The kitchen with no chefs: a plate inviting a first conversation. */
export function KitchenEmptyState({
	hasThreads,
	insets,
	onStart,
	reduced,
	side,
}: {
	hasThreads: boolean;
	insets: IsoInsets;
	onStart: () => void;
	reduced: boolean;
	side: number;
}) {
	return (
		<motion.div
			animate={{ opacity: 1 }}
			className="absolute inset-x-0 z-20 flex items-center justify-center"
			initial={reduced ? false : { opacity: 0 }}
			style={{
				bottom: insets.bottom,
				paddingInline: side,
				top: insets.top,
			}}
			transition={{ duration: 0.2, ease: "easeOut" }}
		>
			<div className="absolute inset-0 flex items-center justify-center px-6">
				<GamePlate className="flex max-w-sm flex-col items-center gap-4 px-6 py-6 text-center">
					<div className="flex flex-col gap-1.5">
						<h2 className="gk-display text-[24px] leading-7">
							No chefs on the line
						</h2>
						<p className="text-pretty font-medium text-(--gk-ink-muted) text-sm leading-5">
							{hasThreads
								? "These orders have no agent to cook them. Add an agent to staff a station."
								: "Add an agent to staff a station, or start a conversation."}
						</p>
					</div>
					<Button onClick={onStart} size="sm" type="button">
						<SquarePen aria-hidden="true" data-icon="inline-start" />
						Start a conversation
					</Button>
				</GamePlate>
			</div>
		</motion.div>
	);
}
