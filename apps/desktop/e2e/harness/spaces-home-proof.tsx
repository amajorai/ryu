import type { SpaceDocumentRow } from "@ryu/blocks/desktop/spaces.tsx";
import { SpacesView } from "@ryu/blocks/desktop/spaces.tsx";
import { FileUpload } from "@ryu/ui/components/file-upload.tsx";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import {
	SpacesProvider,
	useSpacesContext,
} from "../../src/contexts/SpacesContext.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import { queryClient } from "../../src/lib/query-client.ts";
import SpacesPage from "../../src/pages/SpacesPage.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

const updatedAt = Date.parse("2026-09-14T08:00:00Z");

const space = {
	description: "Product decisions, launch notes, and the research behind them.",
	documentCount: 5,
	id: "space_product",
	name: "Product research",
	retrievalMode: "vector" as const,
};

useNodeStore.setState({
	autoSelect: false,
	defaultNode: "Proof",
	nodes: [
		{
			name: "Proof",
			url: "http://127.0.0.1:5222/alpha",
			token: null,
			userJwt: null,
		},
	],
});

const documents: SpaceDocumentRow[] = [
	{
		chunkCount: 9,
		id: "page_launch",
		kind: "page",
		preview:
			"# Launch brief\n\nThe next release should feel calm, fast, and grounded in the work already done.\n\n- Make the first run obvious\n- Keep the source close",
		rawKind: "page",
		title: "Launch brief",
		updatedAt,
	},
	{
		chunkCount: 6,
		id: "page_roadmap",
		kind: "page",
		preview:
			"# Q4 roadmap\n\nA small set of durable bets for the quarter.\n\n## Focus\n\n- Shared context\n- Local-first workflows",
		rawKind: "page",
		title: "Q4 roadmap",
		updatedAt: updatedAt - 86_400_000,
	},
	{
		chunkCount: 4,
		id: "page_interviews",
		kind: "page",
		preview:
			"# Interview notes\n\nCustomers want the answer and the source together, without another tab to manage.",
		rawKind: "page",
		title: "Interview notes",
		updatedAt: updatedAt - 172_800_000,
	},
	{
		byteSize: 2_621_440,
		chunkCount: 12,
		id: "file_research",
		indexState: "indexed",
		kind: "page",
		mime: "application/pdf",
		rawKind: "file",
		title: "Research synthesis.pdf",
		updatedAt: updatedAt - 259_200_000,
	},
	{
		chunkCount: 18,
		id: "db_feedback",
		kind: "database",
		rawKind: "database",
		title: "Feedback tracker",
		updatedAt: updatedAt - 345_600_000,
	},
];

function Story() {
	const [openedDocument, setOpenedDocument] = useState("None");
	const [lastAction, setLastAction] = useState("None");
	return (
		<main className="min-h-screen bg-background text-foreground">
			<SpacesView
				detail={{
					documents,
					onNewDatabase: () => setLastAction("new-database"),
					onNewPage: () => setLastAction("new-page"),
					onNewWhiteboard: () => setLastAction("new-whiteboard"),
					onOpenDoc: (id, title) => setOpenedDocument(`${id}:${title}`),
					onSearchQueryChange: () => undefined,
					onSearchSubmit: () => setLastAction("search"),
					searchQuery: "",
					space,
					uploadPanel: (
						<section
							aria-labelledby="space-upload-title"
							className="rounded-lg border border-border/70 bg-white/80 p-4 dark:bg-card"
							data-testid="space-upload-panel"
						>
							<h2 className="font-medium text-sm" id="space-upload-title">
								Add files
							</h2>
							<div className="mt-3">
								<FileUpload
									description="Files are read and indexed by this node"
									items={[]}
									onFilesAdded={() => undefined}
									title="Drop files here"
								/>
							</div>
						</section>
					),
				}}
				spaces={[space]}
			/>
			<output aria-label="Opened document" className="sr-only">
				{openedDocument}
			</output>
			<output aria-label="Last action" className="sr-only">
				{lastAction}
			</output>
		</main>
	);
}

function LiveStory() {
	const { spaces } = useSpacesContext();
	return (
		<main className="min-h-screen bg-background text-foreground">
			<SpacesPage />
			<output aria-label="Live spaces loaded" className="sr-only">
				{spaces.length}
			</output>
		</main>
	);
}

const app = location.search.includes("live") ? (
	<QueryClientProvider client={queryClient}>
		<AppSurfaceProvider surface="desktop">
			<EntitlementProvider>
				<TabsProvider>
					<SpacesProvider>
						<LiveStory />
					</SpacesProvider>
				</TabsProvider>
			</EntitlementProvider>
		</AppSurfaceProvider>
	</QueryClientProvider>
) : (
	<Story />
);

createRoot(document.getElementById("root")!).render(app);
