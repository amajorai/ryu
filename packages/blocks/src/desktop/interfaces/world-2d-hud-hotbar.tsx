import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { frameStyle } from "./world-2d-frame.ts";
import {
	BAR_FRAME_SCALE,
	PAGE_TURN_WIDTH,
	SLOT_BUTTON,
	SLOT_FRAME_SCALE,
	SLOT_GAP,
	SLOT_SIZE,
	type SlotSize,
} from "./world-2d-hud-hotbar-layout.ts";
import {
	HelpButton,
	MapIcon,
	SlotKeyLabel,
	SlotStatus,
} from "./world-2d-hud-slots.tsx";
import { type VillagerStatus, villagerStatusSuffix } from "./world-2d-model.ts";
import { SV_UI } from "./world-2d-palette.ts";
import { PixelPortrait } from "./world-2d-portrait.tsx";

export interface HotbarAgent {
	/**
	 * The act layer: the slot's whole name (the act sentence and "Visit
	 * <name>.", or for an asker its ask and "Answer their ask.").
	 */
	actLabel?: string;
	agentId: string;
	/** The agent's place in the village (picks its outfit). */
	index: number;
	name: string;
	status: VillagerStatus;
}

/**
 * A chunky 5x7 pixel chevron for the hotbar's page turns, cream with a
 * dark brown edge so it reads on the wooden plank.
 */
function PageArrowIcon({ direction }: { direction: "left" | "right" }) {
	const right =
		"M0 0h2v1h1v1h1v1h1v1h-1v1h-1v1h-1v1h-2v-1h1v-1h1v-1h1v-1h-1v-1h-1v-1h-1z";
	const left =
		"M3 0h2v1h-1v1h-1v1h-1v1h1v1h1v1h1v1h-2v-1h-1v-1h-1v-1h-1v-1h1v-1h1v-1h1z";
	const path = direction === "left" ? left : right;
	return (
		<svg
			aria-hidden="true"
			className="shrink-0"
			height="24"
			shapeRendering="crispEdges"
			viewBox="0 0 6 8"
			width="18"
		>
			<path d={path} fill={SV_UI.outline} transform="translate(1 1)" />
			<path d={path} fill={SV_UI.plankInk} />
		</svg>
	);
}

/** A small wooden arrow that turns the hotbar to the previous/next page. */
function PageTurn({
	direction,
	disabled,
	height,
	label,
	onClick,
}: {
	direction: "left" | "right";
	disabled: boolean;
	height: number;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			aria-keyshortcuts={direction === "left" ? "[" : "]"}
			aria-label={label}
			className="flex shrink-0 items-center justify-center outline-none hover:brightness-110 focus-visible:shadow-[inset_0_0_0_2px_var(--sv-focus)] active:translate-y-px disabled:opacity-40 disabled:hover:brightness-100"
			disabled={disabled}
			onClick={onClick}
			style={{ ...frameStyle("plank", 1), height, width: PAGE_TURN_WIDTH }}
			title={`${label} (${direction === "left" ? "[" : "]"})`}
			type="button"
		>
			<PageArrowIcon direction={direction} />
		</button>
	);
}

/**
 * Which page the hotbar shows, as pips under the slots inside its frame
 * (the text is for screen readers).
 */
function PagePips({ page, pageCount }: { page: number; pageCount: number }) {
	const tl = useLiteralMessages();
	return (
		<p className="mt-1 flex items-center justify-center gap-[3px] leading-none">
			<span className="sr-only">
				{tl("Page {page} of {pageCount}", {
					page: String(page + 1),
					pageCount: String(pageCount),
				})}
			</span>
			{Array.from({ length: pageCount }, (_, index) => (
				<span
					aria-hidden="true"
					className={cn(
						"block border border-(--sv-wood-dark)",
						index === page
							? "size-2 bg-(--sv-red)"
							: "size-1.5 bg-(--sv-ink-shadow)"
					)}
					// biome-ignore lint/suspicious/noArrayIndexKey: pips are positional.
					key={index}
				/>
			))}
		</p>
	);
}

/**
 * One slot per villager, a page of them at a time (Stardew's hotbar rows):
 * click a slot (or press its number key) to walk over and talk; the wooden
 * arrows (or [ and ]) turn the page and pips under the slots show which
 * page is up. The active slot gets Stardew's red selection frame. The
 * controls and map slots stay put at either end.
 */
