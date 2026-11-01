// Installs the proof's Tauri bridge before any app module evaluates.
//
// Tauri injects `__TAURI_INTERNALS__` before page scripts run, and the auth
// vault reads its sealed slot as soon as lib/auth-client.ts is imported. The
// story imports that module, so a bridge installed later in the story races
// the vault's first read and leaves it locked. This side-effect module is the
// story's first import: calls made before the story registers its handler
// wait for it.

import type { ProofJsonRecord } from "../fixture-json.ts";

type ProofTauriHandler = (
	command: string,
	args?: ProofJsonRecord
) => Promise<string | null>;

declare global {
	interface Window {
		__setTeamsBillingTauriHandler: (handler: ProofTauriHandler) => void;
	}
}

let handler: ProofTauriHandler | null = null;
const waiting: (() => void)[] = [];

async function invoke(
	command: string,
	args?: ProofJsonRecord
): Promise<string | null> {
	if (!handler) {
		await new Promise<void>((resolve) => waiting.push(resolve));
	}
	return handler ? await handler(command, args) : null;
}

window.__setTeamsBillingTauriHandler = (next) => {
	handler = next;
	for (const resume of waiting.splice(0)) {
		resume();
	}
};
Object.assign(window, {
	__TAURI_INTERNALS__: { invoke, transformCallback: () => 0 },
});
