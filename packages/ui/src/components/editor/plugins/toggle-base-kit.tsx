import { BaseTogglePlugin } from "@platejs/toggle";

import { ToggleElementStatic } from "@ryu/ui/components/editor/ui/toggle-node-static.tsx";

export const BaseToggleKit = [
	BaseTogglePlugin.withComponent(ToggleElementStatic),
];
