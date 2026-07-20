import { BaseMentionPlugin } from "@platejs/mention";

import { MentionElementStatic } from "@ryu/ui/components/editor/ui/mention-node-static.tsx";

export const BaseMentionKit = [
	BaseMentionPlugin.withComponent(MentionElementStatic),
];
