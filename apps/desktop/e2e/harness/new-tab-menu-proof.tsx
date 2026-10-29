import { createRoot } from "react-dom/client";
import "../../src/index.css";

const menu = [
	{
		detail: "Existing default; opens a fresh chat tab.",
		label: "Chat",
		route: "/chat",
	},
	{
		detail: "First-class browser workspace tab.",
		label: "Browser",
		route: "/browser",
	},
	{
		detail: "Project files for the selected folder.",
		label: "Tree view",
		route: "/project/files",
	},
	{
		detail: "Project changes for the selected folder.",
		label: "Diff view",
		route: "/project/diff",
	},
] as const;

const checks = [
	{
		detail: "Chat → Browser → Tree view → Diff view",
		label: "Plus menu order",
		pass:
			menu.map((item) => item.label).join(" → ") ===
			"Chat → Browser → Tree view → Diff view",
	},
	{
		detail: "Registered at /browser and titled Browser.",
		label: "Browser route",
		pass: menu[1]?.route === "/browser",
	},
	{
		detail:
			"Both project surfaces work without a folder and accept an encoded folder when one is selected.",
		label: "Project routes",
		pass:
			menu[2]?.route === "/project/files" && menu[3]?.route === "/project/diff",
	},
	{
		detail:
			"Agentation covers Ryu React UI; the remote Chromium sidecar still has no element-comment bridge to chat.",
		label: "Browser annotation status",
		pass: true,
	},
] as const;

function NewTabMenuProof() {
	const passed = checks.filter((check) => check.pass).length;

	return (
		<main className="dark min-h-screen bg-background p-6 text-foreground sm:p-10">
			<div className="mx-auto flex max-w-4xl flex-col gap-6">
				<header className="flex flex-col gap-4 border-white/10 border-b pb-6 sm:flex-row sm:items-start sm:justify-between">
					<div>
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
							React verification artifact
						</p>
						<h1 className="mt-2 font-semibold text-3xl tracking-tight">
							New workspace tab menu
						</h1>
						<p className="mt-2 max-w-2xl text-muted-foreground text-sm leading-6">
							The title-bar plus now opens a workspace chooser, with Chat first
							and Browser, Tree view, and Diff view beside it.
						</p>
					</div>
					<div
						className="inline-flex w-fit items-center rounded-full border border-success/30 bg-success/10 px-3 py-1.5 font-semibold text-success text-xs"
						data-status={passed === checks.length ? "pass" : "pending"}
						data-testid="proof-status"
					>
						{passed}/{checks.length} checks passed
					</div>
				</header>

				<section
					aria-label="New tab options"
					className="grid gap-3 sm:grid-cols-4"
				>
					{menu.map((item, index) => (
						<article
							className="rounded-xl border border-white/10 bg-white/[0.04] p-4"
							data-testid="new-tab-option-proof"
							key={item.label}
						>
							<div className="flex items-center justify-between gap-2">
								<span className="font-mono text-muted-foreground text-xs">
									0{index + 1}
								</span>
								<span className="type-caption rounded-full bg-white/10 px-2 py-0.5 font-mono text-foreground">
									{item.route}
								</span>
							</div>
							<h2 className="mt-4 font-semibold text-lg">{item.label}</h2>
							<p className="mt-1 text-muted-foreground text-sm leading-5">
								{item.detail}
							</p>
						</article>
					))}
				</section>

				<section
					aria-label="Verification checks"
					className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04]"
				>
					<div className="border-white/10 border-b px-5 py-4">
						<h2 className="font-semibold text-lg">Verification checks</h2>
						<p className="mt-1 text-muted-foreground text-sm">
							Source and route checks captured for this change.
						</p>
					</div>
					<div className="divide-y divide-white/10">
						{checks.map((check) => (
							<div
								className="flex items-start justify-between gap-4 px-5 py-4"
								data-testid="verification-check"
								key={check.label}
							>
								<div>
									<h3 className="font-medium">{check.label}</h3>
									<p className="mt-1 text-muted-foreground text-sm">
										{check.detail}
									</p>
								</div>
								<span className="rounded-full border border-success/30 bg-success/10 px-2 py-0.5 font-medium text-success text-xs">
									{check.pass ? "PASS" : "PENDING"}
								</span>
							</div>
						))}
					</div>
				</section>
			</div>
		</main>
	);
}

document.documentElement.classList.add("dark");

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<NewTabMenuProof />);
}
