import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { sileo } from "sileo";
import {
	type ComposerSelectionApplyMode,
	composerSelectionToastDescription,
	shouldShowComposerSelectionToast,
} from "../../src/hooks/useComposerSelectionApplyMode.ts";
import "../../src/index.css";

function Story() {
	const [working, setWorking] = useState(false);
	const [mode, setMode] = useState<ComposerSelectionApplyMode>("next-turn");

	const changeEffort = () => {
		if (!shouldShowComposerSelectionToast(working)) {
			return;
		}
		sileo.info({
			duration: null,
			id: "composer-selection-proof",
			title: "Effort: High",
			description: composerSelectionToastDescription(mode),
		});
	};

	return (
		<div className="min-h-screen bg-background p-10 text-foreground">
			<div className="mx-auto max-w-xl rounded-xl border border-border bg-card p-6 shadow-sm">
				<div className="mb-6">
					<p className="text-muted-foreground text-sm">General · Chats</p>
					<h1 className="mt-1 font-semibold text-xl">
						Composer selection changes
					</h1>
				</div>
				<div className="flex items-center justify-between gap-6 border-border border-b pb-5">
					<div>
						<p className="font-medium">Apply agent, model & effort changes</p>
						<p className="mt-1 text-muted-foreground text-sm">
							The confirmation toast only appears while an agent is working.
						</p>
					</div>
					<select
						aria-label="Composer selection changes"
						className="h-9 rounded-md border border-border bg-background px-3 text-sm"
						data-testid="apply-mode"
						onChange={(event) =>
							setMode(
								/* SAFETY: This authored native select renders precisely next-turn and next-user-message, the actual ComposerSelectionApplyMode choices. This fixture forwards a genuine rendered selection, not an arbitrary synthetic-event contract. */ event
									.target.value as ComposerSelectionApplyMode
							)
						}
						value={mode}
					>
						<option value="next-turn">On the next turn</option>
						<option value="next-user-message">On the next user message</option>
					</select>
				</div>
				<div className="mt-5 flex items-center gap-3">
					<button
						className="rounded-md border border-border px-3 py-2 text-sm"
						data-testid="working-toggle"
						onClick={() => setWorking((current) => !current)}
						type="button"
					>
						{working ? "Agent working" : "Agent idle"}
					</button>
					<button
						className="rounded-md bg-primary px-3 py-2 text-primary-foreground text-sm"
						data-testid="change-effort"
						onClick={changeEffort}
						type="button"
					>
						Change effort to High
					</button>
				</div>
			</div>
			<Toaster position="bottom-right" theme="system" />
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
