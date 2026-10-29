"use client";

import * as React from "react";
import type { SolidPaths } from "../../kit/iso-kit.ts";
import { follow, useInView, useLoop } from "../../kit/react/live.tsx";
import { QuietSvg } from "../shared/quiet-svg.tsx";
import {
	HEIGHT,
	marbleAt,
	type PinPaths,
	pinPaths,
	seatOf,
	seatScreen,
	WIDTH,
} from "./geometry.ts";
import { NODE_COUNT, nodeAt, PATH } from "./model.ts";
import {
	DURATION,
	finishedSim,
	newSim,
	type Sim,
	statusOf,
	step,
} from "./sim.ts";

/** World units per second the marble rolls: slow, so the loop stays calm. */
const ROLL_SPEED = 30;
const SPAWN_DROP = 6;
const FADE_OUT_S = 0.9;
/** How long a pin takes to rise or settle (time constant, seconds). */
const PIN_EASE = 0.28;

type Point3 = [number, number, number];

const smooth = (u: number) => {
	const k = Math.min(1, Math.max(0, u));
	return k * k * (3 - 2 * k);
};

const mix = (a: Point3, b: Point3, u: number): Point3 => [
	a[0] + (b[0] - a[0]) * u,
	a[1] + (b[1] - a[1]) * u,
	a[2] + (b[2] - a[2]) * u,
];

function rollTime(from: number, to: number) {
	const a = seatOf(from);
	const b = seatOf(to);
	return Math.hypot(b[0] - a[0], b[1] - a[1]) / ROLL_SPEED;
}

interface Pose {
	centre: Point3;
	opacity: number;
}

function poseOf(sim: Sim): Pose {
	if (sim.phase === "spawn") {
		const u = smooth(sim.t / DURATION.spawn);
		const seat = seatOf(sim.at);
		return {
			centre: [seat[0], seat[1], seat[2] + (1 - u) * SPAWN_DROP],
			opacity: u,
		};
	}
	if (sim.phase === "roll") {
		const u = smooth(sim.t / rollTime(sim.at, sim.to));
		return { centre: mix(seatOf(sim.at), seatOf(sim.to), u), opacity: 1 };
	}
	if (sim.phase === "done") {
		const fade = (sim.t - (DURATION.done - FADE_OUT_S)) / FADE_OUT_S;
		return { centre: seatOf(sim.at), opacity: 1 - smooth(fade) };
	}
	return { centre: seatOf(sim.at), opacity: 1 };
}

/**
 * How far each node's pin stands: only the latest checkpoint is up, so the drawing reads
 * as one marble and one pin, not a row of pins. Earlier pins settle back into their discs.
 */
function pinTargets(sim: Sim): number[] {
	const latest = PATH.findLast((node) => sim.completed[node]);
	return Array.from({ length: NODE_COUNT }, (_, node) =>
		node === latest ? 1 : 0
	);
}

/** The resting picture: one finished run, the marble at full strength on its last node. */
const REST = finishedSim();
const REST_MARBLE = marbleAt(poseOf(REST).centre);
const REST_TARGETS = pinTargets(REST);
const REST_PINS = REST_TARGETS.map((share, node) => pinPaths(node, share));

interface SolidNodes {
	edge: SVGPathElement | null;
	fill: SVGPathElement | null;
	root: SVGGElement | null;
	shades: (SVGPathElement | null)[];
	top: SVGPathElement | null;
}

const solidNodes = (): SolidNodes => ({
	root: null,
	fill: null,
	shades: [null, null, null, null],
	top: null,
	edge: null,
});

function paint(nodes: SolidNodes, paths: SolidPaths | null) {
	if (!nodes.root) {
		return;
	}
	if (!paths) {
		nodes.root.style.display = "none";
		return;
	}
	nodes.root.style.display = "";
	nodes.fill?.setAttribute("d", paths.fill);
	nodes.shades.forEach((node, index) =>
		node?.setAttribute("d", paths.shades[index] ?? "")
	);
	nodes.top?.setAttribute("d", paths.top);
	nodes.edge?.setAttribute("d", paths.outline);
}

