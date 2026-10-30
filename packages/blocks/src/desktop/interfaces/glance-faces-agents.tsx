import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { useMemo } from "react";
import {
	GLANCE_TYPE,
	type GlanceFaceProps,
} from "./glance-faces-type-scale.ts";
import {
	buildGlanceAgents,
	GLANCE_AGENT_STATE_LABELS,
	GLANCE_TILE_LIMIT,
	type GlanceAgentState,
	type GlanceAgentTile,
	glanceSharedGroup,
	glanceThreadTitle,
	glanceTileColumns,
} from "./glance-model.ts";
import {
	GLANCE_INK_SECONDARY,
	GLANCE_STATE_TEXT,
	GlanceAvatar,
	GlanceMark,
} from "./glance-parts.tsx";

// ---------------------------------------------------------------------------
// Agents (modular tiles)
// ---------------------------------------------------------------------------

function tileLabel(tile: GlanceAgentTile, tl: LiteralMessage): string {
	const state = GLANCE_AGENT_STATE_LABELS[tile.state];
	if (tile.thread) {
		return tl("{name}, {state}. Open {title}", {
			name: tile.agent.name,
			state,
			title: glanceThreadTitle(tile.thread),
		});
	}
	return tl("{name}, {state}. Start a thread", {
		name: tile.agent.name,
		state,
	});
}

/** A tile's state: the mark carries the hue, the word names it. */
function TileStatus({
	near,
	state,
}: {
	near: boolean;
	state: GlanceAgentState;
}) {
	return (
		<span
			className={cn(
				"flex min-w-0 items-center font-semibold",
				near
					? cn("gap-[1.2cqw]", GLANCE_TYPE.detail)
					: "gap-[1.6cqw] text-[clamp(0.9375rem,3.4cqw,1.625rem)] leading-tight tracking-[-0.01em]"
			)}
		>
			<GlanceMark
				className={
					near
						? "size-[1.2cqw] min-h-1.5 min-w-1.5"
						: "size-[1.6cqw] min-h-2 min-w-2"
				}
				state={state}
			/>
			<span className={cn("truncate", GLANCE_STATE_TEXT[state])}>
				{GLANCE_AGENT_STATE_LABELS[state]}
			</span>
		</span>
	);
}

function AgentTile({
	near,
	onOpen,
	snapshot,
	tile,
}: {
	near: boolean;
	onOpen: () => void;
	snapshot: InterfaceSnapshot;
	tile: GlanceAgentTile;
}) {
	const tl = useLiteralMessages();
	const { agent, state, thread } = tile;
	const group = thread ? glanceSharedGroup(snapshot, thread) : null;
	const name = (
		<span
			className={cn(
				"truncate font-semibold text-foreground",
				near
					? "text-[clamp(0.9375rem,3.3cqw,1.5rem)] leading-tight tracking-[-0.01em]"
					: "text-[clamp(1.125rem,5.2cqw,2.5rem)] leading-[1.1] tracking-[-0.025em]"
			)}
		>
			{agent.name}
		</span>
	);
	return (
		<button
			aria-label={tileLabel(tile, tl)}
			className="corner-squircle flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[4.4cqw] bg-muted p-[3.6cqw] text-left outline-none transition-[background-color,scale] duration-200 hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] motion-reduce:active:scale-100"
			data-agent-id={agent.id}
			data-state={state}
			onClick={onOpen}
			type="button"
		>
			{near ? (
				<>
					<span className="flex min-w-0 items-center gap-[2.4cqw]">
						<GlanceAvatar
							agent={agent}
							className={cn("size-[7cqw]", !tile.active && "opacity-70")}
						/>
						<span className="flex min-w-0 flex-col gap-[0.4cqw]">
							{name}
							<TileStatus near state={state} />
						</span>
					</span>
					<span className="mt-auto flex min-w-0 flex-col gap-[0.6cqw] pt-[2cqw]">
						{thread ? (
							<>
								<span
									className={cn(
										"truncate font-medium text-foreground",
										GLANCE_TYPE.detail
									)}
								>
									{group ? (
										<span className={GLANCE_INK_SECONDARY}>{group} · </span>
									) : null}
									{glanceThreadTitle(thread)}
								</span>
								<span
									className={cn(
										"line-clamp-2",
										GLANCE_INK_SECONDARY,
										GLANCE_TYPE.detail
									)}
								>
									{thread.lastMessage ?? "No messages yet"}
								</span>
							</>
						) : (
							<span className={cn(GLANCE_INK_SECONDARY, GLANCE_TYPE.detail)}>
								No threads yet
							</span>
						)}
					</span>
				</>
			) : (
				<>
					<GlanceAvatar
						agent={agent}
						className={cn("size-[9cqw]", !tile.active && "opacity-70")}
					/>
					{/* Far reads across a room: who, and where they stand. */}
					<span className="mt-auto flex min-w-0 flex-col gap-[1cqw] pt-[2cqw]">
						{name}
						<TileStatus near={false} state={state} />
					</span>
				</>
			)}
		</button>
	);
}

