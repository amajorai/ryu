import { createRoot } from "react-dom/client";
import { EncryptionSettings } from "../../src/components/settings/EncryptionSettings.tsx";
import { installEncryptionProofFetch } from "./gateway-encryption-settings-proof.mock.ts";
import "../../src/index.css";

const restoreFetch = installEncryptionProofFetch();
window.addEventListener("pagehide", restoreFetch, { once: true });

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing root");
}

createRoot(root).render(
	<main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-4 bg-background p-8 text-foreground">
		<header className="flex items-start justify-between gap-6">
			<div>
				<p className="mb-2 text-primary text-xs tracking-(--tracking-section)">
					RYU · DESKTOP SETTINGS
				</p>
				<h1 className="font-medium text-3xl">Encryption</h1>
				<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
					At-rest encryption and key custody reported by the active node.
				</p>
			</div>
			<div className="rounded-full border border-success/50 bg-success/10 px-3 py-1.5 font-medium text-success text-xs">
				LOCAL API FIXTURES
			</div>
		</header>
		<EncryptionSettings />
	</main>
);
