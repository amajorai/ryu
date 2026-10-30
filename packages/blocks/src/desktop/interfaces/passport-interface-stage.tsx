import type { ReactNode } from "react";
import {
	IsoStage,
	type useGameNight,
	type useIsoView,
} from "./game3d-stage.tsx";
import type { useVillagerLooks } from "./game3d-villager.tsx";
import { ActStatus } from "./interface-ask-card.tsx";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { EmptyCustomsDesk } from "./passport-acts.tsx";
import {
	type DeskActors,
	type DeskLayout,
	DeskScene,
	type deskFraming,
} from "./passport-desk.tsx";
import { passportFaceRenderer } from "./passport-interface-faces.tsx";
import { LoadingIsles, PassportList } from "./passport-interface-list.tsx";
import type {
	Passport,
	PassportCountry,
	PassportSpread,
	upcomingTravel,
} from "./passport-model.ts";
import type { PassportNavigation } from "./passport-navigation.ts";
import type { deskArt } from "./passport-palette.ts";
import type { ActsView, useActClockOptions } from "./use-acts.ts";

type RendererProps = InterfaceRendererProps<unknown>;

/**
 * The desk itself: the booklet open on the 3D desk (or, without WebGL, the
 * countries as a list), or the loading placeholder.
 */
export function PassportStage({
	acts,
	actsOn,
	actors,
	activeThreadId,
	apply,
	art,
	clock,
	countryById,
	deskSpread,
	finishTurn,
	framing,
	insets,
	isoView,
	layout,
	loading,
	looks,
	night,
	nowMs,
	onAsk,
	onBlocker,
	openCountry,
	openStamp,
	passport,
	recordOpen,
	reduceMotion,
	single,
	snapshot,
	summary,
	turn,
	upcoming,
}: {
	acts: ActsView["acts"];
	actsOn: boolean;
	actors: DeskActors | undefined;
	activeThreadId: RendererProps["activeThreadId"];
	apply: (agentId: string) => void;
	art: ReturnType<typeof deskArt>;
	clock: ReturnType<typeof useActClockOptions>;
	countryById: ReadonlyMap<string, PassportCountry>;
	deskSpread: PassportSpread | undefined;
	finishTurn: PassportNavigation["finishTurn"];
	framing: ReturnType<typeof deskFraming>;
	insets: Parameters<typeof deskFraming>[3];
	isoView: ReturnType<typeof useIsoView>;
	layout: DeskLayout;
	loading: boolean;
	looks: ReturnType<typeof useVillagerLooks>["looks"];
	night: ReturnType<typeof useGameNight>;
	nowMs: number;
	onAsk: (askId: string, opener?: HTMLElement) => void;
	onBlocker: (
		threadId: string,
		agentName: string,
		opener?: HTMLElement
	) => void;
	openCountry: (countryId: string | null) => void;
	openStamp: (threadId: string) => void;
	passport: Passport;
	recordOpen: boolean;
	reduceMotion: boolean;
	single: boolean;
	snapshot: RendererProps["snapshot"];
	summary: string;
	turn: PassportNavigation["turn"];
	upcoming: ReturnType<typeof upcomingTravel>;
}): ReactNode {
	const face = passportFaceRenderer({
		acts,
		actsOn,
		activeThreadId,
		countryById,
		openStamp,
		passport,
		recordOpen,
		snapshot,
		summary,
		upcoming,
	});
	const faces = {
		left: face(deskSpread?.left),
		right: face(deskSpread?.right),
	};
	let turning: 1 | -1 | null = null;
	if (turn && !single) {
		turning = turn.to > turn.from ? 1 : -1;
	}
	return loading ? (
		<LoadingIsles />
	) : (
		<IsoStage
			bounds={framing.bounds}
			fallback={
				<PassportList
					acts={
						actsOn
							? {
									sentence: (agentId) => acts.get(agentId)?.ariaLabel ?? null,
									status: (agentId) => {
										const act = acts.get(agentId);
										return act ? (
											<ActStatus
												act={act}
												clock={clock}
												nowMs={nowMs}
												onAsk={onAsk}
												onBlocker={onBlocker}
												snapshot={snapshot}
											/>
										) : null;
									},
								}
							: undefined
					}
					layout={layout}
					onApply={apply}
					onOpenCountry={openCountry}
				/>
			}
			fill={framing.fill}
			insets={insets}
			label="Passport: the booklet open on a desk, a visa page for each agent, whose villager stands on its page's tab. Page Up and Page Down turn the pages; Tab or the arrow keys move between agents; drag to pan, plus and minus to zoom."
			motes={false}
			night={night}
			portrait={framing.portrait}
			reducedMotion={reduceMotion}
			view={isoView}
		>
			{({ theme }) => (
				<DeskScene
					actors={actors}
					art={art}
					customs={actsOn ? undefined : <EmptyCustomsDesk layout={layout} />}
					faces={faces}
					layout={layout}
					looks={looks}
					onApply={apply}
					onTurnDone={finishTurn}
					pages={passport.pages}
					reducedMotion={reduceMotion}
					spread={deskSpread}
					theme={theme}
					turning={turning}
				/>
			)}
		</IsoStage>
	);
}
