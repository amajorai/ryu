"use client";

import { type ReactNode, useId } from "react";
import { useAvatarContributions } from "./avatar-contributions.tsx";
import {
	type AvatarAccessory,
	type AvatarPaintPalette,
	GHOST_AVATAR_REGIONS,
	GHOST_AVATAR_TARGET,
	type GhostAvatarRegion,
	isContributedPartId,
} from "./avatar-parts.ts";
import { AvatarShapes } from "./avatar-shapes.tsx";
import { COSTUME_PALETTES, type GhostCostume } from "./ghost-costume.ts";
import paintStyles from "./ghost-costume-art.module.css";

/* The costumed Ryu ghost, drawn on the mascot's own 24-unit
   silhouette (the same path as Logo). Eyes sit at y=10 either side
   of x=17, and the crown of the head peaks near (18, 0.6) with the top
   sloping about 15 degrees, so hats are anchored there. Plain SVG with no
   animation of its own, so it is cheap to repeat in pickers and lists. */

const BODY =
	"M12,24c9.2,0,12.9-4.8,12.4-14.6C24.1,0.3,12.8-3.7,8.8,5.4c-2.2,5.7,1.1,7.9-2.9,12.6c-0.9,1.1-1.8,2-2.7,3.1c-1.2,1.3,0.7,2.2,1.9,2.2C7.4,23.3,9.7,24,12,24z";

const INK = "#0a0710";
const EYE_L = 14.6;
const EYE_R = 19.4;
const EYE_Y = 10;
const HAT = "translate(18 1.3) rotate(15)";

const star = (cx: number, cy: number, r: number) => {
	const points: string[] = [];
	for (let i = 0; i < 10; i++) {
		const radius = i % 2 === 0 ? r : r * 0.45;
		const angle = (Math.PI / 5) * i - Math.PI / 2;
		points.push(
			`${(cx + Math.cos(angle) * radius).toFixed(2)},${(cy + Math.sin(angle) * radius).toFixed(2)}`
		);
	}
	return points.join(" ");
};

const heart = (cx: number, cy: number, s: number) =>
	`M${cx} ${cy + 0.9 * s} C${cx - 1.6 * s} ${cy - 0.1 * s} ${cx - 1.1 * s} ${cy - 1.3 * s} ${cx} ${cy - 0.5 * s} C${cx + 1.1 * s} ${cy - 1.3 * s} ${cx + 1.6 * s} ${cy - 0.1 * s} ${cx} ${cy + 0.9 * s} Z`;

function Eyes({ kind, ink }: { kind: GhostCostume["eyes"]; ink: string }) {
	const stroke = { stroke: ink, strokeLinecap: "round" as const, fill: "none" };
	switch (kind) {
		case "happy":
			return (
				<g {...stroke} strokeWidth="0.9">
					<path
						d={`M${EYE_L - 1.2} ${EYE_Y + 0.6} Q${EYE_L} ${EYE_Y - 1.2} ${EYE_L + 1.2} ${EYE_Y + 0.6}`}
					/>
					<path
						d={`M${EYE_R - 1.2} ${EYE_Y + 0.6} Q${EYE_R} ${EYE_Y - 1.2} ${EYE_R + 1.2} ${EYE_Y + 0.6}`}
					/>
				</g>
			);
		case "sleepy":
			return (
				<g {...stroke} strokeWidth="0.9">
					<path
						d={`M${EYE_L - 1.2} ${EYE_Y} Q${EYE_L} ${EYE_Y + 1.1} ${EYE_L + 1.2} ${EYE_Y}`}
					/>
					<path
						d={`M${EYE_R - 1.2} ${EYE_Y} Q${EYE_R} ${EYE_Y + 1.1} ${EYE_R + 1.2} ${EYE_Y}`}
					/>
				</g>
			);
		case "star":
			return (
				<g className={paintStyles.eyesStarPaint} stroke={INK} strokeWidth="0.3">
					<polygon points={star(EYE_L, EYE_Y, 1.6)} />
					<polygon points={star(EYE_R, EYE_Y, 1.6)} />
				</g>
			);
		case "heart":
			return (
				<g
					className={paintStyles.eyesHeartPaint}
					stroke={INK}
					strokeWidth="0.3"
				>
					<path d={heart(EYE_L, EYE_Y, 1.1)} />
					<path d={heart(EYE_R, EYE_Y, 1.1)} />
				</g>
			);
		case "x":
			return (
				<g {...stroke} strokeWidth="0.75">
					<path
						d={`M${EYE_L - 0.9} ${EYE_Y - 0.9} l1.8 1.8 m0 -1.8 l-1.8 1.8`}
					/>
					<path
						d={`M${EYE_R - 0.9} ${EYE_Y - 0.9} l1.8 1.8 m0 -1.8 l-1.8 1.8`}
					/>
				</g>
			);
		case "spiral":
			return (
				<g {...stroke} strokeWidth="0.45">
					{[EYE_L, EYE_R].map((x) => (
						<path
							d={`M${x} ${EYE_Y} m0.3 0 a0.3 0.3 0 1 1 -0.6 0 a0.7 0.7 0 1 1 1.4 0 a1.1 1.1 0 1 1 -2.2 0 a1.5 1.5 0 1 1 3 0`}
							key={x}
						/>
					))}
				</g>
			);
		case "glow":
			return (
				<g>
					{[EYE_L, EYE_R].map((x) => (
						<g key={x}>
							<ellipse
								className={paintStyles.eyesGlowPaint}
								cx={x}
								cy={EYE_Y}
								opacity="0.45"
								rx="1.9"
								ry="2.3"
							/>
							<ellipse
								className={paintStyles.eyesGlowPaint2}
								cx={x}
								cy={EYE_Y}
								rx="1.05"
								ry="1.55"
							/>
						</g>
					))}
				</g>
			);
		default:
			return (
				<g fill={ink}>
					<ellipse cx={EYE_L} cy={EYE_Y} rx="1.05" ry="1.55" />
					<ellipse cx={EYE_R} cy={EYE_Y} rx="1.05" ry="1.55" />
					<circle
						className={paintStyles.eyesPaint}
						cx={EYE_L + 0.35}
						cy={EYE_Y - 0.55}
						r="0.32"
					/>
					<circle
						className={paintStyles.eyesPaint}
						cx={EYE_R + 0.35}
						cy={EYE_Y - 0.55}
						r="0.32"
					/>
				</g>
			);
	}
}

