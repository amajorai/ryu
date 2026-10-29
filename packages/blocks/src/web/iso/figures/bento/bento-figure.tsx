"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import { StaticFigure } from "../static/static-figure.tsx";
import {
	BENTO_GROUP_LOADERS,
	type BentoGroupId,
	isBentoGroup,
} from "./loaders.ts";

interface GroupFigureProps {
	title: string;
}

function groupFigure(group: BentoGroupId): ComponentType<GroupFigureProps> {
	return dynamic<GroupFigureProps>(() =>
		BENTO_GROUP_LOADERS[group]().then(({ drawings }) => {
			function GroupFigure({ title }: GroupFigureProps) {
				const drawing = drawings[title];
				return drawing ? (
					<StaticFigure drawing={drawing} name={`${group}:${title}`} />
				) : null;
			}
			return GroupFigure;
		})
	);
}

const GROUP_FIGURES = new Map(
	Object.keys(BENTO_GROUP_LOADERS).map((group) => [
		group,
		groupFigure(group as BentoGroupId),
	])
);

/**
 * The drawing for one bento card: `group` is the page's bento group (see
 * `loaders.ts`) and `title` the card's exact title. Renders nothing for an
 * unknown group or title, so a page never breaks on a missing drawing; the
 * coverage test keeps every card drawn.
 */
export function BentoFigure({
	group,
	title,
}: {
	group: string;
	title: string;
}) {
	const Figure = isBentoGroup(group) ? GROUP_FIGURES.get(group) : undefined;
	return Figure ? <Figure title={title} /> : null;
}
