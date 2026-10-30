import type {
	InterfacePort,
	World2dParams,
	WorldDirection,
	WorldEntity,
	WorldPoint,
} from "@ryuhq/protocol/interfaces";
import {
	type CSSProperties,
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { PIXEL_FONT_STACK } from "./world-2d-font.ts";
import {
	FALLBACK_VIEWPORT,
	type ViewportSize,
} from "./world-2d-interface-camera.ts";
import { hintOpensByDefault } from "./world-2d-model.ts";
import { svCssVariables } from "./world-2d-palette.ts";

/** Narrowest the controls hint gets in the top-left corner (CSS px). */
export const HINT_MIN_WIDTH = 250;
/** Room the clock box takes in the top-right corner, with gaps (CSS px). */
export const CLOCK_ROOM = 264;
/** The HUD's inset from the stage edges (CSS px). */
export const HUD_INSET = 12;

/** How long the controls hint shows after the world opens. */
const HINT_MS = 6000;

/**
 * The controls hint: on a roomy stage it shows until the player first moves
 * (or for a few seconds); on a narrow one it starts closed, so it never
 * covers the player. Either way "?" or the "?" slot toggles it.
 */
export function useControlsHint(
	player: WorldPoint,
	stageWidth: number,
	/** The "Controls hint" setting: `auto` follows the stage, as above. */
	setting: "auto" | "hidden" | "shown" = "auto",
	/** Keeps the "?" choice as the setting (`InterfacePort.updateSettings`). */
	persist?: (value: "hidden" | "shown") => void
): {
	open: boolean;
	toggle: () => void;
} {
	// null until the player (or the timer) decides: follow the setting, or
	// on `auto` the stage width.
	const [chosen, setChosen] = useState<boolean | null>(null);
	const fixed = setting === "auto" ? null : setting === "shown";
	const open = chosen ?? fixed ?? hintOpensByDefault(stageWidth);
	const start = useRef(player);
	const moved = useRef(false);
	// A setting changed in Settings (or by "?" below) decides afresh.
	useEffect(() => {
		setChosen(null);
	}, [setting]);
	useEffect(() => {
		if (setting !== "auto") {
			return;
		}
		const id = setTimeout(() => setChosen((value) => value ?? false), HINT_MS);
		return () => clearTimeout(id);
	}, [setting]);
	useEffect(() => {
		if (moved.current || setting !== "auto") {
			return;
		}
		if (player.x !== start.current.x || player.y !== start.current.y) {
			moved.current = true;
			setChosen((value) => value ?? false);
		}
	}, [player, setting]);
	const toggle = useCallback(() => {
		moved.current = true;
		setChosen(!open);
		persist?.(open ? "hidden" : "shown");
	}, [open, persist]);
	return { open, toggle };
}

/** Whether the app's theme is dark (the `.dark` class on the document). */
export function useDarkTheme(): boolean {
	const [dark, setDark] = useState(false);
	useEffect(() => {
		const root = document.documentElement;
		const update = () => setDark(root.classList.contains("dark"));
		update();
		if (typeof MutationObserver === "undefined") {
			return;
		}
		const observer = new MutationObserver(update);
		observer.observe(root, { attributeFilter: ["class"], attributes: true });
		return () => observer.disconnect();
	}, []);
	return dark;
}

/**
 * The port as the village uses it: leaving a conversation only closes a
 * thread when one is actually open (visiting a villager from the road with
 * nothing open must not tell the host to close anything).
 */
export function useVillagePort(
	port: InterfacePort,
	threadOpen: boolean
): InterfacePort {
	return useMemo(
		() => ({
			closeThread: () => {
				if (threadOpen) {
					port.closeThread();
				}
			},
			openThread: port.openThread,
			startThread: port.startThread,
		}),
		[port, threadOpen]
	);
}

/** The HUD's colors and its pixel face, set once on the world's root. */
export const SV_VARIABLES: CSSProperties = {
	...svCssVariables(),
	"--sv-font": PIXEL_FONT_STACK,
} as CSSProperties;

/**
 * The hotbar's page: turned with the arrows or [ ], and moved to whichever
 * villager the player is talking to or standing by.
 */
export function useHotbarPage(
	agentIds: readonly string[],
	pageSize: number,
	activeId: string | null
): { page: number; pageCount: number; turn: (delta: -1 | 1) => void } {
	const pageCount = Math.max(1, Math.ceil(agentIds.length / pageSize));
	const [page, setPage] = useState(0);
	const activeIndex = activeId ? agentIds.indexOf(activeId) : -1;
	useEffect(() => {
		if (activeIndex >= 0) {
			setPage(Math.floor(activeIndex / pageSize));
		}
	}, [activeIndex, pageSize]);
	const turn = useCallback(
		(delta: -1 | 1) =>
			setPage((current) =>
				Math.min(pageCount - 1, Math.max(0, current + delta))
			),
		[pageCount]
	);
	return { page: Math.min(page, pageCount - 1), pageCount, turn };
}

/** Tracks the rendered size of the world viewport. */
export function useViewportSize(): {
	/** False until the stage's size is known (the fallback size is shown). */
	measured: boolean;
	ref: RefObject<HTMLDivElement | null>;
	size: ViewportSize;
} {
	const ref = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState<ViewportSize | null>(null);
	useEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const update = () => {
			const { height, width } = element.getBoundingClientRect();
			setSize((previous) =>
				previous?.height === height && previous.width === width
					? previous
					: { height, width }
			);
		};
		update();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return { measured: size !== null, ref, size: size ?? FALLBACK_VIEWPORT };
}

/** The largest size seen so far (per axis), stable between growths. */
export function useLargestSize(size: ViewportSize): ViewportSize {
	const largest = useRef(size);
	const { height, width } = largest.current;
	if (size.height > height || size.width > width) {
		largest.current = {
			height: Math.max(height, size.height),
			width: Math.max(width, size.width),
		};
	}
	return largest.current;
}

/**
 * When a thread is opened from outside the world (or was open as it
 * mounted), walk the player up to that thread's agent so the open panel and
 * the player's position agree. Runs once per newly opened agent.
 */
export function useMeetActiveThreadAgent(
	snapshot: InterfaceRendererProps<World2dParams>["snapshot"],
	activeThreadId: string | null,
	world: { meet: (agentId: string) => void; talkingTo: string | null }
): void {
	const agentId = activeThreadId
		? (snapshot.threads.find((thread) => thread.id === activeThreadId)
				?.agentIds[0] ?? null)
		: null;
	const met = useRef<string | null>(null);
	const { meet, talkingTo } = world;
	useEffect(() => {
		if (!agentId) {
			met.current = null;
			return;
		}
		if (met.current === agentId) {
			return;
		}
		met.current = agentId;
		if (talkingTo !== agentId) {
			meet(agentId);
		}
	}, [agentId, meet, talkingTo]);
}

/** Villagers face the player when they are close, otherwise the street. */
export function facingToward(
	entity: WorldEntity,
	player: WorldPoint,
	near: boolean
): WorldDirection {
	if (!near) {
		return "down";
	}
	const dx = player.x - entity.x;
	const dy = player.y - entity.y;
	if (Math.abs(dx) > Math.abs(dy)) {
		return dx > 0 ? "right" : "left";
	}
	return dy < 0 ? "up" : "down";
}
