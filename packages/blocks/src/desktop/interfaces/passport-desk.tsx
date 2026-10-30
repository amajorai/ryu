/* eslint-disable react/no-unknown-property */

import { useLiteralMessages } from "@ryu/i18n/react";
import { type ReactNode, useMemo } from "react";
import type { LifePaths } from "./game3d-life.ts";
import type { Scene3dTheme, Vec3 } from "./game3d-palette.ts";
import {
	FACE_CAMERA,
	type MemberLooks,
	type VillagerPose,
	type VillagerSpec,
	Villagers,
} from "./game3d-villager.tsx";
import {
	DeskAndBooklet,
	FaceOnPage,
	IndexTabs,
	TurningLeaf,
} from "./passport-desk-booklet.tsx";
import {
	type DeskLayout,
	type DeskMode,
	deskPoint,
	FACE_SCALE,
	PAGE_D,
	PAGE_TOP,
	PAGE_W,
} from "./passport-desk-layout.ts";
import {
	type PassportCountry,
	type PassportPage,
	type PassportSpread,
	type PassportStamp,
	plural,
	UNASSIGNED_CODE,
	UNASSIGNED_LABEL,
} from "./passport-model.ts";
import { PHOTO_FEET } from "./passport-page-face.tsx";
import type { DeskArt } from "./passport-palette.ts";

export type {
	DeskEdge,
	DeskLayout,
	DeskMode,
	DeskStation,
} from "./passport-desk-layout.ts";
export {
	DESK_PORTRAIT_PITCH,
	deskBounds,
	deskExtent,
	deskFraming,
	deskPoint,
	deskSquash,
	FACE_SCALE,
	LEAF_SECONDS,
	layoutDesk,
	PAGE_D,
	PAGE_TOP,
	PAGE_W,
} from "./passport-desk-layout.ts";

/**
 * Passport as a desk diorama on the game kit (game3d-stage.tsx): the
 * passport booklet lies open on a desk, on a leather blotter, and turning
 * its pages is how you move through it. A wide stage shows a two-page
 * spread, a phone one page. The identity page sums the passport up; every
 * agent has a visa page, with its villager standing in the photo frame,
 * its name, its emblem and its status, and its conversations as stamps.
 *
 * Every visa page also has an index tab that pokes out round the booklet's
 * edge, and the agent's villager stands on its tab whichever page is open:
 * that figure is the agent's control (it files a visa application, or with
 * the act layer acts out the agent's state; passport-acts.tsx). The page
 * faces are DOM (passport-page-face.tsx) laid flat on the toon paper.
 */

/**
 * A country's villager pose from its stamps: refused, busy, your turn. A
 * denied (failed) run outranks a processing one, so a failure stays in
 * sight while another run of the same agent works.
 */
export function countryPose(stamps: readonly PassportStamp[]): VillagerPose {
	if (stamps.some((stamp) => stamp.marking === "denied")) {
		return "failed";
	}
	if (stamps.some((stamp) => stamp.marking === "processing")) {
		return "working";
	}
	if (stamps.some((stamp) => stamp.marking === "arrived")) {
		return "needs-you";
	}
	if (stamps.some((stamp) => stamp.marking === "applied")) {
		return "waiting";
	}
	return "idle";
}

/** What a country's row says to a screen reader (the list without WebGL). */
export function stationLabel(station: {
	country: PassportCountry | null;
	stamps: readonly PassportStamp[];
}): string {
	const name = station.country?.agent.name ?? UNASSIGNED_LABEL;
	return `${name} (${station.country?.code ?? UNASSIGNED_CODE}): ${plural(station.stamps.length, "stamp", "stamps")}. Open its visa pages`;
}

/**
 * A country row's name with the act layer: the country, not its agent (the
 * agent's own row button is its one target, named by its act).
 */
export function countryLabel(station: {
	country: PassportCountry | null;
	stamps: readonly PassportStamp[];
}): string {
	return `Country ${station.country?.code ?? UNASSIGNED_CODE}: ${plural(station.stamps.length, "stamp", "stamps")}. Open its visa pages`;
}

/** Where a shown page lies: its middle across the desk. */
export function pageMiddle(mode: DeskMode, side: "left" | "right"): number {
	if (mode === "single") {
		return 0;
	}
	return side === "left" ? -PAGE_W / 2 : PAGE_W / 2;
}

/** Where an agent's photo villager stands on its visa page. */
export function photoSpot(mode: DeskMode, side: "left" | "right"): Vec3 {
	const left = pageMiddle(mode, side) - PAGE_W / 2;
	return deskPoint(
		left + PHOTO_FEET.x * FACE_SCALE,
		-PAGE_D / 2 + PHOTO_FEET.y * FACE_SCALE,
		PAGE_TOP
	);
}

