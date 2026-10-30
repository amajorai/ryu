import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { SquarePen } from "lucide-react";
import { motion } from "motion/react";
import type { ComponentProps } from "react";
import { GamePlate } from "./game-hud.tsx";
import {
	DESK_WIDTH,
	GUTTER,
	IslandPlaceholder,
} from "./town-interface-layout.tsx";
import type { Town } from "./town-model.ts";
import { TownDirectory } from "./town-overlay.tsx";
import type { SceneInsets } from "./town-scene.tsx";

/** Without WebGL: the town's buildings, listed by district. */
export function TownWebglFallback({
	actLayer,
	actsOn,
	deskDocked,
	narrowStage,
	onBuilding,
	town,
}: {
	actLayer: ComponentProps<typeof TownDirectory>["actLayer"];
	actsOn: boolean;
	deskDocked: boolean;
	narrowStage: boolean;
	onBuilding: (agentId: string) => void;
	town: Town;
}) {
	return (
		<div
			className={cn(
				"absolute inset-y-0 right-0 overflow-y-auto px-4 pb-6",
				// With acts the blind-spot caption (and on a phone the
				// summary's own plate) sit under the title plate.
				actsOn ? (narrowStage ? "pt-56" : "pt-36") : "pt-24"
			)}
			style={{ left: deskDocked ? GUTTER * 2 + DESK_WIDTH : 0 }}
		>
			<GamePlate className="mx-auto max-w-2xl px-2 py-2">
				<p className="px-2 pt-2 font-medium text-(--gk-ink-muted) text-sm">
					The 3D town needs WebGL, which is off here, so its buildings are
					listed by district.
				</p>
				<TownDirectory
					actLayer={actLayer}
					onBuilding={onBuilding}
					town={town}
				/>
			</GamePlate>
		</div>
	);
}

/** While the scene loads: the island's outline inside the HUD's insets. */
export function TownLoadingPlaceholder({ insets }: { insets: SceneInsets }) {
	return (
		<div
			className="pointer-events-none absolute flex items-center justify-center"
			style={{
				bottom: insets.bottom,
				left: insets.left,
				right: insets.right,
				top: insets.top,
			}}
		>
			<IslandPlaceholder />
			<span className="sr-only">Laying out the town</span>
		</div>
	);
}

/** An empty town: the invitation to found it. */
export function TownEmptyState({
	insets,
	onStart,
	reduced,
}: {
	insets: SceneInsets;
	onStart: () => void;
	reduced: boolean;
}) {
	return (
		<motion.div
			animate={{ opacity: 1, transform: "translateY(0px)" }}
			className="absolute bottom-24 z-20 flex justify-center px-4"
			initial={reduced ? false : { opacity: 0, transform: "translateY(6px)" }}
			style={{ left: insets.left, right: insets.right }}
		>
			<GamePlate className="flex max-w-md flex-col gap-3 px-5 py-4">
				<div className="flex flex-col gap-1">
					<h2 className="gk-display text-[22px] leading-7">
						No one lives here yet
					</h2>
					<p className="text-pretty font-medium text-(--gk-ink-muted) text-sm leading-5">
						Every agent gets a building, and projects and teams become districts
						around City Hall. Start a conversation to found the town.
					</p>
				</div>
				<Button
					className="self-start"
					onClick={onStart}
					size="sm"
					type="button"
				>
					<SquarePen aria-hidden="true" data-icon="inline-start" />
					Start a conversation
				</Button>
			</GamePlate>
		</motion.div>
	);
}
