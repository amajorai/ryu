import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceThread } from "@ryuhq/protocol/interfaces";
import { Coins, Dices, Plus, RotateCw, Ticket } from "lucide-react";
import {
	type ArcadeFloor,
	meterDigits,
	paytable,
	plural,
	threadTitle,
	type WallCabinet,
	wallCabinetLabel,
} from "./arcade-model.ts";
import type { ArcadePalette } from "./arcade-palette.ts";
import { ReelGlyph } from "./arcade-reels.tsx";
import {
	GAME_FOCUS,
	GAME_PLATE,
	GameAction,
	GameCounter,
	GameCounters,
	GameLegend,
	GameTitlePlate,
} from "./game-hud.tsx";

/**
 * The floor's HUD on the shared game kit (game-shell.tsx): the arcade's
 * title plate, Collect (the reply that has waited longest) and New game top
 * right, the meters (credits, machines running, jackpots) bottom left, the
 * paytable legend bottom right, and the projects and teams as filter chips
 * under the marquee.
 */

/** Top left: the arcade and what is going on. */
export function ArcadeTitle({
	compact,
	floor,
	status,
}: {
	compact: boolean;
	floor: ArcadeFloor;
	/** The act layer's summary line, kept visible on compact stages. */
	status?: string;
}) {
	const { totals } = floor;
	const parts = [
		totals.jackpots > 0
			? `${plural(totals.jackpots, "jackpot")} waiting on you`
			: null,
		totals.running > 0 ? `${totals.running} running` : null,
	].filter(Boolean);
	return (
		<GameTitlePlate
			compact={compact}
			icon={<Dices strokeWidth={2.25} />}
			keepStatus={status !== undefined}
			status={
				status ??
				(parts.length > 0 ? parts.join(" · ") : "Every machine is idle")
			}
			title="Arcade"
		/>
	);
}

/** Top right: Collect the longest-waiting reply, and start a new game. */
export function ArcadeActions({
	compact,
	floor,
	loading,
	next,
	onCollect,
	onNewGame,
}: {
	compact: boolean;
	floor: ArcadeFloor;
	loading: boolean;
	next: InterfaceThread | undefined;
	onCollect: (threadId: string) => void;
	onNewGame: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="flex shrink-0 items-start gap-3">
			{next && !loading ? (
				<button
					aria-label={tl(
						"Collect jackpot: open {threadTitle} ({jackpots} waiting on you)",
						{
							jackpots: String(floor.totals.jackpots),
							threadTitle: threadTitle(next),
						}
					)}
					className={cn(
						GAME_PLATE,
						"gk-display pointer-events-auto flex h-12 items-center gap-2 ps-2 pe-3 text-[17px] transition-colors hover:bg-(--gk-plate-sunk)",
						GAME_FOCUS
					)}
					onClick={() => onCollect(next.id)}
					title={tl("Open the reply that has waited longest: {threadTitle}", {
						threadTitle: threadTitle(next),
					})}
					type="button"
				>
					<span
						aria-hidden="true"
						className="grid size-8 place-items-center rounded-lg border-(--gk-edge) border-2 bg-(--gk-gold) text-(--gk-edge)"
					>
						<Ticket className="size-4" strokeWidth={2.5} />
					</span>
					{compact ? null : "Collect"}
					<span className="grid h-6 min-w-6 place-items-center rounded-full border-(--gk-edge) border-2 bg-(--gk-accent) px-1.5 text-(--gk-accent-ink) text-[13px] tabular-nums">
						{floor.totals.jackpots}
					</span>
				</button>
			) : null}
			<GameAction
				compact={compact}
				disabled={loading}
				icon={<Plus strokeWidth={3} />}
				label="New game"
				onClick={onNewGame}
			/>
		</div>
	);
}

