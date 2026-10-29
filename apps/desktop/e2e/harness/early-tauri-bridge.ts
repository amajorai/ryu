// Install the Tauri IPC bridge before any app module evaluates, as the real
// webview does. The desktop auth client reads its sealed vault slot while its
// module loads; without a bridge already present it waits only a bounded time
// and then treats the host as having no native backend. Calls made before the
// harness registers its handler wait for it instead.
//
// Import this module for its side effect FIRST in a harness entry, then hand
// the harness's own invoke to `installEarlyTauriHandler`.

type HarnessInvoke = (
	command: string,
	args?: Record<string, unknown>
) => Promise<unknown>;

let resolveHandler: (invoke: HarnessInvoke) => void = () => undefined;
const handler = new Promise<HarnessInvoke>((resolve) => {
	resolveHandler = resolve;
});

Reflect.set(window, "__TAURI_INTERNALS__", {
	invoke: async (command: string, args?: Record<string, unknown>) =>
		(await handler)(command, args),
	transformCallback: () => 0,
});

/** Route every native call (including ones already waiting) to `invoke`. */
export function installEarlyTauriHandler(invoke: HarnessInvoke): void {
	resolveHandler(invoke);
}
