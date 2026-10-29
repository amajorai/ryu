import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ReconnectRetryBanner } from "../../src/components/shell/ReconnectRetryBanner.tsx";
import type { ReconnectRetryState } from "../../src/hooks/useReconnectRetry.ts";
import "../../src/index.css";

type StateKey = "complete" | "error" | "offline" | "retrying";

const STATE_OPTIONS: Array<{ key: StateKey; label: string }> = [
	{ key: "offline", label: "Simulate connection loss" },
	{ key: "retrying", label: "Connection returns" },
	{ key: "complete", label: "Retry completes" },
	{ key: "error", label: "Retry needs attention" },
];

const STATES = {
	complete: {
		candidateCount: 1,
		failedCount: 0,
		phase: "complete",
		retriedCount: 1,
	},
	error: {
		candidateCount: 1,
		failedCount: 1,
		phase: "error",
		retriedCount: 0,
	},
	offline: {
		candidateCount: 1,
		failedCount: 0,
		phase: "offline",
		retriedCount: 0,
	},
	retrying: {
		candidateCount: 1,
		failedCount: 0,
		phase: "retrying",
		retriedCount: 0,
	},
} satisfies Record<StateKey, ReconnectRetryState>;

function Story() {
	const [stateKey, setStateKey] = useState<StateKey>("complete");

	return (
		<main
			className="flex min-h-screen flex-col bg-background text-foreground"
			data-harness-ready="1"
			data-testid="reconnect-retry-proof"
		>
			<div className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-8 py-12">
				<header className="mb-10 max-w-2xl">
					<p className="mb-3 font-medium text-muted-foreground text-sm uppercase tracking-(--tracking-section)">
						Opt-in reliability plugin
					</p>
					<h1 className="font-semibold text-4xl tracking-tight">
						Reconnect Retry
					</h1>
					<p className="mt-4 text-lg text-muted-foreground">
						Pick up chats after Wi-Fi or LAN returns, without sending the same
						prompt twice.
					</p>
				</header>

				<section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
					<ReconnectRetryBanner state={STATES[stateKey]} />
					<div className="grid gap-8 p-8 md:grid-cols-[1fr_auto] md:items-center">
						<div>
							<p className="font-medium text-sm">Live recovery behavior</p>
							<p className="mt-2 max-w-xl text-muted-foreground text-sm leading-6">
								Ryu resumes a still-running stream first. If the selected node
								marks the turn as failed or interrupted, the plugin asks Core
								for one bounded retry when the browser and node are reachable
								again.
							</p>
						</div>
						<div className="rounded-xl border border-border bg-muted/30 p-4 text-sm">
							<p className="font-medium">Current signal</p>
							<p className="mt-1 text-muted-foreground">
								{stateKey === "offline"
									? "Browser or selected node is offline"
									: stateKey === "retrying"
										? "Node reachable; Core is starting the retry"
										: stateKey === "error"
											? "The bounded retry needs a manual follow-up"
											: "One interrupted chat is running again"}
							</p>
						</div>
					</div>
				</section>

				<section aria-labelledby="state-heading" className="mt-8">
					<div className="mb-3 flex items-baseline justify-between gap-4">
						<h2 className="font-medium text-sm" id="state-heading">
							Proof controls
						</h2>
						<span className="text-muted-foreground text-xs">
							Network state simulator
						</span>
					</div>
					<div className="flex flex-wrap gap-2">
						{STATE_OPTIONS.map((option) => (
							<button
								className="rounded-lg border border-border px-3 py-2 text-sm transition-colors hover:bg-muted"
								data-active={stateKey === option.key ? "true" : undefined}
								key={option.key}
								onClick={() => setStateKey(option.key)}
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
