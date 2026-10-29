import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { type ReactNode, useId } from "react";
import type { Creature, CreatureKind } from "./aquarium-model.ts";
import {
	type CreatureHue,
	cssColor,
	mixRgb,
	type Rgb,
} from "./aquarium-palette.ts";

/** Frosted glass for chrome floating over the water, in the theme's own surface. */
export const GLASS =
	"border border-border/60 bg-background/90 shadow-foreground/5 shadow-sm backdrop-blur-md";

interface GlyphColors {
	accent: string;
	belly: string;
	body: string;
	/** A manta's back along the spine: the body hue, deepened, as the 3D shader paints it. */
	dorsal: string;
	eye: string;
	fin: string;
	/** The underside shadow the soft shading falls into. */
	shadow: string;
	/** A manta's wings: the body hue warming toward the fin color. */
	wing: string;
}

function glyphColors(hue: CreatureHue, eye: Rgb): GlyphColors {
	return {
		accent: cssColor(hue.accent),
		belly: cssColor(hue.belly),
		body: cssColor(hue.body),
		dorsal: cssColor(mixRgb(hue.body, eye, 0.45)),
		eye: cssColor(eye),
		fin: cssColor(hue.fin),
		shadow: cssColor(mixRgb(hue.fin, eye, 0.4)),
		wing: cssColor(mixRgb(hue.body, hue.fin, 0.4)),
	};
}

/**
 * Soft shading for a portrait: a sheen from above (in the belly tone) and a
 * shadow underneath, the same light the 3D models get from the surface.
 */
function ShadingDefs({ colors, id }: { colors: GlyphColors; id: string }) {
	return (
		<defs>
			<radialGradient cx="38%" cy="26%" id={`${id}-sheen`} r="70%">
				<stop offset="0" stopColor={colors.belly} stopOpacity={0.6} />
				<stop offset="0.65" stopColor={colors.belly} stopOpacity={0} />
			</radialGradient>
			<linearGradient id={`${id}-shade`} x1="0" x2="0" y1="0" y2="1">
				<stop offset="0.4" stopColor={colors.shadow} stopOpacity={0} />
				<stop offset="1" stopColor={colors.shadow} stopOpacity={0.6} />
			</linearGradient>
		</defs>
	);
}

/** The shading layered over a body shape (`d`), inside its clip. */
function Shaded({ d, id }: { d: string; id: string }) {
	return (
		<>
			<path d={d} fill={`url(#${id}-shade)`} />
			<path d={d} fill={`url(#${id}-sheen)`} />
		</>
	);
}

/** A jellyfish bell, scalloped at the rim. */
const BELL =
	"M9.5 25.5C9.5 15.8 16 9 24 9s14.5 6.8 14.5 16.5c-2.4 1.4-4.8-.8-7.2.6-2.4 1.4-4.8-.8-7.3.6-2.4-1.4-4.8.8-7.2-.6-2.4-1.4-4.8.8-7.3-.6Z";
/** A turtle's carapace (the ellipse it is drawn as). */
const SHELL = "M12 24a12 9.4 0 1 0 24 0a12 9.4 0 1 0-24 0Z";
/** A manta from above, head up (the 3D outline): swept wings with concave trailing edges and pointed tips. */
const MANTA =
	"M2 23.8 4.8 21.9 7.5 20.1 10.2 18.5 13 16.9 15.8 15.6 18.5 14.4 21.2 13.5 24 13.3 26.8 13.5 29.5 14.4 32.2 15.6 35 16.9 37.8 18.5 40.5 20.1 43.2 21.9 46 23.8 43.2 24.3 40.5 24.8 37.8 25.4 35 26 32.2 26.7 29.5 27.6 26.8 28.6 24 31.3 21.2 28.6 18.5 27.6 15.8 26.7 13 26 10.2 25.4 7.5 24.8 4.8 24.3Z";

/** Side and top views of each species, drawn to match the 3D models. */
type Marking = "bands" | "spots" | "stripe";

