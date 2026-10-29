"use client";

import * as React from "react";
import type { Flat } from "../../kit/iso-kit.ts";
import { follow, useLoop } from "../../kit/react/live.tsx";
import { QuietSvg } from "../shared/quiet-svg.tsx";
import {
	advance,
	begin,
	type Changer,
	changerAt,
	layoutOf,
	phaseOf,
	planSwap,
} from "./changer.ts";
import {
	DEFAULT_ENGINE,
	ENGINE_COUNT,
	engineAt,
	type Phase,
	RESTING_SPOKEN,
	SWEEP_SHOWN_S,
	spokenOf,
} from "./model.ts";
import {
	at,
	CART_H,
	HEIGHT,
	RACK_SEAT,
	ROW_Y,
	SHELF_SLOTS,
	shift,
	slotOf,
	slotX,
	WIDTH,
} from "./view.ts";

/** How far a pointed-at cartridge rises out of its slot, in world units. */
const HOVER_LIFT = 3;
const HOVER_EASE = 0.14;
const PICK_RADIUS = 18;

const SLOT_POINTS: Flat[] = Array.from({ length: SHELF_SLOTS }, (_, slot) =>
	at([slotX(slot), ROW_Y, RACK_SEAT + CART_H * 0.5])
);

function nearest(point: Flat): number | null {
	let best: number | null = null;
	let bestDistance = PICK_RADIUS;
	for (const [index, slot] of SLOT_POINTS.entries()) {
		const distance = Math.hypot(slot[0] - point[0], slot[1] - point[1]);
		if (distance < bestDistance) {
			best = index;
			bestDistance = distance;
		}
	}
	return best;
}

const clampIndex = (index: number) =>
	Math.min(ENGINE_COUNT - 1, Math.max(0, index));

const fine = (value: number) => Math.round(value * 10) / 10;

interface Props {
	carried: React.ReactNode;
	deck: React.ReactNode;
	description: string;
	pulse: string;
	pulseCentre: Flat;
	shelf: React.ReactNode;
	slots: React.ReactNode;
}

interface Nodes {
	carried: SVGGElement | null;
	slots: SVGGElement[];
}

