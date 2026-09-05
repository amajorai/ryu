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
import "../../src/index.css";

const BOOT_NOW = 1_000_000;

type MemoryClockWindow = Window & { __ryuMemoryNow: number };

const proofJson = (body: unknown) =>
	new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status: 200,
	});

const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const url = typeof input === "string" ? input : input.toString();
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
			<p className="font-medium text-[10px] text-muted-foreground uppercase tracking-[0.16em]">
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
		(window as MemoryClockWindow).__ryuMemoryNow = BOOT_NOW + 11 * 60_000;
		setAdvanced(true);
	};

	return (
		<AppSurfaceProvider surface="desktop">
			<EntitlementProvider>
				<TabsProvider>
					<main className="min-h-screen bg-background p-6 text-foreground">
						<header className="mx-auto mb-5 flex max-w-5xl flex-wrap items-end justify-between gap-4">
							<div>
								<p className="font-medium text-primary text-xs uppercase tracking-[0.16em]">
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