function Brows({ kind, ink }: { kind: GhostCostume["brows"]; ink: string }) {
	const props = { fill: "none", stroke: ink, strokeLinecap: "round" as const };
	switch (kind) {
		case "raised":
			return (
				<g {...props} strokeWidth="0.6">
					<path d="M13.3 7.6 Q14.6 6.5 15.9 7.3" />
					<path d="M18.1 7.3 Q19.4 6.5 20.7 7.6" />
				</g>
			);
		case "angry":
			return (
				<g {...props} strokeWidth="0.7">
					<path d="M13.2 7 L16 8" />
					<path d="M18 8 L20.8 7" />
				</g>
			);
		case "worried":
			return (
				<g {...props} strokeWidth="0.6">
					<path d="M13.3 8 L15.9 7" />
					<path d="M18.1 7 L20.7 8" />
				</g>
			);
		case "unibrow":
			return (
				<path {...props} d="M13.1 7.6 Q17 6.2 20.9 7.6" strokeWidth="0.85" />
			);
		case "bushy":
			return (
				<g {...props} strokeWidth="1.25">
					<path d="M13.5 7.3 L15.7 7.1" />
					<path d="M18.3 7.1 L20.5 7.3" />
				</g>
			);
		default:
			return null;
	}
}

function Mouth({ kind, ink }: { kind: GhostCostume["mouth"]; ink: string }) {
	const line = {
		fill: "none",
		stroke: ink,
		strokeLinecap: "round" as const,
		strokeWidth: 0.6,
	};
	switch (kind) {
		case "smile":
			return <path {...line} d="M15.6 13 Q17 14.5 18.4 13" />;
		case "fangs":
			return (
				<g>
					<path {...line} d="M15.4 13 Q17 14.1 18.6 13" />
					<path
						className={paintStyles.mouthFangsPaint}
						d="M15.9 13.35 l0.35 1 l0.4 -0.85 Z"
						stroke={ink}
						strokeWidth="0.25"
					/>
					<path
						className={paintStyles.mouthFangsPaint}
						d="M17.4 13.5 l0.4 0.85 l0.35 -1 Z"
						stroke={ink}
						strokeWidth="0.25"
					/>
				</g>
			);
		case "grin":
			return (
				<path
					d="M14.8 12.6 Q17 15.4 19.2 12.6 L18.5 13.1 L18 13.7 L17.5 13.1 L16.9 13.8 L16.4 13.1 L15.8 13.6 Z"
					fill={ink}
				/>
			);
		case "o":
			return <ellipse cx="17" cy="13.5" fill={ink} rx="0.65" ry="0.85" />;
		case "tongue":
			return (
				<g>
					<path {...line} d="M15.6 13 Q17 14.3 18.4 13" />
					<path
						className={paintStyles.mouthTonguePaint}
						d="M16.6 13.55 q0.45 1.2 0.9 0 Z"
						stroke={ink}
						strokeWidth="0.25"
					/>
				</g>
			);
		case "stitched":
			return (
				<g {...line} strokeWidth="0.45">
					<path d="M15.2 13.3 H18.8" />
					<path d="M15.8 12.8 v1 M16.6 12.8 v1 M17.4 12.8 v1 M18.2 12.8 v1" />
				</g>
			);
		default:
			return null;
	}
}

