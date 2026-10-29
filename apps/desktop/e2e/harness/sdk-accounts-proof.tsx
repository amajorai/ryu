import { createRoot } from "react-dom/client";
import { GatewaySdkAccounts } from "../../src/components/gateway/GatewaySdkAccounts.tsx";
import { sdkAccountProviders } from "./sdk-accounts-fixture.ts";
import "../../src/index.css";

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<main className="min-h-screen bg-background px-5 py-8 text-foreground">
			<div className="mx-auto max-w-4xl space-y-5">
				<h1 className="font-semibold text-2xl">Gateway provider connections</h1>
				<GatewaySdkAccounts
					onRefresh={async () => {}}
					providers={sdkAccountProviders}
					target={{ url: window.location.origin, token: null }}
				/>
			</div>
		</main>
	);
}
