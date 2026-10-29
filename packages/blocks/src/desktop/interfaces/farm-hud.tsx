import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	CircleAlert,
	Coins,
	ShoppingBasket,
	Sprout,
	Tractor,
	Warehouse,
} from "lucide-react";
import { type FarmTotals, plural, STAGE_HINTS } from "./farm-model.ts";
import { PlantGlyph } from "./farm-plants.tsx";
import {
	GAME_FOCUS,
	GAME_PLATE,
	GameAction,
	GameCounter,
	GameCounters,
	GameLegend,
	GamePlate,
	GameTitlePlate,
} from "./game-hud.tsx";
import type { ActTotals } from "./game3d-acts.ts";

/**
 * The farm's HUD on the shared game kit (game-shell.tsx): the farm's name
 * and day on the title plate, the Barn and Plant a seed (the one primary
 * action) top right, the counters a farmer checks first bottom left (what
 * withered, what is ready to harvest, what is growing, and coins, one per
 * message), and a legend of the crop stages bottom right.
 */

/** Top left: the farm's name, its day and what wants harvesting. */
export function FarmTitle({
	actStatus,
	compact,
	day,
	empty,
	totals,
}: {
	/** The act layer's summary line, when the host sends asks. */
	actStatus?: string;
	compact: boolean;
	day: number;
	empty: boolean;
	totals: FarmTotals;
}) {
	let status = `Day ${day}`;
	if (empty) {
		status = "No plots yet. Add an agent, or plant a seed.";
	} else if (totals.ripe > 0) {
		status = `Day ${day} · ${plural(totals.ripe, "crop")} ready to harvest`;
	}
	if (empty && actStatus !== undefined) {
		// An empty farm with an ask at the gate: the summary, and how to start.
		return (
			<div className="flex min-w-0 flex-col items-start gap-2">
				{compact ? (
					<>
						<GameTitlePlate
							compact
							icon={<Tractor strokeWidth={2.25} />}
							title="Farm"
						/>
						<GamePlate className="px-3 py-1.5 font-semibold text-(--gk-ink-muted) text-[13px] leading-5">
							{actStatus}
						</GamePlate>
					</>
				) : (
					<GameTitlePlate
						icon={<Tractor strokeWidth={2.25} />}
						keepStatus
						status={actStatus}
						title="Farm"
					/>
				)}
				<GamePlate className="px-3 py-1.5 font-semibold text-(--gk-ink-muted) text-[13px] leading-5">
					{status}
				</GamePlate>
			</div>
		);
	}
	if (compact && actStatus !== undefined) {
		// A phone's title plate truncates its status line: the act summary
		// gets a plate of its own under it, where it wraps whole.
		return (
			<div className="flex min-w-0 flex-col items-start gap-2">
				<GameTitlePlate
					compact
					icon={<Tractor strokeWidth={2.25} />}
					title="Farm"
				/>
				<GamePlate className="px-3 py-1.5 font-semibold text-(--gk-ink-muted) text-[13px] leading-5">
					{actStatus}
				</GamePlate>
			</div>
		);
	}
	return (
		<GameTitlePlate
			compact={compact}
			icon={<Tractor strokeWidth={2.25} />}
			keepStatus={actStatus !== undefined}
			status={actStatus ?? status}
			title="Farm"
		/>
	);
}