export function Hotbar({
	activeId,
	agents,
	helpInBar,
	helpOpen,
	mapOpen,
	onPage,
	onToggleHelp,
	onToggleMap,
	onVisit,
	page,
	pageCount,
	size,
}: {
	activeId: string | null;
	/** The villagers on this page. */
	agents: readonly HotbarAgent[];
	/** Whether the controls slot is in the bar (else it is by the title). */
	helpInBar: boolean;
	helpOpen: boolean;
	mapOpen: boolean;
	onPage: (delta: -1 | 1) => void;
	onToggleHelp: () => void;
	onToggleMap: () => void;
	onVisit: (agentId: string) => void;
	/** Zero-based page shown. */
	page: number;
	pageCount: number;
	size: SlotSize;
}) {
	const tl = useLiteralMessages();
	const paged = pageCount > 1;
	const px = SLOT_SIZE[size];
	const slotStyle = (kind: "slot" | "slot-active" | "slot-pressed") => ({
		...frameStyle(kind, SLOT_FRAME_SCALE[size]),
		height: px,
		width: px,
	});
	return (
		<nav
			aria-label="Villagers"
			className="pointer-events-auto relative max-w-full"
			style={frameStyle("wood", BAR_FRAME_SCALE[size])}
		>
			<div className="flex items-end" style={{ gap: SLOT_GAP }}>
				{helpInBar ? (
					<HelpButton
						frameScale={SLOT_FRAME_SCALE[size]}
						onToggle={onToggleHelp}
						open={helpOpen}
						size={px}
					/>
				) : null}
				{paged ? (
					<PageTurn
						direction="left"
						disabled={page === 0}
						height={px}
						label="Previous villagers"
						onClick={() => onPage(-1)}
					/>
				) : null}
				<ul
					className="flex min-w-0 overflow-x-auto px-px [scrollbar-color:var(--sv-slot-shade)_transparent] [scrollbar-width:thin]"
					style={{ gap: SLOT_GAP }}
				>
					{agents.map((agent, index) => {
						const active = agent.agentId === activeId;
						return (
							<li className="shrink-0" key={agent.agentId}>
								<button
									aria-current={active ? "true" : undefined}
									aria-keyshortcuts={
										index < 10 ? String((index + 1) % 10) : undefined
									}
									aria-label={
										agent.actLabel ??
										tl("Visit {name}{suffix}", {
											name: agent.name,
											suffix: villagerStatusSuffix(agent.status),
										})
									}
									className={cn(SLOT_BUTTON, "group block")}
									data-act-agent={agent.actLabel ? agent.agentId : undefined}
									onClick={() => onVisit(agent.agentId)}
									style={slotStyle(active ? "slot-active" : "slot")}
									title={agent.name}
									type="button"
								>
									<span className="absolute inset-0 flex items-center justify-center transition-transform group-hover:-translate-y-[2px]">
										<PixelPortrait
											agentId={agent.agentId}
											lookIndex={agent.index}
											scale={2}
										/>
									</span>
									{index < 10 ? (
										<SlotKeyLabel frameScale={SLOT_FRAME_SCALE[size]}>
											{(index + 1) % 10}
										</SlotKeyLabel>
									) : null}
									<SlotStatus size={size} status={agent.status} />
								</button>
							</li>
						);
					})}
				</ul>
				{paged ? (
					<PageTurn
						direction="right"
						disabled={page >= pageCount - 1}
						height={px}
						label="Next villagers"
						onClick={() => onPage(1)}
					/>
				) : null}
				<button
					aria-keyshortcuts="M"
					aria-label="Village map"
					aria-pressed={mapOpen}
					className={SLOT_BUTTON}
					onClick={onToggleMap}
					style={slotStyle(mapOpen ? "slot-pressed" : "slot")}
					title="Map (M)"
					type="button"
				>
					<MapIcon size={size === "full" ? 30 : 20} />
					<SlotKeyLabel frameScale={SLOT_FRAME_SCALE[size]}>M</SlotKeyLabel>
				</button>
			</div>
			{paged ? <PagePips page={page} pageCount={pageCount} /> : null}
		</nav>
	);
}

/** Empty slots shown while the villagers load. */
const PLACEHOLDER_SLOTS = 6;

/**
 * The hotbar while the villagers load: the same wooden bar with empty
 * wells, so the HUD keeps its shape instead of flashing a loading line.
 */
export function HotbarPlaceholder({ size }: { size: SlotSize }) {
	const px = SLOT_SIZE[size];
	return (
		<div
			aria-hidden="true"
			className="max-w-full"
			data-testid="world-2d-hotbar-placeholder"
			style={frameStyle("wood", BAR_FRAME_SCALE[size])}
		>
			<div className="flex" style={{ gap: SLOT_GAP }}>
				{Array.from({ length: PLACEHOLDER_SLOTS }, (_, index) => (
					<span
						className="block shrink-0"
						// biome-ignore lint/suspicious/noArrayIndexKey: placeholder wells are positional.
						key={index}
						style={{
							...frameStyle("slot", SLOT_FRAME_SCALE[size]),
							height: px,
							width: px,
						}}
					/>
				))}
			</div>
		</div>
	);
}
