import { Button } from "@ryu/ui/components/button.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CloneFolderDialog } from "../../src/components/chat/ProjectPicker.tsx";
import { ConnectionsTab } from "../../src/components/settings/ConnectionsTab.tsx";
import "../../src/index.css";

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { retry: false },
	},
});

function ProofSurface() {
	const [cloneOpen, setCloneOpen] = useState(false);

	return (
		<div className="min-h-screen bg-background px-6 py-8 text-foreground">
			<div className="mx-auto flex max-w-3xl flex-col gap-6">
				<div className="flex items-center justify-between gap-4">
					<div>
						<p className="type-compact font-mono text-muted-foreground uppercase tracking-(--tracking-section)">
							Ryu desktop proof
						</p>
						<p className="mt-1 text-muted-foreground text-xs">
							Live connection hub and project clone entry point
						</p>
					</div>
					<Button
						data-testid="open-clone-dialog"
						onClick={() => setCloneOpen(true)}
						size="sm"
						variant="outline"
					>
						Clone from Git
					</Button>
				</div>
				<ConnectionsTab />
			</div>
			<CloneFolderDialog onOpenChange={setCloneOpen} open={cloneOpen} />
		</div>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Proof root not found");
}

document.documentElement.classList.add("dark");

createRoot(root).render(
	<QueryClientProvider client={queryClient}>
		<ProofSurface />
	</QueryClientProvider>
);
document.body.dataset.harnessReady = "1";