export function CoreEnginesLive(props: Props) {
	const root = React.useRef<HTMLDivElement | null>(null);
	const descriptionId = React.useId();
	const announce = React.useRef<HTMLSpanElement>(null);
	const nodes = React.useRef<Nodes>({ slots: [], carried: null });

	const changer = React.useRef<Changer>(changerAt(DEFAULT_ENGINE));
	const target = React.useRef<number>(DEFAULT_ENGINE);
	const preview = React.useRef<number | null>(null);
	/* Hover lift per drawn slot. */
	const lifts = React.useRef<number[]>(new Array(SHELF_SLOTS).fill(0));
	const lastPhase = React.useRef<Phase>("loaded");

	const describe = React.useCallback(() => {
		const node = root.current;
		if (!node) {
			return;
		}
		const state = changer.current;
		const { phase, moving } = phaseOf(state);
		const shown = preview.current ?? target.current;
		const spoken =
			preview.current !== null &&
			preview.current !== state.loaded &&
			phase === "loaded"
				? `${engineAt(preview.current).name}, engine ${preview.current + 1} of ${ENGINE_COUNT}: ${engineAt(preview.current).role}. Press Enter to load it.`
				: spokenOf(state.loaded, phase, moving);
		node.setAttribute("aria-valuenow", `${shown + 1}`);
		if (node.getAttribute("aria-valuetext") !== spoken) {
			node.setAttribute("aria-valuetext", spoken);
		}
	}, []);

	const draw = React.useCallback(() => {
		const state = changer.current;
		const layout = layoutOf(state);
		const { slots, carried } = nodes.current;
		const liftedSlot = layout.lifted ? slotOf(layout.lifted.index) : null;
		for (const [slot, node] of slots.entries()) {
			const away = layout.away.some((engine) => slotOf(engine) === slot);
			node.style.display = away ? "none" : "";
			const dz =
				liftedSlot === slot && layout.lifted
					? layout.lifted.dz
					: (lifts.current[slot] ?? 0);
			const body = node.querySelector<SVGGElement>(".ce-body");
			if (body) {
				/* A cartridge in motion is the one engine on its way in or out: lit. */
				body.toggleAttribute("data-lit", liftedSlot === slot);
			}
			const transform = dz ? shift(0, 0, dz) : "";
			if (node.getAttribute("transform") !== transform) {
				if (transform) {
					node.setAttribute("transform", transform);
				} else {
					node.removeAttribute("transform");
				}
			}
		}
		if (carried) {
			carried.style.display = layout.carried ? "" : "none";
			if (layout.carried) {
				carried.setAttribute(
					"transform",
					shift(layout.carried.dx, 0, layout.carried.dz)
				);
			}
		}
		const { phase, moving } = phaseOf(state);
		if (phase !== lastPhase.current) {
			lastPhase.current = phase;
			describe();
			if (announce.current) {
				announce.current.textContent = spokenOf(state.loaded, phase, moving);
			}
		}
	}, [describe]);

	const startNext = React.useCallback(() => {
		const state = changer.current;
		if (state.steps.length === 0 && target.current !== state.loaded) {
			begin(state, planSwap(state.loaded, target.current));
		}
	}, []);

	const kick = useLoop((dt, calm) => {
		const state = changer.current;
		startNext();
		if (!advance(state, dt, calm)) {
			startNext();
		}
		let easing = false;
		const previewSlot =
			preview.current === null ? null : slotOf(preview.current);
		for (let slot = 0; slot < SHELF_SLOTS; slot++) {
			const goal =
				previewSlot === slot && state.steps.length === 0 ? HOVER_LIFT : 0;
			const next = follow(lifts.current[slot] ?? 0, goal, dt, HOVER_EASE, calm);
			lifts.current[slot] = next;
			easing ||= next !== goal;
		}
		draw();
		return state.steps.length > 0 || easing;
	}, false);

	React.useEffect(() => {
		const svg = root.current?.querySelector("svg");
		if (svg) {
			nodes.current = {
				slots: [...svg.querySelectorAll<SVGGElement>("[data-slot]")],
				carried: svg.querySelector<SVGGElement>("[data-carry]"),
			};
		}
	}, []);

	const pointAt = (clientX: number, clientY: number): Flat | null => {
		const svg = root.current?.querySelector("svg");
		const box = svg?.getBoundingClientRect();
		if (!(box?.width && box.height)) {
			return null;
		}
		return [
			((clientX - box.left) / box.width) * WIDTH,
			((clientY - box.top) / box.height) * HEIGHT,
		];
	};

	const hover = (index: number | null) => {
		if (preview.current === index) {
			return;
		}
		preview.current = index;
		describe();
		kick();
	};

	const commit = (index: number) => {
		target.current = clampIndex(index);
		preview.current = null;
		startNext();
		describe();
		kick();
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		const from = preview.current ?? target.current;
		let next: number | null = null;
		if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
			next = from - 1;
		} else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
			next = from + 1;
		} else if (event.key === "Home") {
			next = 0;
		} else if (event.key === "End") {
			next = ENGINE_COUNT - 1;
		} else if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			commit(from);
			return;
		} else if (event.key === "Escape") {
			hover(null);
			return;
		}
		if (next === null) {
			return;
		}
		event.preventDefault();
		hover(clampIndex(next));
	};

	const [cx, cy] = props.pulseCentre;

	return (
		<>
			<div
				aria-describedby={descriptionId}
				aria-label="Ryu Core engine shelf"
				aria-valuemax={ENGINE_COUNT}
				aria-valuemin={1}
				aria-valuenow={DEFAULT_ENGINE + 1}
				aria-valuetext={RESTING_SPOKEN}
				className="iso-quiet-live ce-live"
				onBlur={() => hover(null)}
				onFocus={() => {
					describe();
					if (announce.current) {
						announce.current.textContent = "";
					}
				}}
				onKeyDown={onKeyDown}
				onPointerDown={(event) => {
					const point = pointAt(event.clientX, event.clientY);
					const pick = point ? nearest(point) : null;
					if (pick !== null) {
						commit(pick);
					}
				}}
				onPointerLeave={(event) => {
					if (event.pointerType === "mouse") {
						hover(null);
					}
				}}
				onPointerMove={(event) => {
					if (event.pointerType !== "mouse") {
						return;
					}
					const point = pointAt(event.clientX, event.clientY);
					hover(point ? nearest(point) : null);
				}}
				ref={root}
				role="slider"
				tabIndex={0}
			>
				<QuietSvg height={HEIGHT} width={WIDTH}>
					{props.shelf}
					<g>{props.slots}</g>
					{props.deck}
					<path
						className="iso-line ce-pulse"
						d={props.pulse}
						data-tone="mid"
						style={
							{
								"--ce-pulse": `${SWEEP_SHOWN_S}s`,
								transformOrigin: `${fine(cx)}px ${fine(cy)}px`,
							} as React.CSSProperties
						}
					/>
					<g data-carry="">{props.carried}</g>
				</QuietSvg>
			</div>
			<p className="iso-sr" id={descriptionId}>
				{props.description}
			</p>
			<span aria-live="polite" className="iso-sr" ref={announce} />
		</>
	);
}
