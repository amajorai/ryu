import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ScrollableTabsView } from "../../src/components/layout/ScrollableTabsView.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import {
	TabsProvider,
	useTabsContext,
} from "../../src/contexts/TabsContext.tsx";
import type { RouteTab } from "../../src/contributions/registry.ts";
import { contributionRegistry } from "../../src/contributions/registry.ts";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import "../../src/index.css";

// Ryu Bot answers every non-chat route with a "belongs in Ryu Build" notice, so
// the proof opts into Console the way the app's access sync would.
useProductModeStore.setState({ consoleAccess: true, requestedMode: "console" });

const BOOT_NOW = 1_000_000;

type MemoryClockWindow = Window & { __ryuMemoryNow: number };

const proofJson = <FixturePayload,>(body: FixturePayload) =>
	new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status: 200,
	});

const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const url = input instanceof Request ? input.url : String(input);
	if (
		url.endsWith("/api/preferences/entitlement-active") ||
		url.endsWith("/api/preferences/managed-inference-entitled")
	) {
		return proofJson({
			key: url.split("/api/preferences/")[1],
			value: "false",
		});
	}
	return nativeFetch(input, init);
};

contributionRegistry.registerRoute({
	kind: "pattern",
	test: { startsWith: "/thread-memory/" },
	render: (tab: RouteTab) => (
		<div className="flex size-full flex-col gap-4 overflow-auto bg-muted/20 p-6">
			<p className="type-compact font-medium text-muted-foreground uppercase tracking-(--tracking-section)">
				Mounted thread route
			</p>
			<h2 className="font-semibold text-foreground text-xl">{tab.path}</h2>
			<p className="max-w-lg text-muted-foreground text-sm leading-6">
				This route is intentionally heavy enough to represent a long chat tree.
				The memory policy can unmount it without deleting its durable
				transcript.
			</p>
			<div
				className="mt-auto rounded-xl border border-border/70 bg-card p-4 text-muted-foreground text-xs"
				data-proof-route={tab.path}
			>
				Mounted and live
			</div>
		</div>
	),
});

function MemoryStatus() {
	const { tabs } = useTabsContext();
	const unloaded = tabs.filter((tab) => tab.unloaded).length;
	return (
		<output className="font-medium text-sm" data-testid="memory-state">
			{unloaded} unloaded · {tabs.length - unloaded} mounted
		</output>
	);
}

function Story() {
	const [advanced, setAdvanced] = useState(false);
	const advanceClock = () => {
		/* SAFETY: The owning proof HTML initializes this private numeric clock before this module, and this callback writes only the authored numeric timestamp expression. */ (
			window as MemoryClockWindow
		).__ryuMemoryNow = BOOT_NOW + 11 * 60_000;
		setAdvanced(true);
	};

	return (
		<AppSurfaceProvider surface="desktop">
			<EntitlementProvider>
				<TabsProvider>
					<main className="min-h-screen bg-background p-6 text-foreground">
						<header className="mx-auto mb-5 flex max-w-5xl flex-wrap items-end justify-between gap-4">
							<div>
								<p className="font-medium text-primary text-xs uppercase tracking-(--tracking-section)">
									Ryu Desktop · thread memory
								</p>
								<h1 className="mt-1 font-semibold text-2xl tracking-tight">
									Inactive thread views release renderer memory
								</h1>
								<p className="mt-2 max-w-2xl text-muted-foreground text-sm leading-6">
									The active thread stays live while old tabs unmount and remain
									reloadable.
								</p>
							</div>
							<div className="flex items-center gap-3 rounded-full border border-border/70 bg-card px-3 py-2">
								<MemoryStatus />
								<button
									className="rounded-full bg-primary px-3 py-1.5 font-medium text-primary-foreground text-xs transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									data-testid="advance-clock"
									disabled={advanced}
									onClick={advanceClock}
									type="button"
								>
									Simulate 11 minutes
								</button>
							</div>
						</header>
						<div className="mx-auto h-[620px] max-w-5xl overflow-hidden rounded-3xl border border-border/70 shadow-xl">
							<ScrollableTabsView />
						</div>
						<p className="mx-auto mt-4 max-w-5xl text-muted-foreground text-xs">
							Unloading releases the mounted route tree; it does not delete the
							conversation transcript.
						</p>
					</main>
				</TabsProvider>
			</EntitlementProvider>
		</AppSurfaceProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