/** The same markings the 3D shader paints, so the portrait matches the creature. */
export function creatureMarking(creature: Creature): Marking {
	const order: Marking[] =
		creature.kind === "angelfish"
			? ["bands", "spots", "stripe"]
			: ["bands", "stripe", "spots"];
	return order[creature.pattern] ?? "bands";
}

/** Markings clipped to a body: vertical bands, a lateral stripe, or spots. */
function Markings({
	bands,
	color,
	marking,
}: {
	bands: readonly [number, number][];
	color: string;
	marking: Marking;
}) {
	if (marking === "stripe") {
		return <path d="M8 22.6 44 23.6v2.6L8 25.4Z" fill={color} />;
	}
	if (marking === "spots") {
		return (
			<g fill={color}>
				{[
					[19, 20],
					[25, 18.6],
					[30, 21],
					[22, 26],
					[28, 27],
					[34, 25],
				].map(([cx, cy]) => (
					<circle cx={cx} cy={cy} key={`${cx}:${cy}`} r={1.3} />
				))}
			</g>
		);
	}
	return (
		<>
			{bands.map(([x, width]) => (
				<path d={`M${x} 6h${width}v36h-${width}Z`} fill={color} key={x} />
			))}
		</>
	);
}

function SpeciesArt({
	clipId,
	colors,
	kind,
	marking,
}: {
	clipId: string;
	colors: GlyphColors;
	kind: CreatureKind;
	marking: Marking;
}) {
	if (kind === "fish") {
		const body =
			"M9 24c3-7.5 13.5-11 23-7.6 4.6 1.6 8 4.4 9.6 7.6-1.6 3.2-5 6-9.6 7.6C22.5 35 12 31.5 9 24Z";
		return (
			<>
				<path d="M11 24 4 16.5l2.3 7.5L4 31.5Z" fill={colors.fin} />
				<path d="M17 17.4c3.4-5 9.8-6 14-2.4l-3 2.6Z" fill={colors.fin} />
				<path d="M20 30.8c2.6 3.4 6.6 3.8 9.4 1.6l-2.4-2Z" fill={colors.fin} />
				<clipPath id={clipId}>
					<path d={body} />
				</clipPath>
				<path d={body} fill={colors.body} />
				<g clipPath={`url(#${clipId})`}>
					<path d="M9 27h34v10H9Z" fill={colors.belly} opacity={0.75} />
					<Markings
						bands={[
							[33, 3.6],
							[22.6, 4.6],
							[13.8, 2.6],
						]}
						color={colors.accent}
						marking={marking}
					/>
					<Shaded d={body} id={clipId} />
				</g>
				<path
					d="M26 25.5c2.6 0 4.6 1 5.4 2.6"
					fill="none"
					opacity={0.5}
					stroke={colors.fin}
					strokeLinecap="round"
					strokeWidth={1.4}
				/>
				<circle cx={37.4} cy={22.4} fill={colors.eye} r={1.9} />
				<circle cx={38} cy={21.8} fill={colors.belly} r={0.6} />
			</>
		);
	}
	if (kind === "angelfish") {
		const body =
			"M14 24c2-7 8.5-11 15-10.4 5.6.5 10.6 5 12 10.4-1.4 5.4-6.4 9.9-12 10.4C22.5 35 16 31 14 24Z";
		return (
			<>
				<path
					d="M24 14.6c-2-5 -6-9.6-12.4-11.4 2 4.6 3.4 9.2 5 13.2Z"
					fill={colors.fin}
				/>
				<path
					d="M24 33.4c-2 5-6 9.6-12.4 11.4 2-4.6 3.4-9.2 5-13.2Z"
					fill={colors.fin}
				/>
				<path d="M15 24 8.4 18.4l1.2 5.6-1.2 5.6Z" fill={colors.fin} />
				<clipPath id={clipId}>
					<path d={body} />
				</clipPath>
				<path d={body} fill={colors.body} />
				<g clipPath={`url(#${clipId})`}>
					<Markings
						bands={[
							[33.2, 3],
							[25, 3.6],
							[18, 2.4],
						]}
						color={colors.accent}
						marking={marking}
					/>
					<Shaded d={body} id={clipId} />
				</g>
				<circle cx={36.6} cy={22.2} fill={colors.eye} r={1.8} />
				<circle cx={37.2} cy={21.6} fill={colors.belly} r={0.55} />
			</>
		);
	}
	if (kind === "jellyfish") {
		return (
			<>
				{[13, 17.5, 22, 26.5, 31, 35.5].map((x, index) => (
					<path
						d={`M${x} 25c${index % 2 ? 2 : -2} 5 ${index % 2 ? -2 : 2} 9 0 ${15 - (index % 3) * 2}`}
						fill="none"
						key={x}
						opacity={0.85}
						stroke={colors.accent}
						strokeLinecap="round"
						strokeWidth={1.3}
					/>
				))}
				<path
					d="M21 25c-1 5 2 8 0 13M27 25c1 5-2 8 0 12"
					fill="none"
					stroke={colors.fin}
					strokeLinecap="round"
					strokeWidth={3}
				/>
				<path d={BELL} fill={colors.body} opacity={0.92} />
				<Shaded d={BELL} id={clipId} />
				<path
					d="M14.4 22c.6-5.4 4.4-9 9.6-9.6"
					fill="none"
					opacity={0.7}
					stroke={colors.belly}
					strokeLinecap="round"
					strokeWidth={2}
				/>
			</>
		);
	}
	if (kind === "turtle") {
		return (
			<>
				<path d="M17 17 6 9.5c-1.6 2.6 2 7.6 9 10.5Z" fill={colors.fin} />
				<path d="M17 31 6 38.5c-1.6-2.6 2-7.6 9-10.5Z" fill={colors.fin} />
				<path d="M33.6 18.4 39 13c1.4 1.6-.6 5-3.6 7Z" fill={colors.fin} />
				<path d="M33.6 29.6 39 35c1.4-1.6-.6-5-3.6-7Z" fill={colors.fin} />
				<ellipse cx={39.8} cy={24} fill={colors.fin} rx={4.6} ry={3.4} />
				<ellipse cx={24} cy={24} fill={colors.belly} rx={13.4} ry={10.6} />
				<ellipse cx={24} cy={24} fill={colors.body} rx={12} ry={9.4} />
				<Shaded d={SHELL} id={clipId} />
				<path
					d="M19 19.4h10l2.6 4.6-2.6 4.6H19l-2.6-4.6ZM19 19.4 15 15.6M29 19.4l3.6-3.6M19 28.6 15 32.4M29 28.6l3.6 3.6M16.4 24h-4.2M31.6 24h4"
					fill="none"
					opacity={0.55}
					stroke={colors.accent}
					strokeLinejoin="round"
					strokeWidth={1.2}
				/>
				<circle cx={42} cy={22.6} fill={colors.eye} r={0.9} />
				<circle cx={42} cy={25.4} fill={colors.eye} r={0.9} />
			</>
		);
	}
	// Seen from above, head up: a wide diamond of wings in the creature's
	// hue (deep along the spine, richer toward the tips), pale shoulder
	// chevrons, cephalic fins either side of the mouth and a whip of a tail.
	return (
		<>
			<path
				d="M24 30.4c.1 4.4-.2 8.8-.9 13"
				fill="none"
				stroke={colors.dorsal}
				strokeLinecap="round"
				strokeWidth={1.3}
			/>
			<path
				d="M20.4 14.2c-1.2-1.2-1.6-3-1-4.6M27.6 14.2c1.2-1.2 1.6-3 1-4.6"
				fill="none"
				stroke={colors.dorsal}
				strokeLinecap="round"
				strokeWidth={2.4}
			/>
			<path d={MANTA} fill={colors.wing} />
			<clipPath id={clipId}>
				<path d={MANTA} />
			</clipPath>
			<g clipPath={`url(#${clipId})`}>
				<path
					d="M24 12c-7 0-9.6 9.4-9.6 13.6S19 32 24 32s9.6-2.2 9.6-6.4S31 12 24 12Z"
					fill={colors.dorsal}
					opacity={0.75}
				/>
				<path
					d="M21.6 17.6c-2.6 1.4-5 3.6-6.6 6.4M26.4 17.6c2.6 1.4 5 3.6 6.6 6.4"
					fill="none"
					opacity={0.7}
					stroke={colors.belly}
					strokeLinecap="round"
					strokeWidth={2.2}
				/>
				<Shaded d={MANTA} id={clipId} />
			</g>
			<path
				d={MANTA}
				fill="none"
				opacity={0.55}
				stroke={colors.belly}
				strokeLinejoin="round"
				strokeWidth={0.8}
			/>
			<circle cx={19.6} cy={15.6} fill={colors.eye} r={0.8} />
			<circle cx={28.4} cy={15.6} fill={colors.eye} r={0.8} />
		</>
	);
}

