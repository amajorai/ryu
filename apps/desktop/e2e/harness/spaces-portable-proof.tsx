import { SpacesView } from "@ryu/blocks/desktop/spaces.tsx";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

const space = {
	description: "Customer interviews, briefs, and market data",
	documentCount: 14,
	id: "space_portable_proof",
	name: "Product research",
	retrievalMode: "vector" as const,
};

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<div className="min-h-screen bg-background text-foreground">
			<SpacesView
				detail={{
					documents: [
						{
							chunkCount: 0,
							id: "portable-page",
							kind: "page",
							title: "Research brief",
						},
					],
					searchQuery: "",
					onExportPackage: () => undefined,
					onImportPackage: () => undefined,
					space,
				}}
				spaces={[space]}
			/>
		</div>
	);
}
