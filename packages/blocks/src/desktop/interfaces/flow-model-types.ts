import type {
	InterfaceAgent,
	InterfaceGroup,
	InterfaceThread,
	ThreadStatus,
} from "@ryuhq/protocol/interfaces";

/** World-space geometry, in CSS pixels at zoom 1. */
export const FLOW_GEOMETRY = {
	busX: 100,
	chipSize: 24,
	composerW: 280,
	convBusX: 388,
	convW: 280,
	convX: 416,
	corner: 8,
	leadW: 176,
	leadX: 132,
	moreH: 28,
	moreW: 104,
	nodeH: 40,
	originR: 20,
	row: 56,
	stubSize: 20,
} as const;

/** Conversations shown per lead before a "N more" node takes the last slot. */
export const FLOW_VISIBLE_PER_LEAD = 3;

/** The dot a node carries on its right edge. */
export type FlowDotTone = ThreadStatus | "idle" | "success";

/** Where a new conversation is filed and where its pending node sits. */
export interface FlowTarget {
	agentId?: string;
	/** The flow group the pending node joins (`agent:<id>`, `team:<id>`, `root`). */
	groupKey: string;
	/** Placeholder for the pending node ("Message Atlas"). */
	label: string;
	projectId?: string;
	teamId?: string;
}

interface FlowNodeBase {
	column: 0 | 1 | 2;
	h: number;
	id: string;
	/** The node this one hangs off (keyboard Left), or null for the origin. */
	parentId: string | null;
	w: number;
	/** Left edge. */
	x: number;
	/** Vertical center. */
	y: number;
}

export type FlowNode =
	| (FlowNodeBase & { kind: "origin" })
	| (FlowNodeBase & {
			agent: InterfaceAgent;
			conversations: number;
			kind: "agent";
			tone: FlowDotTone;
	  })
	| (FlowNodeBase & {
			conversations: number;
			group: InterfaceGroup;
			kind: "team";
			tone: FlowDotTone;
	  })
	| (FlowNodeBase & {
			conversations: number;
			kind: "lane";
			label: string;
	  })
	| (FlowNodeBase & {
			kind: "thread";
			status: ThreadStatus;
			thread: InterfaceThread;
	  })
	| (FlowNodeBase & { count: number; groupKey: string; kind: "more" })
	| (FlowNodeBase & { kind: "stub"; ownerId: string })
	| (FlowNodeBase & { kind: "composer"; target: FlowTarget });

export type FlowNodeKind = FlowNode["kind"];

export interface FlowEdge {
	arrow: boolean;
	dashed: boolean;
	id: string;
	/** Always four points (two corners), so edges morph cleanly when rows move. */
	points: [number, number][];
	/** The node this edge leads into, for tinting the open path. */
	to: string;
}

export interface FlowChip {
	/** Spoken label for the chip. */
	description: string;
	id: string;
	label: string;
	/** The most urgent conversation behind this chip, opened on press. */
	threadId: string | null;
	tone: "attention" | "plain";
	x: number;
	y: number;
}

/** The quiet round glyph on a connector that has nothing waiting on it. */
export interface FlowJoint {
	id: string;
	x: number;
	y: number;
}

export interface FlowLayout {
	bounds: { maxX: number; maxY: number; minX: number; minY: number };
	chips: FlowChip[];
	edges: FlowEdge[];
	/** One per lead connector without a chip, so every connector reads alike. */
	joints: FlowJoint[];
	nodes: FlowNode[];
}

export interface FlowLayoutOptions {
	/** Open thread: always laid out, even when it would sit behind "N more". */
	activeThreadId?: string | null;
	composer: FlowTarget | null;
	/** Lead keys the user brought onto the canvas this session. */
	engaged: readonly string[];
	/** Group keys whose full conversation list is shown. */
	expanded: readonly string[];
	/** Keep the origin's dotted "+" stub on the canvas at all times. */
	originStub?: boolean;
	/** Node id (`origin` or a lead) that shows its dotted "+" stub. */
	stubFor: string | null;
}
