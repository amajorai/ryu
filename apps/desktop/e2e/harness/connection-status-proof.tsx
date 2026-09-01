import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import {
	ConnectionStatusToastView,
	type ConnectionStatusToastViewProps,
} from "../../src/components/shell/ConnectionStatusToast.tsx";
import type { ConnectionPhase } from "../../src/lib/connectivity.ts";

type ProofState = "checking" | "node-unreachable" | "offline" | "restored";

const STATE_OPTIONS: Array<{ key: ProofState; label: string }> = [
	{ key: "node-unreachable", label: "Simulate node outage" },
	{ key: "offline", label: "Simulate no Wi-Fi" },
	{ key: "checking", label: "Reconnect" },
	{ key: "restored", label: "Confirm restored" },
];

const stateCopy: Record<ProofState, string> = {
	checking: "The shell stays usable while the active node is checked.",
	"node-unreachable":
		"Only the selected node is unavailable; the rest of the workspace remains mounted.",
	offline:
		"The device has no network connection; Ryu waits without replacing the workspace.",
	restored: "The node answered again and the shell confirms recovery briefly.",
};

function toToastProps(
	state: ProofState,
	setState: (next: ProofState) => void
): ConnectionStatusToastViewProps {
	const phase: ConnectionPhase = state === "restored" ? "online" : state;
	return {
		nodeName: "Design node",
		onRetry:
			state === "node-unreachable" ? () => setState("checking") : undefined,
		phase,
		restored: state === "restored",
	};
}

function Story() {
	const [state, setState] = useState<ProofState>("node-unreachable");

	return (
		<main
			className="min-h-screen bg-background text-foreground"
			data-harness-ready="1"
			data-testid="connection-status-proof"
		>
			<ConnectionStatusToastView {...toToastProps(state, setState)} />
			<div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-6 py-24 sm:px-10">
				<header className="max-w-2xl">
					<p className="font-medium text-muted-foreground text-sm uppercase tracking-[0.18em]">
						Desktop reliability
					</p>
					<h1 className="mt-3 font-semibold text-4xl tracking-tight sm:text-5xl">
						Your workspace stays open.
					</h1>
					<p className="mt-4 text-lg text-muted-foreground leading-7">
						Connection problems are surfaced as a small, recoverable status —
						not an app-wide error screen.
					</p>
				</header>

				<section className="mt-12 grid gap-6 rounded-3xl border border-border bg-card p-6 shadow-sm sm:p-8 md:grid-cols-[1fr_18rem]">
					<div>
						<div className="flex items-center gap-2 text-muted-foreground text-sm">
							<span className="size-2 rounded-full bg-success" />
							Workspace mounted
						</div>
						<h2 className="mt-5 font-medium text-xl">
							Open tabs remain available
						</h2>
						<p className="mt-2 max-w-xl text-muted-foreground text-sm leading-6">
							The sidebar, current tab, and local drafts remain in place while
							live node work waits. When the connection returns, the app checks
							the node and refreshes affected data automatically.
						</p>
					</div>
					<div className="rounded-2xl border border-border bg-muted/30 p-4">
						<p className="font-medium text-sm">Current behavior</p>
						<p className="mt-2 text-muted-foreground text-sm leading-6">
							{stateCopy[state]}
						</p>
					</div>
				</section>

				<section aria-labelledby="proof-controls" className="mt-8">
					<div className="flex items-baseline justify-between gap-4">
						<h2 className="font-medium text-sm" id="proof-controls">
							Proof controls
						</h2>
						<span className="text-muted-foreground text-xs">
							Network state simulator
						</span>
					</div>
					<div className="mt-3 flex flex-wrap gap-2">
						{STATE_OPTIONS.map((option) => (
							<button
								className="rounded-full border border-border px-3 py-2 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								data-active={state === option.key ? "true" : undefined}
								key={option.key}
								onClick={() => setState(option.key)}
								type="button"
							>
								{option.label}
							</button>
						))}
					</div>
				</section>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
