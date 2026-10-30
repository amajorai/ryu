// apps/desktop/src/lib/mission-control/turn-groups-types.ts
//
// The Mission Control digest shapes, split out of `turn-groups.ts` (which
// re-exports them so existing import paths stay stable).

/** A message part, typed loosely — we read the AI SDK fields we care about and
 *  ignore the rest, exactly as `CoworkContextPanel` does. */
export interface MissionStreamPart {
	input?: unknown;
	output?: unknown;
	/** Tool parts only: `input-available` until the result frame patches it. */
	state?: string;
	text?: unknown;
	toolCallId?: string;
	/** Present on `dynamic-tool` parts, where the name isn't in `type`. */
	toolName?: string;
	type?: string;
}

export interface MissionStreamMessage {
	id?: string;
	parts?: MissionStreamPart[];
	role?: string;
}

/** How a turn touched one path. `create` and `edit` are writes; `read` is not. */
export type MissionTouchKind = "create" | "edit" | "read";

export interface MissionFileTouch {
	/** Number of tool calls in scope that touched this path. */
	count: number;
	kind: MissionTouchKind;
	path: string;
}

export interface MissionCommand {
	command: string;
	description?: string;
	failed: boolean;
}

export interface MissionToolStat {
	calls: number;
	failures: number;
	name: string;
}

export interface MissionTodo {
	content: string;
	status: "completed" | "in_progress" | "pending";
}

/** A turn that is still streaming has tool calls with no result frame yet. */
export type MissionTurnStatus = "failed" | "ok" | "running";

export interface MissionTurn {
	/** Sub-agents this turn spawned, by their task description. */
	delegates: string[];
	files: MissionFileTouch[];
	/** Deterministic one-liner naming the work, e.g. "Edited 3 files, ran 2 commands". */
	headline: string;
	/** Stable id: the first message in the turn. */
	id: string;
	/** 1-based position in the conversation. */
	index: number;
	messageIds: string[];
	/** The assistant's closing prose — what it says it accomplished. */
	outcome: string;
	/** The assistant's prose before it touched anything — why it did this. */
	rationale: string;
	/** The user's ask, trimmed to a readable length. */
	request: string;
	searches: string[];
	shellCommands: MissionCommand[];
	status: MissionTurnStatus;
	/** Extended-thinking text, when the agent emitted reasoning parts. */
	thinking: string;
	/** The plan snapshot this turn wrote, if it wrote one. */
	todos: MissionTodo[];
	tools: MissionToolStat[];
	web: string[];
}

export interface MissionTotals {
	commands: number;
	failures: number;
	filesTouched: number;
	toolCalls: number;
	turns: number;
	writes: number;
}

export interface MissionDigest {
	/** Latest plan snapshot, split by whether the work is still outstanding. */
	doneTodos: MissionTodo[];
	/** Every path the conversation wrote or read, rolled up across turns. */
	files: MissionFileTouch[];
	openTodos: MissionTodo[];
	totals: MissionTotals;
	turns: MissionTurn[];
}
