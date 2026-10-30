import {
	accountAccessHeadline,
	accountAccessNote,
	accountKeyKind,
	accountKeyUnusedReason,
	identityModeDescription,
	identityModeLabel,
	isRemotePeerEngine,
	REMOTE_PEER_IDENTITY_NOTE,
} from "../core/agentIdentity.ts";
import type { AgentIdentityView } from "./agents-core.ts";
import { formatTable } from "./output.ts";
import { type CliContext, UsageError } from "./types.ts";

// ── Output ───────────────────────────────────────────────────────────────────

export function describeAccess(view: AgentIdentityView): string[] {
	const lines = [
		`Account access: ${accountAccessHeadline(view.accountAccess)}`,
	];
	lines.push(
		`                ${accountAccessNote(view.accountAccess, view.identityMode)}`
	);
	if (view.accountAccess && view.accountAccess.length > 0) {
		const rows = view.accountAccess.map((key) => [
			key,
			accountKeyKind(key)?.label ?? "Other",
			accountKeyUnusedReason(key, view.identityMode) ?? "",
		]);
		const table = formatTable(["KEY", "KIND", "NOTE"], rows);
		lines.push("", ...table.split("\n").map((line) => `  ${line}`));
	}
	return lines;
}

/** The lines that show an app's pending identity request, if there is one. */
export function describePendingIdentity(view: AgentIdentityView): string[] {
	if (!view.pendingIdentityMode) {
		return [];
	}
	return [
		`App request:    ${identityModeLabel(view.pendingIdentityMode)}. A newer version of this agent's app asks for it; nothing changes until you choose.`,
		`                Accept: ryu-cli agents identity ${view.id} ${view.pendingIdentityMode}`,
		`                Dismiss and keep ${identityModeLabel(view.identityMode)}: ryu-cli agents identity ${view.id} dismiss`,
	];
}

export function describeRemotePeer(): string[] {
	return [
		`How it works:   ${REMOTE_PEER_IDENTITY_NOTE.title}`,
		`                ${REMOTE_PEER_IDENTITY_NOTE.description}`,
	];
}

export function describeAgent(view: AgentIdentityView): string {
	if (isRemotePeerEngine(view.engine)) {
		return [
			`Agent:          ${view.name} (${view.id})`,
			`Engine:         ${view.engine ?? "—"}`,
			...describeRemotePeer(),
		].join("\n");
	}
	return [
		`Agent:          ${view.name} (${view.id})`,
		`Engine:         ${view.engine ?? "—"}`,
		`How it works:   ${identityModeLabel(view.identityMode)}`,
		`                ${identityModeDescription(view.identityMode)}`,
		...describePendingIdentity(view),
		...describeAccess(view),
	].join("\n");
}

export function output(ctx: CliContext, json: unknown, human: string): void {
	ctx.io.out(
		ctx.flags.json ? `${JSON.stringify(json, null, 2)}\n` : `${human}\n`
	);
}

export function requireId(id: string | undefined, usage: string): string {
	if (!id) {
		throw new UsageError(`Usage: ${usage}`);
	}
	return id;
}

/**
 * A remote A2A peer has no identity or account access to change here: Core
 * ignores both for it, so a change would only look like it did something.
 * Moving it to another engine with `--engine` is allowed.
 */
export function refuseRemotePeerChange(
	view: AgentIdentityView,
	engine: string | null
): void {
	if (isRemotePeerEngine(engine ?? view.engine)) {
		throw new Error(
			`'${view.name}' ${REMOTE_PEER_IDENTITY_NOTE.title.toLowerCase()}. ${REMOTE_PEER_IDENTITY_NOTE.description} Nothing was saved.`
		);
	}
}

export function requireEditable(view: AgentIdentityView): void {
	if (view.locked) {
		throw new Error(
			`Agent '${view.id}' is locked. Unlock it before changing how it works or its account access.`
		);
	}
}
