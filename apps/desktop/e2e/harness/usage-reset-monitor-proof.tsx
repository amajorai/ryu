import {
	markCompanionAppRoot,
	subscribeCompanionTheme,
} from "@ryu/app-host/companion-theme";
import { RyuAppShell } from "@ryu/blocks/companion/app-ui.tsx";
import { Monitors } from "../../../../apps-store/monitors/ui/src/Monitors.tsx";
import "../../../../apps-store/monitors/ui/src/tailwind.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

subscribeCompanionTheme();
const container = document.getElementById("ryu-plugin-root");
if (container) {
	markCompanionAppRoot(container);
	createRoot(container).render(
		<StrictMode>
			<RyuAppShell>
				<div className="flex h-screen flex-col bg-background text-foreground">
					<p className="border-b bg-muted px-3 py-1.5 text-muted-foreground text-xs">
						Browser proof · fixture provider data only
					</p>
					<div className="min-h-0 flex-1">
						<Monitors />
					</div>
				</div>
			</RyuAppShell>
		</StrictMode>
	);
}
