import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import {
	askAriaLabel,
	compareAsks,
	type InterfaceParamsByRenderer,
	type InterfacePort,
	type WorldLayout,
} from "@ryuhq/protocol/interfaces";
import { type KeyboardEvent, useCallback, useMemo, useState } from "react";
import type { useActCards } from "./interface-ask-card.tsx";
import type { useActs } from "./use-acts.ts";
import type { useWorldController } from "./use-world-controller.ts";
import { hotbarLayout } from "./world-2d-hud.tsx";
import {
	useControlsHint,
	useHotbarPage,
	type useViewportSize,
} from "./world-2d-interface-hooks.ts";
import { ASK_KEYS, DIGIT_KEYS, ownsAskKey } from "./world-2d-interface-keys.ts";
import type { VillagerStatus } from "./world-2d-model.ts";

type ActsView = ReturnType<typeof useActs>;

/**
 * The village's hotbar, map and controls hint, and the keys that drive
 * them: digits visit, [ ] page, M opens the map, ? the hint.
 */
export function useWorld2dHotbar({
	acts,
	cards,
	hostPort,
	layout,
	nearbyId,
	nowMs,
	privacy,
	settings,
	statuses,
	talkingId,
	viewport,
	withActs,
	world,
}: {
	acts: ActsView["acts"];
	cards: ReturnType<typeof useActCards>;
	hostPort: InterfacePort;
	layout: WorldLayout;
	nearbyId: string | null;
	nowMs: number;
	privacy: ActsView["privacy"];
	settings: Required<InterfaceParamsByRenderer["world-2d"]>;
	statuses: ReadonlyMap<string, VillagerStatus>;
	talkingId: string | null;
	viewport: ReturnType<typeof useViewportSize>;
	withActs: boolean;
	world: ReturnType<typeof useWorldController>;
}) {
	const tl: LiteralMessage = useLiteralMessages();
	const [mapOpen, setMapOpen] = useState(false);
	const toggleMap = useCallback(() => setMapOpen((open) => !open), []);
	const persistControls = useCallback(
		(value: "hidden" | "shown") =>
			hostPort.updateSettings?.({ controls: value }),
		[hostPort]
	);
	const hint = useControlsHint(
		world.player,
		viewport.size.width,
		settings.controls,
		persistControls
	);
	const toggleHint = hint.toggle;
	// With acts the hotbar leads with the askers, in the queue's order: an
	// asker's slot says its ask and answers it; the rest say their act.
	const allHotbarAgents = useMemo(() => {
		const slots = layout.entities.map((entity, index) => {
			const act = withActs ? acts.get(entity.agentId) : undefined;
			const ask = act?.act === "asking" ? act.ask : null;
			let actLabel: string | undefined;
			if (ask) {
				actLabel = tl("{label} Answer their ask.", {
					label: askAriaLabel(ask, entity.name, nowMs, privacy),
				});
			} else if (act) {
				actLabel = `${act.ariaLabel} Visit ${entity.name}.`;
			}
			return {
				ask,
				slot: {
					actLabel,
					agentId: entity.agentId,
					index,
					name: entity.name,
					status: statuses.get(entity.agentId) ?? "idle",
				},
			};
		});
		if (!withActs) {
			return slots.map((item) => item.slot);
		}
		return [
			...slots
				.filter((item) => item.ask)
				.sort((a, b) => (a.ask && b.ask ? compareAsks(a.ask, b.ask) : 0)),
			...slots.filter((item) => !item.ask),
		].map((item) => item.slot);
	}, [acts, layout, nowMs, privacy, statuses, tl, withActs]);
	// The hotbar's order (askers first with acts) pages the slots.
	const agentIds = useMemo(
		() => allHotbarAgents.map((agent) => agent.agentId),
		[allHotbarAgents]
	);
	const bar = hotbarLayout(viewport.size.width, agentIds.length);
	const pageSize = bar.pageSize;
	const hotbar = useHotbarPage(agentIds, pageSize, talkingId ?? nearbyId);
	const turnPage = hotbar.turn;
	const hotbarAgents = useMemo(
		() =>
			allHotbarAgents.slice(
				hotbar.page * pageSize,
				hotbar.page * pageSize + pageSize
			),
		[allHotbarAgents, hotbar.page, pageSize]
	);
	const { onKeyDown: worldKeyDown, talkTo: visit } = world;
	// With acts an asker is answered, not visited: its ask opens instead.
	const askerAsk = useCallback(
		(agentId: string) => {
			const act = withActs ? acts.get(agentId) : undefined;
			return act?.act === "asking" ? act.ask : null;
		},
		[acts, withActs]
	);
	const openAskCard = cards.openAsk;
	const talkTo = useCallback(
		(agentId: string) => {
			const ask = askerAsk(agentId);
			if (ask) {
				openAskCard(ask.id);
				return;
			}
			visit(agentId);
		},
		[askerAsk, openAskCard, visit]
	);
	const nearbyAsk = world.nearby ? askerAsk(world.nearby.agentId) : null;
	const controllerKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			// The controller's talk keys, past its own guards: a key a field
			// or button inside the world owns stays theirs.
			if (
				nearbyAsk &&
				!(event.metaKey || event.ctrlKey || event.altKey) &&
				ASK_KEYS.has(event.key.toLowerCase()) &&
				!ownsAskKey(event.target, event.currentTarget, event.key)
			) {
				event.preventDefault();
				openAskCard(nearbyAsk.id);
				return;
			}
			worldKeyDown(event);
		},
		[nearbyAsk, openAskCard, worldKeyDown]
	);
	const visitFromMap = useCallback(
		(agentId: string) => {
			setMapOpen(false);
			talkTo(agentId);
		},
		[talkTo]
	);
	const onKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			const target = event.target as HTMLElement;
			const typing =
				target.isContentEditable ||
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement;
			if (!(typing || event.metaKey || event.ctrlKey || event.altKey)) {
				const key = event.key.toLowerCase();
				if (key === "m" || (key === "escape" && mapOpen)) {
					event.preventDefault();
					toggleMap();
					return;
				}
				if (key === "?") {
					event.preventDefault();
					toggleHint();
					return;
				}
				if (key === "[" || key === "]") {
					event.preventDefault();
					turnPage(key === "[" ? -1 : 1);
					return;
				}
				const slot = DIGIT_KEYS.indexOf(key);
				const agent = slot >= 0 ? hotbarAgents[slot] : undefined;
				if (agent) {
					event.preventDefault();
					talkTo(agent.agentId);
					return;
				}
			}
			controllerKeyDown(event);
		},
		[
			controllerKeyDown,
			hotbarAgents,
			mapOpen,
			talkTo,
			toggleHint,
			toggleMap,
			turnPage,
		]
	);
	return {
		askerAsk,
		bar,
		hint,
		hotbar,
		hotbarAgents,
		mapOpen,
		nearbyAsk,
		onKeyDown,
		pageSize,
		talkTo,
		toggleHint,
		toggleMap,
		turnPage,
		visitFromMap,
	};
}
