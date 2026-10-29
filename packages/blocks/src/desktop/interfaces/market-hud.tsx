import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	BellRing,
	ChevronDown,
	Hourglass,
	Map as MapIcon,
	ReceiptText,
	Store,
} from "lucide-react";
import type { ReactNode } from "react";
import {
	GAME_FOCUS,
	GAME_PLATE,
	GameCounter,
	GameCounters,
	GameTitlePlate,
} from "./game-hud.tsx";
import { GameHudSlot } from "./game-shell.tsx";
import type { ActTotals } from "./game3d-acts.ts";
import { type IsoView, IsoZoomControls } from "./game3d-stage.tsx";
import {
	type MarketShop,
	type MarketTotals,
	shopKindText,
	shopState,
} from "./market-model.ts";

/**
 * The Market's HUD on the shared game kit (game-shell.tsx): the street's
 * name and what waits on you on the title plate, the shop directory top
 * right (it opens a shop's sheet), the street's counters bottom left and
 * the zoom plate bottom right.
 */

export const STREET_NAME = "Market Street";

function streetStatus(totals: MarketTotals, tl: LiteralMessage): string {
	if (totals.waitingOnYou > 0) {
		return tl(
			"{shops, plural, one {{shopsText} shop} other {{shopsText} shops}} · {waitingOnYou} waiting on you",
			{
				shops: totals.shops,
				shopsText: String(totals.shops),
				waitingOnYou: totals.waitingOnYou,
			}
		);
	}
	return tl(
		"{shops, plural, one {{shopsText} shop} other {{shopsText} shops}} · all served",
		{ shops: totals.shops, shopsText: String(totals.shops) }
	);
}

function Directory({
	acts,
	compact,
	onEnter,
	shops,
}: {
	/** With the act layer the counts are what needs you (shop.waitingOnYou). */
	acts: boolean;
	compact: boolean;
	onEnter: (shopId: string) => void;
	shops: MarketShop[];
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<button
						aria-label="Directory"
						className={cn(
							GAME_PLATE,
							"gk-display pointer-events-auto flex h-12 items-center gap-2 ps-2 pe-3.5 text-[17px] transition-colors hover:bg-(--gk-plate-sunk) aria-expanded:bg-(--gk-plate-sunk)",
							GAME_FOCUS
						)}
						type="button"
					/>
				}
			>
				<span
					aria-hidden="true"
					className="grid size-8 place-items-center rounded-lg border-(--gk-edge) border-2 bg-(--gk-plate-sunk)"
				>
					<MapIcon className="size-4" strokeWidth={2.5} />
				</span>
				{compact ? null : "Directory"}
				<ChevronDown aria-hidden="true" className="size-4" strokeWidth={2.5} />
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="w-72 border border-border bg-popover text-popover-foreground shadow-foreground/10 shadow-lg"
				drawerLabel="Directory"
				sideOffset={8}
			>
				<DropdownMenuGroup>
					<DropdownMenuLabel>{STREET_NAME}</DropdownMenuLabel>
					{shops.map((shop) => (
						<DropdownMenuItem key={shop.id} onClick={() => onEnter(shop.id)}>
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="truncate text-sm">{shop.name}</span>
								<span className="truncate text-[13px] text-muted-foreground">
									{shopKindText(shop)} · {shopState(shop)}
								</span>
							</span>
							{shop.waitingOnYou > 0 ? (
								<span className="ms-3 flex shrink-0 items-center gap-1.5 self-start pt-0.5 text-[13px] text-muted-foreground tabular-nums">
									<span
										aria-hidden="true"
										className={cn(
											"size-2 rounded-full",
											!acts && shop.counts.attention > 0
												? "bg-destructive"
												: "bg-primary"
										)}
									/>
									{shop.waitingOnYou} {acts ? "need you" : "waiting"}
								</span>
							) : null}
						</DropdownMenuItem>
					))}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** The act layer's HUD parts, when the snapshot carries acts. */
export interface MarketHudActs {
	/** The need-you and Queue buttons. */
	actions: ReactNode;
	/** The blind-spot caption. */
	caption: ReactNode;
	/** `actSummaryLine`, kept visible on compact stages. */
	summary: string;
	totals: ActTotals;
}

/** The street's HUD: title, directory, counters and the zoom plate. */
export function MarketStreetHud({
	acts,
	compact,
	loading,
	onEnter,
	shops,
	totals,
	view,
}: {
	acts?: MarketHudActs;
	compact: boolean;
	loading: boolean;
	onEnter: (shopId: string) => void;
	shops: MarketShop[];
	totals: MarketTotals;
	view: IsoView;
}) {
	const tl = useLiteralMessages();
	const empty = !loading && shops.length === 0;
	let status = loading ? undefined : streetStatus(totals, tl);
	if (empty) {
		status = "No shops yet";
	}
	const title = (
		<>
			<GameTitlePlate
				compact={compact}
				icon={<Store strokeWidth={2.25} />}
				keepStatus={acts !== undefined && !compact}
				status={
					loading ? (
						<Skeleton className="mt-1 h-3 w-36" />
					) : acts && !empty ? (
						acts.summary
					) : (
						status
					)
				}
				title={STREET_NAME}
			/>
			{loading || empty ? null : (
				<div className={acts ? "ms-auto shrink-0" : "ms-auto"}>
					<Directory
						acts={acts !== undefined}
						compact={compact}
						onEnter={onEnter}
						shops={shops}
					/>
				</div>
			)}
		</>
	);
	return (
		<>
			{acts && !loading && !empty ? (
				<GameHudSlot at="top-left" className="right-0 flex-col items-stretch">
					<div className="flex min-w-0 @min-[672px]/game:gap-3 gap-2">
						{title}
					</div>
					<div className="flex flex-wrap items-center gap-2">
						{acts.actions}
					</div>
					{compact ? (
						// A compact plate has no room for the whole summary: it gets
						// its own line, so no term is cut off.
						<p
							aria-hidden="true"
							className="w-fit rounded-full border-(--gk-edge) border-2 bg-(--gk-plate) px-2.5 py-0.5 font-semibold text-(--gk-ink) text-[12px]"
						>
							{acts.summary}
						</p>
					) : null}
					<div className="flex">{acts.caption}</div>
				</GameHudSlot>
			) : (
				<GameHudSlot at="top-left" className="right-0">
					{title}
				</GameHudSlot>
			)}
			{loading || empty ? null : (
				<GameHudSlot at="bottom-left">
					<GameCounters label="Street counters">
						<GameCounter
							compact={compact}
							icon={<BellRing strokeWidth={2.5} />}
							label={acts ? "need you" : "waiting on you"}
							tone={
								(acts ? acts.totals.needYou : totals.waitingOnYou) > 0
									? "warn"
									: "good"
							}
							value={acts ? acts.totals.needYou : totals.waitingOnYou}
						/>
						<GameCounter
							compact={compact}
							icon={<Hourglass strokeWidth={2.5} />}
							label={acts ? "working" : "busy"}
							tone="info"
							value={acts ? acts.totals.working : totals.busy}
						/>
						<GameCounter
							compact={compact}
							icon={<ReceiptText strokeWidth={2.5} />}
							label={totals.orders === 1 ? "order" : "orders"}
							tone="accent"
							value={totals.orders}
						/>
					</GameCounters>
				</GameHudSlot>
			)}
			{loading || empty ? null : (
				<GameHudSlot at="bottom-right">
					<IsoZoomControls view={view} />
				</GameHudSlot>
			)}
		</>
	);
}