/** A solid whose paths the loop rewrites: the kit's `Solid` markup without creases. */
function LiveSolid({
	nodes,
	paths,
}: {
	nodes: SolidNodes;
	paths: SolidPaths | null;
}) {
	return (
		<g
			className="iso-solid"
			ref={(node) => {
				nodes.root = node;
			}}
			style={paths ? undefined : { display: "none" }}
		>
			<path
				className="iso-fill"
				d={paths?.fill ?? ""}
				ref={(node) => {
					nodes.fill = node;
				}}
			/>
			{[0, 1, 2, 3].map((index) => (
				<path
					className="iso-shade"
					d={paths?.shades[index] ?? ""}
					data-shade={index}
					key={index}
					ref={(node) => {
						nodes.shades[index] = node;
					}}
				/>
			))}
			<path
				className="iso-top"
				d={paths?.top ?? ""}
				ref={(node) => {
					nodes.top = node;
				}}
			/>
			<path
				className="iso-line iso-edge"
				d={paths?.outline ?? ""}
				data-tone="hi"
				ref={(node) => {
					nodes.edge = node;
				}}
			/>
		</g>
	);
}

interface PinNodes {
	head: SolidNodes;
	stem: SolidNodes;
}

const SEATS = Array.from({ length: NODE_COUNT }, (_, node) => seatScreen(node));

function nearestNode(sx: number, sy: number) {
	let best = 0;
	let bestDistance = Number.POSITIVE_INFINITY;
	SEATS.forEach(([x, y], node) => {
		const distance = Math.hypot(x - sx, (y - sy) * 0.6);
		if (distance < bestDistance) {
			best = node;
			bestDistance = distance;
		}
	});
	return best;
}

function spokenOf(sim: Sim, node: number) {
	const item = nodeAt(node);
	return `Node ${node + 1} of ${NODE_COUNT}, ${item.name} (${item.kind}): ${statusOf(sim, node)}. ${item.does}`;
}

export interface WorkflowRunLiveProps {
	children: React.ReactNode;
	description: string;
}