/**
 * A creature on a disc of its own water: the agent's face in the side panel
 * and the no-WebGL list. Decorative, since a heading or label beside it names
 * the agent.
 */
export function CreaturePortrait({
	className,
	creature,
	eye,
	hue,
	size,
}: {
	className?: string;
	creature: Creature;
	eye: Rgb;
	hue: CreatureHue;
	size: number;
}) {
	const clipId = `${useId()}-body`;
	return (
		<span
			aria-hidden="true"
			className={cn(
				"relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-b from-primary/10 to-muted ring-1 ring-border",
				className
			)}
			style={{ height: size, width: size }}
		>
			<svg className="size-[82%]" viewBox="0 0 48 48">
				<ShadingDefs colors={glyphColors(hue, eye)} id={clipId} />
				<SpeciesArt
					clipId={clipId}
					colors={glyphColors(hue, eye)}
					kind={creature.kind}
					marking={creatureMarking(creature)}
				/>
			</svg>
		</span>
	);
}

/** The legend's bubble trail glyph, in the current text color. */
export function BubblesGlyph({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			className={cn("size-3.5 shrink-0", className)}
			fill="none"
			viewBox="0 0 16 16"
		>
			<circle cx="5" cy="11" r="3" stroke="currentColor" strokeWidth="1.4" />
			<circle
				cx="10.5"
				cy="6"
				r="2.2"
				stroke="currentColor"
				strokeWidth="1.3"
			/>
			<circle cx="7" cy="2.6" r="1.3" stroke="currentColor" strokeWidth="1.2" />
		</svg>
	);
}

