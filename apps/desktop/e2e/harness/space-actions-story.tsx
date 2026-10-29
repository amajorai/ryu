import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SpaceScopeMenu } from "../../src/components/layout/AppSidebar.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";
import type { Space } from "../../src/lib/api/spaces.ts";
import { createTabsProofContext } from "./tabs-proof-context.ts";
import "../../src/index.css";

const INITIAL_SPACE: Space = {
	createdAt: Date.now(),
	description: null,
	documentCount: 3,
	icon: null,
	id: "space-actions-story",
	name: "Research notes",
	retrievalMode: "vector",
	system: false,
	updatedAt: Date.now(),
};

function Story() {
	const [space, setSpace] = useState(INITIAL_SPACE);
	const [status, setStatus] = useState("Ready");
	const tabsContext = createTabsProofContext({
		updateTabsIconWhere: () => undefined,
	});

	return (
		<TabsContext.Provider value={tabsContext}>
			<main className="flex min-h-screen flex-col gap-4 bg-background p-10 text-foreground">
				<div className="flex max-w-sm items-center justify-between rounded-lg border p-3">
					<div>
						<p className="text-muted-foreground text-xs">Spaces</p>
						<p className="font-medium text-sm" data-testid="space-name">
							{space.name}
						</p>
					</div>
					<SpaceScopeMenu
						canMakePrivate
						contributedRows={[]}
						onAdd={() => setStatus("Add files")}
						onOpen={() => setStatus("Open space page")}
						onOpenInNewTab={() => setStatus("Open in new tab")}
						onRename={async (name) => {
							setSpace((current) => ({
								...current,
								name,
								updatedAt: Date.now(),
							}));
							setStatus(`Renamed to ${name}`);
						}}
						onRequestDelete={() => setStatus("Delete requested")}
						onRequestVisibilityChange={(request) => {
							setSpace((current) => ({
								...current,
								visibility: request.to === "team" ? "org" : "private",
							}));
							setStatus(
								request.to === "team" ? "Shared with the team" : "Made private"
							);
						}}
						setSpaceIcon={async () => undefined}
						space={space}
					/>
				</div>
				<output data-testid="action-status">{status}</output>
			</main>
		</TabsContext.Provider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
