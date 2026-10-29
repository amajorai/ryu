import type { MarketplacePublishPreflightReport } from "@ryu/marketplace/catalog/publish-preflight";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PublishDialog } from "../../src/components/marketplace/PublishDialog.tsx";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
	query: Record<string, string>;
	status: number | null;
}

interface TauriCall {
	args: unknown;
	command: string;
}

interface PublishProofSnapshot {
	externalNavigationAttempts: string[];
	listingCount: number;
	requests: CapturedRequest[];
	tauriCalls: TauriCall[];
}

type PublishMode =
	| "fail-once"
	| "github-install-required"
	| "hold-once"
	| "preflight-fail";

function publishPreflight(
	overrides: Partial<MarketplacePublishPreflightReport> = {}
): MarketplacePublishPreflightReport {
	return {
		categories: [],
		checks: [
			{
				category: "configuration",
				detail: "The app package has a defined Ryu publish profile.",
				id: "package-kind",
				label: "Uses a supported package profile",
				status: "pass",
				weight: 3,
			},
			{
				category: "design-system",
				detail:
					"The Companion mounts through RyuAppShell and marks its host root.",
				id: "app-shell",
				label: "Uses the Ryu App UI shell",
				status: "pass",
				weight: 3,
			},
		],
		evaluated: 2,
		grade: "A",
		packageDigest: "abcdef0123456789abcdef0123456789",
		packageKind: "app",
		passed: true,
		releaseTag: "v2.4.0",
		rulesetVersion: "marketplace-publish-1",
		schemaVersion: "1",
		score: 100,
		sourceCommit: "1234567890abcdef1234567890abcdef12345678",
		summary: "Passes every automated check.",
		uiDetected: true,
		uiGrade: "A",
		uiHostRendered: false,
		uiScore: 100,
		verifiedAt: "2026-09-28T00:00:00.000Z",
		...overrides,
	};
}

declare global {
	interface Window {
		__marketplacePublishProof: {
			armPublishMode: (mode: PublishMode) => void;
			failNextInstallStatus: () => void;
			resolveHeldPublish: () => void;
			snapshot: () => PublishProofSnapshot;
		};
	}
}

function jsonResponse<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function parseBody(body: BodyInit | null | undefined) {
	if (!isNativeText(body)) {
		return null;
	}
	try {
		return parseProofJson(body);
	} catch {
		return null;
	}
}

