import type {
	InterfacePort,
	InterfaceSettingValue,
} from "@ryuhq/protocol/interfaces";
import {
	type Dispatch,
	type KeyboardEvent,
	type PointerEvent,
	type RefObject,
	type SetStateAction,
	useRef,
} from "react";
import { DRAG_SLOP, isTextField } from "./knowledge-interface-layout.ts";
import {
	cycleNode,
	DEFAULT_SETTINGS,
	displayLabel,
	KIND_LABELS,
	type KnowledgeNode,
	type KnowledgeSettings,
	type Layout,
	nodeId,
	plural,
} from "./knowledge-model.ts";
import {
	type CameraApi,
	type Projection,
	pickNode,
} from "./knowledge-stage.ts";

type SetState<T> = Dispatch<SetStateAction<T>>;

/**
 * What the knowledge graph does on input: selecting nodes and threads, the
 * settings card's saves, Escape stepping back, the graph region's keys and
 * pointer picks.
 */
export function useKnowledgeInteractions({
	cameraApi,
	cursor,
	focusHeading,
	fromParams,
	hovered,
	layout,
	nodesById,
	openControls,
	ordered,
	originId,
	port,
	projection,
	query,
	searchRef,
	selected,
	selectedNode,
	setAnnouncement,
	setCursor,
	setHovered,
	setOriginId,
	setQuery,
	setSelectedId,
	setSettings,
	stageRef,
	threadOpen,
}: {
	cameraApi: { readonly current: CameraApi | null };
	cursor: string | null;
	focusHeading: { current: boolean };
	fromParams: KnowledgeSettings;
	hovered: string | null;
	layout: Layout;
	nodesById: ReadonlyMap<string, KnowledgeNode>;
	openControls: () => void;
	ordered: KnowledgeNode[];
	originId: string | null;
	port: InterfacePort;
	projection: Projection;
	query: string;
	searchRef: RefObject<HTMLInputElement | null>;
	selected: string | null;
	selectedNode: KnowledgeNode | undefined;
	setAnnouncement: SetState<string>;
	setCursor: SetState<string | null>;
	setHovered: SetState<string | null>;
	setOriginId: SetState<string | null>;
	setQuery: SetState<string>;
	setSelectedId: SetState<string | null>;
	setSettings: SetState<KnowledgeSettings>;
	stageRef: RefObject<HTMLDivElement | null>;
	threadOpen: boolean;
}) {
	const pointer = useRef<{ x: number; y: number } | null>(null);

	const select = (id: string, options: { focus?: boolean } = {}) => {
		const node = nodesById.get(id);
		if (!node) {
			return;
		}
		focusHeading.current = options.focus ?? true;
		if (node.kind === "conversation") {
			if (selectedNode && selectedNode.kind !== "conversation") {
				setOriginId(selectedNode.id);
			} else if (!threadOpen) {
				setOriginId(null);
			}
			setSelectedId(id);
			port.openThread(node.refId);
			setAnnouncement(`Opened ${node.label}`);
			return;
		}
		if (threadOpen) {
			port.closeThread();
		}
		setSelectedId(id);
		setAnnouncement(`${KIND_LABELS[node.kind]} ${displayLabel(node)} selected`);
	};
	const openThread = (threadId: string) => {
		select(nodeId.conversation(threadId));
	};
	const close = () => {
		if (threadOpen) {
			port.closeThread();
		}
		setSelectedId(null);
		setOriginId(null);
		setAnnouncement("Selection cleared");
	};
	const back = () => {
		port.closeThread();
		focusHeading.current = originId !== null;
		setSelectedId(originId);
		setOriginId(null);
	};
	const newThread = (node: KnowledgeNode) => {
		if (node.kind === "agent") {
			port.startThread({ agentId: node.refId });
		} else if (node.kind === "project") {
			port.startThread({ projectId: node.refId });
		} else if (node.kind === "team") {
			port.startThread({ teamId: node.refId });
		} else {
			port.startThread({});
		}
	};
	const saveSettings = (next: Partial<KnowledgeSettings>) => {
		setSettings((previous) => ({ ...previous, ...next }));
		port.updateSettings?.(next as Record<string, InterfaceSettingValue>);
	};
	// Restore defaults: forget the user's settings so the interface's own
	// defaults and params apply (they arrive as new params). Without the
	// port's reset, save the renderer's defaults instead.
	const restoreSettings = () => {
		if (port.resetSettings) {
			port.resetSettings();
			setSettings(fromParams);
			return;
		}
		saveSettings(DEFAULT_SETTINGS);
	};

	/** Escape steps out: thread → its origin, selection → none, search → empty. */
	const stepBack = (): boolean => {
		if (threadOpen) {
			back();
			return true;
		}
		if (selected) {
			close();
			return true;
		}
		if (query) {
			setQuery("");
			return true;
		}
		return false;
	};
	const stepBackRef = useRef(stepBack);
	stepBackRef.current = stepBack;
	const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key !== "Escape" ||
			event.defaultPrevented ||
			isTextField(event.target) ||
			(event.target instanceof HTMLElement &&
				event.target.closest("[data-knowledge-thread]") !== null)
		) {
			return;
		}
		if (stepBackRef.current()) {
			event.preventDefault();
		}
	};

	/** The graph region's keys: arrows walk nodes, Enter opens, +/- zoom. */
	const onSceneKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.target !== event.currentTarget) {
			return;
		}
		const key = event.key;
		if (
			key === "ArrowRight" ||
			key === "ArrowDown" ||
			key === "ArrowLeft" ||
			key === "ArrowUp"
		) {
			event.preventDefault();
			const next = cycleNode(
				ordered,
				cursor ?? selected,
				key === "ArrowRight" || key === "ArrowDown" ? 1 : -1
			);
			setCursor(next);
			setHovered(null);
			const node = next ? nodesById.get(next) : undefined;
			if (node) {
				cameraApi.current?.reveal(node.id);
				setAnnouncement(
					`${displayLabel(node)}, ${KIND_LABELS[node.kind].toLowerCase()}, ${plural(node.degree, "link")}`
				);
			}
		} else if (key === "Enter" || key === " ") {
			event.preventDefault();
			const target = cursor ?? ordered[0]?.id;
			if (target) {
				select(target, { focus: false });
			}
		} else if (key === "+" || key === "=") {
			event.preventDefault();
			cameraApi.current?.zoom(0.74);
		} else if (key === "-" || key === "_") {
			event.preventDefault();
			cameraApi.current?.zoom(1.35);
		} else if (key === "0") {
			event.preventDefault();
			cameraApi.current?.reset();
		} else if (key === "/") {
			event.preventDefault();
			if (searchRef.current) {
				searchRef.current.focus();
				return;
			}
			openControls();
			requestAnimationFrame(() => searchRef.current?.focus());
		}
	};

	const pick = (event: PointerEvent<HTMLDivElement>) => {
		const stage = stageRef.current;
		if (!stage) {
			return null;
		}
		const rect = stage.getBoundingClientRect();
		return pickNode(
			layout,
			projection,
			event.clientX - rect.left,
			event.clientY - rect.top
		);
	};
	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		if (event.buttons !== 0) {
			return;
		}
		const id = pick(event);
		if (id !== hovered) {
			setHovered(id);
		}
	};
	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		pointer.current = { x: event.clientX, y: event.clientY };
		setCursor(null);
	};
	const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
		const start = pointer.current;
		pointer.current = null;
		if (
			!start ||
			event.button !== 0 ||
			Math.hypot(event.clientX - start.x, event.clientY - start.y) > DRAG_SLOP
		) {
			return;
		}
		const id = pick(event);
		if (id) {
			select(id, { focus: false });
		}
	};

	return {
		back,
		close,
		newThread,
		onPointerDown,
		onPointerMove,
		onPointerUp,
		onRootKeyDown,
		onSceneKeyDown,
		openThread,
		restoreSettings,
		saveSettings,
		select,
	};
}