/** Bottom left: credits (messages), machines running and jackpots. */
export function ArcadeMeters({
	answers,
	compact,
	floor,
	running,
}: {
	/** Unread answers, from the act layer's reply asks (else jackpots). */
	answers?: number;
	compact: boolean;
	floor: ArcadeFloor;
	/** Agents working, from the act layer's totals (else machines running). */
	running?: number;
}) {
	const { totals } = floor;
	return (
		<GameCounters label="Meters">
			<GameCounter
				compact={compact}
				icon={<Coins strokeWidth={2.5} />}
				label="Credits"
				tone="gold"
				value={totals.credits}
			/>
			<GameCounter
				compact={compact}
				icon={<RotateCw strokeWidth={2.5} />}
				label="Running"
				tone="info"
				value={running ?? totals.running}
			/>
			<GameCounter
				compact={compact}
				icon={<Ticket strokeWidth={2.5} />}
				label={answers === undefined ? "Jackpots" : "Answers"}
				tone="good"
				value={answers ?? totals.jackpots}
			/>
		</GameCounters>
	);
}

/** Bottom right: what each reel symbol means, and how many show it now. */
export function ArcadePaytable({
	floor,
	palette,
}: {
	floor: ArcadeFloor;
	palette: ArcadePalette;
}) {
	return (
		<GameLegend
			items={paytable(floor).map((line) => ({
				key: line.status,
				label: (
					<span
						className={cn(
							"flex items-center gap-1.5",
							line.count === 0 && "text-(--gk-ink-soft)"
						)}
					>
						{line.label}
						<span className="font-mono tabular-nums">
							{meterDigits(line.count, 2)}
						</span>
					</span>
				),
				mark: (
					<span
						className={cn(
							"grid size-7 place-items-center rounded-md border-(--gk-edge) border-2",
							line.count === 0 && "opacity-50"
						)}
						style={{ background: palette.reelFace }}
					>
						<ReelGlyph palette={palette} size={20} symbol={line.symbol} />
					</span>
				),
			}))}
			label="Paytable"
		/>
	);
}

/**
 * Projects and teams as chips under the marquee: press one to narrow the
 * floor to its agents' machines, press it again (or All machines) to show
 * every machine.
 */
export function ArcadeFilters({
	acted = false,
	cabinets,
	filterId,
	onClear,
	onToggle,
}: {
	/** The act layer is on: the chips' names leave out legacy counts. */
	acted?: boolean;
	cabinets: WallCabinet[];
	filterId: string | null;
	onClear: () => void;
	onToggle: (groupId: string) => void;
}) {
	if (cabinets.length === 0) {
		return null;
	}
	const chip =
		"gk-display pointer-events-auto flex h-10 shrink-0 items-center gap-2 rounded-full border-(--gk-edge) border-2 bg-(--gk-plate) px-4 text-(--gk-ink) text-[15px] shadow-[0_3px_0_var(--gk-edge)] transition-colors hover:bg-(--gk-plate-sunk) aria-pressed:bg-(--gk-accent) aria-pressed:text-(--gk-accent-ink)";
	return (
		<nav
			aria-label="Projects and teams"
			className="-mx-4 flex max-w-[calc(100%+2rem)] items-center gap-2.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:justify-center [&::-webkit-scrollbar]:hidden"
		>
			<button
				aria-pressed={filterId === null}
				className={cn(chip, GAME_FOCUS)}
				onClick={onClear}
				type="button"
			>
				All machines
			</button>
			{cabinets.map((cabinet) => {
				const active = cabinet.group.id === filterId;
				return (
					<button
						aria-label={wallCabinetLabel(cabinet, active, acted)}
						aria-pressed={active}
						className={cn(chip, GAME_FOCUS)}
						data-arcade-wall={cabinet.group.id}
						key={cabinet.group.id}
						onClick={() => onToggle(cabinet.group.id)}
						type="button"
					>
						{cabinet.group.name}
						<span className="grid h-6 min-w-6 place-items-center rounded-full bg-(--gk-plate-sunk) px-1.5 text-(--gk-ink-muted) text-[13px] tabular-nums">
							{cabinet.machines}
						</span>
					</button>
				);
			})}
		</nav>
	);
}
