import {
	type AgentOption,
	type ChannelConfigView,
	ChannelsView,
	defaultBehaviorSettings,
} from "@ryu/blocks/desktop/channels.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CreateAgentDialog } from "../../src/components/agents/CreateAgentDialog.tsx";
import { DestructiveConfirmDialog } from "../../src/components/ui/DestructiveConfirmDialog.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";
import { useCreateAgentDialog } from "../../src/store/useCreateAgentDialog.ts";
import { createTabsProofContext } from "./tabs-proof-context.ts";
import "../../src/index.css";

const agents: AgentOption[] = [{ id: "default-agent", name: "Default agent" }];

const orphanedDiscord: ChannelConfigView = {
	...defaultBehaviorSettings(),
	agentId: "deleted-agent",
	bindingWarning:
		"This channel was reverted to the default agent because its original agent was deleted. Rebind it to another agent to clear this warning.",
	channelType: "discord",
	enabled: true,
	groupReplyMode: "mentions",
	id: "discord-bot-1",
	model: null,
	name: "Support Discord bot",
	platformOptions: {},
	secrets: { bot_token: "***" },
	systemPrompt: null,
	teamId: null,
};

const tabsContext = createTabsProofContext({
	openTab: () => "proof-chat",
	updateTabsIconWhere: () => undefined,
});

const queryClient = new QueryClient();

function Proof() {
	const [deleteOpen, setDeleteOpen] = useState(false);

	useEffect(() => {
		useCreateAgentDialog.getState().openCreateAgent();
	}, []);

	return (
		<ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
			<QueryClientProvider client={queryClient}>
				<EntitlementProvider>
					<TabsContext.Provider value={tabsContext}>
						<main className="min-h-screen bg-background text-foreground">
							<div className="border-b px-8 py-5">
								<p className="font-medium text-muted-foreground text-xs uppercase tracking-widest">
									Production component proof
								</p>
								<h1 className="mt-2 font-semibold text-2xl tracking-tight">
									Channels stay connected to shared agent sessions
								</h1>
								<p className="mt-2 max-w-3xl text-muted-foreground text-sm">
									The real channel manager keeps bot records and Core history
									when an agent is removed, and the new-agent flow can queue
									channel setup.
								</p>
								<button
									className="mt-4 rounded-lg border px-3 py-2 text-sm"
									onClick={() => setDeleteOpen(true)}
									type="button"
								>
									Show protected delete
								</button>
							</div>
							<div className="h-[calc(100vh-8rem)] min-h-[42rem] p-8">
								<ChannelsView
									agents={agents}
									channels={[orphanedDiscord]}
									initialSelectedId={orphanedDiscord.id}
									onSave={() => true}
								/>
							</div>
							<CreateAgentDialog />
							<DestructiveConfirmDialog
								description="The channel credentials are removed, but its shared Core session history stays available."
								impact={
									<p className="text-muted-foreground">
										Deleting a channel never deletes its agent or conversation
										history.
									</p>
								}
								label="Delete Support Discord bot"
								onConfirm={() => true}
								onOpenChange={setDeleteOpen}
								open={deleteOpen}
								title="Delete this channel?"
							/>
						</main>
					</TabsContext.Provider>
				</EntitlementProvider>
			</QueryClientProvider>
		</ThemeProvider>
	);
}

createRoot(document.getElementById("root")!).render(<Proof />);
document.body.dataset.harnessReady = "1";
