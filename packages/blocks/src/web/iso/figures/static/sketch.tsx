import type * as React from "react";
import {
	type Flat,
	fitProjection,
	iso,
	type LineTone,
	type Plan,
	type Point3,
	type Projection,
	type SolidPaths,
	slabOf,
	type Tone,
} from "../../kit/iso-kit.ts";
import { Dots, Line, Solid, Wire } from "../../kit/react/draw.tsx";

/*
 * A small builder for the static product figures: geometry is computed once at
 * module load and collected, in painter's order (far to near), as keyed
 * elements of the kit's server-safe draw components. Static figures ship no
 * client code beyond the shared stage.
 */

export interface SolidStyle {
	crease?: Tone | "none";
	lit?: boolean;
	tone?: Tone;
}

export interface LineStyle {
	dotted?: boolean;
	flow?: boolean;
	free?: boolean | "start" | "end";
	tone?: LineTone;
}

export interface Sketch {
	/** Project a world point to the drawing. */
	at: (point: Point3) => Flat;
	dots: (points: Flat[], style?: { size?: number; tone?: Tone }) => void;
	/** Soft shadow under a plan resting at `z`. */
	halo: (plan: Plan, z: number, blur?: number) => void;
	line: (d: string, style?: LineStyle) => void;
	nodes: () => React.ReactNode[];
	P: Projection;
	solid: (paths: SolidPaths, style?: SolidStyle) => void;
	wire: (
		from: Point3,
		to: Point3,
		via?: Point3[],
		style?: { flow?: boolean; tone?: LineTone }
	) => void;
}

export function createSketch(
	bounds: Point3[],
	width: number,
	height: number,
	{ azimuth = 40, pad = 24 }: { azimuth?: number; pad?: number } = {}
): Sketch {
	const P = fitProjection(bounds, width, height, { azimuth, pad });
	const items: React.ReactNode[] = [];
	const at = (point: Point3) => iso(point, P);
	const key = () => `n${items.length}`;
	return {
		P,
		at,
		solid: (paths, { tone = "mid", crease = "faint", lit = false } = {}) => {
			items.push(
				<Solid
					crease={crease}
					key={key()}
					lit={lit}
					paths={paths}
					tone={lit ? "hi" : tone}
				/>
			);
		},
		line: (d, { tone = "lo", dotted, flow, free } = {}) => {
			if (d) {
				items.push(
					<Line
						d={d}
						dotted={dotted}
						flow={flow}
						free={free}
						key={key()}
						tone={tone}
					/>
				);
			}
		},
		dots: (points, { size = 0.5, tone = "mid" } = {}) => {
			items.push(<Dots key={key()} points={points} size={size} tone={tone} />);
		},
		wire: (from, to, via = [], { tone = "mid", flow } = {}) => {
			items.push(
				<Wire
					flow={flow}
					from={at(from)}
					key={key()}
					to={at(to)}
					tone={tone}
					via={via.map(at)}
				/>
			);
		},
		halo: (plan, z, blur = 5) => {
			items.push(
				<path
					className="iso-halo"
					d={slabOf(plan, z, 0.1, P).fill}
					key={key()}
					style={{ filter: `blur(${blur}px)` }}
				/>
			);
		},
		nodes: () => items,
	};
}
