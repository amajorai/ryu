import { Button } from "@ryu/ui/components/button.tsx";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LanguagePackBridge } from "../../src/components/LanguagePackBridge.tsx";
import { SkillDistributionProvider } from "../../src/components/skills/SkillDistributionProvider.tsx";
import { WallpaperBackdrop } from "../../src/components/wallpaper/WallpaperBackdrop.tsx";
import { ChatHistoryProvider } from "../../src/contexts/ChatHistoryContext.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { SpacesProvider } from "../../src/contexts/SpacesContext.tsx";
import {
	TabsProvider,
	useTabSelector,
} from "../../src/contexts/TabsContext.tsx";
import { useWallpaper } from "../../src/lib/wallpaper.ts";
import LibraryPage from "../../src/pages/LibraryPage.tsx";
import StorePage from "../../src/pages/StorePage.tsx";
import "../../src/index.css";

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function ActivePage() {
	const activePath = useTabSelector(
		(state) =>
			state.tabs.find((tab) => tab.id === state.activeTabId)?.path ??
			"/marketplace/wallpapers"
	);
	const openTab = useTabSelector((state) => state.openTab);
	const isLibrary = activePath.startsWith("/library");

	return (
		<div className="flex h-screen flex-col bg-background text-foreground">
			<header className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
				<Button
					aria-current={isLibrary ? undefined : "page"}
					data-testid="open-marketplace"
					onClick={() =>
						openTab("/marketplace/wallpapers", { title: "Marketplace" })
					}
					size="sm"
					variant={isLibrary ? "ghost" : "secondary"}
				>
					Marketplace
				</Button>
				<Button
					aria-current={isLibrary ? "page" : undefined}
					data-testid="open-library"
					onClick={() => openTab("/library/wallpapers", { title: "Library" })}
					size="sm"
					variant={isLibrary ? "secondary" : "ghost"}
				>
					Library
				</Button>
			</header>
			<main className="min-h-0 flex-1" data-testid="product-page">
				{isLibrary ? (
					<LibraryPage initialSection="wallpapers" />
				) : (
					<StorePage initialSection="wallpapers" />
				)}
			</main>
			<ActiveWallpaperProof />
		</div>
	);
}

function ActiveWallpaperProof() {
	const { wallpaper } = useWallpaper();
	return (
		<aside
			aria-label="Rendered desktop wallpaper"
			className="flex h-20 shrink-0 items-center gap-3 border-t bg-muted/40 px-4"
			data-testid="active-wallpaper-proof"
		>
			<div className="relative h-14 w-24 overflow-hidden rounded-md border">
				<WallpaperBackdrop live={false} wallpaper={wallpaper} />
			</div>
			<div className="min-w-0">
				<p className="text-muted-foreground text-xs">Applied on this device</p>
				<p className="truncate font-medium text-sm">{wallpaper.label}</p>
				<output className="sr-only" data-testid="active-wallpaper-id">
					{wallpaper.id}
				</output>
			</div>
		</aside>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Root element not found");
}

createRoot(root).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<LanguagePackBridge>
				<TooltipProvider delay={0}>
					<EntitlementProvider>
						<TabsProvider
							initialTab={{
								path: "/marketplace/wallpapers",
								title: "Marketplace",
							}}
						>
							<SkillDistributionProvider>
								<ChatHistoryProvider>
									<SpacesProvider>
										<ActivePage />
									</SpacesProvider>
								</ChatHistoryProvider>
							</SkillDistributionProvider>
						</TabsProvider>
					</EntitlementProvider>
				</TooltipProvider>
			</LanguagePackBridge>
		</QueryClientProvider>
	</StrictMode>
);
