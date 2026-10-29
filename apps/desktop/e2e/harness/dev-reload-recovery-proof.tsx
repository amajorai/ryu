import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { ReconnectRetryBanner } from "../../src/components/shell/ReconnectRetryBanner.tsx";
import { useReconnectRetryRecovery } from "../../src/hooks/useReconnectRetryRecovery.ts";
import { runSummarySchema } from "../../src/lib/api/run-wire-contracts.ts";
import { CHAT_RECOVERY_STOP_EVENT } from "../../src/lib/reconnect-retry.ts";
import "../../src/index.css";

const runSnapshotSchema = z.object({ runs: z.array(runSummarySchema) });

const target = { url: window.location.origin, token: null, userJwt: null };
const probe = async () => {
	const response = await fetch("/api/health");
	if (!response.ok) {
		throw new Error("Node unavailable");
	}
	return undefined;
};

function Story() {
	const [runs, setRuns] = useState<z.output<typeof runSummarySchema>[]>([]);
	const [online, setOnline] = useState<boolean | null>(null);
	const recovery = useReconnectRetryRecovery({
		activeNode: target,
		activeNodeOnline: online,
		devRecovery: true,
		pluginEnabled: false,
		probeActiveNode: probe,
		runs,
	});

	useEffect(() => {
		let active = true;
		const refresh = async () => {
			try {
				await probe();
				const response = await fetch("/api/runs");
				if (!response.ok) {
					throw new Error("Run snapshot unavailable");
				}
				const payload = runSnapshotSchema.parse(await response.json());
				if (active) {
					setRuns(payload.runs);
					setOnline(true);
				}
			} catch {
				if (active) {
					setOnline(false);
				}
			}
		};
		void refresh();
		const timer = window.setInterval(() => void refresh(), 250);
		return () => {
			active = false;
			window.clearInterval(timer);
		};
	}, []);

	const stop = async (conversationId: string) => {
		window.dispatchEvent(
			new CustomEvent(CHAT_RECOVERY_STOP_EVENT, {
				detail: { conversationId, nodeUrl: target.url },
			})
		);
		await fetch(`/api/chat/cancel/${conversationId}`, { method: "POST" });
	};

	return (
		<main
			className="min-h-screen bg-background text-foreground"
			data-phase={recovery.phase}
			data-testid="dev-reload-recovery-proof"
		>
			<div className="mx-auto max-w-4xl px-8 py-12">
				<header className="mb-8">
					<p className="mb-2 text-muted-foreground text-sm">
						Ryu · Development
					</p>
					<h1 className="font-semibold text-3xl tracking-tight">
						Your work continues after reload
					</h1>
					<p className="mt-3 text-muted-foreground">
						Active chats recover automatically. Stopped chats stay stopped.
					</p>
				</header>
				<div className="mb-6 overflow-hidden rounded-xl border border-border">
					<ReconnectRetryBanner state={recovery} />
				</div>
				<section aria-label="Development chats" className="space-y-3">
					{runs.map((run) => (
						<article
							className="flex items-center justify-between rounded-xl border border-border bg-card p-5"
							data-testid={`run-${run.id}`}
							key={run.id}
						>
							<div>
								<h2 className="font-medium">{run.title}</h2>
								<p className="mt-1 text-muted-foreground text-sm">
									{run.run_status === "running"
										? "Agent is working"
										: run.run_status === "completed"
											? "Task complete"
											: "Turn interrupted"}
								</p>
							</div>
							{run.run_status === "running" && (
								<button
									className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted"
									onClick={() => void stop(run.id)}
									type="button"
								>
									Stop {run.title}
								</button>
							)}
						</article>
					))}
				</section>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
