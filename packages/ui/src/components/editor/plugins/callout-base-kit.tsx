import { BaseCalloutPlugin } from "@platejs/callout";

import { CalloutElementStatic } from "@ryu/ui/components/editor/ui/callout-node-static.tsx";

export const BaseCalloutKit = [
	BaseCalloutPlugin.withComponent(CalloutElementStatic),
];
