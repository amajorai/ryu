import { QueueBar } from "@ryu/blocks/desktop/agent-elements/queue/queue-bar.tsx";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

const noop = () => undefined;

function Story() {
	return (
		<main className="min-h-screen bg-muted/30 px-6 py-10 text-foreground">
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
				<div className="space-y-2">
					<p className="font-medium text-muted-foreground text-sm uppercase tracking-(--tracking-section)">
						Desktop chat queue
					</p>
					<h1 className="font-semibold text-3xl tracking-tight">
						Queued messages
					</h1>
					<p className="max-w-2xl text-muted-foreground text-sm">
						Queued prompts stay visible above the composer while the agent is
						busy.
					</p>
				</div>

				<section className="rounded-3xl border border-border/70 bg-card/40 p-4 shadow-sm">
					<QueueBar
						items={[
							{
								content:
									"Review the auth client and identify the device-code path",
								id: "queued-1",
							},
							{
								content: "Then add focused tests for the approval polling loop",
								id: "queued-2",
							},
						]}
						onClear={noop}
						onEdit={noop}
						onRemove={noop}
						onReorder={noop}
						onSendAll={noop}
						onSendNow={noop}
					/>
				</section>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
