import type {
	InterfaceAgentAct,
	InterfaceAsk,
} from "@ryuhq/protocol/interfaces";
import type { KeyboardEvent } from "react";

/** Keeps keys pressed inside kit DOM away from the game's own handlers. */
export function isolateKeys(event: KeyboardEvent): void {
	event.stopPropagation();
}

/** Text with backticks and simple markdown removed. */
export function plainText(text: string): string {
	return text
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[`*_#>~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Who owns each ask, by name (null when no agent on the snapshot does). */
export function askOwners(
	acts: ReadonlyMap<string, InterfaceAgentAct>
): Map<string, string> {
	const owners = new Map<string, string>();
	for (const act of acts.values()) {
		const asks = [
			...(act.ask ? [act.ask] : []),
			...act.parkedAsks,
			...act.suggestions,
		];
		for (const ask of asks) {
			owners.set(ask.id, act.agentName);
		}
	}
	return owners;
}

export function ownerName(
	ask: InterfaceAsk,
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	owners: ReadonlyMap<string, string>
): string | null {
	const owned = owners.get(ask.id);
	if (owned) {
		return owned;
	}
	if (ask.agentId) {
		return acts.get(ask.agentId)?.agentName ?? null;
	}
	return null;
}

export function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}
