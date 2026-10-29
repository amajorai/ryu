import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { createRoot } from "react-dom/client";
import { CloudSyncSection } from "../../src/components/settings/CloudSyncSection.tsx";
import { installCloudSyncProofFetch } from "./desktop-cloud-sync-settings-proof.mock.ts";
import "../../src/index.css";

const restoreFetch = installCloudSyncProofFetch();
window.addEventListener("pagehide", restoreFetch, { once: true });

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing root");
}

createRoot(root).render(
	<div className="min-h-screen bg-background p-8 text-foreground">
		<main className="mx-auto flex w-full max-w-3xl flex-col gap-6">
			<header>
				<p className="mb-2 text-primary text-xs tracking-(--tracking-section)">
					RYU · DESKTOP SETTINGS
				</p>
				<h1 className="font-medium text-3xl">Connections</h1>
				<p className="mt-2 text-muted-foreground text-sm">
					Sync preferences and node authentication reported by the active node.
				</p>
			</header>
			<CloudSyncSection />
		</main>
		<Toaster position="bottom-right" theme="dark" />
	</div>
);
