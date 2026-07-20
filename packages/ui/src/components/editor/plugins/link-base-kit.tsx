import { BaseLinkPlugin } from "@platejs/link";

import { LinkElementStatic } from "@ryu/ui/components/editor/ui/link-node-static.tsx";

export const BaseLinkKit = [BaseLinkPlugin.withComponent(LinkElementStatic)];
