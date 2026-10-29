declare const window: Window;

// Browser proof for the archive/stop contract. It uses the shipping
// conversation-flags store and chat-stop registry; only Core's HTTP response is
// stubbed because this isolated story has no running node.

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { registerChatStop } from "../../src/lib/chat-stop-registry.ts";
import { useConversationFlagsStore } from "../../src/store/useConversationFlagsStore.ts";
import "../../src/index.css";

const CHAT_ID = "archive-stop-proof-chat";
let archiveWrites = 0;

const realFetch = window.fetch.bind(globalThis);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = input instanceof Request ? input.url : String(input);
	if (url.includes(`/api/conversations/${CHAT_ID}/archived`)) {
		archiveWrites += 1;
		window.dispatchEvent(new Event("archive-proof-write"));
		return Response.json({ archived: true, ok: true });
	}
	return realFetch(input, init);
};

useConversationFlagsStore.setState({ archivedIds: new Set() });

function Proof() {
	const archived = useConversationFlagsStore((state) =>
		state.archivedIds.has(CHAT_ID)
	);
	const [status, setStatus] = useState<"streaming" | "stopped">("streaming");
	const [stopCount, setStopCount] = useState(0);
	const [writeCount, setWriteCount] = useState(archiveWrites);

	useEffect(() => {
		const onArchiveWrite = () => setWriteCount(archiveWrites);
		window.addEventListener("archive-proof-write", onArchiveWrite);
		return () =>
			window.removeEventListener("archive-proof-write", onArchiveWrite);
	}, []);

	useEffect(
		() =>
			registerChatStop(CHAT_ID, () => {
				setStatus("stopped");
				setStopCount((count) => count + 1);
			}),
		[]
	);

	const archive = () =>
		useConversationFlagsStore.getState().toggleArchive(CHAT_ID);

	return (
		<main className="min-h-screen bg-background p-8 text-foreground">
			<section className="mx-auto max-w-2xl rounded-2xl border bg-card p-6 shadow-sm">
				<div className="flex items-start justify-between gap-4">
					<div>
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
							Live interaction proof
						</p>
						<h1 className="mt-2 font-semibold text-2xl">
							Archive stops an in-progress chat
						</h1>
						<p className="mt-2 text-muted-foreground text-sm">
							The archive action targets the same conversation id as the mounted
							stream, so the local stop runs before the archive write.
						</p>
					</div>
					<span
						className={`rounded-full px-3 py-1 font-medium text-xs ${status === "streaming" ? "bg-warning/15 text-warning" : "bg-success/15 text-success"}`}
						data-testid="proof-status"
					>
						{status === "streaming"
							? "Reply in progress"
							: "Stopped immediately"}
					</span>
				</div>

				<div className="mt-6 rounded-xl border border-dashed p-4">
					<div className="flex items-center justify-between gap-3">
						<div>
							<p className="font-medium text-sm">Conversation: {CHAT_ID}</p>
							<p className="mt-1 text-muted-foreground text-xs">
								{archived ? "Archived" : "Active"} · local stop calls:{" "}
								{stopCount} · archive writes: {writeCount}
							</p>
						</div>
						<button
							className="rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground text-sm disabled:opacity-50"
							data-testid="archive-chat"
							disabled={archived}
							onClick={archive}
							type="button"
						>
							{archived ? "Archived" : "Archive chat"}
						</button>
					</div>
				</div>

				<div className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
					<div className="rounded-lg bg-muted/50 p-3">
						<p className="text-muted-foreground text-xs">Local stream</p>
						<p data-testid="proof-local">{status}</p>
					</div>
					<div className="rounded-lg bg-muted/50 p-3">
						<p className="text-muted-foreground text-xs">Flag store</p>
						<p data-testid="proof-archive">
							{archived ? "archived" : "active"}
						</p>
					</div>
					<div className="rounded-lg bg-muted/50 p-3">
						<p className="text-muted-foreground text-xs">Core write</p>
						<p data-testid="proof-write">
							{writeCount > 0 ? "sent" : "pending"}
						</p>
					</div>
				</div>
			</section>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Proof />);
}
