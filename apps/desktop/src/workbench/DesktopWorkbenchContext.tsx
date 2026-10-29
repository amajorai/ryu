import type {
	WorkbenchItem,
	WorkbenchRegion,
	WorkbenchState,
} from "@ryu/workbench/model";
import type { WorkbenchIds } from "@ryu/workbench/persistence";
import { reduceWorkbench, type WorkbenchAction } from "@ryu/workbench/reducer";
import type { ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useReducer,
	useRef,
} from "react";
import { sealedLocalStorage } from "@/src/lib/content-seal.ts";
import {
	createDesktopWorkbenchWriter,
	readDesktopWorkbenchStartup,
} from "./desktop-workbench-persistence.ts";

interface OpenItemTarget {
	groupId?: string;
	region?: WorkbenchRegion;
}

interface MoveItemTarget extends OpenItemTarget {
	activate?: boolean;
	index?: number;
}

export interface DesktopWorkbenchValue {
	dispatch: (action: WorkbenchAction) => void;
	/**
	 * The state including actions dispatched since the last render, so several
	 * actions in one handler each see the previous one's result.
	 */
	getState: () => WorkbenchState;
	moveItem: (itemId: string, target: MoveItemTarget) => void;
	openItem: (item: WorkbenchItem, target?: OpenItemTarget) => string;
	state: WorkbenchState;
}

/** Provider-private actions whose target group is resolved against the state
    the reducer receives, never against a render closure. That keeps `openItem`
    and `moveItem` stable across Workbench changes while they still act on the
    latest layout, including a focus change dispatched earlier in the same
    handler. They never leave this provider and are not persisted. */
type DesktopWorkbenchAction =
	| WorkbenchAction
	| { type: "desktop/open-item"; item: WorkbenchItem; target?: OpenItemTarget }
	| { type: "desktop/move-item"; itemId: string; target: MoveItemTarget };

interface DesktopWorkbenchProviderProps {
	children: ReactNode;
	folder?: string | null;
	makeId?: (prefix: string) => string;
	persistenceDelayMs?: number;
	sidebarOpen?: boolean;
	storage?: Storage;
}

const DesktopWorkbenchContext = createContext<DesktopWorkbenchValue | null>(
	null
);

