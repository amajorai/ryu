// React proof artifact for the Keyboard Shortcuts settings filter.
// It mounts the shipped tab, provider, rows, and scroll-fade utility so the
// browser spec checks the same component users see in the desktop dialog.

import { HotkeysProvider } from "@ryu/hotkeys/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { KeyboardShortcutsTab } from "@/src/components/settings/KeyboardShortcutsTab.tsx";
import { DESKTOP_HOTKEYS } from "@/src/lib/hotkeys/actions.ts";
import "../../src/index.css";

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

const EMPTY_PLUGIN_CONTRIBUTIONS = { companions: [] };
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const pathname = new URL(String(input), window.location.origin).pathname;
	if (pathname === "/api/plugins") {
		return new Response(JSON.stringify({ apps: [] }), {
			headers: { "content-type": "application/json" },
			status: 200,
		});
	}
	if (pathname === "/api/plugins/contributions") {
		return new Response(JSON.stringify(EMPTY_PLUGIN_CONTRIBUTIONS), {
			headers: { "content-type": "application/json" },
			status: 200,
		});
	}
	return realFetch(input, init);
};

function readProofMetrics() {
	const input = document.querySelector<HTMLInputElement>(
		'[data-testid="keyboard-shortcuts-filter"]'
	);
	const scroller = document.querySelector<HTMLElement>(
		'[data-testid="keyboard-shortcuts-scroll"]'
	);
	if (!(input && scroller)) {
		return null;
	}
	const inputBox = input.getBoundingClientRect();
	const scrollBox = scroller.getBoundingClientRect();
	return {
		filterHeight: Math.round(inputBox.height),
		filterValue: input.value,
		defaultFilter: input.classList.contains("h-9"),
		listTop: Math.round(scrollBox.top),
		scrollFade: scroller.classList.contains("scroll-fade"),
		scrollHeight: scroller.scrollHeight,
		clientHeight: scroller.clientHeight,
	};
}

function Story() {
	const [metrics, setMetrics] =
		useState<ReturnType<typeof readProofMetrics>>(null);
	const [initialOverflow, setInitialOverflow] = useState(false);

	useEffect(() => {
		const update = () => {
			const next = readProofMetrics();
			setMetrics(next);
			if (next && next.scrollHeight > next.clientHeight) {
				setInitialOverflow(true);
			}
		};
		const timer = window.setTimeout(update, 100);
		return () => window.clearTimeout(timer);
	}, []);

	const verified =
		metrics?.defaultFilter && metrics.scrollFade && initialOverflow;

	return (
		<main className="min-h-screen bg-background p-6 text-foreground">
			<div className="mx-auto flex h-[calc(100vh-3rem)] max-w-3xl flex-col gap-4">
				<header className="flex items-start justify-between gap-4">
					<div>
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
							React verification artifact
						</p>
						<h1 className="font-semibold text-2xl">Keyboard shortcut search</h1>
						<p className="mt-1 text-muted-foreground text-sm">
							The real settings tab keeps its filter above an independent
							scroll-fade list.
						</p>
					</div>
					<p
						className="rounded-full border px-3 py-1 font-medium text-xs"
						data-status={verified ? "pass" : "pending"}
						data-testid="proof-status"
					>
						{verified ? "PASS" : "CHECKING"}
					</p>
				</header>

				<section className="min-h-0 flex-1 overflow-hidden rounded-xl border bg-card shadow-sm">
					<div className="h-full p-6">
						<QueryClientProvider client={queryClient}>
							<HotkeysProvider registry={DESKTOP_HOTKEYS}>
								<KeyboardShortcutsTab />
							</HotkeysProvider>
						</QueryClientProvider>
					</div>
				</section>

				<dl className="grid gap-2 rounded-xl border bg-card p-4 text-sm sm:grid-cols-3">
					<div>
						<dt className="text-muted-foreground">Filter height</dt>
						<dd className="font-mono" data-testid="filter-height">
							{metrics?.filterHeight ?? "pending"}px
						</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">Scroll fade</dt>
						<dd className="font-mono" data-testid="scroll-fade-value">
							{metrics?.scrollFade ? "scroll-fade" : "pending"}
						</dd>
					</div>
					<div>
						<dt className="text-muted-foreground">List overflow</dt>
						<dd className="font-mono" data-testid="overflow-value">
							{metrics
								? `${metrics.scrollHeight} / ${metrics.clientHeight}px`
								: "pending"}
						</dd>
					</div>
				</dl>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
