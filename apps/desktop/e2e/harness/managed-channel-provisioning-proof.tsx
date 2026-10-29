import {
	type ChannelConfigView,
	ChannelsView,
	defaultBehaviorSettings,
} from "@ryu/blocks/desktop/channels.tsx";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

const managedTelegram: ChannelConfigView = {
	...defaultBehaviorSettings(),
	agentId: "ryu",
	channelType: "telegram",
	credentialSource: "ryu_managed",
	enabled: true,
	groupReplyMode: "mentions",
	id: "managed-telegram-node-a",
	managedBotId: "telegram-node-a",
	managedBotUsername: "ryu_node_a",
	managedProvisioningState: "ready",
	model: null,
	name: "Ryu Telegram · node-a",
	platformOptions: {},
	provisionedServerId: "node-a",
	secrets: { bot_token: "***" },
	systemPrompt: null,
	teamId: null,
};

const managedDiscord: ChannelConfigView = {
	...defaultBehaviorSettings(),
	agentId: "ryu",
	channelType: "discord",
	credentialSource: "ryu_managed",
	enabled: true,
	groupReplyMode: "mentions",
	id: "managed-discord-node-a",
	managedBotId: "123456789012345678",
	managedBotUsername: "Ryu Node A",
	managedProvisioningState: "ready",
	model: null,
	name: "Ryu Discord · node-a",
	platformOptions: {},
	provisionedServerId: "node-a",
	secrets: { bot_token: "***" },
	systemPrompt: null,
	teamId: null,
};

createRoot(document.querySelector<HTMLElement>("#root")!).render(
	<main className="min-h-screen bg-background text-foreground">
		<header className="border-b px-8 py-6">
			<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
				Managed node provisioning proof
			</p>
			<h1 className="mt-2 font-semibold text-2xl tracking-tight">
				Dedicated bots are ready for the default Ryu agent
			</h1>
			<p className="mt-2 max-w-3xl text-muted-foreground text-sm">
				Each managed node receives one separate Telegram bot and one separate
				Discord bot. The credentials stay node-bound, and customers can paste
				their own token later.
			</p>
		</header>
		<div className="grid gap-8 p-8 xl:grid-cols-2">
			<section className="min-w-0">
				<ChannelsView
					agents={[{ id: "ryu", name: "Ryu" }]}
					channels={[managedTelegram]}
					initialSelectedId={managedTelegram.id}
					onSave={() => true}
				/>
			</section>
			<section className="min-w-0">
				<ChannelsView
					agents={[{ id: "ryu", name: "Ryu" }]}
					channels={[managedDiscord]}
					initialSelectedId={managedDiscord.id}
					onSave={() => true}
				/>
			</section>
		</div>
	</main>
);

document.body.dataset.harnessReady = "1";
