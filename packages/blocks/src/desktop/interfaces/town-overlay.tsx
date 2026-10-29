import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type {
	ClockOptions,
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { type ReactNode, type Ref, useId } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { GAME_FOCUS } from "./game-hud.tsx";
import type { LifeBubble } from "./game3d-life.ts";
import { LifeBubbleTag } from "./game3d-life.tsx";
import { ActStatus } from "./interface-ask-card.tsx";
import {
	BUILDING_NAMES,
	buildingLabel,
	plural,
	type Town,
	type TownBuilding,
} from "./town-model.ts";

/**
 * The accessible DOM layer over the 3D town: a hit target on every agent
 * building with its name tag under it, a name sign on every district and
 * City Hall's door. The scene moves each `[data-anchor]` element onto the
 * art after every camera move, so the layer stays crisp and themable while
 * the town stays in WebGL.
 */

/**
 * A name tag hangs above its point (`data-hang="above"`): the scene moves
 * it over the roof, crane or bubble and keeps it inside the stage. A short
 * leader under the tag points down at the art.
 */
/**
 * The act layer, when the host sends asks: each building button is named
 * by its agent's act sentence ("… Open its card.", or "… Answer their
 * ask." opening the ask card for an asking agent, with no aria-pressed),
 * and the act props follow the buildings in Tab order.
 */
export interface TownOverlayActs {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	/**
	 * The act bubbles the budget kept, by agent id, hung on each building's
	 * name tag (an asking villager's hangs on its queue plate instead).
	 */
	bubbles: ReadonlyMap<string, LifeBubble>;
	/** Blocking asks (City Hall's count with acts). */
	needYou: number;
	onAsk: (askId: string) => void;
	props: ReactNode;
}

/** A building's act name and what activating it does. */
function actTarget(
	act: InterfaceAgentAct | undefined,
	onAsk: (askId: string) => void,
	tl: LiteralMessage
): { activate: (() => void) | null; label: string } | null {
	if (!act) {
		return null;
	}
	const ask = act.act === "asking" ? act.ask : null;
	return ask
		? {
				activate: () => onAsk(ask.id),
				label: tl("{actLabel} Answer their ask.", {
					actLabel: act.ariaLabel,
				}),
			}
		: {
				activate: null,
				label: tl("{actLabel} Open its card.", { actLabel: act.ariaLabel }),
			};
}

const TAG =
	"gk-display pointer-events-none invisible absolute flex h-7 -translate-x-1/2 -translate-y-full items-center whitespace-nowrap rounded-lg border-2 border-(--gk-edge) px-2.5 text-[14px] leading-none shadow-[0_2px_0_var(--gk-edge)] transition-[opacity,background-color] duration-150 after:absolute after:top-[calc(100%+2px)] after:left-1/2 after:h-1.5 after:w-0.5 after:-translate-x-1/2 after:bg-(--gk-edge) motion-reduce:transition-none";

export function TownOverlay({
	actLayer = null,
	hoverId,
	layerRef,
	onBuilding,
	onDistrict,
	onHall,
	onHover,
	selectedId,
	showCounts,
	showTags,
	town,
}: {
	actLayer?: TownOverlayActs | null;
	hoverId: string | null;
	layerRef: Ref<HTMLDivElement>;
	onBuilding: (agentId: string) => void;
	onDistrict: (districtId: string) => void;
	onHall: () => void;
	onHover: (id: string | null) => void;
	selectedId: string | null;
	/** Conversation counts on the district signs (off on a phone-width stage). */
	showCounts: boolean;
	/** Name tags under buildings (off when zoomed far out on small stages). */
	showTags: boolean;
	town: Town;
}) {
	const tl = useLiteralMessages();
	const names = new Map(town.districts.map((item) => [item.id, item.name]));
	// With acts City Hall counts the blocking asks waiting on you.
	const petitions = actLayer ? actLayer.needYou : town.petitions.length;
	// With acts a district sign carries no conversation count (the acts say
	// who needs you), and it looks a little farther for room before hiding
	// (it still settles after the act words).
	const districtCounts = showCounts && !actLayer;
	return (
		<div
			className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
			ref={layerRef}
		>
			<ul aria-label="Districts on the map" className="contents">
				{town.districts.map((district) => (
					<li className="contents" key={district.id}>
						<button
							aria-label={
								actLayer
									? tl("{districtName} district. Show on the map", {
											districtName: district.name,
										})
									: tl(
											"{districtName} district, {count, plural, one {{countText} conversation} other {{countText} conversations}}. Show on the map",
											{
												count: district.threads.length,
												countText: String(district.threads.length),
												districtName: district.name,
											}
										)
							}
							className={cn(
								"gk-display pointer-events-auto invisible absolute flex h-9 -translate-x-1/2 -translate-y-1/2 items-center gap-2 whitespace-nowrap rounded-xl border-(--gk-edge) border-2 bg-(--gk-plate) ps-3 pe-2 text-(--gk-ink) text-[16px] shadow-[0_3px_0_var(--gk-edge)] transition-colors hover:bg-(--gk-plate-sunk)",
								GAME_FOCUS,
								!districtCounts && "pe-3"
							)}
							data-anchor={`d:${district.id}`}
							data-rank="2"
							data-wide={actLayer ? "true" : undefined}
							onClick={() => onDistrict(district.id)}
							type="button"
						>
							{district.name}
							{districtCounts ? (
								<span className="grid h-6 min-w-6 place-items-center rounded-md bg-(--gk-plate-sunk) px-1.5 text-(--gk-ink-muted) text-[14px] tabular-nums">
									{district.threads.length}
								</span>
							) : null}
						</button>
					</li>
				))}
			</ul>
			<ul aria-label="Buildings" className="contents">
				{town.buildings.map((building) => (
					<li className="contents" key={building.agent.id}>
						<BuildingTarget
							act={
								actLayer
									? actTarget(
											actLayer.acts.get(building.agent.id),
											actLayer.onAsk,
											tl
										)
									: null
							}
							agentId={actLayer ? building.agent.id : undefined}
							building={building}
							districtName={names.get(building.districtId) ?? ""}
							onBuilding={onBuilding}
							onHover={onHover}
							selected={selectedId === building.agent.id}
						/>
					</li>
				))}
			</ul>
			{actLayer?.props}
			<button
				aria-label={
					actLayer
						? tl("City Hall, {petitions} need you. Go to what needs you", {
								petitions,
							})
						: tl(
								"City Hall, {petitions, plural, one {# petition} other {# petitions}}. Go to the petitions",
								{ petitions }
							)
				}
				className={cn(
					"pointer-events-auto invisible absolute rounded-md",
					GAME_FOCUS
				)}
				data-anchor="hall"
				onBlur={() => onHover(null)}
				onClick={onHall}
				onFocus={() => onHover("hall")}
				onPointerEnter={() => onHover("hall")}
				onPointerLeave={() => onHover(null)}
				type="button"
			/>
			<span
				aria-hidden="true"
				className={cn(
					TAG,
					"gap-2 bg-(--gk-accent) text-(--gk-accent-ink)",
					hoverId === "hall" && "brightness-110"
				)}
				data-anchor="t:hall"
				data-hang="above"
				data-rank="3"
			>
				City Hall
				{petitions > 0 ? (
					<span className="grid h-5 min-w-5 place-items-center rounded-md bg-(--gk-plate) px-1 text-(--gk-ink) text-[13px] tabular-nums">
						{petitions}
					</span>
				) : null}
			</span>
			{town.buildings.map((building) => {
				const hovered = hoverId === `b:${building.agent.id}`;
				const selected = selectedId === building.agent.id;
				const bubble = actLayer?.bubbles.get(building.agent.id) ?? null;
				const shown = showTags || hovered || selected || bubble !== null;
				return (
					<span
						aria-hidden="true"
						className={cn(
							TAG,
							selected
								? "z-10 bg-(--gk-accent) text-(--gk-accent-ink)"
								: "bg-(--gk-plate) text-(--gk-ink)",
							hovered && !selected && "z-10 bg-(--gk-plate-sunk)",
							shown ? "opacity-100" : "opacity-0"
						)}
						data-anchor={`t:${building.agent.id}`}
						data-fixed={selected ? "true" : undefined}
						data-hang="above"
						// A tag carrying a bubble the budget kept is never hidden.
						data-rank={bubble ? "6" : hovered ? "4" : "0"}
						data-shown={shown}
						key={building.agent.id}
					>
						{bubble ? <LifeBubbleTag bubble={bubble} /> : null}
						{building.agent.name}
					</span>
				);
			})}
		</div>
	);
}

function BuildingTarget({
	act = null,
	agentId,
	building,
	districtName,
	onBuilding,
	onHover,
	selected,
}: {
	/** The act layer's name and activation for this building. */
	act?: { activate: (() => void) | null; label: string } | null;
	/** The agent this building is the one target of (`data-act-agent`). */
	agentId?: string;
	building: TownBuilding;
	districtName: string;
	onBuilding: (agentId: string) => void;
	onHover: (id: string | null) => void;
	selected: boolean;
}) {
	const tl = useLiteralMessages();
	const id = `b:${building.agent.id}`;
	return (
		<button
			aria-label={
				act?.label ??
				tl("{buildingLabel}. Open its card", {
					buildingLabel: buildingLabel(building, districtName),
				})
			}
			aria-pressed={act?.activate ? undefined : selected}
			className={cn(
				"pointer-events-auto invisible absolute rounded-md",
				GAME_FOCUS
			)}
			data-act-agent={agentId}
			data-act-scene={agentId ? "" : undefined}
			data-anchor={id}
			onBlur={() => onHover(null)}
			onClick={() =>
				act?.activate ? act.activate() : onBuilding(building.agent.id)
			}
			onFocus={() => onHover(id)}
			onPointerEnter={() => onHover(id)}
			onPointerLeave={() => onHover(null)}
			type="button"
		/>
	);
}

/**
 * The town without WebGL: each district as a section of its buildings, so
 * everything the scene shows is still reachable.
 */
/** The act layer for the directory's rows, when the host sends asks. */
export interface TownDirectoryActs {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	nowMs: number;
	onAsk: (askId: string, opener?: HTMLElement) => void;
	onBlocker: (threadId: string, agentName: string, opener: HTMLElement) => void;
	snapshot: InterfaceSnapshot;
}

export function TownDirectory({
	actLayer = null,
	onBuilding,
	town,
}: {
	/** With acts each building row is named by its act and says its status. */
	actLayer?: TownDirectoryActs | null;
	onBuilding: (agentId: string) => void;
	town: Town;
}) {
	const tl = useLiteralMessages();
	const baseId = useId();
	return (
		<div className="mx-auto flex w-full max-w-2xl flex-col gap-6 py-6">
			{town.districts.map((district) => (
				<section
					aria-label={district.name}
					className="flex flex-col gap-1"
					key={district.id}
				>
					<h2 className="flex items-baseline gap-2 px-2 font-semibold text-foreground text-sm">
						{district.name}
						<span className="font-normal text-muted-foreground text-xs tabular-nums">
							{plural(district.threads.length, "conversation")}
						</span>
					</h2>
					<ul className="flex flex-col">
						{district.buildings.map((building) => {
							const act = actLayer?.acts.get(building.agent.id);
							const target = actLayer
								? actTarget(act, (askId) => actLayer.onAsk(askId), tl)
								: null;
							const describedBy = `${baseId}-${building.agent.id}`;
							return (
								<li key={building.agent.id}>
									{act ? (
										<span className="sr-only" id={describedBy}>
											{act.ariaLabel}
										</span>
									) : null}
									<button
										aria-describedby={act ? describedBy : undefined}
										aria-label={
											target?.label ??
											tl("{buildingLabel}. Open its card", {
												buildingLabel: buildingLabel(building, district.name),
											})
										}
										className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
										data-act-agent={act ? building.agent.id : undefined}
										onClick={() =>
											target?.activate
												? target.activate()
												: onBuilding(building.agent.id)
										}
										type="button"
									>
										<BoardAvatar
											agent={building.agent}
											name={building.agent.name}
											size={28}
										/>
										<span className="flex min-w-0 flex-1 flex-col">
											<span className="truncate font-medium text-foreground text-sm">
												{building.agent.name}
											</span>
											<span className="truncate text-muted-foreground text-xs">
												{BUILDING_NAMES[building.kind]} ·{" "}
												{plural(building.threads.length, "conversation")}
											</span>
										</span>
										{act ? null : <BuildingState building={building} />}
									</button>
									{act && actLayer ? (
										<div className="px-2 ps-12 pb-2">
											<ActStatus
												act={act}
												clock={actLayer.clock}
												nowMs={actLayer.nowMs}
												onAsk={(askId, opener) => actLayer.onAsk(askId, opener)}
												onBlocker={actLayer.onBlocker}
												snapshot={actLayer.snapshot}
											/>
										</div>
									) : null}
								</li>
							);
						})}
						{district.buildings.length === 0 ? (
							<li className="px-2 py-2 text-muted-foreground text-sm">
								No agents live here yet.
							</li>
						) : null}
					</ul>
				</section>
			))}
		</div>
	);
}

/** One short state for a building, most urgent first. */
export function BuildingState({ building }: { building: TownBuilding }) {
	if (building.alert) {
		return (
			<span className="shrink-0 font-medium text-destructive text-xs">
				Run failed
			</span>
		);
	}
	if (building.replied) {
		return (
			<span className="shrink-0 font-medium text-primary text-xs">
				Reply waiting
			</span>
		);
	}
	if (building.working) {
		return (
			<span className="shrink-0 font-medium text-success text-xs">
				Under construction
			</span>
		);
	}
	return <span className="shrink-0 text-muted-foreground text-xs">Quiet</span>;
}