function Ears({ kind, fill }: { kind: GhostCostume["ears"]; fill: string }) {
	const outline = {
		stroke: INK,
		strokeWidth: 0.8,
		strokeLinejoin: "round" as const,
	};
	switch (kind) {
		case "cat":
			return (
				<g>
					<path {...outline} d="M10 4.6 L10.4 -1 L14 2.2 Z" fill={fill} />
					<path {...outline} d="M20.2 0.9 L24.4 -1.8 L23.8 4 Z" fill={fill} />
					<path
						className={paintStyles.earsCatPaint}
						d="M10.9 3.2 L11.1 0.4 L12.8 2 Z"
					/>
					<path
						className={paintStyles.earsCatPaint}
						d="M21.2 1.2 L23.6 -0.4 L23.3 2.6 Z"
					/>
				</g>
			);
		case "bat":
			return (
				<g className={paintStyles.earsBatPaint} {...outline}>
					<path d="M10.2 4.4 L9 -2.2 L11.4 -0.6 L12.2 -2.8 L14 2 Z" />
					<path d="M20.4 0.6 L22.8 -3.4 L23.2 -1 L25.4 -2.2 L24 4 Z" />
				</g>
			);
		case "bunny":
			return (
				<g>
					<ellipse
						{...outline}
						cx="12.4"
						cy="-1.8"
						fill={fill}
						rx="1.4"
						ry="3.6"
						transform="rotate(-20 12.4 -1.8)"
					/>
					<ellipse
						{...outline}
						cx="21.4"
						cy="-2.4"
						fill={fill}
						rx="1.4"
						ry="3.6"
						transform="rotate(16 21.4 -2.4)"
					/>
					<ellipse
						className={paintStyles.earsBunnyPaint}
						cx="12.4"
						cy="-1.6"
						rx="0.6"
						ry="2.4"
						transform="rotate(-20 12.4 -1.6)"
					/>
					<ellipse
						className={paintStyles.earsBunnyPaint}
						cx="21.4"
						cy="-2.2"
						rx="0.6"
						ry="2.4"
						transform="rotate(16 21.4 -2.2)"
					/>
				</g>
			);
		case "horns":
			return (
				<g
					className={paintStyles.earsHornsPaint}
					{...outline}
					strokeWidth="0.6"
				>
					<path d="M11 3.6 Q9.4 0.6 11 -1.8 Q11.4 1.2 13.6 2.2 Z" />
					<path d="M21.4 1.4 Q23 -1.4 21.8 -3.6 Q24.4 -1.8 23.8 2.6 Z" />
				</g>
			);
		case "bolts":
			return (
				<g
					className={paintStyles.earsBoltsPaint}
					{...outline}
					strokeWidth="0.5"
				>
					<rect height="1.6" rx="0.3" width="2.2" x="5.7" y="12.6" />
					<rect height="1.6" rx="0.3" width="2.2" x="23.7" y="12.2" />
				</g>
			);
		default:
			return null;
	}
}

