"use client";

import * as React from "react";
import { Solid } from "../../kit/react/draw.tsx";
import { useInView, useLoop, useStillness } from "../../kit/react/live.tsx";
import { QuietSvg } from "../shared/quiet-svg.tsx";
import {
	doorAt,
	HEIGHT,
	TOKEN_ART,
	TOKEN_CLIP,
	tokenAt,
	tokenShows,
	WIDTH,
} from "./geometry.ts";

/*
 * One slow loop, in seconds: the box rests sealed, the hatch lifts, one call slides out
 * onto the tray, waits, slides back in with its answer, and the hatch closes again.
 */
const LIFT_FROM = 2.6;
const LIFT_TO = 4;
const OUT_TO = 5.8;
const BACK_FROM = 7.4;
const BACK_TO = 9.2;
const CLOSE_TO = 10.6;
const LOOP_S = 12.4;
/** Where the loop starts, and the pose reduced motion holds: the call out on the tray. */
const HOLD_AT = 6.6;

const smooth = (from: number, to: number, t: number) => {
	const u = Math.max(0, Math.min(1, (t - from) / (to - from)));
	return u * u * (3 - 2 * u);
};

/** The hatch's lift and the call's way out, both 0..1, at loop time `t`. */
function poseAt(t: number) {
	const time = ((t % LOOP_S) + LOOP_S) % LOOP_S;
	const lift =
		smooth(LIFT_FROM, LIFT_TO, time) - smooth(BACK_TO, CLOSE_TO, time);
	const out = smooth(LIFT_TO, OUT_TO, time) - smooth(BACK_FROM, BACK_TO, time);
	return { lift, out };
}

const HELD = poseAt(HOLD_AT);

export interface SandboxGloveboxLiveProps {
	box: React.ReactNode;
	description: string;
	door: React.ReactNode;
	label: string;
	tray: React.ReactNode;
}

export function SandboxGloveboxLive({
	box,
	description,
	door,
	label,
	tray,
}: SandboxGloveboxLiveProps) {
	const root = React.useRef<HTMLDivElement | null>(null);
	const descriptionId = React.useId();
	const clipId = `sgb-clip-${descriptionId.replace(/[^a-zA-Z0-9-]/g, "")}`;
	const visible = useInView(root);
	const still = useStillness();
	const clock = React.useRef(HOLD_AT);
	const hatch = React.useRef<SVGGElement | null>(null);
	const token = React.useRef<SVGGElement | null>(null);

	const tick = React.useCallback((dt: number, calm: boolean) => {
		clock.current = calm ? HOLD_AT : clock.current + dt;
		const { lift, out } = poseAt(clock.current);
		hatch.current?.setAttribute("transform", doorAt(lift));
		if (token.current) {
			token.current.setAttribute("transform", tokenAt(out));
			token.current.style.display = tokenShows(out) ? "" : "none";
		}
		return !calm;
	}, []);

	useLoop(tick, visible && !still);

	return (
		<>
			<div
				aria-describedby={descriptionId}
				aria-label={label}
				className="sgb-live"
				ref={root}
				role="img"
			>
				<QuietSvg height={HEIGHT} width={WIDTH}>
					<defs>
						<clipPath clipPathUnits="userSpaceOnUse" id={clipId}>
							<path d={TOKEN_CLIP} />
						</clipPath>
					</defs>
					{box}
					<g ref={hatch} transform={doorAt(HELD.lift)}>
						{door}
					</g>
					{tray}
					<g clipPath={`url(#${clipId})`}>
						<g ref={token} transform={tokenAt(HELD.out)}>
							<Solid crease="faint" lit paths={TOKEN_ART} tone="hi" />
						</g>
					</g>
				</QuietSvg>
			</div>
			<p className="iso-sr" id={descriptionId}>
				{description}
			</p>
		</>
	);
}