export function WorkflowRunLive({
	description,
	children,
}: WorkflowRunLiveProps) {
	const root = React.useRef<HTMLDivElement | null>(null);
	const visible = useInView(root);

	const descriptionId = React.useId();
	/* The loop opens on the rest picture, holds it, then fades and starts over. */
	const sim = React.useRef<Sim>(finishedSim());
	const pins = React.useRef<number[]>([...REST_TARGETS]);
	const pinNodes = React.useRef(
		Array.from(
			{ length: NODE_COUNT },
			(): PinNodes => ({ stem: solidNodes(), head: solidNodes() })
		)
	).current;
	const marble = React.useRef<SVGGElement | null>(null);

	const [selected, setSelected] = React.useState<number | null>(null);
	const selectedRef = React.useRef(selected);
	selectedRef.current = selected;

	const tick = React.useCallback(
		(dt: number, calm: boolean) => {
			if (calm) {
				sim.current = finishedSim();
			} else if (step(sim.current, dt, rollTime)) {
				sim.current = newSim();
			}
			const current = sim.current;

			const pose = poseOf(current);
			const { cx, cy } = marbleAt(pose.centre);
			const ball = marble.current;
			if (ball) {
				ball.setAttribute(
					"transform",
					`translate(${(cx - REST_MARBLE.cx).toFixed(1)} ${(cy - REST_MARBLE.cy).toFixed(1)})`
				);
				ball.style.opacity = pose.opacity < 1 ? `${pose.opacity}` : "";
			}

			const targets = pinTargets(current);
			for (let node = 0; node < NODE_COUNT; node++) {
				const target = targets[node] ?? 0;
				const before = pins.current[node] ?? 0;
				const after = follow(before, target, dt, PIN_EASE, calm);
				pins.current[node] = after;
				const nodes = pinNodes[node];
				if (nodes && (after !== before || calm)) {
					const paths: PinPaths | null = pinPaths(node, after);
					paint(nodes.stem, paths?.stem ?? null);
					paint(nodes.head, paths?.head ?? null);
				}
			}

			root.current?.toggleAttribute("data-skip", current.skipped);
			root.current?.setAttribute(
				"aria-valuetext",
				spokenOf(current, selectedRef.current ?? current.at)
			);
			return !calm;
		},
		[pinNodes]
	);

	useLoop(tick, visible);

	React.useEffect(() => {
		const node = root.current;
		if (!node) {
			return;
		}
		for (const part of node.querySelectorAll<SVGGElement>("[data-stage]")) {
			part.toggleAttribute(
				"data-on",
				selected !== null && part.dataset.stage === String(selected)
			);
		}
	}, [selected]);

	const pointAt = (clientX: number, clientY: number) => {
		const svg = root.current?.querySelector("svg");
		const box = svg?.getBoundingClientRect();
		if (!box?.width) {
			return null;
		}
		return nearestNode(
			((clientX - box.left) / box.width) * WIDTH,
			((clientY - box.top) / box.height) * HEIGHT
		);
	};

	const shown = selected ?? REST.at;

	return (
		<>
			<div
				aria-describedby={descriptionId}
				aria-label="A Ryu workflow run"
				aria-valuemax={NODE_COUNT}
				aria-valuemin={1}
				aria-valuenow={shown + 1}
				aria-valuetext={spokenOf(REST, shown)}
				className="iso-quiet-live wfr-live"
				data-focus={selected === null ? undefined : ""}
				data-skip=""
				onBlur={() => setSelected(null)}
				onKeyDown={(event) => {
					const from = selected ?? sim.current.at;
					let next: number | null = null;
					if (event.key === "ArrowRight" || event.key === "ArrowUp") {
						next =
							selected === null ? from : Math.min(NODE_COUNT - 1, from + 1);
					} else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
						next = selected === null ? from : Math.max(0, from - 1);
					} else if (event.key === "Home") {
						next = 0;
					} else if (event.key === "End") {
						next = NODE_COUNT - 1;
					} else if (event.key === "Escape") {
						setSelected(null);
						return;
					}
					if (next === null) {
						return;
					}
					event.preventDefault();
					setSelected(next);
				}}
				onPointerLeave={() => setSelected(null)}
				onPointerMove={(event) => {
					const node = pointAt(event.clientX, event.clientY);
					if (node !== null && node !== selected) {
						setSelected(node);
					}
				}}
				ref={root}
				role="slider"
				tabIndex={0}
			>
				<QuietSvg height={HEIGHT} width={WIDTH}>
					{children}
					{pinNodes.map((nodes, node) => (
						<g className="wfr-pin" data-stage={node} key={node}>
							<LiveSolid
								nodes={nodes.stem}
								paths={REST_PINS[node]?.stem ?? null}
							/>
							<LiveSolid
								nodes={nodes.head}
								paths={REST_PINS[node]?.head ?? null}
							/>
						</g>
					))}
					<g className="wfr-marble" ref={marble}>
						<circle
							className="wfr-ball"
							cx={REST_MARBLE.cx}
							cy={REST_MARBLE.cy}
							r={REST_MARBLE.r}
						/>
						<circle
							className="wfr-glint"
							cx={REST_MARBLE.cx - REST_MARBLE.r * 0.32}
							cy={REST_MARBLE.cy - REST_MARBLE.r * 0.36}
							r={REST_MARBLE.r * 0.24}
						/>
					</g>
				</QuietSvg>
			</div>
			<p className="iso-sr" id={descriptionId}>
				{description}
			</p>
		</>
	);
}
