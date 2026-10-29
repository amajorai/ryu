import { createRoot } from "react-dom/client";

import { ComposioBillingView } from "../../src/components/settings/composio-billing-view.tsx";

import "../../src/index.css";

const query = new URLSearchParams(location.search);

const root = document.getElementById("root");

if (!root) {
	throw new Error("Missing root");
}

createRoot(root).render(
	<main className="mx-auto max-w-3xl space-y-6 px-5 py-8">
		<header className="space-y-1">
			<p className="text-muted-foreground text-xs">Gateway / Integrations</p>
			<h1 className="font-semibold text-xl">Usage & privacy</h1>
			<p className="text-muted-foreground text-sm">
				Acme workspace · {query.get("plan") ?? "Free"}
			</p>
		</header>
		<ComposioBillingView
			loading={false}
			policy={{
				zeroDataRetention: query.get("zdr") === "on",
				baa: false,
				ipAllowlist: false,
			}}
		/>
	</main>
);
