import type { CSSProperties, ReactNode } from "react";
import { Stage } from "../iso/kit/react/live.tsx";
import styles from "./marketplace.module.css";
import { Scene } from "./scene.tsx";

/**
 * Marketplace homepage card scene: one search across every kind of listing.
 * The query "review" types into the search pill, four listings of different
 * kinds stay lit while the rest dim, and the matched skill installs (its
 * download arrow drops into an emerald check). The markup with no motion is
 * that finished frame, which is what reduced motion and the server show.
 */

type GlyphKind =
	| "app"
	| "skill"
	| "model"
	| "workflow"
	| "theme"
	| "agent"
	| "tool"
	| "mcp"
	| "prompt"
	| "dataset"
	| "voice"
	| "plugin"
	| "template"
	| "integration"
	| "lsp";

/** The 5 x 3 grid in reading order; the four `review` matches are spread out. */
const TILES: readonly { kind: GlyphKind; match?: true }[] = [
	{ kind: "app" },
	{ kind: "skill", match: true },
	{ kind: "model" },
	{ kind: "theme" },
	{ kind: "dataset" },
	{ kind: "mcp" },
	{ kind: "tool" },
	{ kind: "voice" },
	{ kind: "agent", match: true },
	{ kind: "plugin" },
	{ kind: "workflow", match: true },
	{ kind: "template" },
	{ kind: "integration" },
	{ kind: "lsp" },
	{ kind: "prompt", match: true },
];

const QUERY = "review";
const COLUMNS = 5;
const TILE_WIDTH = 44;
const TILE_HEIGHT = 28;
const GAP = 8;
const GRID_X = 34;
const GRID_Y = 42;
const QUERY_X = 50;
const CHAR_WIDTH = 5.4;

const HAIRLINE = {
	fill: "none",
	stroke: "currentColor",
	strokeLinecap: "round",
	strokeLinejoin: "round",
	strokeWidth: 1,
} as const;

/** One tiny hairline mark per listing kind, drawn around (0, 0) in a 12px box. */
function Glyph({ kind }: { kind: GlyphKind }): ReactNode {
	switch (kind) {
		case "app":
			return <rect height="10" rx="2.5" width="10" x="-5" y="-5" />;
		case "skill":
			return <path d="M-4 -6H2L5 -3V6H-4ZM2 -6V-3H5M-2 0H3M-2 2.5H2" />;
		case "model":
			return (
				<path d="M0 -6L5.2 -3V3L0 6L-5.2 3V-3ZM-5.2 -3L0 0L5.2 -3M0 0V6" />
			);
		case "workflow":
			return (
				<>
					<circle cx="-4.5" cy="0" r="1.5" />
					<circle cx="4.5" cy="-4" r="1.5" />
					<circle cx="4.5" cy="4" r="1.5" />
					<path d="M-3 0C0 0 0 -4 3 -4M-3 0C0 0 0 4 3 4" />
				</>
			);
		case "theme":
			return (
				<>
					<circle cx="0" cy="0" r="5" />
					<path d="M0 -5A5 5 0 0 0 0 5Z" fill="currentColor" />
				</>
			);
		case "agent":
			return (
				<>
					<circle cx="0" cy="0" r="5.5" />
					<circle cx="0" cy="0" r="2" />
				</>
			);
		case "tool":
			return <path d="M-5 5L0.3 -0.3M5.8 -3.4A3.3 3.3 0 1 1 3.4 -5.8" />;
		case "mcp":
			return (
				<>
					<rect height="5" rx="1.5" width="7" x="-3.5" y="-2" />
					<path d="M-1.5 -2V-5.5M1.5 -2V-5.5M0 3V6" />
				</>
			);
		case "prompt":
			return (
				<path d="M-4.5 2V-0.5C-4.5 -2.5 -3.5 -3.5 -2 -4M-4.5 -0.5H-2V2H-4.5M1 2V-0.5C1 -2.5 2 -3.5 3.5 -4M1 -0.5H3.5V2H1" />
			);
		case "dataset":
			return (
				<>
					<rect height="10" rx="1.5" width="11" x="-5.5" y="-5" />
					<path d="M-5.5 -1.7H5.5M-5.5 1.7H5.5" />
				</>
			);
		case "voice":
			return <path d="M-5 -1V1M-2.5 -3.5V3.5M0 -5.5V5.5M2.5 -2.5V2.5M5 -1V1" />;
		case "plugin":
			return (
				<path d="M-5 -5H-1.5A1.7 1.7 0 1 1 1.5 -5H5V5H-5V1.5A1.7 1.7 0 1 1 -5 -1.5Z" />
			);
		case "template":
			return (
				<>
					<rect height="10" rx="1.5" width="11" x="-5.5" y="-5" />
					<path d="M-5.5 -2H5.5M-1 -2V5" />
				</>
			);
		case "integration":
			return (
				<g transform="rotate(-45)">
					<rect height="4" rx="2" width="7" x="-6" y="-2" />
					<rect height="4" rx="2" width="7" x="-1" y="-2" />
				</g>
			);
		case "lsp":
			return (
				<path d="M-2 -5.5C-4 -5.5 -3 -1 -5 0C-3 1 -4 5.5 -2 5.5M2 -5.5C4 -5.5 3 -1 5 0C3 1 4 5.5 2 5.5" />
			);
		default:
			return null;
	}
}

