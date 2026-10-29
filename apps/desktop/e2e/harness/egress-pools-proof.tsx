import { createRoot } from "react-dom/client";
import { EgressPoolsEditor } from "../../src/components/gateway/EgressPoolsEditor.tsx";
import "../../src/index.css";

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<main className="min-h-screen bg-background px-5 py-8 text-foreground sm:px-10">
			<div className="mx-auto max-w-4xl space-y-5">
				<header className="space-y-1">
					<p className="text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						Gateway · Routing
					</p>
					<h1 className="font-semibold text-2xl">Direct provider egress</h1>
				</header>
				<EgressPoolsEditor
					canConfigure
					providers={[
						"openai",
						"anthropic",
						"mistral",
						"assemblyai",
						"inworld",
						"replicate",
						"fal",
						"genai",
					]}
					reachable
					target={{ url: window.location.origin, token: null }}
				/>
			</div>
		</main>
	);
}