function defaultMakeId(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

function defaultStorage(): Storage {
	try {
		// The layout names open conversations and project paths: it is sealed at
		// rest through the desktop's sealed localStorage facade.
		return sealedLocalStorage;
	} catch {
		return {
			length: 0,
			clear: () => undefined,
			getItem: () => null,
			key: () => null,
			removeItem: () => undefined,
			setItem: () => undefined,
		};
	}
}

function createWorkbenchIds(makeId: (prefix: string) => string): WorkbenchIds {
	return {
		bottomGroupId: makeId("workbench-bottom"),
		centerGroupId: makeId("workbench-center"),
		leftGroupId: makeId("workbench-left"),
		navigationId: makeId("workbench-navigation"),
		rightGroupId: makeId("workbench-right"),
		makeItemId: () => makeId("workbench-item"),
	};
}

function targetGroupId(
	state: WorkbenchState,
	groupId: string | undefined,
	region: WorkbenchRegion
): string | undefined {
	if (groupId && state.groups.some((group) => group.id === groupId)) {
		return groupId;
	}
	if (region !== "center") {
		return state.groups.find((group) => group.region === region)?.id;
	}
	const focusedGroup = state.groups.find(
		(group) => group.id === state.focusedGroupId
	);
	if (focusedGroup?.region === "center" && !focusedGroup.locked) {
		return focusedGroup.id;
	}
	return state.groups.find(
		(group) => group.region === "center" && !group.locked
	)?.id;
}

function reduceDesktopWorkbench(
	state: WorkbenchState,
	action: DesktopWorkbenchAction
): WorkbenchState {
	if (action.type === "desktop/open-item") {
		const groupId = targetGroupId(
			state,
			action.target?.groupId,
			action.target?.region ?? action.item.preferredRegion
		);
		return groupId
			? reduceWorkbench(state, {
					type: "item/open",
					groupId,
					item: action.item,
				})
			: state;
	}
	if (action.type === "desktop/move-item") {
		const item = state.items.find(
			(candidate) => candidate.id === action.itemId
		);
		const groupId =
			item &&
			targetGroupId(
				state,
				action.target.groupId,
				action.target.region ?? item.preferredRegion
			);
		return groupId
			? reduceWorkbench(state, {
					type: "item/move",
					activate: action.target.activate,
					itemId: action.itemId,
					toGroupId: groupId,
					index: action.target.index,
				})
			: state;
	}
	return reduceWorkbench(state, action);
}

export function DesktopWorkbenchProvider({
	children,
	folder,
	makeId = defaultMakeId,
	persistenceDelayMs = 150,
	sidebarOpen,
	storage = defaultStorage(),
}: DesktopWorkbenchProviderProps) {
	const startupRef = useRef<
		ReturnType<typeof readDesktopWorkbenchStartup> | undefined
	>(undefined);
	if (!startupRef.current) {
		startupRef.current = readDesktopWorkbenchStartup({
			folder,
			ids: createWorkbenchIds(makeId),
			sidebarOpen,
			storage,
		});
	}
	const [state, dispatchToReact] = useReducer(
		reduceDesktopWorkbench,
		startupRef.current.state
	);
	// Mirrors the reducer so getState() reflects dispatches React has not
	// rendered yet. Each render re-syncs it to React's state, which already
	// includes every action dispatched before it.
	const latestRef = useRef(state);
	const renderedRef = useRef(state);
	if (renderedRef.current !== state) {
		renderedRef.current = state;
		latestRef.current = state;
	}
	// The one dispatch every action goes through, including the private
	// open/move actions, so the mirror above never misses one.
	const dispatch = useCallback((action: DesktopWorkbenchAction) => {
		latestRef.current = reduceDesktopWorkbench(latestRef.current, action);
		dispatchToReact(action);
	}, []);
	const getState = useCallback(() => latestRef.current, []);
	const writerRef = useRef<
		ReturnType<typeof createDesktopWorkbenchWriter> | undefined
	>(undefined);
	if (!writerRef.current) {
		writerRef.current = createDesktopWorkbenchWriter(
			storage,
			persistenceDelayMs,
			startupRef.current.state
		);
	}
	useEffect(() => {
		writerRef.current?.schedule(state);
	}, [state]);

	useEffect(() => {
		const flush = () => writerRef.current?.flush();
		window.addEventListener("pagehide", flush);
		return () => {
			window.removeEventListener("pagehide", flush);
			flush();
		};
	}, []);

	// Both actions depend only on the stable dispatch, so consumers that hold
	// them (TabsProvider's `openTab`) keep one identity across every Workbench
	// change; the target group is resolved at reduce time.
	const openItem = useCallback(
		(item: WorkbenchItem, target?: OpenItemTarget): string => {
			dispatch({ type: "desktop/open-item", item, target });
			return item.id;
		},
		[dispatch]
	);

	const moveItem = useCallback(
		(itemId: string, target: MoveItemTarget) => {
			dispatch({ type: "desktop/move-item", itemId, target });
		},
		[dispatch]
	);

	const value = useMemo<DesktopWorkbenchValue>(
		() => ({ dispatch, getState, moveItem, openItem, state }),
		[dispatch, getState, moveItem, openItem, state]
	);

	return (
		<DesktopWorkbenchContext.Provider value={value}>
			{children}
		</DesktopWorkbenchContext.Provider>
	);
}

export function useDesktopWorkbench(): DesktopWorkbenchValue {
	const value = useContext(DesktopWorkbenchContext);
	if (!value) {
		throw new Error(
			"useDesktopWorkbench must be used inside DesktopWorkbenchProvider"
		);
	}
	return value;
}

export function useWorkbenchItem(id: string): WorkbenchItem | undefined {
	return useDesktopWorkbench().state.items.find((item) => item.id === id);
}

export function useOptionalDesktopWorkbench(): DesktopWorkbenchValue | null {
	return useContext(DesktopWorkbenchContext);
}
