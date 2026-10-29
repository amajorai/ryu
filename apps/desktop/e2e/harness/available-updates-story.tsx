// Standalone browser story for the REAL `AvailableUpdates` section — the
// "Available updates" list in the download center, and the surface behind the
// report that pressing Update did nothing.
//
// Unlike the other stories this one is NOT prop-driven: the whole point is the
// round trip. It renders the real component over the real `useAvailableUpdates`
// hook against a REAL Core (`VITE_CORE_URL`, default the dev profile's :8980),
// so the spec exercises the actual chain — Core's catalog verdict decides
// whether a row exists, the press issues the forced install, and the outcome is
// reported as a toast. A prop-driven story could not have caught either half of
// the bug: the row that could never clear, or the press that returned success
// having done nothing.
//
// Run it against a Core whose `versions.json` records an engine version behind
// the pin, which is what makes an update row appear.

import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { AvailableUpdates } from "../../src/components/downloads/AvailableUpdates.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

// The Core under test. It must allow this harness origin, or the browser blocks
// every call before it is sent — start it with:
//   RYU_CORS_ORIGINS=http://localhost:5177
// (Core's supported extension point for extra allowed origins; the built-in list
// covers the app's own dev servers, not this harness.)
// SAFETY: Native Vite loadEnv publishes custom VITE_ values as dotenv/process-environment strings, with undefined for an absent key; this proof configuration does not override VITE_CORE_URL with a non-string define.
const CORE_URL =
	(import.meta.env.VITE_CORE_URL as string | undefined) ??
	"http://127.0.0.1:8980";

// Point the store at the Core under test. The hook reads the active node
// through `getActiveNode`, so seeding the store is all the wiring it needs.
useNodeStore.setState({
	localNodes: [{ name: "local", url: CORE_URL, token: null }],
	defaultNode: "local",
});

// No retries: a failing source should surface immediately as an empty list
// rather than being masked by a slow backoff during the spec.
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function Story() {
	return (
		<QueryClientProvider client={queryClient}>
			<div className="flex min-h-screen flex-col gap-4 bg-background p-6 text-foreground">
				{/* Deliberately does NOT contain the section's own heading text, so
				    a spec asserting on "Available updates" can only match the real
				    component. */}
				<h1 className="font-semibold text-lg" data-testid="story-title">
					Live update section (proxied to Core)
				</h1>
				<div className="w-[640px] rounded-xl border border-border">
					<AvailableUpdates />
				</div>
			</div>
			<Toaster position="bottom-right" theme="system" />
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
