import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { sileo } from "sileo";
import { AddChannelDialog } from "@/src/components/channels/AddChannelDialog.tsx";
import "../../src/index.css";
import { addChannelProofFailureTitle } from "../add-channel-proof.contracts.ts";

function AddChannelDialogProof() {
	const [open, setOpen] = useState(true);
	const proofWindow = window;
	return (
		<main className="min-h-screen bg-background p-8 text-foreground">
			<button
				className="rounded-md border px-3 py-2"
				onClick={() => setOpen(true)}
			>
				Open channel dialog
			</button>
			<AddChannelDialog
				agents={[
					{ id: "agent-support", name: "Support Agent" },
					{ id: "agent-research", name: "Research Agent" },
				]}
				onCreate={async (input) => {
					proofWindow.__ADD_CHANNEL_PROOF__?.calls.push(input);
					const response = await fetch("/api/channels", {
						body: JSON.stringify(input),
						credentials: "include",
						headers: { "Content-Type": "application/json" },
						method: "POST",
					});
					if (!response.ok) {
						const body = await response.json().catch(() => null);
						sileo.error({ title: addChannelProofFailureTitle(body) });
						return false;
					}
					sileo.success({ title: `Channel "${input.name}" created` });
					return true;
				}}
				onNodeCreated={(name) => {
					proofWindow.__ADD_CHANNEL_PROOF__?.nodeCreated.push(name);
				}}
				onOpenChange={setOpen}
				open={open}
				teams={[{ id: "team-ops", name: "Operations Team" }]}
			/>
			<Toaster position="bottom-right" theme="dark" />
		</main>
	);
}

const proofWindow = window;
proofWindow.__ADD_CHANNEL_PROOF__ = { calls: [], nodeCreated: [] };
const root = document.getElementById("root");
if (!root) {
	throw new Error("Add channel proof root is missing");
}
createRoot(root).render(<AddChannelDialogProof />);

document.body.dataset.harnessReady = "1";
