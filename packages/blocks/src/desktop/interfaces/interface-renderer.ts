import {
	agentHandleText,
	type InterfaceAgent,
	type InterfacePort,
	type InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";

/**
 * What every interface renderer receives. Renderers are pure presentation:
 * they read the snapshot, act through the port, and show the host's own
 * conversation surface (`threadView`) for the open thread, so streaming,
 * tools, and approvals behave the same in every interface.
 */
export interface InterfaceRendererProps<Params> {
	/** Id of the open thread, when the host knows it (null for a new thread). */
	activeThreadId: string | null;
	/** True until the host's first snapshot load settles. */
	loading: boolean;
	params: Params;
	port: InterfacePort;
	snapshot: InterfaceSnapshot;
	/** The host's canonical conversation surface, or null when none is open. */
	threadView: ReactNode | null;
}

export function agentById(
	snapshot: InterfaceSnapshot,
	agentId: string | null | undefined
): InterfaceAgent | undefined {
	return agentId
		? snapshot.agents.find((agent) => agent.id === agentId)
		: undefined;
}

/** Up to two initials for an avatar fallback. */
export function initials(name: string): string {
	const letters = name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((word) => word[0]?.toUpperCase() ?? "")
		.join("");
	return letters || "?";
}

/** Stable hue for an id, so an agent keeps its color across interfaces. */
export function agentHue(id: string): number {
	let hash = 0;
	for (const char of id) {
		hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
	}
	return hash;
}

const UNITS: [number, string][] = [
	[60, "s"],
	[60, "m"],
	[24, "h"],
	[7, "d"],
	[Number.POSITIVE_INFINITY, "w"],
];

/** Compact social-style age ("now", "5m", "3h", "2d", "4w"). */
export function compactAge(iso: string, now: number = Date.now()): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	let value = Math.max(0, Math.floor((now - then) / 1000));
	if (value < 45) {
		return "now";
	}
	for (const [size, unit] of UNITS) {
		if (value < size) {
			return `${value}${unit}`;
		}
		value = Math.floor(value / size);
	}
	return "";
}

/**
 * `@handle` for an agent name. Built by the protocol's `agentHandleText`, so
 * `resolveAgentHandle` accepts every handle an interface shows or completes.
 */
export function agentHandle(name: string): string {
	return `@${agentHandleText(name)}`;
}