/** The legend's pearl glyph: a filled bead in a soft ring. */
export function PearlGlyph({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			className={cn("size-3.5 shrink-0", className)}
			fill="none"
			viewBox="0 0 16 16"
		>
			<circle
				cx="8"
				cy="8"
				opacity="0.35"
				r="6.6"
				stroke="currentColor"
				strokeWidth="1.2"
			/>
			<circle cx="8" cy="8" fill="currentColor" r="3.6" />
		</svg>
	);
}

/** Working agents get a live ring, idle ones a quiet outline. */
export function CreatureStatusMark({ working }: { working: boolean }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"relative inline-block size-2 shrink-0 rounded-full",
				working
					? "border-2 border-success"
					: "border border-muted-foreground/70"
			)}
		>
			{working ? (
				<span className="absolute -inset-0.75 rounded-full bg-success/25 motion-safe:animate-pulse" />
			) : null}
		</span>
	);
}

/**
 * A key hint that reads on the tank's frosted glass in every theme. The shared
 * Kbd's muted fill nearly vanishes on dark glass, so this one takes a
 * foreground tint and a hairline ring instead.
 */
export function GlassKbd({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<Kbd
			aria-hidden="true"
			className={cn(
				"h-5 bg-foreground/10 pt-px text-[11px] text-foreground/80 leading-none ring-1 ring-border",
				className
			)}
		>
			{children}
		</Kbd>
	);
}
