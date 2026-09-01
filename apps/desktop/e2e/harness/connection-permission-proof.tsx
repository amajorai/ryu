import { Shield01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	accessLevelSummary,
	ConnectionPermissionDialog,
} from "../../src/components/marketplace/ConnectionPermissionDialog.tsx";
import type { ConnectionAccessLevel } from "../../src/lib/connection-permissions.ts";
import "../../src/index.css";

function ProofSurface() {
	const [connection, setConnection] = useState<"Composio" | "MCP">("Composio");
	const [open, setOpen] = useState(false);
	const [levels, setLevels] = useState<
		Record<"Composio" | "MCP", ConnectionAccessLevel>
	>({ Composio: "risk_based", MCP: "risk_based" });

	return (
		<div className="min-h-screen bg-background px-6 py-10 text-foreground">
			<div className="mx-auto max-w-3xl space-y-8">
				<header className="space-y-3">
					<div className="flex items-center gap-2 text-muted-foreground text-xs uppercase tracking-[0.14em]">
						<HugeiconsIcon className="size-4" icon={Shield01Icon} />
						<span>Ryu connection review</span>
					</div>
					<h1 className="font-semibold text-2xl tracking-tight">
						Connected accounts stay on a clear access ceiling
					</h1>
					<p className="max-w-2xl text-muted-foreground text-sm leading-relaxed">
						Every MCP and Composio account gets the same people-data permission
						review before authorization.
					</p>
				</header>

				<div className="grid gap-3 sm:grid-cols-2">
					{(["Composio", "MCP"] as const).map((kind) => (
						<div
							className="rounded-2xl border border-border/70 bg-card p-4"
							key={kind}
						>
							<div className="flex items-start justify-between gap-3">
								<div>
									<p className="font-medium text-sm">
										{kind === "Composio" ? "Salesforce" : "People MCP"}
									</p>
									<p className="mt-1 text-muted-foreground text-xs">
										{kind} account
									</p>
								</div>
								<Badge variant="outline">
									{accessLevelSummary(levels[kind])}
								</Badge>
							</div>
							<Button
								className="mt-4 w-full"
								onClick={() => {
									setConnection(kind);
									setOpen(true);
								}}
								size="sm"
								variant="outline"
							>
								Review {kind} access
							</Button>
						</div>
					))}
				</div>

				<div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-muted-foreground text-sm">
					<span className="font-medium text-foreground">
						People-data guardrail:
					</span>{" "}
					start with Risk-based or Read only when an account may contain
					contacts, messages, customer records, or HR details.
				</div>
			</div>

			<ConnectionPermissionDialog
				connectionName={connection === "Composio" ? "Salesforce" : "People MCP"}
				connectionType={connection}
				currentLevel={levels[connection]}
				onConfirm={async (level) => {
					setLevels((current) => ({ ...current, [connection]: level }));
				}}
				onOpenChange={setOpen}
				open={open}
			/>
		</div>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Proof root not found");
}

document.documentElement.classList.add("dark");
document.body.dataset.harnessReady = "1";

createRoot(root).render(<ProofSurface />);
