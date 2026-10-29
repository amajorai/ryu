"use client";

import * as React from "react";
import type { Point3 } from "../../kit/iso-kit.ts";
import { Line, Solid } from "../../kit/react/draw.tsx";
import { useInView, useLoop, useStillness } from "../../kit/react/live.tsx";
import { QuietSvg } from "../shared/quiet-svg.tsx";
import {
	HEIGHT,
	KEY_ART,
	KEY_AWAY,
	KEY_DOCK,
	KEY_HOME,
	KEY_OUT,
	placeAt,
	SHEET_ART,
	SHEET_FROM,
	SHEET_TO,
	WIDTH,
} from "./geometry.ts";

/*
 * One slow loop, in seconds: the key leaves its box, crosses to the site and docks; the
 * page slides down to the agent's tray; the key goes home; the page fades. Each leg is
 * eased, and the loop holds still between legs so the motion stays calm.
 */
const OUT = [2, 4] as const;
const ACROSS = [4, 8] as const;
const DOCK = [8, 9.4] as const;
const PAGE = [9.8, 13.4] as const;
const UNDOCK = [13.8, 15.2] as const;
const BACK = [15.2, 19.2] as const;
const HOME = [19.2, 21.2] as const;
const PAGE_FADE = [20, 22] as const;
const LOOP = 23;
/** The still picture, and where the loop starts: key at the site, page in the tray. */
const REST_TIME = PAGE[1] + 0.2;
const PAGE_APPEAR = 0.8;

const smooth = (value: number) => {
	const u = Math.min(1, Math.max(0, value));
	return u * u * (3 - 2 * u);
};
const progress = (t: number, [from, to]: readonly [number, number]) =>
	smooth((t - from) / (to - from));
const mix = (a: Point3, b: Point3, u: number): Point3 => [
	a[0] + (b[0] - a[0]) * u,
	a[1] + (b[1] - a[1]) * u,
	a[2] + (b[2] - a[2]) * u,
];

function keyAt(t: number): Point3 {
	if (t < OUT[1]) {
		return mix(KEY_HOME, KEY_OUT, progress(t, OUT));
	}
	if (t < ACROSS[1]) {
		return mix(KEY_OUT, KEY_AWAY, progress(t, ACROSS));
	}
	if (t < UNDOCK[0]) {
		return mix(KEY_AWAY, KEY_DOCK, progress(t, DOCK));
	}
	if (t < UNDOCK[1]) {
		return mix(KEY_DOCK, KEY_AWAY, progress(t, UNDOCK));
	}
	if (t < BACK[1]) {
		return mix(KEY_AWAY, KEY_OUT, progress(t, BACK));
	}
	return mix(KEY_OUT, KEY_HOME, progress(t, HOME));
}

function pageAt(t: number) {
	const share = progress(t, PAGE);
	const appear = Math.min(1, Math.max(0, (t - PAGE[0]) / PAGE_APPEAR));
	const fade = 1 - progress(t, PAGE_FADE);
	return {
		place: mix(SHEET_FROM, SHEET_TO, share),
		alpha: Math.round(appear * fade * 100) / 100,
	};
}

const REST_KEY = placeAt(keyAt(REST_TIME));
const REST_PAGE = pageAt(REST_TIME);

export interface PassportCabinetLiveProps {
	/** The static drawing behind the moving parts: cabinet, keys, site and tray. */
	children: React.ReactNode;
	description: string;
	label: string;
}

export function PassportCabinetLive({
	children,
	description,
	label,
}: PassportCabinetLiveProps) {
	const root = React.useRef<HTMLDivElement | null>(null);
	const descriptionId = React.useId();
	const visible = useInView(root);
	const still = useStillness();
	const time = React.useRef(REST_TIME);
	const key = React.useRef<SVGGElement | null>(null);
	const page = React.useRef<SVGGElement | null>(null);

	const tick = React.useCallback((dt: number, calm: boolean) => {
		if (calm) {
			time.current = REST_TIME;
		} else {
			time.current = (time.current + dt) % LOOP;
		}
		const shown = pageAt(time.current);
		key.current?.setAttribute("transform", placeAt(keyAt(time.current)));
		page.current?.setAttribute("transform", placeAt(shown.place));
		page.current?.setAttribute("opacity", `${shown.alpha}`);
		return !calm;
	}, []);

	useLoop(tick, visible && !still);

	return (
		<>
			<div
				aria-describedby={descriptionId}
				aria-label={label}
				className="ppc-live"
				ref={root}
				role="img"
			>
				<QuietSvg height={HEIGHT} width={WIDTH}>
					{children}
					<g ref={key} transform={REST_KEY}>
						<Solid crease="none" lit paths={KEY_ART.solid} tone="hi">
							<Line d={KEY_ART.hole} tone="lit" />
						</Solid>
					</g>
					<g
						opacity={REST_PAGE.alpha}
						ref={page}
						transform={placeAt(REST_PAGE.place)}
					>
						<Solid crease="none" paths={SHEET_ART} tone="mid" />
					</g>
				</QuietSvg>
			</div>
			<p className="iso-sr" id={descriptionId}>
				{description}
			</p>
		</>
	);
}
