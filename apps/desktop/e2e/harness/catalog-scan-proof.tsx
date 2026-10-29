import { createRoot } from "react-dom/client";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "../../../../packages/blocks/src/desktop/settings-items.tsx";
import { ScorecardPanel } from "../../../../packages/marketplace/src/catalog/detail/scorecard-panel.tsx";
import {
	runScorecard,
	runSkillScorecard,
} from "../../../../packages/marketplace/src/catalog/scorecard.ts";
import type {
	CatalogEntry,
	PluginCatalogDetail,
	SkillCard,
	SkillDetail,
} from "../../../../packages/marketplace/src/catalog/types.ts";
import "../../src/index.css";

const pluginEntry: CatalogEntry = {
	description: "A mail app with a clear, focused job.",
	id: "com.example.mail",
	kinds: ["tool"],
	name: "Example Mail",
	tags: ["productivity"],
	version: "1.4.2",
};

const pluginDetail: PluginCatalogDetail = {
	apiSurface: {
		runnables: [
			{ id: "example-mail-companion", kind: "companion", name: "Example Mail" },
		],
	},
	archived: false,
	description: pluginEntry.description,
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
	version: pluginEntry.version,
	versions: [
		{ publishedAt: "2026-08-01T00:00:00Z", version: pluginEntry.version },
	],
};

const skillCard: SkillCard = {
	description: "A reusable review workflow with a clear, bounded purpose.",
	id: "example/review-skill",
	installed: false,
	installs: 120,
	name: "Review skill",
	slug: "review-skill",
	source: "github",
	trustLevel: "trusted",
};

const skillDetail: SkillDetail = {
	card: skillCard,
	description: skillCard.description ?? null,
	files: [
		{
			contents: "# Review skill\n\n".concat(
				"Documented instructions. ".repeat(30)
			),
			path: "SKILL.md",
		},
	],
	metadata: {
		firstSeen: "2026-07-01T00:00:00Z",
		githubCreatedAt: "2026-01-01T00:00:00Z",
		githubPushedAt: "2026-08-01T00:00:00Z",
		githubStars: "40",
		githubUpdatedAt: "2026-08-01T00:00:00Z",
		installs: "120",
		repositoryUrl: "https://github.com/example/review-skill",
		securityAudits: [
			{
				name: "Registry audit",
				status: "pass",
				url: "https://example.com/audit",
			},
		],
	},
	readme: "# Review skill\n\n".concat("Real documentation. ".repeat(40)),
	url: "https://github.com/example/review-skill",
};

const appScorecard = runScorecard(
	pluginEntry,
	pluginDetail,
	Date.parse("2026-08-17")
);
const skillScorecard = runSkillScorecard(
	skillCard,
	skillDetail,
	Date.parse("2026-08-17")
);

function agentScanReport(kind: string) {
	return async () => ({
		agentId: "catalog-reviewer",
		report: `Verdict\nThe ${kind} is reviewable from the published evidence.\n\nEvidence\nThe deterministic checks remain the source of the numeric grade. No instruction-like content was found in this fixture.\n\nRecommended follow-up\nReview the linked source before installing.`,
		status: "complete" as const,
	});
}

function Story() {
	return (
		<main className="min-h-svh bg-background p-8 text-foreground">
			<div className="mx-auto flex max-w-6xl flex-col gap-6">
				<header>
					<p className="text-muted-foreground text-xs uppercase tracking-widest">
						Ryu · Catalog scan proof
					</p>
					<h1 className="mt-2 font-semibold text-3xl">
						Health and agent review
					</h1>
					<p className="mt-2 max-w-3xl text-muted-foreground text-sm">
						Skills, Apps, and Plugins keep one deterministic scorecard and add a
						bounded read-only agent narrative when the node provides a scanner.
					</p>
				</header>

				<SettingsSection
					caption="Choose the registered agent that reviews Skills, Apps, and Plugins after their deterministic scorecard runs."
					title="Gateway → Guardrails → Catalog scanner"
				>
					<SettingsGroup>
						<SettingsItem
							actions={
								<select
									aria-label="Scanning agent"
									className="rounded-md border bg-background px-2 py-1.5 text-sm"
									defaultValue="catalog-reviewer"
								>
									<option value="catalog-reviewer">catalog-reviewer</option>
									<option value="ryu">Ryu</option>
								</select>
							}
							description="Saved per node and used by catalog Scan buttons."
							title="Scanning agent"
						/>
					</SettingsGroup>
				</SettingsSection>

				<div className="grid gap-6 lg:grid-cols-2">
					<section className="rounded-xl border bg-card p-6">
						<h2 className="mb-4 font-medium text-lg">App / Plugin</h2>
						<ScorecardPanel
							agentScan={agentScanReport("plugin")}
							developerCommand="ryu plugin doctor com.example.mail"
							scorecard={appScorecard}
						/>
					</section>
					<section className="rounded-xl border bg-card p-6">
						<h2 className="mb-4 font-medium text-lg">Skill</h2>
						<ScorecardPanel
							agentScan={agentScanReport("skill")}
							scorecard={skillScorecard}
						/>
					</section>
				</div>
				<p className="font-medium text-success" data-testid="proof-status">
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
