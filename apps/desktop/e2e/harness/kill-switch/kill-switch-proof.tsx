import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import {
	EntityRowGlyph,
	useContributedRowsFor,
} from "../../../src/components/layout/tab-entity-menu.tsx";
import "../../../src/index.css";

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function KillSwitchProof() {
	const rows = useContributedRowsFor(
		"conversation",
		"conversation_id"
	)("kill-switch-proof");
	return (
		<main className="min-h-screen bg-background p-8 text-foreground">
			<section className="mx-auto max-w-xl rounded-xl border bg-card p-6">
				<h1 className="font-semibold text-xl">Chats</h1>
				<p className="mt-2 text-muted-foreground text-sm">
					Right-click a chat to control execution on this node.
				</p>
				<ContextMenu>
					<ContextMenuTrigger
						render={
							<div className="mt-6 block w-full rounded-lg border p-4 text-start" />
						}
					>
						<span className="font-medium">Project research</span>
						<span className="mt-1 block text-muted-foreground text-sm">
							Chat and bot execution controls
						</span>
					</ContextMenuTrigger>
					<ContextMenuContent>
						{rows.map((row) => (
							<ContextMenuItem key={row.id} onClick={row.onSelect}>
								<EntityRowGlyph row={row} />
								{row.label}
							</ContextMenuItem>
						))}
					</ContextMenuContent>
				</ContextMenu>
			</section>
			<Toaster />
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={queryClient}>
			<KillSwitchProof />
		</QueryClientProvider>
	);
}
