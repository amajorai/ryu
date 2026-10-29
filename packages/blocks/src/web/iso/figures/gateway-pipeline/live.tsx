"use client";

import * as React from "react";
import {
	type Spring,
	spring,
	useInView,
	useLoop,
	useStillness,
} from "../../kit/react/live.tsx";
import { QuietSvg } from "../shared/quiet-svg.tsx";
import {
	ENTER_X,
	GATE_SX,
	GATE_X,
	HEIGHT,
	LEAVE_X,
	slideTo,
	WIDTH,
} from "./geometry.ts";
import { STAGE_COUNT, spokenOf } from "./model.ts";

/** Where the request rests before it moves, and under reduced motion: the firewall. */
const REST_STAGE = 1;
/** Seconds per hop between neighbouring stops; the loop is slow on purpose. */
const HOP_S = 1.9;
/** How much the request slows as it passes under a gate (0 is constant speed). */
const LINGER = 0.65;
/** Distance over which the request fades in at the start and out at the end. */
const FADE = 36;
/** How close the request must be to a gate for that gate to step up. */
const UNDER = 12;
const STIFF = 14;
const DRAG = 7.5;

/** Every stop the request passes, in order: the entry, each gate, the exit. */
const STOPS: readonly number[] = [ENTER_X, ...GATE_X, LEAVE_X];
const HOPS = STOPS.length - 1;
const LOOP_S = HOPS * HOP_S;

const linger = (u: number) =>
	u - (LINGER * Math.sin(2 * Math.PI * u)) / (2 * Math.PI);

/** Where the ambient loop puts the request at loop time `t`. */
function ambientX(t: number) {
	const hops = (((t % LOOP_S) + LOOP_S) % LOOP_S) / HOP_S;
	const hop = Math.min(HOPS - 1, Math.floor(hops));
	const from = STOPS[hop] ?? ENTER_X;
	const to = STOPS[hop + 1] ?? LEAVE_X;
	return from + (to - from) * linger(hops - hop);
}

/** The loop time at which the request reaches `x`, so the loop resumes without a jump. */
function ambientTimeFor(x: number) {
	let low = 0;
	let high = LOOP_S - 1e-3;
	for (let step = 0; step < 40; step++) {
		const middle = (low + high) / 2;
		if (ambientX(middle) < x) {
			low = middle;
		} else {
			high = middle;
		}
	}
	return low;
}

const opacityAt = (x: number) =>
	Math.max(0, Math.min(1, (x - ENTER_X) / FADE, (LEAVE_X - x) / FADE));

function gateUnder(x: number) {
	const index = GATE_X.findIndex((gx) => Math.abs(gx - x) < UNDER);
	return index < 0 ? null : index;
}

function nearestStage(sx: number) {
	let best = 0;
	GATE_SX.forEach((gx, index) => {
		if (Math.abs(gx - sx) < Math.abs((GATE_SX[best] ?? 0) - sx)) {
			best = index;
		}
	});
	return best;
}

export interface GatewayPipelineLiveProps {
	behind: React.ReactNode;
	description: string;
	inFront: React.ReactNode;
	parcel: React.ReactNode;
}

export function GatewayPipelineLive({
	behind,
	description,
	inFront,
	parcel,
}: GatewayPipelineLiveProps) {
	const root = React.useRef<HTMLDivElement | null>(null);
	const descriptionId = React.useId();
	const visible = useInView(root);
	const still = useStillness();

	const restX = GATE_X[REST_STAGE] ?? 0;
	const slide = React.useRef<SVGGElement | null>(null);
	const travel = React.useRef<Spring>({ at: restX, rate: 0 });
	const clock = React.useRef(ambientTimeFor(restX));
	const lit = React.useRef<number | null>(null);
	const [selected, setSelected] = React.useState<number | null>(null);

	const ambient = selected === null && !still;

	const light = React.useCallback((stage: number | null) => {
		if (lit.current === stage) {
			return;
		}
		lit.current = stage;
		for (const part of root.current?.querySelectorAll<SVGGElement>(
			"[data-stage]"
		) ?? []) {
			part.toggleAttribute(
				"data-on",
				stage !== null && part.dataset.stage === String(stage)
			);
		}
	}, []);

	const tick = React.useCallback(
		(dt: number, calm: boolean) => {
			let x: number;
			let more: boolean;
			if (ambient) {
				clock.current += dt;
				x = ambientX(clock.current);
				travel.current = { at: x, rate: 0 };
				more = true;
			} else {
				const target = GATE_X[selected ?? REST_STAGE] ?? travel.current.at;
				more = !spring(travel.current, target, dt, STIFF, DRAG, calm);
				if (calm) {
					travel.current = { at: target, rate: 0 };
					more = false;
				}
				x = travel.current.at;
			}
			const node = slide.current;
			if (node) {
				node.setAttribute("transform", slideTo(x));
				node.style.opacity = `${Math.round(opacityAt(x) * 100) / 100}`;
			}
			light(selected ?? (ambient ? gateUnder(x) : null));
			return more;
		},
		[ambient, light, selected]
	);

	const kick = useLoop(tick, visible);

	React.useEffect(() => {
		if (ambient) {
			clock.current = ambientTimeFor(travel.current.at);
		}
		kick();
	}, [ambient, kick]);

	const choose = (index: number | null) => {
		setSelected(index);
		kick();
	};

	const stageAtPointer = (clientX: number) => {
		const box = root.current?.querySelector("svg")?.getBoundingClientRect();
		if (!box?.width) {
			return null;
		}
		return nearestStage(((clientX - box.left) / box.width) * WIDTH);
	};

	const shown = selected ?? REST_STAGE;

	return (
		<>
			<div
				aria-describedby={descriptionId}
				aria-label="Ryu Gateway request pipeline"
				aria-valuemax={STAGE_COUNT}
				aria-valuemin={1}
				aria-valuenow={shown + 1}
				aria-valuetext={spokenOf(shown)}
				className="iso-quiet-live gwp-live"
				onBlur={() => choose(null)}
				onKeyDown={(event) => {
					const from = selected ?? REST_STAGE;
					let next: number | null = null;
					if (event.key === "ArrowRight" || event.key === "ArrowUp") {
						next =
							selected === null ? from : Math.min(STAGE_COUNT - 1, from + 1);
					} else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
						next = selected === null ? from : Math.max(0, from - 1);
					} else if (event.key === "Home") {
						next = 0;
					} else if (event.key === "End") {
						next = STAGE_COUNT - 1;
					} else if (event.key === "Escape") {
						choose(null);
						return;
					}
					if (next === null) {
						return;
					}
					event.preventDefault();
					choose(next);
				}}
				onPointerDown={(event) => {
					if (event.pointerType === "mouse") {
						return;
					}
					const stage = stageAtPointer(event.clientX);
					if (stage !== null) {
						choose(stage);
					}
				}}
				onPointerLeave={(event) => {
					if (event.pointerType === "mouse") {
						choose(null);
					}
				}}
				onPointerMove={(event) => {
					if (event.pointerType !== "mouse") {
						return;
					}
					const stage = stageAtPointer(event.clientX);
					if (stage !== null && stage !== selected) {
						choose(stage);
					}
				}}
				ref={root}
				role="slider"
				tabIndex={0}
			>
				<QuietSvg height={HEIGHT} width={WIDTH}>
					{behind}
					<g ref={slide} style={{ opacity: 1 }} transform={slideTo(restX)}>
						{parcel}
					</g>
					{inFront}
				</QuietSvg>
			</div>
			<p className="iso-sr" id={descriptionId}>
				{description}
			</p>
		</>
	);
}
