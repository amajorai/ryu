declare const window: Window;

import { createRoot } from "react-dom/client";
import PrivatePackageInstallDialog from "../../src/components/marketplace/PrivatePackageInstallDialog.tsx";
import "../../src/index.css";

const PREVIEW = {
	audience: "organization",
	capabilities: ["workflow.execute", "composio:googledrive"],
	connections: [
		{
			consumers: ["Weekly revenue brief"],
			display_name: "Google Drive",
			id: "google-drive",
			provider: "Composio",
			purpose: "Read the source spreadsheet before each run.",
			required: true,
			toolkit: "googledrive",
		},
	],
	description:
		"Turns the latest customer spreadsheet into a concise Monday brief.",
	expires_at: "2026-09-19T00:00:00.000Z",
	id: "acme/weekly-revenue-brief",
	kind: "workflow",
	name: "Weekly revenue brief",
	organization_name: "Acme Customer Success",
	version: "2.4.0",
	verification: "verified",
};

const requests: Array<{ body: unknown; path: string }> = [];

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

const realFetch = window.fetch.bind(globalThis);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
	const url = input instanceof Request ? input.url : String(input);
	const path = new URL(url, window.location.origin).pathname;
	if (path.includes("/api/marketplace/share-codes/preview")) {
		requests.push({ body: init?.body ?? null, path });
		return Promise.resolve(json({ preview: PREVIEW }));
	}
	if (path.includes("/api/marketplace/share-codes/redeem")) {
		requests.push({ body: init?.body ?? null, path });
		return Promise.resolve(
			json({
				install_session: "signed-install-session-for-proof",
				preview: PREVIEW,
			})
		);
	}
	if (path.includes("/api/marketplace/packages/install")) {
		requests.push({ body: init?.body ?? null, path });
		return Promise.resolve(
			json({
				package: {
					enabled: true,
					id: PREVIEW.id,
					installed_at_unix_ms: Date.now(),
					kind: PREVIEW.kind,
					package_digest: "sha256:proof",
					version: PREVIEW.version,
				},
			})
		);
	}
	if (path.includes("/api/composio/status")) {
		return Promise.resolve(
			json({ base_url: "https://composio.example", configured: true })
		);
	}
	if (path.includes("/api/composio/connections")) {
		return Promise.resolve(json({ data: [] }));
	}
	return realFetch(input, init);
};

declare global {
	interface Window {
		__privatePackageRequests?: Array<{ body: unknown; path: string }>;
	}
}

window.__privatePackageRequests = requests;

function PrivatePackageShareStory() {
	return (
		<main className="min-h-screen bg-background px-6 py-10 text-foreground sm:px-10">
			<div className="mx-auto max-w-5xl">
				<header className="mb-8">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-widest">
						Marketplace · customer handoff
					</p>
					<h1 className="mt-2 font-semibold text-3xl tracking-tight">
						Private package install
					</h1>
					<p className="mt-3 max-w-2xl text-muted-foreground">
						A publisher can share a signed workflow release without sharing
						credentials. The recipient sees setup requirements before the
						package is installed.
					</p>
				</header>
				<section
					className="rounded-3xl border bg-card p-6 shadow-sm"
					data-testid="private-package-proof"
				>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div>
							<p className="font-medium">Customer workspace</p>
							<p className="mt-1 text-muted-foreground text-sm">
								Acme Customer Success · local node
							</p>
						</div>
						<span className="rounded-full bg-primary/10 px-3 py-1 font-medium text-primary text-xs">
							Ready for a publisher code
						</span>
					</div>
				</section>
			</div>
			<PrivatePackageInstallDialog onClose={() => undefined} open />
		</main>
	);
}

createRoot(document.getElementById("root")!).render(
	<PrivatePackageShareStory />
);