/** The download arrow that drops into the installed check on the skill tile. */
function GetLayer() {
	return (
		<g transform={`translate(${TILE_WIDTH - 7} 7)`}>
			<g className={`${styles.arrow} text-foreground/70`}>
				<path {...HAIRLINE} d="M0 -3V2M-2.2 -0.2L0 2L2.2 -0.2" />
			</g>
			<g
				className={`${styles.check} text-realm-complete dark:text-realm-complete-dark`}
			>
				<circle fill="currentColor" r="4" />
				<path
					{...HAIRLINE}
					className="stroke-background"
					d="M-1.8 0.1L-0.5 1.4L1.9 -1.2"
					strokeWidth={1.2}
				/>
			</g>
		</g>
	);
}

function Tile({
	index,
	kind,
	match,
}: {
	index: number;
	kind: GlyphKind;
	match: boolean;
}) {
	const column = index % COLUMNS;
	const row = Math.floor(index / COLUMNS);
	const x = GRID_X + column * (TILE_WIDTH + GAP);
	const y = GRID_Y + row * (TILE_HEIGHT + GAP);
	const order = { "--i": index } as CSSProperties;
	const installs = kind === "skill";
	let tileClass: string | undefined = styles.dim;
	if (installs) {
		tileClass = styles.lift;
	} else if (match) {
		tileClass = undefined;
	}

	return (
		<g transform={`translate(${x} ${y})`}>
			<g className={tileClass} style={order}>
				<rect
					{...HAIRLINE}
					className="fill-background/55 text-foreground/12"
					height={TILE_HEIGHT}
					rx="5"
					width={TILE_WIDTH}
				/>
				{match ? (
					<rect
						{...HAIRLINE}
						className={`${styles.ring} text-foreground/45`}
						height={TILE_HEIGHT}
						rx="5"
						style={order}
						width={TILE_WIDTH}
					/>
				) : null}
				<g
					{...HAIRLINE}
					className="text-foreground/75"
					transform={`translate(${TILE_WIDTH / 2} ${TILE_HEIGHT / 2})`}
				>
					<Glyph kind={kind} />
				</g>
				{installs ? <GetLayer /> : null}
			</g>
		</g>
	);
}

function SearchPill() {
	return (
		<g>
			<rect
				{...HAIRLINE}
				className="fill-background/80 text-foreground/15"
				height="20"
				rx="10"
				width="272"
				x="24"
				y="12"
			/>
			<g {...HAIRLINE} className="text-muted-foreground">
				<circle cx="37" cy="21" r="3.5" />
				<path d="M39.6 23.6L42 26" />
			</g>
			<g className={`${styles.query} fill-current`}>
				{Array.from(QUERY, (char, position) => (
					<text
						className={styles.char}
						fontSize="9"
						key={`${char}-${position}`}
						style={{ "--i": position } as CSSProperties}
						x={QUERY_X + position * CHAR_WIDTH}
						y="25"
					>
						{char}
					</text>
				))}
			</g>
			<g transform={`translate(${QUERY_X + 0.5} 17)`}>
				<g className={styles.caret}>
					<rect
						className={`${styles.blink} fill-foreground`}
						height="10"
						width="1"
					/>
				</g>
			</g>
		</g>
	);
}

export function MarketplaceScene() {
	return (
		<Scene id="marketplace">
			<Stage className={`${styles.root} absolute inset-x-0 top-0 px-2 pt-2`}>
				<svg
					className="mx-auto block h-auto w-full max-w-[22rem] font-mono text-foreground"
					focusable="false"
					preserveAspectRatio="xMidYMin meet"
					role="presentation"
					viewBox="0 0 320 154"
				>
					<SearchPill />
					{TILES.map((tile, index) => (
						<Tile
							index={index}
							key={tile.kind}
							kind={tile.kind}
							match={tile.match === true}
						/>
					))}
				</svg>
			</Stage>
		</Scene>
	);
}
