import type { ComponentProps, ReactNode } from "react";
import { ArcadeDioramaScene } from "./arcade-diorama.tsx";
import {
	ARCADE_ACT_PLATE_FIT,
	ARCADE_PLATE_FIT,
} from "./arcade-interface-layout.ts";
import type { buildFloor, Machine, nextJackpot } from "./arcade-model.ts";
import { type ArcadeMode, cabinetSkin } from "./arcade-palette.ts";
import { IsoStage, type IsoView } from "./game3d-stage.tsx";

type SceneProps = ComponentProps<typeof ArcadeDioramaScene>;

/** The 3D hall: a player beside every machine, with the act layer on stage. */
export function ArcadeHallStage({
	actView,
	compact,
	filters,
	floor,
	floorView,
	hall,
	isoView,
	looks,
	mode,
	next,
	night,
	onStage,
	open,
	portraitFloor,
	reduced,
	selectedMachine,
	selectMachine,
	shape,
	sheetCover,
	withActs,
}: {
	actView: NonNullable<SceneProps["acts"]>["view"] | null;
	compact: boolean;
	filters: boolean;
	floor: ReturnType<typeof buildFloor>;
	floorView: ReactNode;
	hall: SceneProps["hall"];
	isoView: IsoView;
	looks: SceneProps["looks"];
	mode: ArcadeMode;
	next: ReturnType<typeof nextJackpot>;
	night: boolean;
	onStage: NonNullable<SceneProps["acts"]>["onStage"];
	open: (threadId: string) => void;
	portraitFloor: boolean;
	reduced: boolean;
	selectedMachine: Machine | undefined;
	selectMachine: (machineId: string) => void;
	shape: SceneProps["shape"];
	sheetCover: number;
	withActs: boolean;
}) {
	const insets = {
		bottom: compact ? 72 : 96,
		left: 16,
		right: 16 + sheetCover,
		// A phone with acts stacks a two-line title, the caption and the
		// chips in one column.
		top:
			compact && withActs
				? 120 + (filters ? 56 : 0)
				: (compact ? 64 : 92) + (filters ? 56 : 0) + (withActs ? 36 : 0),
	};
	return (
		<IsoStage
			bounds={{
				maxX: hall.halfWidth,
				maxZ: hall.halfDepth,
				minX: -hall.halfWidth,
				minZ: -hall.halfDepth,
				// The act signs stand over the marquees.
				top: withActs ? 3.8 : 3,
			}}
			fallback={floorView}
			fill={1.1}
			fitPlates={withActs ? ARCADE_ACT_PLATE_FIT : ARCADE_PLATE_FIT}
			insets={insets}
			label="Arcade hall: a slot machine per agent, its player beside it. Tab or the arrow keys move between players; Enter opens their machine. Drag to pan, plus and minus to zoom."
			night={night}
			reducedMotion={reduced}
			view={isoView}
		>
			{({ quality, theme }) => (
				<ArcadeDioramaScene
					acts={actView ? { onStage, view: actView } : null}
					collectable={floor.totals.jackpots}
					hall={hall}
					looks={looks}
					night={night}
					onCollect={() => {
						if (next) {
							open(next.id);
						}
					}}
					onSelect={selectMachine}
					platesAbove={portraitFloor}
					quality={quality}
					reduced={reduced}
					selectedId={selectedMachine?.id ?? null}
					shape={shape}
					skinOf={(machine) => cabinetSkin(mode, machine.skin)}
					theme={theme}
				/>
			)}
		</IsoStage>
	);
}
