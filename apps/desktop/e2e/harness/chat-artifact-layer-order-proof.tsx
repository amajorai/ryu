// Mirrors the shipping entry order in `src/main.tsx`: the App graph is imported
// before `./index.css`. App → Layout → ProjectDockHost → WorkspacePanels →
// ArtifactRenderer statically reaches `artifact-renderer.module.css`, so that
// module's stylesheet precedes the Tailwind entry in both dev injection and the
// built CSS. Only the real component and the real global stylesheet load here.
import { I18nProvider } from "@ryu/i18n/react";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { createRoot } from "react-dom/client";
import { ArtifactRenderer } from "../../src/components/chat/ArtifactRenderer.tsx";
import "../../src/index.css";

function LayerOrderProof() {
	return (
		<I18nProvider>
			<TooltipProvider>
				<main className="min-h-screen bg-background text-foreground">
					<h1 className="sr-only">Chat artifact stylesheet layer order</h1>
					<div className="mx-2 px-2 py-1.5" data-testid="dock-row">
						<button className="p-1" data-testid="edge-control" type="button">
							Refresh
						</button>
					</div>
					{/* Independent oracle: the same theme spacing resolved inline. */}
					<div
						data-testid="spacing-oracle"
						style={{
							margin: "0 calc(var(--spacing) * 2)",
							padding: "calc(var(--spacing) * 1)",
						}}
					/>
					<section className="h-64" data-testid="artifact">
						<ArtifactRenderer
							artifact={{
								content: "const answer = 42;",
								id: "layer-order-artifact",
								kind: "code",
								language: "ts",
								sourceMessageId: "layer-order-message",
								title: "answer.ts",
							}}
						/>
					</section>
				</main>
			</TooltipProvider>
		</I18nProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("The layer order proof root is missing.");
}
createRoot(root).render(<LayerOrderProof />);
