declare const window: Window;

import {
	type SideChatCodecs,
	sideChatEntriesSchema,
	sideChatRequestSchema,
} from "./side-chat-proof.contracts.ts";

interface SideChatCodecWindow extends Window {
	__SIDE_CHAT_PROOF_CODECS__: SideChatCodecs;
}
// SAFETY: this browser bootstrap installs precisely these genuine native input codecs for its following init-script consumer.
(window as SideChatCodecWindow).__SIDE_CHAT_PROOF_CODECS__ = {
	sideChatRequestSchema,
	sideChatEntriesSchema,
};
