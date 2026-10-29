import { createRoot } from "react-dom/client";
import { CustomAppSecuritySettings } from "../../src/components/settings/CustomAppSecuritySettings.tsx";
import "../../src/index.css";

const target = { url: window.location.origin, token: "csp-proof-node-token" };
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<main className="min-h-dvh bg-background px-8 py-12 text-foreground">
			<div className="mx-auto max-w-2xl space-y-8">
				<header className="space-y-2">
					<p className="text-muted-foreground text-sm">
						Gateway settings / Privacy
					</p>
					<h1 className="font-semibold text-2xl">Custom app security</h1>
				</header>
				<CustomAppSecuritySettings target={target} />
			</div>
		</main>
	);
}
