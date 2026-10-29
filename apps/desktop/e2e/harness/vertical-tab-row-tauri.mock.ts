interface NativeCall {
	args: unknown;
	command: string;
	result: unknown;
}

export interface VerticalTabProofState {
	nativeCalls: NativeCall[];
	renameCalls: Array<{ conversationId: string; title: string }>;
	windowResults: boolean[];
}

declare global {
	interface Window {
		__VERTICAL_TAB_PROOF__?: VerticalTabProofState;
	}
}

export function initializeVerticalTabFixture(): VerticalTabProofState {
	const state: VerticalTabProofState = {
		nativeCalls: [],
		renameCalls: [],
		windowResults: [],
	};
	window.__VERTICAL_TAB_PROOF__ = state;
	return state;
}

function proofState(): VerticalTabProofState {
	const state = window.__VERTICAL_TAB_PROOF__;
	if (!state) {
		throw new Error("Vertical tab proof fixture was not initialized");
	}
	return state;
}

export class TauriUnavailableError extends Error {
	constructor(target: string) {
		super(`Native fixture did not handle ${target}`);
		this.name = "TauriUnavailableError";
	}
}

/** Mirrors tauri-ready.ts: a fixture's own unavailable error means "no backend". */
export function isNoDesktopBackend(error: unknown): boolean {
	return error instanceof TauriUnavailableError;
}

export function isTauriReady(): boolean {
	return true;
}

export async function invokeWhenReady(
	command: string,
	args?: {
		tabId?: string;
		path?: string;
		title?: string;
		conversationId?: string;
	}
): Promise<boolean | null> {
	const state = proofState();
	const result =
		command === "open_tab_window"
			? (state.windowResults.shift() ?? true)
			: null;
	state.nativeCalls.push({
		args: structuredClone(args ?? null),
		command,
		result,
	});
	return result;
}

export async function listenWhenReady<_T>(): Promise<() => void> {
	return () => undefined;
}

export async function withTauri<T>(work: () => Promise<T> | T): Promise<T> {
	return await work();
}

export function resetTauriGateForTests(): void {
	// The isolated browser fixture is ready for the entire test lifetime.
}
