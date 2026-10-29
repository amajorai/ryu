import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import {
	type LayerOption,
	NodeLayerMenu,
} from "../../src/components/shell/NodeLayerMenu.tsx";
import {
	NodePanelNav,
	PanelBackButton,
	PanelGroup,
} from "../../src/components/shell/NodePanelNav.tsx";
import { WebSearchAccessMenu } from "../../src/components/shell/WebSearchAccessMenu.tsx";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import "../../src/index.css";

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

const searchProvider: LayerOption = {
	name: "exa",
	label: "Exa",
	active: true,
	detail: "default provider",
	select: () => undefined,
};

/** The expanded Computer dialog's surface: layers are pages on a stack. */
function PanelProofPage() {
	const target: ApiTarget = { url: window.location.origin };

	return (
		<QueryClientProvider client={queryClient}>
			<main className="flex min-h-screen items-start justify-center bg-background p-14 text-foreground">
				<section
					className="flex w-96 flex-col gap-3 rounded-xl border bg-card p-4 shadow-lg"
					data-testid="panel-proof"
				>
					<NodePanelNav
						renderHeader={({ back, backLabel, title }) => (
							<header className="min-h-12">
								{back && backLabel ? (
									<>
										<PanelBackButton label={backLabel} onClick={back} />
										<h1 className="font-medium text-base">{title}</h1>
									</>
								) : (
									<h1 className="font-medium text-base">Computer</h1>
								)}
							</header>
						)}
						root={
							<PanelGroup>
								<NodeLayerMenu
									caption="Provider for web.search"
									currentLabel="Exa"
									installed={[searchProvider]}
									label="Search"
								>
									<WebSearchAccessMenu enabled target={target} />
								</NodeLayerMenu>
							</PanelGroup>
						}
					/>
				</section>
			</main>
		</QueryClientProvider>
	);
}

function ProofPage() {
	const target: ApiTarget = { url: window.location.origin };

	return (
		<QueryClientProvider client={queryClient}>
			<main className="flex min-h-screen items-start justify-center bg-background p-14 text-foreground">
				<section className="flex w-80 flex-col gap-3 rounded-xl border bg-card p-4 shadow-lg">
					<div>
						<h1 className="font-medium text-sm">Node tools</h1>
						<p className="text-muted-foreground text-xs">
							Choose a provider and set web access.
						</p>
					</div>
					<DropdownMenu>
						<DropdownMenuTrigger variant="toolkit-picker">
							Toolkits
						</DropdownMenuTrigger>
						<DropdownMenuContent className="w-72" sideOffset={6}>
							<NodeLayerMenu
								caption="Provider for web.search"
								currentLabel="Exa"
								installed={[searchProvider]}
								label="Search"
							>
								<WebSearchAccessMenu enabled target={target} />
							</NodeLayerMenu>
						</DropdownMenuContent>
					</DropdownMenu>
				</section>
			</main>
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Proof page root not found");
}

const panel =
	new URLSearchParams(window.location.search).get("surface") === "panel";
createRoot(root).render(panel ? <PanelProofPage /> : <ProofPage />);
