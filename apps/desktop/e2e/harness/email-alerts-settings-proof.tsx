import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { createRoot } from "react-dom/client";
import { EmailAlertsSettings } from "../../src/components/settings/EmailAlertsSettings.tsx";
import { installEmailAlertsProofFetch } from "./email-alerts-settings-proof.mock.ts";
import "../../src/index.css";

const restoreFetch = installEmailAlertsProofFetch();
window.addEventListener("pagehide", restoreFetch, { once: true });

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing root");
}

createRoot(root).render(
	<main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 bg-background p-8 text-foreground">
		<header>
			<p className="mb-2 text-primary text-xs tracking-(--tracking-section)">
				RYU · DESKTOP SETTINGS
			</p>
			<h1 className="font-medium text-3xl">Email &amp; alerts</h1>
			<p className="mt-2 text-muted-foreground text-sm">
				Node-local SMTP and policy alert delivery settings.
			</p>
		</header>
		<EmailAlertsSettings />
		<Toaster position="bottom-right" theme="dark" />
	</main>
);
