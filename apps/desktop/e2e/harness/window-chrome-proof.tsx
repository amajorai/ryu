import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { createRoot } from "react-dom/client";
import { WindowNavigationCluster } from "../../src/components/layout/WindowNavigationCluster.tsx";
import { windowChromeLayout } from "../../src/lib/window-chrome-layout.ts";
import "../../src/index.css";

type ProofSurface = "extension" | "mobile" | "webapp";

const requestedSurface = new URLSearchParams(window.location.search).get(
	"surface"
);
const surface: ProofSurface =
	requestedSurface === "extension" || requestedSurface === "mobile"
		? requestedSurface
		: "webapp";
const isMobile = surface === "mobile";
const layout = windowChromeLayout({
	isMac: true,
	isMobile,
	nativeWindowChrome: false,
});

const surfaceLabel = {
	extension: "Browser extension dashboard",
	mobile: "Phone-sized Webapp",
	webapp: "Webapp",
}[surface];

function ProofShell() {
	return (
		<TooltipProvider delay={0}>
			<main className="relative min-h-screen overflow-hidden bg-background text-foreground">
				<div className="absolute inset-x-0 top-0 h-16 border-border/60 border-b bg-background/85 backdrop-blur-xl" />
				<WindowNavigationCluster
					canGoBack={false}
					canGoForward={false}
					isMac={true}
					isMobile={isMobile}
					navClusterPosition={layout.navClusterPosition}
					onGoBack={() => undefined}
					onGoForward={() => undefined}
					onSearch={() => undefined}
					onToggleSidebar={() => undefined}
					sidebarShown={false}
				/>
				<div
					className={cn(
						"fixed top-4 right-0 flex h-8 items-center gap-2 rounded-xl border bg-card px-3 text-muted-foreground text-xs shadow-sm",
						layout.pageActionsMargin
					)}
					data-testid="right-page-actions"
				>
					Actions
				</div>

				<section
					className={cn(
						"mx-auto flex min-h-screen max-w-5xl items-center px-6",
						isMobile ? "justify-center" : "justify-start"
					)}
				>
					<div className="max-w-xl rounded-3xl border bg-card/80 p-7 shadow-2xl backdrop-blur-sm">
						<p className="font-medium text-primary text-xs uppercase tracking-(--tracking-section)">
							Responsive shell proof
						</p>
						<h1 className="mt-2 font-semibold text-3xl">{surfaceLabel}</h1>
						<p className="mt-3 text-muted-foreground text-sm leading-6">
							The real Ryu navigation cluster starts at the browser viewport
							edge. No macOS traffic-light space and no Windows caption-button
							space is reserved on this surface.
						</p>
						<div className="mt-5 grid grid-cols-2 gap-3 text-sm">
							<div className="rounded-xl bg-muted p-3">
								<p className="text-muted-foreground text-xs">Left inset</p>
								<p className="mt-1 font-medium">
									{isMobile ? "8 px" : "24 px"}
								</p>
							</div>
							<div className="rounded-xl bg-muted p-3">
								<p className="text-muted-foreground text-xs">Right inset</p>
								<p className="mt-1 font-medium">8 px</p>
							</div>
						</div>
					</div>
				</section>
			</main>
		</TooltipProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Root element not found");
}

createRoot(root).render(<ProofShell />);
