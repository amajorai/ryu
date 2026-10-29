import {
	type InterfaceAgent,
	type InterfacePort,
	type InterfaceSnapshot,
	type InterfaceThread,
	isWorldTileFree,
	nearestWorldEntity,
	stepWorldPlayer,
	type WorldDirection,
	type WorldEntity,
	type WorldLayout,
	type WorldPoint,
} from "@ryuhq/protocol/interfaces";
import {
	type KeyboardEvent,
	type RefObject,
	useCallback,
	useMemo,
	useRef,
	useState,
} from "react";

const KEY_DIRECTIONS: Record<string, WorldDirection> = {
	ArrowDown: "down",
	ArrowLeft: "left",
	ArrowRight: "right",
	ArrowUp: "up",
	a: "left",
	d: "right",
	s: "down",
	w: "up",
};

const NO_OBSTACLES: ReadonlySet<string> = new Set();

const TALK_KEYS = new Set(["e", "Enter", " "]);
const ACTIVATION_KEYS = new Set(["Enter", " "]);

/** Letters match regardless of Shift or Caps Lock; named keys stay as-is. */
function normalizedKey(key: string): string {
	return key.length === 1 ? key.toLowerCase() : key;
}

/**
 * Keys from inside the map (an agent label the user clicked, say) still drive
 * the world, except where the focused element needs them itself: text fields,
 * and Enter/Space on a button or link, which activate it natively.
 */
function ownsKey(target: EventTarget, key: string): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	if (
		target.isContentEditable ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement
	) {
		return true;
	}
	return (
		ACTIVATION_KEYS.has(key) &&
		(target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement)
	);
}

export interface WorldController {
	facing: WorldDirection;
	/** Attach to the focusable world surface; talking and walking away refocus it. */
	mapRef: RefObject<HTMLDivElement | null>;
	/**
	 * Walk up to an agent whose conversation is already open (a thread opened
	 * elsewhere) and face it, without closing that thread.
	 */
	meet: (agentId: string) => void;
	/** The agent the player could talk to right now. */
	nearby: WorldEntity | null;
	onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
	player: WorldPoint;
	talkingTo: string | null;
	talkTo: (agentId: string) => void;
	walkAway: () => void;
}

/**
 * Shared player state for the 2D and 3D worlds: arrow keys or WASD walk,
 * E / Enter / Space talks to the adjacent agent, Escape walks away.
 */
export function useWorldController(
	layout: WorldLayout,
	port: InterfacePort,
	/** Renderer scenery that also blocks walking (houses, trees), as `x,y` keys. */
	obstacles: ReadonlySet<string> = NO_OBSTACLES
): WorldController {
	const [storedPlayer, setPlayer] = useState<WorldPoint>(layout.spawn);
	const [facing, setFacing] = useState<WorldDirection>("up");
	const [talkingTo, setTalkingTo] = useState<string | null>(null);
	const mapRef = useRef<HTMLDivElement>(null);
	// The layout grows and shrinks as agents come and go; never leave the
	// player standing inside an agent or outside the world.
	const walkable = useCallback(
		(point: WorldPoint) =>
			isWorldTileFree(layout, point) && !obstacles.has(`${point.x},${point.y}`),
		[layout, obstacles]
	);
	const player = walkable(storedPlayer) ? storedPlayer : layout.spawn;
	const nearby = nearestWorldEntity(layout, player, 1);

	const focusMap = useCallback(() => {
		mapRef.current?.focus({ preventScroll: true });
	}, []);

	// Switching to another agent leaves the open thread first; otherwise the
	// panel would show the new agent's name over the previous conversation.
	const startTalking = useCallback(
		(agentId: string) => {
			if (agentId !== talkingTo) {
				port.closeThread();
			}
			setTalkingTo(agentId);
		},
		[port, talkingTo]
	);

	/** Steps in front of the agent; false when it is not in the world. */
	const approach = useCallback(
		(agentId: string) => {
			const entity = layout.entities.find((item) => item.agentId === agentId);
			if (!entity) {
				return false;
			}
			const front = { x: entity.x, y: entity.y + 1 };
			if (walkable(front)) {
				setPlayer(front);
				setFacing("up");
			}
			return true;
		},
		[layout, walkable]
	);

	const meet = useCallback(
		(agentId: string) => {
			if (approach(agentId)) {
				setTalkingTo(agentId);
			}
		},
		[approach]
	);

	const talkTo = useCallback(
		(agentId: string) => {
			if (!approach(agentId)) {
				return;
			}
			startTalking(agentId);
			// A clicked agent label takes focus in Chromium webviews; keep the
			// world as the focus owner so walking keeps working.
			focusMap();
		},
		[approach, focusMap, startTalking]
	);

	const walkAway = useCallback(() => {
		setTalkingTo(null);
		port.closeThread();
		// The panel (and its focused close button) unmounts; return focus here.
		focusMap();
	}, [focusMap, port]);

	const onKeyDown = useCallback(
		(event: KeyboardEvent<HTMLElement>) => {
			if (event.metaKey || event.ctrlKey || event.altKey) {
				return;
			}
			const key = normalizedKey(event.key);
			if (event.target !== event.currentTarget && ownsKey(event.target, key)) {
				return;
			}
			const direction = KEY_DIRECTIONS[key];
			if (direction) {
				event.preventDefault();
				setFacing(direction);
				const next = stepWorldPlayer(layout, player, direction);
				setPlayer(walkable(next) ? next : player);
				return;
			}
			if (TALK_KEYS.has(key) && nearby) {
				event.preventDefault();
				startTalking(nearby.agentId);
				return;
			}
			if (key === "Escape" && talkingTo) {
				event.preventDefault();
				walkAway();
			}
		},
		[layout, nearby, player, startTalking, talkingTo, walkAway, walkable]
	);

	return {
		facing,
		mapRef,
		meet,
		nearby,
		onKeyDown,
		player,
		talkingTo,
		talkTo,
		walkAway,
	};
}

/**
 * The agent whose panel is open: the one the player is talking to, or, when
 * a thread was already open as the world mounted, that thread's agent.
 */
export function useTalkingAgent(
	snapshot: InterfaceSnapshot,
	talkingTo: string | null,
	activeThreadId: string | null
): {
	talkingAgent: InterfaceAgent | undefined;
	talkingThreads: InterfaceThread[];
} {
	return useMemo(() => {
		const activeAgentId = activeThreadId
			? snapshot.threads.find((thread) => thread.id === activeThreadId)
					?.agentIds[0]
			: undefined;
		const agentId = talkingTo ?? activeAgentId;
		const talkingAgent = agentId
			? snapshot.agents.find((agent) => agent.id === agentId)
			: undefined;
		const talkingThreads = talkingAgent
			? snapshot.threads
					.filter((thread) => thread.agentIds.includes(talkingAgent.id))
					.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
			: [];
		return { talkingAgent, talkingThreads };
	}, [activeThreadId, snapshot, talkingTo]);
}
