import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import type { GlanceDistance } from "./glance-model.ts";

/**
 * Type scale, in units of the display's own width (`cqw`) so a face reads the
 * same on a 7-inch square or a full window; clamps keep the small end legible.
 */
export const GLANCE_TYPE = {
	/** Far clock digits. */
	clock: "text-[25cqw] leading-[0.9] tracking-[-0.045em]",
	/** Near clock and flow digits. */
	clockNear: "text-[13cqw] leading-[0.9] tracking-[-0.04em]",
	/** Far captions: the one line under the clock. */
	lead: "text-[clamp(1rem,4.4cqw,2.125rem)] leading-tight tracking-[-0.01em]",
	/** Near rows: thread titles. */
	body: "text-[clamp(0.875rem,2.9cqw,1.375rem)] leading-snug tracking-[-0.005em]",
	/** Near secondary lines. */
	detail: "text-[clamp(0.75rem,2.3cqw,1.0625rem)] leading-snug",
} as const;

export interface GlanceFaceProps {
	distance: GlanceDistance;
	loading: boolean;
	now: number;
	onOpenThread: (threadId: string) => void;
	onStartWithAgent: (agentId: string) => void;
	snapshot: InterfaceSnapshot;
}