function Headwear({ kind }: { kind: GhostCostume["headwear"] }) {
	const outline = {
		stroke: INK,
		strokeWidth: 0.6,
		strokeLinejoin: "round" as const,
	};
	switch (kind) {
		case "witch":
			return (
				<g transform={HAT}>
					<path
						{...outline}
						className={paintStyles.headwearWitchPaint}
						d="M-3.8 -0.6 L0.6 -9.4 Q1.6 -11.6 3.6 -10.8 Q1.8 -10.2 2.2 -8.6 L4 -0.6 Z"
					/>
					<rect
						className={paintStyles.headwearWitchPaint2}
						height="1.1"
						width="7.6"
						x="-3.7"
						y="-2.1"
					/>
					<rect
						className={paintStyles.headwearWitchPaint3}
						height="1"
						stroke={INK}
						strokeWidth="0.25"
						width="1"
						x="-0.2"
						y="-2.05"
					/>
					<ellipse
						{...outline}
						className={paintStyles.headwearWitchPaint}
						cx="0"
						cy="-0.3"
						rx="7.2"
						ry="1.3"
					/>
				</g>
			);
		case "pumpkin":
			return (
				<g transform={HAT}>
					<ellipse
						{...outline}
						className={paintStyles.headwearPumpkinPaint}
						cx="0"
						cy="-1.6"
						rx="4.6"
						ry="2.6"
					/>
					<path
						className={paintStyles.headwearPumpkinPaint2}
						d="M-1.6 -3.9 Q-2.2 -1.6 -1.6 0.6 M1.6 -3.9 Q2.2 -1.6 1.6 0.6"
						fill="none"
						strokeWidth="0.45"
					/>
					<path
						className={paintStyles.headwearPumpkinPaint3}
						d="M-0.4 -4 Q0 -5.8 1.4 -6.2"
						fill="none"
						strokeLinecap="round"
						strokeWidth="0.9"
					/>
					<path
						className={paintStyles.headwearPumpkinPaint4}
						d="M1 -4.6 Q2.8 -5.4 3.4 -4"
					/>
				</g>
			);
		case "crown":
			return (
				<g transform={HAT}>
					<path
						{...outline}
						className={paintStyles.headwearCrownPaint}
						d="M-3.6 0 L-3.6 -3.4 L-1.8 -1.6 L0 -4.2 L1.8 -1.6 L3.6 -3.4 L3.6 0 Z"
					/>
					<circle
						className={paintStyles.headwearCrownPaint2}
						cx="0"
						cy="-1.1"
						r="0.55"
					/>
					<circle
						className={paintStyles.headwearCrownPaint3}
						cx="-2.2"
						cy="-0.8"
						r="0.4"
					/>
					<circle
						className={paintStyles.headwearCrownPaint3}
						cx="2.2"
						cy="-0.8"
						r="0.4"
					/>
				</g>
			);
		case "tophat":
			return (
				<g transform={HAT}>
					<rect
						{...outline}
						className={paintStyles.headwearTophatPaint}
						height="5.6"
						rx="0.4"
						width="5.6"
						x="-2.8"
						y="-6"
					/>
					<rect
						className={paintStyles.headwearTophatPaint2}
						height="1.1"
						width="5.6"
						x="-2.8"
						y="-1.6"
					/>
					<ellipse
						{...outline}
						className={paintStyles.headwearTophatPaint}
						cx="0"
						cy="-0.3"
						rx="4.8"
						ry="1"
					/>
				</g>
			);
		case "halo":
			return (
				<g transform="translate(18 -2.2) rotate(15)">
					<ellipse
						className={paintStyles.headwearHaloPaint}
						cx="0"
						cy="0"
						fill="none"
						opacity="0.45"
						rx="4.4"
						ry="1.2"
						strokeWidth="1.6"
					/>
					<ellipse
						className={paintStyles.headwearHaloPaint2}
						cx="0"
						cy="0"
						fill="none"
						rx="4.4"
						ry="1.2"
						strokeWidth="0.7"
					/>
				</g>
			);
		case "party":
			return (
				<g transform={HAT}>
					<path
						{...outline}
						className={paintStyles.headwearPartyPaint}
						d="M-3 0 L0 -7.4 L3 0 Z"
					/>
					<path
						className={paintStyles.headwearPartyPaint2}
						d="M-2.2 -2 L1.4 -3.4 M-1.2 -4.4 L1 -5.2"
						strokeWidth="0.7"
					/>
					<circle
						className={paintStyles.headwearPartyPaint3}
						cx="0"
						cy="-7.6"
						r="0.9"
						stroke={INK}
						strokeWidth="0.4"
					/>
				</g>
			);
		default:
			return null;
	}
}

