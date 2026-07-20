/**
 * Tool state cache for detecting AI SDK in-place mutations.
 * AI SDK mutates objects in-place during streaming, so we must
 * cache state externally and compare cached values.
 */

interface CachedToolState {
	inputJson: string;
	outputJson: string;
	state: string | undefined;
}

const toolStateCache = new Map<string, CachedToolState>();

interface ToolPartLike {
	input?: unknown;
	output?: { success?: boolean } | null;
	state?: string;
	toolCallId?: string;
	type?: string;
}

function getToolStateSnapshot(part: ToolPartLike): CachedToolState {
	return {
		state: part.state,
		inputJson: JSON.stringify(part.input || {}),
		outputJson: JSON.stringify(part.output || {}),
	};
}

function hasToolStateChanged(toolCallId: string, part: ToolPartLike): boolean {
	const cached = toolStateCache.get(toolCallId);
	const current = getToolStateSnapshot(part);

	if (!cached) {
		toolStateCache.set(toolCallId, current);
		return true;
	}

	const changed =
		cached.state !== current.state ||
		cached.inputJson !== current.inputJson ||
		cached.outputJson !== current.outputJson;

	if (changed) {
		toolStateCache.set(toolCallId, current);
	}

	return changed;
}

function arePartsEqual(prev: ToolPartLike, next: ToolPartLike): boolean {
	if (prev.toolCallId !== next.toolCallId) {
		return false;
	}
	if (prev.type !== next.type) {
		return false;
	}

	const toolCallId = next.toolCallId;
	if (!toolCallId) {
		return prev.state === next.state;
	}

	const changed = hasToolStateChanged(toolCallId, next);
	return !changed;
}

function isToolCompleted(part: ToolPartLike): boolean {
	if (part.output !== undefined && part.output !== null) {
		return true;
	}
	if (part.state === "error") {
		return true;
	}
	if (part.state === "result") {
		return true;
	}
	return false;
}

/** Deep compare function for tool part props. Used with React.memo(). */
export function areToolPropsEqual(
	prevProps: { part: ToolPartLike; chatStatus?: string },
	nextProps: { part: ToolPartLike; chatStatus?: string }
): boolean {
	const partsEqual = arePartsEqual(prevProps.part, nextProps.part);
	if (!partsEqual) {
		return false;
	}
	if (isToolCompleted(nextProps.part)) {
		return true;
	}
	if (prevProps.chatStatus !== nextProps.chatStatus) {
		return false;
	}
	return true;
}

/** Get tool status from part state */
export function getToolStatus(part: ToolPartLike, chatStatus?: string) {
	const basePending =
		part.state !== "output-available" && part.state !== "output-error";
	const isError =
		part.state === "output-error" ||
		(part.state === "output-available" && part.output?.success === false);
	const isSuccess = part.state === "output-available" && !isError;
	const isPending = basePending && chatStatus === "streaming";
	const isInterrupted =
		basePending && chatStatus !== "streaming" && chatStatus !== undefined;

	return { isPending, isError, isSuccess, isInterrupted };
}
