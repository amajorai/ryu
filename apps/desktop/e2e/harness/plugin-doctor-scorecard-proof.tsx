import { createRoot } from "react-dom/client";
import { ScorecardPanel } from "../../../../packages/marketplace/src/catalog/detail/scorecard-panel.tsx";
import {
	runScorecard,
	type Scorecard,
} from "../../../../packages/marketplace/src/catalog/scorecard.ts";
import type {
	CatalogEntry,
	PluginCatalogDetail,
} from "../../../../packages/marketplace/src/catalog/types.ts";
import { Badge } from "../../../../packages/ui/src/components/badge.tsx";
import { Button } from "../../../../packages/ui/src/components/button.tsx";
import "../../src/index.css";

const entry: CatalogEntry = {
	description: "A mail app with a clear, focused job.",
	id: "com.example.mail",
	kinds: ["tool"],
	name: "Example Mail",
	tags: ["productivity"],
	version: "1.4.2",
};

const detail: PluginCatalogDetail = {
	archived: false,
	apiSurface: {
		runnables: [
			{ id: "example-mail-companion", kind: "companion", name: "Example Mail" },
		],
	},
	description: entry.description,
	designSystem: {
		files: [
			{
				contents: '@import "@ryu/ui/app-ui.css";',
				path: "ui/src/styles.css",
			},
			{
				contents: [
					'import { markCompanionAppRoot, subscribeCompanionTheme } from "@ryu/app-host/companion-theme";',
					'import { RyuAppShell } from "@ryu/blocks/companion/app-ui";',
					"markCompanionAppRoot(document.getElementById('root'));",
					"subscribeCompanionTheme();",
				].join("\n"),
				path: "ui/src/main.tsx",
			},
			{
				contents: [
					'import { Button, Empty, Spinner } from "@ryu/ui/components";',
					'<RyuAppShell className="bg-background text-foreground">',
					'<Button aria-label="Save" disabled={loading}>Save</Button>',
					"{loading ? <Spinner /> : null}",
					"{empty ? <Empty /> : null}",
					"{error ? <p>Unable to load</p> : null}",
					"</RyuAppShell>",
				].join("\n"),
				path: "ui/src/App.tsx",
			},
		],
		navigation: "manifest",
	},
	engines: { ryu: ">=0.3.0" },
	issuesEnabled: true,
	license: "MIT",
	origin: "first-party",
	permissions: { declared: true, network: ["https://api.example.com"] },
	privacyPolicyUrl: "https://example.com/privacy",
	readme: "# Example Mail\n\n".concat("Useful documentation. ".repeat(30)),
	repositoryUrl: "https://example.com/mail",
	reviewed: true,
	surfaces: ["desktop"],
	termsOfServiceUrl: "https://example.com/terms",
	updatedAt: "2026-08-01T00:00:00Z",
	version: entry.version,
	versions: [{ publishedAt: "2026-08-01T00:00:00Z", version: entry.version }],
};

const scorecard: Scorecard = runScorecard(
	entry,
	detail,
	Date.parse("2026-08-17")
);

function Story() {
	return (
		<main className="min-h-svh bg-background p-8 text-foreground">
			<div className="mx-auto max-w-3xl">
				<p className="text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
					Ryu · Marketplace React proof
				</p>
				<h1 className="mt-2 font-semibold text-3xl">Health + Plugin Doctor</h1>
				<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
					The catalog score and the installed runtime doctor are shown as
					separate layers, with one handoff command for developers.
				</p>
				<section className="mt-6 rounded-xl border bg-card p-6">
					<ScorecardPanel
						developerCommand="ryu plugin doctor com.example.mail"
						developerEvals={
							<section
								className="flex flex-col gap-3 rounded-lg border border-primary/25 bg-primary/5 p-4"
								data-testid="plugin-evals-card"
							>
								<div className="flex flex-wrap items-start justify-between gap-3">
									<div>
										<h3 className="font-medium text-sm">Behavioral evals</h3>
										<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
											The installed app's prompt cases are separate from the
											static scorecard and the read-only doctor.
										</p>
									</div>
									<Button size="sm">Run evals</Button>
								</div>
								<div className="flex items-center gap-2 text-xs">
									<Badge data-testid="plugin-evals-status" variant="outline">
										Ready · 2 cases · 3 graders
									</Badge>
									<span className="text-muted-foreground">
										Latest run 100/100 · plugin-agent evidence
									</span>
								</div>
								<ul className="space-y-1 text-xs">
									<li className="rounded-md bg-background px-3 py-2">
										search uses the app · 100/100
									</li>
									<li className="rounded-md bg-background px-3 py-2">
										refuses an unsafe request · 100/100
									</li>
								</ul>
							</section>
						}
						scorecard={scorecard}
					/>
				</section>
				<p className="mt-4 font-medium text-success" data-testid="proof-status">
					VERIFIED
				</p>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
document.body.setAttribute("data-harness-ready", "1");
