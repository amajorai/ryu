import { I18nProvider } from "@ryu/i18n/react";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { BrowserBotLiveView } from "@/src/components/panels/workspace-panels/browser-bot-live-view.tsx";
import {
	askForTakeover,
	PROOF_BASE,
	proofCall,
	proofSnapshot,
	proofVersion,
	startProof,
	subscribeProof,
} from "./browser-takeover-proof-sidecar.ts";
import "../../src/index.css";

const HEADERS = { Authorization: "Bearer proof-token" };
const search = window.location.search;

startProof(search);
if (new URLSearchParams(search).get("theme") === "dark") {
	document.documentElement.classList.add("dark");
}

/** The Browser dock's Agents view on a stand-in sidecar, with its state readable. */
function BrowserTakeoverProof() {
	useSyncExternalStore(subscribeProof, proofVersion);
	return (
		<I18nProvider packs={[]}>
			<I18nDirectionProvider>
				<main className="flex h-screen flex-col bg-background text-foreground">
					<header className="flex items-center gap-3 border-border border-b px-3 py-2 text-xs">
						<span className="font-medium">Browser dock - Agents</span>
						<button
							className="rounded-md border border-border px-2 py-1"
							onClick={askForTakeover}
							type="button"
						>
							Agent asks for a takeover
						</button>
					</header>
					<BrowserBotLiveView
						active
						base={PROOF_BASE}
						call={proofCall}
						headers={HEADERS}
					/>
					<output className="sr-only" data-testid="takeover-proof-state">
						{JSON.stringify(proofSnapshot())}
					</output>
				</main>
			</I18nDirectionProvider>
		</I18nProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Browser takeover proof root is missing");
}
createRoot(root).render(<BrowserTakeoverProof />);
