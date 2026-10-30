// The companion frame host, fetched on first use.
//
// PluginHostPanel carries the whole host-service surface (realtime, mail,
// prompt suites, media, browser recording). Every caller renders it on demand
// (an opened companion, the sketch dialog, a Space app document), so it stays
// out of the startup chunk. The frame itself loads asynchronously anyway, so
// the empty fallback only stretches that blank moment slightly.

import { type ComponentProps, lazy, Suspense } from "react";
import type { PluginHostPanel as PluginHostPanelComponent } from "./PluginHostPanel.tsx";

const PluginHostPanelImpl = lazy(() =>
	import("./PluginHostPanel.tsx").then((module) => ({
		default: module.PluginHostPanel,
	}))
);

export function PluginHostPanel(
	props: ComponentProps<typeof PluginHostPanelComponent>
) {
	return (
		<Suspense fallback={<div className="h-full" />}>
			<PluginHostPanelImpl {...props} />
		</Suspense>
	);
}