const SKELETON_TILES = ["a", "b", "c", "d", "e", "f"] as const;

/** The agents face: one large tile per agent, like Home's modular face. */
export function GlanceAgentsFace({
	distance,
	loading,
	onOpenThread,
	onShowAll,
	onStartThread,
	onStartWithAgent,
	snapshot,
}: GlanceFaceProps & { onShowAll: () => void; onStartThread: () => void }) {
	const tl = useLiteralMessages();
	const tiles = useMemo(() => buildGlanceAgents(snapshot), [snapshot]);
	const near = distance === "near";

	if (loading) {
		// The same grid six loaded tiles take, so nothing jumps when data lands.
		const skeletonColumns = glanceTileColumns(SKELETON_TILES.length);
		return (
			<div
				className="grid size-full gap-[2.8cqw] p-[4.4cqw]"
				style={{
					gridTemplateColumns: `repeat(${skeletonColumns}, minmax(0, 1fr))`,
					gridTemplateRows: `repeat(${Math.ceil(SKELETON_TILES.length / skeletonColumns)}, minmax(0, 1fr))`,
				}}
			>
				{SKELETON_TILES.map((key) => (
					<Skeleton
						className="corner-squircle rounded-[4.4cqw] bg-muted"
						key={key}
					/>
				))}
			</div>
		);
	}

	if (tiles.length === 0) {
		return (
			<div className="flex size-full flex-col items-center justify-center gap-[2.4cqw] p-[8cqw] text-center">
				<h3 className={cn("font-semibold text-foreground", GLANCE_TYPE.lead)}>
					No agents yet
				</h3>
				<p
					className={cn(
						"max-w-[56cqw]",
						GLANCE_INK_SECONDARY,
						GLANCE_TYPE.body
					)}
				>
					Agents you add appear here.
				</p>
				<Button
					className="mt-[1.6cqw]"
					onClick={onStartThread}
					type="button"
					variant="secondary"
				>
					New thread
				</Button>
			</div>
		);
	}

	const overflow = tiles.length > GLANCE_TILE_LIMIT;
	const shown = overflow ? tiles.slice(0, GLANCE_TILE_LIMIT - 1) : tiles;
	const cells = shown.length + (overflow ? 1 : 0);
	const columns = glanceTileColumns(cells);
	const rows = Math.ceil(cells / columns);
	return (
		<ul
			aria-label="Agents"
			className="grid size-full gap-[2.8cqw] p-[4.4cqw]"
			style={{
				gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
				gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
			}}
		>
			{shown.map((tile) => (
				<li className="flex min-h-0 min-w-0 *:flex-1" key={tile.agent.id}>
					<AgentTile
						near={near}
						onOpen={() =>
							tile.thread
								? onOpenThread(tile.thread.id)
								: onStartWithAgent(tile.agent.id)
						}
						snapshot={snapshot}
						tile={tile}
					/>
				</li>
			))}
			{overflow ? (
				<li className="flex min-h-0 min-w-0 *:flex-1">
					<button
						className={cn(
							"corner-squircle flex flex-col justify-end rounded-[4.4cqw] bg-muted p-[3.6cqw] text-left font-semibold text-foreground outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring",
							GLANCE_TYPE.lead
						)}
						onClick={onShowAll}
						type="button"
					>
						{tl("{count} more", { count: String(tiles.length - shown.length) })}
					</button>
				</li>
			) : null}
		</ul>
	);
}