function Glasses({ kind }: { kind: GhostCostume["glasses"] }) {
	const frame = { stroke: INK, strokeWidth: 0.45 };
	switch (kind) {
		case "round":
			return (
				<g {...frame} className={paintStyles.glassesRoundPaint}>
					<circle cx={EYE_L} cy={EYE_Y} r="1.9" />
					<circle cx={EYE_R} cy={EYE_Y} r="1.9" />
					<path d={`M${EYE_L + 1.9} ${EYE_Y} H${EYE_R - 1.9}`} fill="none" />
				</g>
			);
		case "star":
			return (
				<g {...frame} className={paintStyles.glassesStarPaint}>
					<polygon points={star(EYE_L, EYE_Y, 2.4)} />
					<polygon points={star(EYE_R, EYE_Y, 2.4)} />
				</g>
			);
		case "heart":
			return (
				<g {...frame} className={paintStyles.glassesHeartPaint}>
					<path d={heart(EYE_L, EYE_Y, 1.75)} />
					<path d={heart(EYE_R, EYE_Y, 1.75)} />
				</g>
			);
		case "monocle":
			return (
				<g {...frame}>
					<circle
						className={paintStyles.glassesMonoclePaint}
						cx={EYE_R}
						cy={EYE_Y}
						r="2"
						strokeWidth="0.55"
					/>
					<path
						className={paintStyles.glassesMonoclePaint2}
						d={`M${EYE_R + 1.6} ${EYE_Y + 1.2} Q${EYE_R + 2.6} ${EYE_Y + 4} ${EYE_R + 1.2} ${EYE_Y + 6}`}
						fill="none"
						strokeDasharray="0.4 0.3"
						strokeWidth="0.35"
					/>
				</g>
			);
		case "patch":
			return (
				<g>
					<path d="M9.4 7.4 L24.2 5.8" stroke={INK} strokeWidth="0.45" />
					<ellipse cx={EYE_L} cy={EYE_Y} fill={INK} rx="1.9" ry="2" />
				</g>
			);
		case "threeD":
			return (
				<g {...frame}>
					<rect
						className={paintStyles.glassesThreeDPaint}
						height="3.2"
						rx="0.5"
						width="9.2"
						x={EYE_L - 2.1}
						y={EYE_Y - 1.6}
					/>
					<rect
						className={paintStyles.glassesThreeDPaint2}
						height="2.2"
						opacity="0.85"
						rx="0.3"
						width="3.4"
						x={EYE_L - 1.6}
						y={EYE_Y - 1.1}
					/>
					<rect
						className={paintStyles.glassesThreeDPaint3}
						height="2.2"
						opacity="0.85"
						rx="0.3"
						width="3.4"
						x={EYE_R - 1.8}
						y={EYE_Y - 1.1}
					/>
				</g>
			);
		case "shades":
			return (
				<g className={paintStyles.glassesShadesPaint} {...frame}>
					<path
						d={`M${EYE_L - 2.1} ${EYE_Y - 1.3} H${EYE_L + 1.9} Q${EYE_L + 1.8} ${EYE_Y + 1.8} ${EYE_L} ${EYE_Y + 1.7} Q${EYE_L - 2} ${EYE_Y + 1.6} ${EYE_L - 2.1} ${EYE_Y - 1.3} Z`}
					/>
					<path
						d={`M${EYE_R - 1.9} ${EYE_Y - 1.3} H${EYE_R + 2.1} Q${EYE_R + 2} ${EYE_Y + 1.6} ${EYE_R} ${EYE_Y + 1.7} Q${EYE_R - 1.8} ${EYE_Y + 1.8} ${EYE_R - 1.9} ${EYE_Y - 1.3} Z`}
					/>
					<path
						d={`M${EYE_L + 1.9} ${EYE_Y - 1} H${EYE_R - 1.9}`}
						fill="none"
					/>
					<path
						className={paintStyles.glassesShadesPaint2}
						d={`M${EYE_L - 1.3} ${EYE_Y - 0.7} l0.9 0`}
						strokeLinecap="round"
						strokeWidth="0.35"
					/>
				</g>
			);
		default:
			return null;
	}
}

function Behind({ kind }: { kind: GhostCostume["accessory"] }) {
	if (kind !== "cape") {
		return null;
	}
	return (
		<g stroke={INK} strokeLinejoin="round" strokeWidth="0.6">
			<path
				className={paintStyles.behindPaint}
				d="M9 6.5 Q2.4 14 0.6 24.4 Q4.6 22.6 6.6 24.6 Q9.6 22.4 12 24.8 L24 23.6 Q27.6 21.6 29.4 24 Q29.6 14.4 24.4 6.6 Z"
			/>
			<path
				className={paintStyles.behindPaint2}
				d="M9.6 10 Q4.6 6.4 4.2 1.4 Q8.4 4.4 11 5.6 Z"
			/>
			<path
				className={paintStyles.behindPaint2}
				d="M23.8 8.6 Q28.4 5 28.2 0.2 Q24.8 3 22.4 4.4 Z"
			/>
		</g>
	);
}

