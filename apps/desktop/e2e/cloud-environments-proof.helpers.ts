import type { Page } from "@playwright/test";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import {
	type CloudEnvironmentState,
	parseCloudEnvironmentState,
} from "@ryuhq/protocol/cloud-environments";
import { z } from "zod";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for cloud-environments-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export const proofDirectory = proofEvidencePath("cloud-environments");
export interface CloudProofBrowserLog {
	consoleMessages: string[];
	errors: string[];
	requests: string[];
}

export const browserLog: CloudProofBrowserLog = {
	errors: [],
	consoleMessages: [],
	requests: [],
};

export async function installFixture(page: Page) {
	let snapshot: CloudEnvironmentState = {
		schemaVersion: 1,
		revision: 0,
		environments: [],
		vault: [],
	};
	let failSave = false;
	const requests: string[] = [];
	await page.route(
		/\/api\/cloud-environments(?:\/(?:import|shared(?:\/[^/]+\/import)?|[^/]+\/launch))?$/,
		async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			requests.push(`${request.method()} ${url.pathname}`);
			if (request.headers().authorization !== "Bearer cloud-proof-node-token") {
				await route.fulfill({
					status: 401,
					json: { error: "Unauthorized fixture request" },
				});
				return;
			}
			if (request.headers()["x-ryu-user-jwt"] !== "cloud-proof-user-identity") {
				await route.fulfill({
					status: 403,
					json: { error: "Missing fixture user identity" },
				});
				return;
			}
			if (url.pathname.startsWith("/alternate/")) {
				await route.fulfill({
					json: { schemaVersion: 1, revision: 0, environments: [], vault: [] },
				});
				return;
			}
			if (url.pathname.endsWith("/launch")) {
				await route.fulfill({
					status: 501,
					json: {
						error: {
							code: "cloud_environment_runtime_unsupported",
							message: "Restricted domain policies require a supported runtime",
						},
					},
				});
				return;
			}
			if (url.pathname.endsWith("/shared")) {
				const source = snapshot.environments[0];
				await route.fulfill({
					json: {
						environments: source
							? [
									{
										...source,
										id: "shared-profile",
										name: "Shared project template",
										privacy: "shared",
										published: true,
										vaultKeys: [],
										tailscaleVaultKey: null,
									},
								]
							: [],
					},
				});
				return;
			}
			if (url.pathname.endsWith("/shared/shared-profile/import")) {
				const source = snapshot.environments[0];
				if (source) {
					snapshot = {
						...snapshot,
						revision: snapshot.revision + 1,
						environments: [
							...snapshot.environments,
							{
								...source,
								id: "imported-profile",
								name: "Shared project template",
								privacy: "private",
								published: false,
								vaultKeys: [],
								tailscaleVaultKey: null,
							},
						],
					};
				}
				await route.fulfill({ json: snapshot });
				return;
			}
			if (url.pathname.endsWith("/import") && request.method() === "GET") {
				await route.fulfill({
					json: { names: ["DEMO_ACCESS_TOKEN", "DEMO_REGION"] },
				});
				return;
			}
			if (url.pathname.endsWith("/import") && request.method() === "POST") {
				const parsed = z
					.object({ keys: z.array(z.string()) })
					.safeParse(request.postDataJSON());
				if (!parsed.success) {
					await route.fulfill({
						status: 400,
						json: { error: "Invalid import" },
					});
					return;
				}
				const input = parsed.data;
				snapshot = {
					...snapshot,
					revision: snapshot.revision + 1,
					vault: [
						...snapshot.vault,
						...input.keys
							.filter((key): key is string => isNativeText(key))
							.map((key) => ({
								id: `import-${key}`,
								key,
								kind: "variable" as const,
								hasValue: true,
								domains: [],
								environmentIds: [],
							})),
					],
				};
			}
			if (request.method() === "PUT") {
				if (failSave) {
					await route.fulfill({
						status: 500,
						json: { error: "Could not save cloud settings" },
					});
					return;
				}
				const parsed = z
					.object({ vault: z.array(z.record(z.string(), z.json())) })
					.passthrough()
					.safeParse(request.postDataJSON());
				if (!parsed.success) {
					await route.fulfill({
						status: 400,
						json: { error: "Invalid fixture snapshot" },
					});
					return;
				}
				const input = parsed.data;
				const vault = input.vault.map((entry) => {
					const value = "value" in entry ? entry.value : undefined;
					const metadata = Object.fromEntries(
						Object.entries(entry).filter(([key]) => key !== "value")
					);
					return {
						...metadata,
						hasValue:
							(isNativeText(value) && value.length > 0) ||
							snapshot.vault.some(
								(saved) => saved.id === metadata.id && saved.hasValue
							),
					};
				});
				snapshot = parseCloudEnvironmentState({
					...input,
					vault,
					revision: snapshot.revision + 1,
				});
			}
			await route.fulfill({ json: snapshot });
		}
	);
	return {
		requests,
		getSnapshot: () => snapshot,
		setSnapshot: (next: CloudEnvironmentState) => {
			snapshot = parseCloudEnvironmentState(next);
		},
		setFailSave: (value: boolean) => {
			failSave = value;
		},
	};
}
