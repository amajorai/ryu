import { createRoot } from "react-dom/client";
import proofStyles from "./skill-pack-verification-proof.module.css";
import "../../src/index.css";

interface Check {
	detail: string;
	label: string;
	status: "PASS" | "LIVE";
}

const checks: Check[] = [
	{
		detail: "apps/core/src/skills_catalog/packs.rs",
		label: "Core built-in pack catalog",
		status: "PASS",
	},
	{
		detail: "Root SKILL.md is resolved as the repository skill",
		label: "Root-level skill support",
		status: "PASS",
	},
	{
		detail: "Derived by system_skills::bundled_repos()",
		label: "Boot sync includes the repository",
		status: "PASS",
	},
	{
		detail: "packages/api/src/routers/catalog.ts",
		label: "Public pack shelf mirror",
		status: "PASS",
	},
	{
		detail: "SKILL.md + references/ + scripts/ + templates/ · MIT · v2.0.0",
		label: "Upstream skill package",
		status: "LIVE",
	},
];

function CheckRow({ detail, label, status }: Check): React.JSX.Element {
	return (
		<li className="flex items-center justify-between gap-4 border-b px-4 py-3 last:border-b-0">
			<div>
				<p className={`font-medium ${proofStyles.rowTitle}`}>{label}</p>
				<p className={`${proofStyles.muted} text-sm`}>{detail}</p>
			</div>
			<span
				className={`rounded-full px-2.5 py-1 font-semibold text-xs tracking-wide ${
					status === "PASS" ? proofStyles.pass : proofStyles.live
				}`}
			>
				{status}
			</span>
		</li>
	);
}

function ProofArtifact(): React.JSX.Element {
	return (
		<main className={`min-h-screen ${proofStyles.surface} px-6 py-12`}>
			<div className="mx-auto max-w-3xl space-y-8">
				<header className="space-y-3">
					<p
						className={`font-semibold ${proofStyles.kicker} text-sm uppercase`}
					>
						Ryu verification artifact
					</p>
					<h1 className="font-semibold text-4xl tracking-tight">
						Unlazy is bundled as a built-in skill
					</h1>
					<p className={`max-w-2xl ${proofStyles.description}`}>
						Ryu syncs the root-level skill from its upstream repository and
						keeps its supporting references, scripts, and templates intact.
					</p>
				</header>

				<section
					aria-label="Pack summary"
					className="grid gap-4 sm:grid-cols-3"
				>
					<div className={`rounded-2xl border ${proofStyles.card} p-5`}>
						<p className={`${proofStyles.muted} text-sm`}>Pack</p>
						<p className="mt-2 font-semibold text-xl">Leonxlnx/unlazy</p>
					</div>
					<div className={`rounded-2xl border ${proofStyles.card} p-5`}>
						<p className={`${proofStyles.muted} text-sm`}>Upstream layout</p>
						<p className="mt-2 font-semibold text-xl">1 root skill</p>
					</div>
					<div className={`rounded-2xl border ${proofStyles.card} p-5`}>
						<p className={`${proofStyles.muted} text-sm`}>Ownership</p>
						<p className={`mt-2 font-semibold ${proofStyles.positive} text-xl`}>
							Built-in
						</p>
					</div>
				</section>

				<section
					className={`overflow-hidden rounded-2xl border ${proofStyles.card}`}
				>
					<div className={`${proofStyles.cardHeader} border-b px-4 py-3`}>
						<h2 className="font-semibold">Completed checks</h2>
					</div>
					<ul>
						{checks.map((check) => (
							<CheckRow key={check.label} {...check} />
						))}
					</ul>
				</section>

				<a
					className={`inline-flex rounded-lg border ${proofStyles.action} px-4 py-2 text-sm transition`}
					href="https://github.com/Leonxlnx/unlazy"
					rel="noopener noreferrer"
					target="_blank"
				>
					Open upstream repository
				</a>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<ProofArtifact />);
}