function Front({ kind }: { kind: GhostCostume["accessory"] }) {
	const outline = {
		stroke: INK,
		strokeWidth: 0.55,
		strokeLinejoin: "round" as const,
	};
	switch (kind) {
		case "bowtie":
			return (
				<g
					{...outline}
					className={paintStyles.frontBowtiePaint}
					transform="rotate(-8 17.6 16.6)"
				>
					<path d="M17.6 16.6 L14.8 15 L14.8 18.2 Z" />
					<path d="M17.6 16.6 L20.4 15 L20.4 18.2 Z" />
					<rect
						className={paintStyles.frontBowtiePaint2}
						height="1.6"
						rx="0.4"
						width="1.4"
						x="16.9"
						y="15.8"
					/>
				</g>
			);
		case "scarf":
			return (
				<g {...outline}>
					<path
						className={paintStyles.frontScarfPaint}
						d="M8.4 15.2 Q16.6 18 24.6 14.4 L24.5 16.8 Q16.4 20.4 8 17.6 Z"
					/>
					<path
						className={paintStyles.frontScarfPaint2}
						d="M11.4 16.4 v2 M14.4 17.1 v2.1 M17.4 17.4 v2.1 M20.4 16.9 v2.1"
						strokeWidth="0.7"
					/>
					<path
						className={paintStyles.frontScarfPaint}
						d="M21.4 17.4 L22.6 22.4 L20.6 22.6 L20 18 Z"
					/>
				</g>
			);
		case "bucket":
			return (
				<g transform="translate(27 19.4)">
					<path
						d="M-2.6 -2.4 Q0 -6.2 2.6 -2.4"
						fill="none"
						stroke={INK}
						strokeWidth="0.5"
					/>
					<ellipse
						{...outline}
						className={paintStyles.frontBucketPaint}
						cx="0"
						cy="0"
						rx="2.8"
						ry="2.4"
					/>
					<path
						className={paintStyles.frontBucketPaint2}
						d="M-1.4 -0.6 l0.6 -0.7 l0.6 0.7 Z M0.2 -0.6 l0.6 -0.7 l0.6 0.7 Z M-1.2 0.6 Q0 1.6 1.2 0.6"
					/>
					<circle
						className={paintStyles.frontBucketPaint3}
						cx="-0.8"
						cy="-2.6"
						r="0.6"
					/>
					<circle
						className={paintStyles.frontBucketPaint4}
						cx="0.7"
						cy="-2.7"
						r="0.55"
					/>
				</g>
			);
		case "wand":
			return (
				<g>
					<path
						className={paintStyles.frontWandPaint}
						d="M24.2 16.4 L29 10.6"
						strokeLinecap="round"
						strokeWidth="0.8"
					/>
					<polygon
						className={paintStyles.frontWandPaint2}
						points={star(29.2, 10.2, 1.7)}
						stroke={INK}
						strokeWidth="0.3"
					/>
					<circle
						className={paintStyles.frontWandPaint3}
						cx="27.4"
						cy="8.2"
						data-ghost-twinkle=""
						r="0.35"
					/>
					<circle
						className={paintStyles.frontWandPaint3}
						cx="30.8"
						cy="12.4"
						data-ghost-twinkle=""
						r="0.28"
					/>
				</g>
			);
		case "lantern":
			return (
				<g transform="translate(27.6 16)">
					<path d="M0 -4.2 V-2.6" stroke={INK} strokeWidth="0.45" />
					<rect
						className={paintStyles.frontLanternPaint}
						height="0.8"
						rx="0.2"
						width="2.6"
						x="-1.3"
						y="-2.8"
					/>
					<rect
						className={paintStyles.frontLanternPaint2}
						height="3.6"
						opacity="0.95"
						rx="0.6"
						stroke={INK}
						strokeWidth="0.45"
						width="2.8"
						x="-1.4"
						y="-2"
					/>
					<circle
						className={paintStyles.frontLanternPaint3}
						cx="0"
						cy="-0.2"
						opacity="0.6"
						r="2.6"
					/>
					<rect
						className={paintStyles.frontLanternPaint}
						height="0.7"
						rx="0.2"
						width="3"
						x="-1.5"
						y="1.5"
					/>
				</g>
			);
		default:
			return null;
	}
}

function Pattern({
	kind,
	deep,
}: {
	kind: GhostCostume["pattern"];
	deep: string;
}) {
	switch (kind) {
		case "mummy":
			return (
				<g className={paintStyles.patternMummyPaint} strokeWidth="0.3">
					{[3.6, 6.4, 12.8, 15.6, 18.4, 21.2].map((y, i) => (
						<rect
							height="2.2"
							key={y}
							transform={`rotate(${i % 2 ? -9 : 7} 16 ${y})`}
							width="30"
							x="1"
							y={y}
						/>
					))}
				</g>
			);
		case "skeleton":
			return (
				<g className={paintStyles.patternSkeletonPaint} opacity="0.92">
					<rect height="7.4" rx="0.4" width="0.9" x="16.6" y="15" />
					{[15.8, 17.6, 19.4].map((y, i) => (
						<path
							d={`M${16.9 - (4.6 - i)} ${y + 0.7} Q17 ${y - 0.5} ${16.9 + (4.6 - i)} ${y + 0.7} l0 0.6 Q17 ${y + 0.4} ${16.9 - (4.6 - i)} ${y + 1.3} Z`}
							key={y}
						/>
					))}
				</g>
			);
		case "stitches":
			return (
				<g fill="none" stroke={INK} strokeLinecap="round" strokeWidth="0.45">
					<path d="M10.6 4.6 Q14.6 3.2 18.4 4.2" />
					<path d="M11.6 3.6 l0.4 1.6 M13.4 3.2 l0.3 1.6 M15.2 3.1 l0.2 1.6 M17 3.4 l0 1.5" />
					<path d="M20.6 18.4 l2.6 1.8 M21.2 20.2 l1.4 -2" />
				</g>
			);
		case "stripes":
			return (
				<g opacity="0.35" stroke={deep} strokeWidth="1.3">
					{[-8, -4, 0, 4, 8, 12, 16, 20, 24, 28].map((x) => (
						<path d={`M${x} 26 L${x + 12} -2`} key={x} />
					))}
				</g>
			);
		case "polka":
			return (
				<g fill={deep} opacity="0.4">
					{[
						[10, 8],
						[13, 18],
						[21.5, 6],
						[22.5, 16.5],
						[17.5, 21],
						[8.5, 15],
						[18.5, 3.2],
						[6.4, 20.6],
					].map(([x, y]) => (
						<circle cx={x} cy={y} key={`${x}-${y}`} r="1.05" />
					))}
				</g>
			);
		case "web":
			return (
				<g
					className={paintStyles.patternWebPaint}
					fill="none"
					opacity="0.5"
					strokeWidth="0.25"
				>
					<path d="M24.4 4 L18 9 M24.4 4 L20.4 12.4 M24.4 4 L14.8 5.6 M24.4 4 L23.8 14" />
					<path d="M21.6 6.2 Q22.4 7.4 22 8.8 M19.6 7.6 Q21 9.6 21.4 11.6 M17.6 8.6 Q19.4 10.6 19.6 13" />
				</g>
			);
		default:
			return null;
	}
}

