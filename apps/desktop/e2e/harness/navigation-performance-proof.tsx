import { Button } from "@ryu/ui/components/button.tsx";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppSurfaceProvider } from "@/src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "@/src/contexts/entitlement-context.tsx";
import {
	CurrentTabIdProvider,
	IsActiveTabProvider,
	TabsProvider,
	useCurrentTabId,
	useIsActiveTab,
	useTabSelector,
	useTabsContext,
} from "@/src/contexts/TabsContext.tsx";
import {
	TitleBarProvider,
	useTitleBar,
} from "@/src/contexts/TitleBarContext.tsx";
import { RouteOutlet } from "@/src/contributions/RouteOutlet.tsx";
import { contributionRegistry } from "@/src/contributions/registry.ts";
import "../../src/index.css";
import { useProductModeStore } from "../../src/lib/product-mode.ts";

// OS is rollout-flagged (off by default) and this proof exercises it, so switch
// it on as the app's flag sync (ProductModeAccessSync) would.
useProductModeStore.getState().setOsAccess(true);

localStorage.setItem("ryu:product-mode", "os");
localStorage.setItem("ryu_startup_behavior", "restore");
localStorage.setItem(
	"ryu_session_tabs",
	JSON.stringify({
		activeIndex: 0,
		tabs: Array.from({ length: 12 }, (_, index) => ({
			path: index === 0 ? "/chat" : `/navigation-proof/${index}`,
			title: `Workspace ${index + 1}`,
		})),
	})
);
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
	const url = input instanceof Request ? input.url : String(input);
	if (url.includes("/api/preferences/")) {
		return Promise.resolve(Response.json({ value: "false" }));
	}
	return nativeFetch(input, init);
};

const rows = Array.from({ length: 160 }, (_, index) => ({
	id: index,
	title: `Research note ${index + 1}`,
	body: "Working notes remain available when you return to this workspace.",
}));
function Workspace({ title }: { title: string }) {
	useTitleBar(title);
	const openTab = useTabSelector((state) => state.openTab);
	const id = useCurrentTabId();
	const active = useIsActiveTab();
	const requested = useTabSelector(
		(state) => state.tabs.find((tab) => tab.id === id)?.scrollToMessageId
	);
	const renders = useRef(0);
	renders.current += 1;
	const [draft, setDraft] = useState("");
	useEffect(() => {
		const el = document.querySelector(`[data-workspace="${id}"]`);
		el?.setAttribute("data-renders", String(renders.current));
	});
	return (
		<article
			className="flex h-full flex-col gap-4 p-6"
			data-active={active}
			data-workspace={id}
		>
			<div className="flex items-center justify-between">
				<div>
					<p className="text-muted-foreground text-xs">
						Ryu Desktop · Navigation component harness
					</p>
					<h1 className="font-semibold text-2xl">{title}</h1>
				</div>
				<Button
					onClick={() =>
						openTab(`/navigation-proof/new-${Date.now()}`, {
							title: "New workspace",
							forceNew: true,
						})
					}
				>
					Open page
				</Button>
			</div>
			<label className="flex flex-col gap-2 text-sm">
				Working draft
				<input
					aria-label="Working draft"
					className="rounded-lg border bg-background p-3"
					onChange={(event) => setDraft(event.target.value)}
					placeholder="Your draft stays here when switching tabs"
					value={draft}
				/>
			</label>
			<output className="text-muted-foreground text-xs" data-request={id}>
				{requested ?? "Ready"}
			</output>
			<div
				className="min-h-0 flex-1 overflow-auto rounded-xl border"
				data-scroll={id}
			>
				{rows.map((row) => (
					<section className="border-b p-4" key={row.id}>
						<h2 className="font-medium text-sm">{row.title}</h2>
						<p className="mt-1 text-muted-foreground text-sm">{row.body}</p>
					</section>
				))}
			</div>
		</article>
	);
}
contributionRegistry.registerRoute({
	kind: "pattern",
	test: { startsWith: "/navigation-proof/" },
	render: (tab) => (
		<Workspace
			title={
				tab.path.includes("/new-")
					? "New workspace"
					: `Workspace ${Number(tab.path.split("/").at(-1)) + 1}`
			}
		/>
	),
});
contributionRegistry.registerRoute({
	kind: "exact",
	path: "/chat",
	render: () => <Workspace title="Workspace 1" />,
});
function Shell() {
	const {
		tabs,
		activeTabId,
		activateTab,
		closeTab,
		unloadTab,
		requestScrollToMessage,
		bindTabConversation,
		updateTabBusy,
	} = useTabsContext();
	const active = tabs.find((tab) => tab.id === activeTabId);
	return (
		<main className="flex h-screen flex-col bg-background text-foreground">
			<nav
				aria-label="Workspace tabs"
				className="flex shrink-0 flex-wrap gap-1 border-b p-2"
			>
				{tabs.map((tab) => (
					<Button
						aria-pressed={tab.id === activeTabId}
						key={tab.id}
						onClick={() => activateTab(tab.id)}
						size="sm"
						variant={tab.id === activeTabId ? "secondary" : "ghost"}
					>
						{tab.title}
					</Button>
				))}
			</nav>
			<div className="flex gap-2 border-b px-3 py-2">
				<Button
					onClick={() => {
						const tab = tabs.at(-1);
						if (tab) {
							unloadTab(tab.id);
						}
					}}
					size="sm"
					variant="outline"
				>
					Unload last tab
				</Button>
				<Button
					onClick={() => {
						if (active) {
							bindTabConversation(active.id, "proof-conversation");
							requestScrollToMessage("proof-conversation", "message-42");
						}
					}}
					size="sm"
					variant="outline"
				>
					Find message
				</Button>
				<Button
					onClick={() => {
						if (active) {
							updateTabBusy(active.id, true);
						}
					}}
					size="sm"
					variant="outline"
				>
					Mark busy
				</Button>
				<span className="self-center text-muted-foreground text-xs">
					{tabs.length} open · {tabs.filter((tab) => !tab.unloaded).length}{" "}
					mounted
				</span>
			</div>
			<div className="relative min-h-0 flex-1">
				{tabs.map((tab) => (
					<IsActiveTabProvider
						isActive={tab.id === activeTabId}
						key={`${tab.id}:${tab.navToken ?? 0}`}
					>
						<CurrentTabIdProvider tabId={tab.id}>
							{tab.unloaded ? null : (
								<div
									className={
										tab.id === activeTabId
											? "absolute inset-0"
											: "absolute inset-0 hidden"
									}
									data-pane={tab.id}
								>
									<RouteOutlet onClose={() => closeTab(tab.id)} tab={tab} />
								</div>
							)}
						</CurrentTabIdProvider>
					</IsActiveTabProvider>
				))}
			</div>
		</main>
	);
}
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<AppSurfaceProvider surface="desktop">
			<EntitlementProvider>
				<TabsProvider>
					<TitleBarProvider>
						<Shell />
					</TitleBarProvider>
				</TabsProvider>
			</EntitlementProvider>
		</AppSurfaceProvider>
	);
}
