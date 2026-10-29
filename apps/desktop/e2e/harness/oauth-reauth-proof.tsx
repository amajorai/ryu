import { Button } from "@ryu/ui/components/button.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	type ProviderAccount,
	ProviderAccountSection,
} from "../../components/agent-elements/input/provider-account-section.tsx";
import "../../src/index.css";

function OAuthReauthProof() {
	const [needsReauth, setNeedsReauth] = useState(true);
	const accounts: ProviderAccount[] = [
		{
			accountId: "fixture-claude-personal",
			active: true,
			kind: "oauth",
			label: "Personal Claude",
			needsReauth,
		},
		{
			accountId: "fixture-claude-work",
			active: false,
			kind: "oauth",
			label: "Work Claude",
		},
	];
	return (
		<main className="min-h-screen bg-background px-5 py-8 text-foreground sm:px-10">
			<div className="mx-auto max-w-2xl space-y-6">
				<header className="space-y-1">
					<p className="text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						Gateway · LLM providers
					</p>
					<h1 className="font-semibold text-2xl">Claude accounts</h1>
					<p className="text-muted-foreground text-sm">
						OAuth account state in the Ryu provider picker.
					</p>
				</header>
				<section
					aria-label="Claude account controls"
					className="rounded-xl border border-border bg-card p-4"
				>
					<ProviderAccountSection
						accounts={accounts}
						onRemove={() => undefined}
						onSwitch={() => undefined}
					/>
				</section>
				<section aria-label="Verification fixture" className="space-y-2">
					<p className="text-muted-foreground text-xs">
						Local verification fixture. No vendor account or login is used.
					</p>
					<Button
						onClick={() => setNeedsReauth((current) => !current)}
						variant="outline"
					>
						{needsReauth
							? "Simulate newer successful login"
							: "Restore blocked credential fixture"}
					</Button>
				</section>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<OAuthReauthProof />);
}