const VIEWBOX = {
	/* Room for tall hats and held items beside the ghost. */
	stage: { box: "-4 -12 36 38", ratio: 36 / 38 },
	/* Square and tighter, for avatars; tall hats may overflow the box. */
	avatar: { box: "-1.5 -4.5 28.5 28.5", ratio: 1 },
} as const;

/** The marketplace accessory each region names, when its plugin is enabled. */
function contributedParts(
	look: GhostCostume,
	accessories: readonly AvatarAccessory[]
): Partial<Record<GhostAvatarRegion, AvatarAccessory>> {
	const parts: Partial<Record<GhostAvatarRegion, AvatarAccessory>> = {};
	for (const region of GHOST_AVATAR_REGIONS) {
		const id = look[region];
		if (!isContributedPartId(id)) {
			continue;
		}
		const accessory = accessories.find(
			(row) =>
				row.id === id &&
				row.target === GHOST_AVATAR_TARGET &&
				row.region === region
		);
		if (accessory) {
			parts[region] = accessory;
		}
	}
	return parts;
}

export function GhostCostumeArt({
	costume: look,
	size = 220,
	framing = "stage",
	className = "",
	accessories,
}: {
	costume: GhostCostume;
	size?: number;
	framing?: keyof typeof VIEWBOX;
	className?: string;
	/** Override the provider's contributed accessories (previews, tests). */
	accessories?: readonly AvatarAccessory[];
}) {
	const frame = VIEWBOX[framing];
	const uid = useId().replace(/:/g, "");
	const palette = COSTUME_PALETTES[look.palette];
	const dark = look.palette === "midnight";
	const ink = dark ? "#fff3c4" : INK;
	const contributions = useAvatarContributions();
	const parts = contributedParts(
		look,
		accessories ?? contributions.accessories
	);
	const partPalette: AvatarPaintPalette = { ...palette, ink };
	/* A contributed region replaces the built-in drawing in that slot. When its
	   plugin is off, the built-in renderer sees an id it does not know and draws
	   the plain fallback (classic eyes, nothing elsewhere). */
	const region = (
		name: GhostAvatarRegion,
		layer: "front" | "behind",
		builtIn: ReactNode
	) => {
		const part = parts[name];
		if (!part) {
			return layer === "front" ? builtIn : null;
		}
		return part.layer === layer ? (
			<AvatarShapes
				palette={partPalette}
				partId={part.id}
				shapes={part.shapes}
			/>
		) : null;
	};
	const ids = {
		clip: `${uid}-clip`,
		lin: `${uid}-lin`,
		rad: `${uid}-rad`,
		holo: `${uid}-holo`,
		noise: `${uid}-noise`,
		glow: `${uid}-glow`,
	};
	const fills = {
		smooth: palette.base,
		gradient: `url(#${ids.lin})`,
		plastic: `url(#${ids.rad})`,
		fabric: palette.base,
		"3d": `url(#${ids.rad})`,
		glow: palette.base,
		glass: palette.base,
		holo: `url(#${ids.holo})`,
	} satisfies Record<GhostCostume["finish"], string>;
	const fill = fills[look.finish];
	const bodyOpacity =
		look.finish === "glass" ? 0.32 : look.finish === "glow" ? 0.7 : 1;
	const outline =
		look.finish === "glass" || look.finish === "glow" ? palette.light : INK;

	return (
		<svg
			aria-hidden="true"
			className={className}
			data-ghost-costume={look.finish}
			height={size}
			overflow="visible"
			viewBox={frame.box}
			width={size * frame.ratio}
		>
			<defs>
				<clipPath id={ids.clip}>
					<path d={BODY} />
				</clipPath>
				<linearGradient id={ids.lin} x1="0" x2="0.35" y1="0" y2="1">
					<stop offset="0" stopColor={palette.light} />
					<stop offset="0.5" stopColor={palette.base} />
					<stop offset="1" stopColor={palette.deep} />
				</linearGradient>
				<radialGradient cx="0.62" cy="0.28" id={ids.rad} r="0.9">
					<stop offset="0" stopColor={palette.light} />
					<stop
						offset={look.finish === "plastic" ? "0.35" : "0.45"}
						stopColor={palette.base}
					/>
					<stop offset="1" stopColor={palette.deep} />
				</radialGradient>
				<linearGradient id={ids.holo} x1="0" x2="1" y1="0" y2="1">
					<stop className={paintStyles.bodyPaint} offset="0" />
					<stop className={paintStyles.bodyPaint2} offset="0.35" />
					<stop className={paintStyles.bodyPaint3} offset="0.65" />
					<stop className={paintStyles.bodyPaint4} offset="1" />
				</linearGradient>
				<filter height="1.4" id={ids.noise} width="1.4" x="-0.2" y="-0.2">
					<feTurbulence
						baseFrequency="1.6"
						numOctaves="2"
						seed="7"
						type="fractalNoise"
					/>
					<feColorMatrix type="saturate" values="0" />
					<feComponentTransfer>
						<feFuncA tableValues="0 0.22" type="table" />
					</feComponentTransfer>
				</filter>
				<filter height="2" id={ids.glow} width="2" x="-0.5" y="-0.5">
					<feGaussianBlur stdDeviation="1.4" />
				</filter>
			</defs>

			<Behind kind={look.accessory} />
			{GHOST_AVATAR_REGIONS.map((name) => (
				<g key={name}>{region(name, "behind", null)}</g>
			))}
			{region("ears", "front", <Ears fill={fill} kind={look.ears} />)}

			{look.finish === "glow" ? (
				<path
					d={BODY}
					fill={palette.base}
					filter={`url(#${ids.glow})`}
					opacity="0.85"
				/>
			) : null}
			<path d={BODY} fill={fill} opacity={bodyOpacity} />

			<g clipPath={`url(#${ids.clip})`}>
				{region(
					"pattern",
					"front",
					<Pattern deep={palette.deep} kind={look.pattern} />
				)}
				{look.finish === "fabric" ? (
					<g>
						<rect
							filter={`url(#${ids.noise})`}
							height="30"
							width="34"
							x="-2"
							y="-4"
						/>
						<g
							fill="none"
							opacity="0.35"
							stroke={palette.deep}
							strokeLinecap="round"
							strokeWidth="0.55"
						>
							<path d="M11.4 24 Q12.6 18.6 11 14.4" />
							<path d="M16.6 24.2 Q17.6 20 16.4 16.8" />
							<path d="M21.6 22.4 Q22.2 18.8 21.2 15.8" />
						</g>
					</g>
				) : null}
				{look.finish === "plastic" || look.finish === "glass" ? (
					<g className={paintStyles.bodyPaint5}>
						<ellipse
							cx="20.4"
							cy="3.6"
							opacity="0.75"
							rx="2.6"
							ry="1.1"
							transform="rotate(20 20.4 3.6)"
						/>
						<circle cx="23" cy="6" opacity="0.6" r="0.55" />
					</g>
				) : null}
				{look.finish === "3d" ? (
					<g>
						<ellipse
							cx="13"
							cy="25"
							fill={palette.deep}
							opacity="0.45"
							rx="12"
							ry="3.4"
						/>
						<ellipse
							className={paintStyles.bodyPaint5}
							cx="20.6"
							cy="3.8"
							opacity="0.35"
							rx="3.4"
							ry="1.6"
							transform="rotate(20 20.6 3.8)"
						/>
					</g>
				) : null}
				{look.finish === "glass" ? (
					<path
						className={paintStyles.bodyPaint6}
						d="M10.6 8 Q10 14 12.6 20"
						fill="none"
						opacity="0.5"
						strokeLinecap="round"
						strokeWidth="0.7"
					/>
				) : null}
			</g>

			<path
				d={BODY}
				fill="none"
				stroke={outline}
				strokeLinejoin="round"
				strokeWidth="0.85"
			/>

			{region("brows", "front", <Brows ink={ink} kind={look.brows} />)}
			{region("eyes", "front", <Eyes ink={ink} kind={look.eyes} />)}
			{region("mouth", "front", <Mouth ink={ink} kind={look.mouth} />)}
			{region("glasses", "front", <Glasses kind={look.glasses} />)}
			{region("headwear", "front", <Headwear kind={look.headwear} />)}
			{region("accessory", "front", <Front kind={look.accessory} />)}
		</svg>
	);
}
