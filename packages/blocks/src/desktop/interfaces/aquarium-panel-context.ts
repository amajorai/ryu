import type {
	ClockOptions,
	InterfaceAgentAct,
	InterfaceSnapshot,
	InterfaceThread,
	ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { createContext } from "react";

/**
 * The act layer for the panel, when the host sends asks: an agent's card
 * shows its act (not thread states) and counts only its blocking asks.
 */
export const AquariumPanelActs = createContext<{
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	nowMs: number;
	onAsk: (askId: string, opener: HTMLElement) => void;
	onBlocker: (threadId: string, agentName: string, opener: HTMLElement) => void;
	snapshot: InterfaceSnapshot;
} | null>(null);

export const STATUS_TONE: Record<ThreadStatus, string> = {
	attention: "text-status-destructive",
	quiet: "text-muted-foreground",
	waiting: "text-muted-foreground",
	working: "text-status-success",
	"your-turn": "text-foreground",
};

export function threadTitle(thread: InterfaceThread | undefined): string {
	if (!thread) {
		return "New thread";
	}
	return thread.title.trim() || "Untitled thread";
}
