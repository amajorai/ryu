// Installs the proof's Tauri bridge before any app module evaluates.
//
// Tauri injects `__TAURI_INTERNALS__` before page scripts run, and the auth
// vault reads its sealed slot as soon as lib/auth-client.ts is imported. A
// bridge the harness installs later races that first read and leaves the vault
// locked, so the runtime proof's read-only session never reached the
// permission check. This side-effect module is the harness's first import:
// calls made before the harness registers its handler wait for it.

type ProofTauriArgs = Parameters<
	typeof import("@tauri-apps/api/core").invoke
>[1];
export type ProofTauriHandler = (
	command: string,
	args?: ProofTauriArgs
) => Promise<string | undefined>;

declare global {
	interface Window {
		__setGatewayDialogShellTauriHandler: (handler: ProofTauriHandler) => void;
	}
}

let handler: ProofTauriHandler | null = null;
const waiting: (() => void)[] = [];

async function invoke(
	command: string,
	args?: ProofTauriArgs
): Promise<string | undefined> {
	if (!handler) {
		await new Promise<void>((resolve) => waiting.push(resolve));
	}
	return handler ? await handler(command, args) : undefined;
}

window.__setGatewayDialogShellTauriHandler = (next) => {
	handler = next;
	for (const resume of waiting.splice(0)) {
		resume();
	}
};
Object.assign(window, {
	__TAURI_INTERNALS__: { invoke, transformCallback: () => 1 },
});