function installFixture(): void {
	localStorage.setItem("ryu_session_token", "local-marketplace-proof-token");
	const state: PublishProofSnapshot & {
		nextPublishMode: PublishMode | null;
		failNextStatus: boolean;
		releaseHeldPublish: (() => void) | null;
	} = {
		externalNavigationAttempts: [],
		listingCount: 0,
		nextPublishMode: null,
		failNextStatus: false,
		requests: [],
		tauriCalls: [],
		releaseHeldPublish: null,
	};
	window.__marketplacePublishProof = {
		armPublishMode: (mode) => {
			state.nextPublishMode = mode;
		},
		failNextInstallStatus: () => {
			state.failNextStatus = true;
		},
		resolveHeldPublish: () => {
			state.releaseHeldPublish?.();
		},
		snapshot: () =>
			structuredClone({
				externalNavigationAttempts: state.externalNavigationAttempts,
				listingCount: state.listingCount,
				requests: state.requests,
				tauriCalls: state.tauriCalls,
			}),
	};

	const tauriWindow = window;
	const proofTauriKernel = {
		invoke: async <Arguments,>(command: string, args?: Arguments) => {
			state.tauriCalls.push({ args: args ?? null, command });
			return undefined;
		},
		transformCallback: () => 1,
	};
	// SAFETY: This browser fixture installs the exact complete private kernel constructed above.
	// This mutation view owns that two-method fixture slot, not the public Tauri SDK result ABI.
	(
		tauriWindow as Omit<typeof window, "__TAURI_INTERNALS__"> & {
			__TAURI_INTERNALS__: typeof proofTauriKernel;
		}
	).__TAURI_INTERNALS__ = proofTauriKernel;
	Object.defineProperty(window, "open", {
		configurable: true,
		value: (url: string) => {
			state.externalNavigationAttempts.push(String(url));
			return null;
		},
	});

	const nativeFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const request = input instanceof Request ? input : null;
		const url = new URL(request?.url ?? String(input), window.location.href);
		if (!url.pathname.startsWith("/api/marketplace/github/")) {
			return nativeFetch(input, init);
		}
		const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
		const body = parseBody(
			init?.body ?? (request ? await request.clone().text() : null)
		);
		const captured: CapturedRequest = {
			body,
			method,
			path: url.pathname,
			query: Object.fromEntries(url.searchParams.entries()),
			status: null,
		};
		state.requests.push(captured);

		if (
			url.pathname === "/api/marketplace/github/publish" &&
			method === "POST"
		) {
			const mode = state.nextPublishMode;
			state.nextPublishMode = null;
			if (mode === "github-install-required") {
				captured.status = 403;
				return jsonResponse(
					{
						code: "github_installation_required",
						message: "GitHub App access is required for this repository.",
						installationUrl:
							"https://github.com/apps/ryu-marketplace/installations/new",
						repository: "acme/private-app",
						installationState: "github-state-proof-001",
					},
					403
				);
			}
			if (mode === "fail-once") {
				captured.status = 503;
				return jsonResponse(
					{ message: "Marketplace fixture is temporarily unavailable." },
					503
				);
			}
			if (mode === "preflight-fail") {
				captured.status = 422;
				return jsonResponse(
					{
						code: "github_publish_preflight_failed",
						message:
							"An A grade is required before this package can be submitted.",
						preflight: publishPreflight({
							checks: [
								{
									category: "design-system",
									detail:
										"Interactive controls were found without a shared Ryu UI or Blocks import in the supplied source.",
									id: "shared-primitives",
									label: "Uses shared controls instead of local copies",
									status: "fail",
									weight: 3,
								},
							],
							grade: "F",
							passed: false,
							score: 60,
							uiGrade: "F",
							uiScore: 58,
						}),
					},
					422
				);
			}
			if (mode === "hold-once") {
				return await new Promise<Response>((resolve) => {
					state.releaseHeldPublish = () => {
						state.releaseHeldPublish = null;
						state.listingCount += 1;
						captured.status = 200;
						resolve(
							jsonResponse({
								id: `listing-proof-${state.listingCount}`,
								kind: "app",
								preflight: publishPreflight(),
								status: "pending",
								version: "2.4.0",
							})
						);
					};
				});
			}
			state.listingCount += 1;
			captured.status = 200;
			return jsonResponse({
				id: `listing-proof-${state.listingCount}`,
				kind: "app",
				preflight: publishPreflight(),
				status: "pending",
				version: "2.4.0",
			});
		}

		if (
			url.pathname === "/api/marketplace/github/install/status" &&
			method === "GET"
		) {
			if (state.failNextStatus) {
				state.failNextStatus = false;
				captured.status = 409;
				return jsonResponse(
					{ message: "GitHub App installation is not ready yet." },
					409
				);
			}
			captured.status = 200;
			return jsonResponse({
				installationProof: "local-installation-proof-token",
				ready: true,
				repository: "acme/private-app",
			});
		}

		captured.status = 404;
		return jsonResponse(
			{ message: `No Marketplace fixture for ${method} ${url.pathname}` },
			404
		);
	};
}

function ProofArtifact() {
	const [open, setOpen] = useState(true);
	return (
		<main className="dark min-h-screen bg-background px-8 py-8 text-foreground">
			<div className="mx-auto max-w-4xl">
				<header className="mb-6 flex items-start justify-between gap-4">
					<div>
						<div className="text-primary text-xs tracking-table-label">
							RYU · LIVE REACT PROOF
						</div>
						<h1 className="mt-2 font-semibold text-3xl">
							Marketplace publisher
						</h1>
						<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
							Production PublishDialog with local API responses and capture-only
							Tauri openExternal. No repository or browser is opened.
						</p>
					</div>
					<div className="flex flex-col items-end gap-2">
						<span data-testid="dialog-open-state">
							{open ? "open" : "closed"}
						</span>
						<button
							className="rounded-lg border px-3 py-2 text-sm"
							onClick={() => setOpen(true)}
							type="button"
						>
							Open publisher
						</button>
					</div>
				</header>
				<PublishDialog kindLabel="App" onOpenChange={setOpen} open={open} />
			</div>
		</main>
	);
}

installFixture();
createRoot(document.getElementById("root")!).render(<ProofArtifact />);
