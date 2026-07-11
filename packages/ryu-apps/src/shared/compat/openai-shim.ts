// ChatGPT Apps-SDK compatibility shim (spec §1.3): make `window.openai` the SAME
// object as `window.ryu` so an unmodified component that reads
// `window.openai.toolOutput` or calls `window.openai.callTool(...)` runs against the
// Ryu bridge with no changes.
//
// Order matters: the bridge must be installed first so `window.ryu` exists and holds
// the methods; this shim then aliases. `installOpenAiShim` is idempotent and calls
// `installRyuBridge` itself, so importing it alone is sufficient.

import { installRyuBridge } from "../bridge";

/** Alias `window.openai` onto the live `window.ryu` object (same reference), so all
 *  props and methods — and every subsequent host push — are shared. */
export function installOpenAiShim(): void {
	const globals = installRyuBridge();
	if (window.openai !== globals) {
		window.openai = globals;
	}
}
