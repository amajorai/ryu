import { createRoot } from "react-dom/client";
import { SidebarBrandBadge } from "@/src/components/layout/SidebarBrandBadge.tsx";
import "../../src/index.css";

createRoot(document.getElementById("root") as HTMLElement).render(
	<div className="dark min-h-screen bg-background p-8 text-foreground">
		<p className="mb-6 font-medium text-muted-foreground text-xs uppercase tracking-widest">
			Eligible managed organization
		</p>
		<div className="w-72" data-testid="badge-switcher">
			<SidebarBrandBadge canSwitchToConsole canSwitchToOs />
		</div>
		<div className="mt-56 w-72" data-testid="badge-member">
			<SidebarBrandBadge />
		</div>
	</div>
);
