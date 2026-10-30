import styles from "./marketplace.module.css";
import { Check, Label, SceneCanvas } from "./scene.tsx";

/**
 * Marketplace homepage card scene: an app store for agents. One search covers
 * every kind of listing, and each tile names its kind (agent, skill, tool,
 * app, mcp, model) above the listing. The selection moves tile to tile and
 * each pick installs in one click: its "get" button turns into a check.
 *
 * The markup is the still (the agent and the skill installed, the skill
 * selected); the 9s loop in `marketplace.module.css` starts and ends on it.
 */

const COLUMNS = [10, 104, 198] as const;
const ROWS = [38, 104] as const;
const TILE_WIDTH = 88;
const TILE_HEIGHT = 58;

interface Tile {
	readonly col: 0 | 1 | 2;
	/** Motion classes for the check and the "get" label of a tile the loop installs. */
	readonly done?: string;
	readonly get?: string;
	readonly kind: string;
	readonly name: string;
	readonly row: 0 | 1;
}

const TILES: readonly Tile[] = [
	{
		col: 0,
		done: styles.doneA,
		get: styles.getA,
		kind: "agent",
		name: "reviewer",
		row: 0,
	},
	{
		col: 1,
		done: styles.doneB,
		get: styles.getB,
		kind: "skill",
		name: "pdf",
		row: 0,
	},
	{
		col: 2,
		done: styles.doneC,
		get: styles.getC,
		kind: "tool",
		name: "browser",
		row: 0,
	},
	{ col: 0, kind: "app", name: "canvas", row: 1 },
	{ col: 1, kind: "mcp", name: "files", row: 1 },
	{ col: 2, kind: "model", name: "vision", row: 1 },
];

function ListingTile({ tile }: { tile: Tile }) {
	const x = COLUMNS[tile.col];
	const y = ROWS[tile.row];
	const button = { x: x + TILE_WIDTH - 38, y: y + TILE_HEIGHT - 21 };
	return (
		<g>
			<rect
				className={styles.tile}
				height={TILE_HEIGHT}
				rx={8}
				width={TILE_WIDTH}
				x={x}
				y={y}
			/>
			<Label anchor="start" muted x={x + 8} y={y + 12}>
				{tile.kind}
			</Label>
			<Label anchor="start" x={x + 8} y={y + 27}>
				{tile.name}
			</Label>
			<rect
				className={styles.button}
				height={16}
				rx={8}
				width={30}
				x={button.x}
				y={button.y}
			/>
			<Label className={tile.get} x={button.x + 15} y={button.y + 8}>
				get
			</Label>
			{tile.done ? (
				<g
					className={tile.done}
					transform={`translate(${button.x + 15} ${button.y + 8})`}
				>
					<Check />
				</g>
			) : null}
		</g>
	);
}

export function MarketplaceScene() {
	return (
		<SceneCanvas className={styles.root} id="marketplace">
			<rect
				className={styles.search}
				height={20}
				rx={10}
				width={276}
				x={10}
				y={8}
			/>
			<circle className={styles.glass} cx={23} cy={17} r={3.4} />
			<path className={styles.glass} d="M25.6 19.6 L28 22" />
			<Label anchor="start" muted x={34} y={18}>
				agents, skills, tools
			</Label>

			{TILES.map((tile) => (
				<ListingTile key={tile.kind} tile={tile} />
			))}

			<rect
				className={styles.ring}
				height={TILE_HEIGHT + 6}
				rx={11}
				width={TILE_WIDTH + 6}
				x={COLUMNS[1] - 3}
				y={ROWS[0] - 3}
			/>
		</SceneCanvas>
	);
}