/** The agents whose visa page (its first page) shows in `spread`. */
export function shownPhotos(
	pages: readonly PassportPage[],
	spread: PassportSpread | undefined
): { countryId: string; side: "left" | "right" }[] {
	const sides: ["left" | "right", number | null | undefined][] = [
		["left", spread?.left],
		["right", spread?.right],
	];
	const shown: { countryId: string; side: "left" | "right" }[] = [];
	for (const [side, index] of sides) {
		const page = index === null || index === undefined ? null : pages[index];
		if (page?.kind === "visa" && page.first && page.countryId) {
			shown.push({ countryId: page.countryId, side });
		}
	}
	return shown;
}

/** The act layer's cast and props, when the snapshot carries acts. */
export interface DeskActors {
	/** Exempt plates collapse to glyphs on narrow stages. */
	iconOnly: boolean;
	/** The agents' villagers, driven by their acts (and their helpers). */
	officers: VillagerSpec[];
	paths: LifePaths;
	/** The customs desk and each station's cues. */
	props: ReactNode;
}

export interface DeskSceneProps {
	actors?: DeskActors;
	art: DeskArt;
	/** The customs desk without the act layer (its empty state). */
	customs?: ReactNode;
	/** The face printed on each shown page (null: none). */
	faces: { left: ReactNode; right: ReactNode };
	layout: DeskLayout;
	looks: ReadonlyMap<string, MemberLooks>;
	onApply: (agentId: string) => void;
	/** A leaf turning: forward (1) or back (-1). */
	onTurnDone: () => void;
	pages: readonly PassportPage[];
	reducedMotion: boolean;
	spread: PassportSpread | undefined;
	theme: Scene3dTheme;
	turning: 1 | -1 | null;
}

/** The desk diorama: the open booklet, its tabs, and the agents. */
export function DeskScene({
	actors,
	art,
	customs,
	faces,
	layout,
	looks,
	onApply,
	onTurnDone,
	pages,
	reducedMotion,
	spread,
	turning,
}: DeskSceneProps) {
	const tl = useLiteralMessages();
	const closed = spread?.right === 0 && (spread.left ?? null) === null;
	const photos = useMemo<VillagerSpec[]>(
		() =>
			turning
				? []
				: shownPhotos(pages, spread).flatMap(({ countryId, side }) => {
						const base = looks.get(countryId);
						if (!base) {
							return [];
						}
						return [
							{
								facing: FACE_CAMERA,
								id: `photo:${countryId}`,
								label: "",
								looks: base,
								name: "",
								plate: false as const,
								pose: "idle" as const,
								position: photoSpot(layout.mode, side),
								scale: 0.62,
							},
						];
					}),
		[layout.mode, looks, pages, spread, turning]
	);
	const standing = useMemo<VillagerSpec[]>(
		() =>
			layout.stations.flatMap((station) => {
				const country = station.country;
				const base = country ? looks.get(country.agent.id) : undefined;
				if (!(country && base)) {
					return [];
				}
				return [
					{
						facing: FACE_CAMERA,
						id: country.agent.id,
						label: tl("{name}: apply for a visa", { name: country.agent.name }),
						looks: base,
						name: country.agent.name,
						pose: countryPose(station.stamps),
						position: station.at,
					},
				];
			}),
		[layout, looks, tl]
	);
	const villagers = actors?.officers ?? standing;
	const showFaces = turning === null;
	return (
		<group>
			<DeskAndBooklet art={art} closed={closed} layout={layout} />
			<IndexTabs art={art} layout={layout} />
			{showFaces && faces.left !== null && !closed ? (
				<FaceOnPage middle={pageMiddle(layout.mode, "left")}>
					{faces.left}
				</FaceOnPage>
			) : null}
			{showFaces && faces.right !== null ? (
				<FaceOnPage
					lift={closed ? PAGE_TOP + 0.03 : PAGE_TOP}
					middle={
						closed && layout.mode === "spread"
							? PAGE_W / 2
							: pageMiddle(layout.mode, "right")
					}
				>
					{faces.right}
				</FaceOnPage>
			) : null}
			{turning ? (
				<TurningLeaf art={art} direction={turning} onDone={onTurnDone} />
			) : null}
			<Villagers
				plates={false}
				reducedMotion={reducedMotion}
				villagers={photos}
			/>
			{actors ? actors.props : (customs ?? null)}
			<Villagers
				iconOnly={actors?.iconOnly}
				onSelect={onApply}
				paths={actors?.paths}
				reducedMotion={reducedMotion}
				villagers={villagers}
			/>
		</group>
	);
}