/** Top right: the barn (every crop by status) and the seed bag. */
export function FarmActions({
	barnOpen,
	compact,
	crops,
	disabled,
	onOpenBarn,
	onPlant,
}: {
	barnOpen: boolean;
	compact: boolean;
	crops: number;
	disabled: boolean;
	onOpenBarn: () => void;
	onPlant: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="flex shrink-0 items-start gap-3">
			<button
				aria-label={tl(
					"Barn: {count, plural, one {{crops} crop} other {{crops} crops}}",
					{
						count: crops,
						crops: String(crops),
					}
				)}
				aria-pressed={barnOpen}
				className={cn(
					GAME_PLATE,
					"gk-display pointer-events-auto flex h-12 items-center gap-2 ps-2 pe-4 text-[17px] transition-colors hover:bg-(--gk-plate-sunk) disabled:opacity-60 aria-pressed:bg-(--gk-plate-sunk)",
					compact && "pe-2",
					GAME_FOCUS
				)}
				disabled={disabled}
				onClick={onOpenBarn}
				type="button"
			>
				<span
					aria-hidden="true"
					className="grid size-8 place-items-center rounded-lg border-(--gk-edge) border-2 bg-(--gk-plate-sunk)"
				>
					<Warehouse className="size-4" strokeWidth={2.5} />
				</span>
				{compact ? null : "Barn"}
			</button>
			<GameAction
				compact={compact}
				disabled={disabled}
				icon={<Sprout strokeWidth={2.5} />}
				label="Plant a seed"
				onClick={onPlant}
			/>
		</div>
	);
}

/**
 * Bottom left: withered (only when there are any), ready, growing and
 * coins. The order is urgency, as the reference farm games put alerts first.
 */
export function FarmCounters({
	actTotals,
	compact,
	showCoins = true,
	totals,
}: {
	/** The act layer's counts, when the host sends asks. */
	actTotals?: ActTotals;
	compact: boolean;
	/** The farm's `coins` setting. */
	showCoins?: boolean;
	totals: FarmTotals;
}) {
	if (actTotals) {
		return (
			<GameCounters label="Farm counters">
				{actTotals.failed > 0 ? (
					<GameCounter
						compact={compact}
						icon={<CircleAlert strokeWidth={2.5} />}
						label="failed"
						tone="bad"
						value={actTotals.failed}
					/>
				) : null}
				<GameCounter
					compact={compact}
					icon={<ShoppingBasket strokeWidth={2.5} />}
					label="need you"
					tone={actTotals.needYou > 0 ? "gold" : "info"}
					value={actTotals.needYou}
				/>
				<GameCounter
					compact={compact}
					icon={<Sprout strokeWidth={2.5} />}
					label="working"
					tone="info"
					value={actTotals.working}
				/>
				{showCoins ? (
					<GameCounter
						compact={compact}
						icon={<Coins strokeWidth={2.5} />}
						label={totals.coins === 1 ? "coin" : "coins"}
						tone="gold"
						value={totals.coins}
					/>
				) : null}
			</GameCounters>
		);
	}
	return (
		<GameCounters label="Farm counters">
			{totals.withered > 0 ? (
				<GameCounter
					compact={compact}
					icon={<CircleAlert strokeWidth={2.5} />}
					label="withered"
					tone="bad"
					value={totals.withered}
				/>
			) : null}
			<GameCounter
				compact={compact}
				icon={<ShoppingBasket strokeWidth={2.5} />}
				label="ready"
				tone="good"
				value={totals.ripe}
			/>
			<GameCounter
				compact={compact}
				icon={<Sprout strokeWidth={2.5} />}
				label="growing"
				tone="info"
				value={totals.growing}
			/>
			{showCoins ? (
				<GameCounter
					compact={compact}
					icon={<Coins strokeWidth={2.5} />}
					label={totals.coins === 1 ? "coin" : "coins"}
					tone="gold"
					value={totals.coins}
				/>
			) : null}
		</GameCounters>
	);
}

/** Bottom right: what each stage of a crop means. */
export function FarmLegend() {
	const items = [
		{ key: "seed", label: "Seeded", stage: "seed" },
		{ key: "growing", label: "Growing", stage: "growing" },
		{ key: "ripe", label: "Ripe: harvest", stage: "ripe" },
		{ key: "withered", label: "Withered", stage: "withered" },
	] as const;
	return (
		<GameLegend
			items={items.map((item) => ({
				key: item.key,
				label: <span title={STAGE_HINTS[item.stage]}>{item.label}</span>,
				mark: (
					<PlantGlyph className="size-6" fruit="tomato" stage={item.stage} />
				),
			}))}
			label="Crop stages"
		/>
	);
}
