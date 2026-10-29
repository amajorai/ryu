// Production Marketplace and Library components with an explicit fixture catalog.
import { LayerIcon } from "@hugeicons/core-free-icons";
import AppIcon from "@ryu/marketplace/catalog/chrome/app-icon";
import { engineLogoProps } from "@ryu/marketplace/catalog/engine-logos";
import { Button } from "@ryu/ui/components/button.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import SidebarLibrarySection from "../../src/components/library/SidebarLibrarySection.tsx";
import EnginesCatalogSection from "../../src/components/store/EnginesCatalogSection.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import catalog from "./engine-logos-catalog.json" with { type: "json" };
import "../../src/index.css";

const node = {
	name: "Logo fixtures",
	url: window.location.origin,
	token: null,
};
useNodeStore.setState({
	nodes: [node],
	defaultNode: node.name,
	getActiveNode: () => node,
});
const queryClient = new QueryClient();
const items = catalog.sidecars.map((engine) => ({
	id: engine.name,
	name: engine.display_name,
	subtitle: engine.category,
	icon: LayerIcon,
	iconNode: (
		<AppIcon
			{...engineLogoProps(engine.name)}
			className="size-8"
			name={engine.display_name}
		/>
	),
	onOpen() {},
}));
function Proof() {
	const [surface, setSurface] = useState("marketplace");
	const [dark, setDark] = useState(true);
	useEffect(() => {
		document.documentElement.classList.toggle("dark", dark);
	}, [dark]);
	const [narrow, setNarrow] = useState(false);
	const [list, setList] = useState(false);
	return (
		<div className={dark ? "dark" : ""}>
			<main className="min-h-screen bg-background text-foreground">
				<nav className="flex flex-wrap items-center gap-2 border-b p-3">
					<span className="mr-auto text-muted-foreground text-sm">
						Engine artwork · fixture catalog
					</span>
					<Button onClick={() => setSurface("marketplace")} variant="outline">
						Marketplace
					</Button>
					<Button onClick={() => setSurface("library")} variant="outline">
						Library
					</Button>
					<Button onClick={() => setDark(!dark)} variant="outline">
						{dark ? "Light mode" : "Dark mode"}
					</Button>
					<Button onClick={() => setNarrow(!narrow)} variant="outline">
						{narrow ? "Wide" : "Narrow"}
					</Button>
					<Button onClick={() => setList(!list)} variant="outline">
						{list ? "Grid" : "List"}
					</Button>
				</nav>
				<section
					className={`mx-auto h-[calc(100vh-65px)] overflow-auto p-4 ${narrow ? "max-w-93.75" : "max-w-300"}`}
				>
					{surface === "marketplace" ? (
						<EnginesCatalogSection />
					) : (
						<SidebarLibrarySection
							icon={LayerIcon}
							items={items}
							label="Engines"
							query=""
							view={list ? "list" : "grid"}
						/>
					)}
				</section>
			</main>
		</div>
	);
}
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={queryClient}>
			<MemoryRouter>
				<Proof />
			</MemoryRouter>
		</QueryClientProvider>
	);
}
