import { Toaster } from "@ryu/ui/components/sileo";
import { createRoot } from "react-dom/client";
import { NodeAccessSettings } from "../../src/components/settings/NodeAccessSettings.tsx";
import "../../src/index.css";

Object.defineProperty(window, "__TAURI_INTERNALS__", {
	configurable: true,
	value: {
		invoke: async () => ({ source: "file", token: "owner-proof-token" }),
		transformCallback: () => 0,
	},
});

function ProofArtifact() {
	return (
		<main className="min-h-screen bg-background px-8 py-8 text-foreground">
			<div className="mx-auto max-w-6xl">
				<header className="mb-6 flex items-start justify-between gap-6">
					<div>
						<p className="font-semibold text-primary text-xs tracking-[0.22em]">
							RYU · DEVICES &amp; ACCESS
						</p>
						<h1 className="mt-2 font-semibold text-3xl">Scoped node access</h1>
						<p className="mt-2 max-w-3xl text-muted-foreground text-sm leading-6">
							Approve the minimum capabilities each app needs. Every grant can
							be bound, expired, and revoked without sharing the node owner
							token.
						</p>
					</div>
					<div className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 font-semibold text-emerald-400 text-xs tracking-wider">
						OWNER VERIFIED
					</div>
				</header>

				<div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
					<section
						aria-label="Scoped device access settings"
						className="rounded-2xl border bg-card p-6 shadow-sm"
					>
						<NodeAccessSettings />
					</section>

					<aside className="rounded-2xl border bg-card p-5">
						<p className="font-semibold text-muted-foreground text-xs tracking-wider">
							AUTH BOUNDARIES
						</p>
						<h2 className="mt-2 font-semibold text-lg">
							Least privilege by default
						</h2>
						<ul className="mt-4 space-y-3 text-sm">
							<li className="rounded-lg border bg-muted/40 p-3">
								<strong className="block text-xs">Owner token</strong>
								<span className="text-muted-foreground">
									Recovery and administration only
								</span>
							</li>
							<li className="rounded-lg border bg-muted/40 p-3">
								<strong className="block text-xs">Paired apps</strong>
								<span className="text-muted-foreground">
									Exact scopes plus bindings and expiry
								</span>
							</li>
							<li className="rounded-lg border bg-muted/40 p-3">
								<strong className="block text-xs">MCP and plugins</strong>
								<span className="text-muted-foreground">
									Independent revocable credentials
								</span>
							</li>
						</ul>
					</aside>
				</div>
			</div>
			<Toaster position="bottom-right" theme="system" />
		</main>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("scoped pairing proof root is missing");
}
createRoot(root).render(<ProofArtifact />);
document.body.dataset.harnessReady = "1";
