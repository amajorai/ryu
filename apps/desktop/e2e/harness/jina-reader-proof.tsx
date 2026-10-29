import AppIcon from "@ryu/marketplace/catalog/chrome/app-icon";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<main className="min-h-screen bg-background px-5 py-8 text-foreground sm:px-10">
			<div className="mx-auto max-w-4xl space-y-5">
				<header className="space-y-1">
					<p className="text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						Marketplace · Search
					</p>
					<h1 className="font-semibold text-2xl">Direct web providers</h1>
				</header>
				<article className="flex items-center gap-4 rounded-lg border border-border p-4">
					<AppIcon
						name="Jina Reader"
						seedId="@ryu/jina-reader"
						size={36}
						variant="hero"
					/>
					<div>
						<h2 className="font-semibold text-lg">Jina Reader</h2>
						<p className="text-muted-foreground text-sm">
							Read web pages as clean text for agents
						</p>
						<p className="text-muted-foreground text-xs">
							Direct web.extract · Optional API key
						</p>
					</div>
				</article>
			</div>
		</main>
	);
}
