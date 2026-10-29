import { Button } from "@ryu/ui/components/button.tsx";
import { CommandGroup } from "@ryu/ui/components/command.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ProviderAccountSection } from "../../components/agent-elements/input/provider-account-section.tsx";
import { ProviderCommandDialog } from "../../components/agent-elements/input/provider-command-dialog.tsx";
import { GatewayDialog } from "../../src/components/gateway/GatewayDialog.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { useLlmProviders } from "../../src/hooks/useLlmProviders.ts";
import "../../src/index.css";

function RenamePanel() {
	const { catalog, renameAccount, switchAccount, removeAccount } =
		useLlmProviders();
	const provider = catalog?.providers.find(
		(item) => item.id === "custom/service"
	);
	return (
		<main className="min-h-screen bg-background p-8 text-foreground">
			<div className="mx-auto max-w-2xl space-y-5">
				<h1 className="font-semibold text-2xl">Saved provider accounts</h1>
				<p className="text-muted-foreground text-sm">{provider?.label}</p>
				<ProviderCommandDialog
					renderBody={() => (
						<CommandGroup heading={provider?.label}>
							<ProviderAccountSection
								accounts={provider?.accounts ?? []}
								onRemove={(accountId) => {
									void removeAccount("custom/service", accountId);
								}}
								onRename={async (accountId, label) => {
									await renameAccount("custom/service", accountId, label);
									return true;
								}}
								onSwitch={(account, target) => {
									void switchAccount(
										"custom/service",
										account.accountId,
										target
									);
								}}
							/>
						</CommandGroup>
					)}
					title="Saved accounts"
					trigger={<Button>Choose saved account</Button>}
				/>
			</div>
		</main>
	);
}
const panel = new URLSearchParams(window.location.search).get("panel");
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<EntitlementProvider>
				{panel === "rename" ? (
					<RenamePanel />
				) : (
					<GatewayDialog
						defaultSection={panel === "routing" ? "routing" : "keys"}
						onOpenChange={() => {}}
						open
					/>
				)}
			</EntitlementProvider>
		</QueryClientProvider>
	);
}
