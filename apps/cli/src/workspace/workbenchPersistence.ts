// workbenchPersistence - saves the TUI's workbench layout (tab placement,
// regions, splits) as `workbench-layout.json` in the Ryu home directory, using
// the same versioned parser as Desktop. Reads and writes never throw: a corrupt
// or unreadable file falls back to the default layout, and a failed write
// reports one message while the session keeps running in memory.

import {
	chmodSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { WorkbenchState } from "@ryu/workbench/model";
import {
	parseWorkbenchSnapshot,
	serializeWorkbenchSnapshot,
} from "@ryu/workbench/persistence";
import { ryuHomeDir } from "@ryuhq/core-client/node-token";

export type SaveResult = { ok: true } | { message: string; ok: false };

export interface WorkbenchPersistence {
	load: () => WorkbenchState | undefined;
	save: (state: WorkbenchState) => SaveResult;
}

export function workbenchLayoutPath(): string {
	return join(ryuHomeDir(), "workbench-layout.json");
}

function makeId(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

/** Read the saved layout; undefined when absent, unreadable, or invalid. */
export function loadWorkbenchLayout(
	path = workbenchLayoutPath()
): WorkbenchState | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return;
	}
	return parseWorkbenchSnapshot(parsed, {
		bottomGroupId: makeId("bottom"),
		centerGroupId: makeId("center"),
		leftGroupId: makeId("left"),
		makeItemId: () => makeId("tab"),
		navigationId: makeId("navigation"),
		rightGroupId: makeId("right"),
	});
}

/** Best-effort cleanup; a path that cannot even be inspected is left alone. */
function removeQuietly(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {
		// Nothing was written there, or the directory itself is unusable.
	}
}

/** Atomically replace the saved layout (owner-only permissions). */
export function saveWorkbenchLayout(
	state: WorkbenchState,
	path = workbenchLayoutPath()
): SaveResult {
	const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(path), { mode: 0o700, recursive: true });
		writeFileSync(
			temporary,
			JSON.stringify(serializeWorkbenchSnapshot(state)),
			{ mode: 0o600 }
		);
		renameSync(temporary, path);
		chmodSync(path, 0o600);
		return { ok: true };
	} catch {
		removeQuietly(temporary);
		return { message: "Layout could not be saved.", ok: false };
	}
}

/**
 * File-backed persistence for the shell. `onError` hears about a failed save
 * once per run of failures, so a read-only home does not spam the status line.
 */
export function fileWorkbenchPersistence({
	onError,
	path = workbenchLayoutPath(),
}: {
	onError?: (message: string) => void;
	path?: string;
} = {}): WorkbenchPersistence {
	let failing = false;
	return {
		load: () => loadWorkbenchLayout(path),
		save: (state) => {
			const result = saveWorkbenchLayout(state, path);
			if (result.ok) {
				failing = false;
			} else if (!failing) {
				failing = true;
				onError?.(result.message);
			}
			return result;
		},
	};
}
