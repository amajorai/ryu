import {
	type ChannelConfigView,
	ChannelsView,
	defaultBehaviorSettings,
} from "@ryu/blocks/desktop/channels.tsx";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

const channel: ChannelConfigView = {
	...defaultBehaviorSettings(),
	agentId: "ryu",
	channelType: "telegram",
	enabled: true,
	groupReplyMode: "mentions",
	id: "proof-channel",
	model: null,
	name: "Ryu family helper",
	platformOptions: {},
	secrets: { bot_token: "***" },
	systemPrompt: null,
	teamId: null,
};

createRoot(document.querySelector<HTMLElement>("#root")!).render(
	<ChannelsView
		agents={[{ id: "ryu", name: "Ryu" }]}
		channels={[channel]}
		initialSelectedId={channel.id}
		onSave={() => true}
	/>
);

document.body.dataset.harnessReady = "1";
