import "./marketplace-publish-dialog-proof-fixture.ts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PublishDialog } from "../../src/components/marketplace/PublishDialog.tsx";
import "../../src/index.css";

function ProofArtifact() {
	const [open, setOpen] = useState(true);
	return (
		<main className="dark min-h-screen bg-background px-8 py-8 text-foreground">
			<div className="mx-auto max-w-4xl">
				<header className="mb-6 flex items-start justify-between gap-4">
					<div>
						<div className="text-primary text-xs tracking-table-label">
							RYU · LIVE REACT PROOF
						</div>
						<h1 className="mt-2 font-semibold text-3xl">
							Marketplace publisher
						</h1>
						<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
							Production PublishDialog with local API responses and capture-only
							Tauri openExternal. No repository or browser is opened.
						</p>
					</div>
					<div className="flex flex-col items-end gap-2">
						<span data-testid="dialog-open-state">
							{open ? "open" : "closed"}
						</span>
						<button
							className="rounded-lg border px-3 py-2 text-sm"
							onClick={() => setOpen(true)}
							type="button"
						>
							Open publisher
						</button>
					</div>
				</header>
				<PublishDialog kindLabel="App" onOpenChange={setOpen} open={open} />
			</div>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(<ProofArtifact />);
