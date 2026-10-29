import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import type { SquadState } from "./lobby-model.ts";
import type { FigureColors } from "./lobby-palette.ts";

/**
 * A squad member's portrait: a cartoon operator bust (helmet, visor,
 * shoulders and collar) in the agent's own hue, outlined like the rest of
 * the game kit's art. What sits on the helmet is picked per agent so a squad
 * never looks cloned, and the eyes on the visor show how they are doing:
 * calm when ready, focused in a match, wide when they need you, crossed out
 * when downed. Drawn on a 120 by 150 box; decorative (the card names it).
 */

/** What sits on the helmet. */
export type LobbyTopper = "antenna" | "crest" | "fins";
const TOPPERS: readonly LobbyTopper[] = ["antenna", "fins", "crest"];

/** A small stable hash of the agent's id, so its look never changes. */
function idHash(id: string): number {
	let hash = 0;
	for (const char of id) {
		hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 9973;
	}
	return hash;
}

export function topperFor(agent: Pick<InterfaceAgent, "id">): LobbyTopper {
	return TOPPERS[idHash(agent.id) % TOPPERS.length] ?? "antenna";
}

const STROKE = 3.5;

function Topper({
	colors,
	topper,
}: {
	colors: FigureColors;
	topper: LobbyTopper;
}) {
	const outline = { fill: colors.trim, stroke: colors.outline };
	if (topper === "antenna") {
		return (
			<g>
				<path
					d="M60 30 L60 12"
					strokeLinecap="round"
					strokeWidth={STROKE + 1}
					style={{ stroke: colors.outline }}
				/>
				<circle
					cx={60}
					cy={11}
					r={6}
					strokeWidth={STROKE}
					style={{ fill: colors.eye, stroke: colors.outline }}
				/>
				<circle cx={58} cy={9} r={2} style={{ fill: colors.face }} />
			</g>
		);
	}
	if (topper === "crest") {
		return (
			<path
				d="M48 32 C50 16 58 8 72 6 C66 14 68 22 72 32 Z"
				strokeLinejoin="round"
				strokeWidth={STROKE}
				style={outline}
			/>
		);
	}
	return (
		<g strokeLinejoin="round" strokeWidth={STROKE} style={outline}>
			<path d="M30 44 L18 20 L42 34 Z" />
			<path d="M90 44 L102 20 L78 34 Z" />
		</g>
	);
}

/** The eyes on the visor, one look per squad state. */
function Eyes({ colors, state }: { colors: FigureColors; state: SquadState }) {
	const fill = { fill: colors.eye };
	if (state === "downed") {
		return (
			<g strokeLinecap="round" strokeWidth={3.5} style={{ stroke: colors.eye }}>
				<path d="M43 62 L51 70 M51 62 L43 70" />
				<path d="M69 62 L77 70 M77 62 L69 70" />
			</g>
		);
	}
	if (state === "in-match") {
		return (
			<g style={fill}>
				<rect height={5} rx={2.5} width={13} x={40} y={64} />
				<rect height={5} rx={2.5} width={13} x={67} y={64} />
			</g>
		);
	}
	if (state === "needs-you") {
		return (
			<g style={fill}>
				<rect height={14} rx={4.5} width={9} x={42} y={59} />
				<rect height={14} rx={4.5} width={9} x={69} y={59} />
			</g>
		);
	}
	if (state === "waiting") {
		// Glancing up and aside, as if watching the clock.
		return (
			<g data-eyes="waiting" style={fill}>
				<rect height={8} rx={4} width={8} x={46} y={58} />
				<rect height={8} rx={4} width={8} x={72} y={58} />
			</g>
		);
	}
	return (
		<g style={fill}>
			<rect height={10} rx={5} width={10} x={42} y={61} />
			<rect height={10} rx={5} width={10} x={68} y={61} />
		</g>
	);
}

export function LobbyBust({
	className,
	colors,
	state,
	topper,
	viewBox = "0 0 120 150",
}: {
	className?: string;
	colors: FigureColors;
	state: SquadState;
	topper: LobbyTopper;
	/** Crop the drawing (the head alone for small chips). */
	viewBox?: string;
}) {
	const line = { stroke: colors.outline };
	return (
		<svg
			aria-hidden="true"
			className={className}
			preserveAspectRatio="xMidYMax meet"
			viewBox={viewBox}
		>
			{/* Shoulders and chest, with a shaded right side and a collar. */}
			<path
				d="M6 152 C6 122 26 106 60 106 C94 106 114 122 114 152 Z"
				strokeLinejoin="round"
				strokeWidth={STROKE}
				style={{ ...line, fill: colors.mid }}
			/>
			<path
				d="M78 108 C100 112 112 126 112 152 L84 152 C86 134 84 120 78 108 Z"
				style={{ fill: colors.shade }}
			/>
			<path
				d="M14 140 C18 124 30 114 44 110 C34 120 28 130 26 146 Z"
				style={{ fill: colors.lit, opacity: 0.55 }}
			/>
			<path
				d="M40 108 C46 120 74 120 80 108 L76 102 C68 110 52 110 44 102 Z"
				strokeLinejoin="round"
				strokeWidth={STROKE}
				style={{ ...line, fill: colors.trim }}
			/>
			{/* Neck. */}
			<rect
				height={14}
				strokeWidth={STROKE}
				style={{ ...line, fill: colors.shade }}
				width={22}
				x={49}
				y={90}
			/>
			{/* Ear pods. */}
			<g strokeWidth={STROKE} style={{ ...line, fill: colors.trim }}>
				<circle cx={25} cy={64} r={9} />
				<circle cx={95} cy={64} r={9} />
			</g>
			<circle cx={25} cy={64} r={3.5} style={{ fill: colors.eye }} />
			<circle cx={95} cy={64} r={3.5} style={{ fill: colors.eye }} />
			<Topper colors={colors} topper={topper} />
			{/* Helmet: lit from the upper left, shaded on the right. */}
			<path
				d="M60 26 C84 26 94 42 94 62 C94 84 80 96 60 96 C40 96 26 84 26 62 C26 42 36 26 60 26 Z"
				strokeWidth={STROKE}
				style={{ ...line, fill: colors.mid }}
			/>
			<path
				d="M74 30 C88 36 92 50 92 62 C92 80 82 92 66 95 C78 84 82 70 80 56 C79 46 77 38 74 30 Z"
				style={{ fill: colors.shade }}
			/>
			<path
				d="M40 36 C46 31 54 29 60 30 C50 34 44 40 41 48 C38 46 38 40 40 36 Z"
				style={{ fill: colors.face, opacity: 0.7 }}
			/>
			{/* Visor glass, with a glint, and the eyes behind it. */}
			<rect
				height={28}
				rx={14}
				strokeWidth={STROKE}
				style={{ ...line, fill: colors.visor }}
				width={62}
				x={29}
				y={52}
			/>
			<Eyes colors={colors} state={state} />
			<path
				d="M36 58 C40 55 46 54 52 54"
				strokeLinecap="round"
				strokeWidth={2.5}
				style={{ opacity: 0.45, stroke: colors.face }}
			/>
		</svg>
	);
}
