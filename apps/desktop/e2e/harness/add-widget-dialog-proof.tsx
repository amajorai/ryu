import { I18nProvider } from "@ryu/i18n/react";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AddWidgetDialog } from "@/src/components/dashboard/AddWidgetDialog.tsx";
import type { WidgetInput } from "@/src/lib/api/dashboard.ts";
import "../../src/index.css";

// Every source the dialog offers; the dialog lists only the node's supported source types
// (the required `sourceTypes` prop from ec6fac15e2), and this proof walks all of them.
const PROOF_SOURCE_TYPES = [
	"core_endpoint",
	"monitor",
	"workflow",
	"composio",
	"http",
	"agent",
	"static",
];

function AddWidgetDialogProof() {
	const [open, setOpen] = useState(true);
	const [created, setCreated] = useState<WidgetInput | null>(null);
	const [createCount, setCreateCount] = useState(0);

	return (
		<I18nProvider packs={[]}>
			<I18nDirectionProvider>
				<main className="min-h-screen bg-background p-8 text-foreground">
					<h1 className="font-semibold text-xl">Dashboard widget setup</h1>
					<p data-testid="widget-proof-status" role="status">
						{created ? `Created ${created.title}` : "No widget created"}
					</p>
					<button
						className="mt-4 rounded-md border px-3 py-2"
						onClick={() => setOpen(true)}
						type="button"
					>
						Open widget dialog
					</button>
					<output className="sr-only" data-testid="widget-proof-state">
						{JSON.stringify({ createCount, created, open })}
					</output>
					<AddWidgetDialog
						coreEndpoints={["agents.list", "gateway.health", "memory.stats"]}
						onCreate={async (input) => {
							setCreated(input);
							setCreateCount((current) => current + 1);
						}}
						onOpenChange={setOpen}
						open={open}
						sourceTypes={PROOF_SOURCE_TYPES}
					/>
				</main>
			</I18nDirectionProvider>
		</I18nProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Add widget proof root is missing");
}
createRoot(root).render(<AddWidgetDialogProof />);
