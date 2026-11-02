import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import type { ProofJsonRecord } from "./fixture-json.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for security-companion-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export const APP_HTML = `${tmpdir()}/ryu-security-companion-ui-build/index.html`;
export const EVIDENCE = proofEvidencePath(
	"test-coverage-sweep-20260924/evidence"
);

export interface SecurityCall {
	body?: ProofJsonRecord;
	method: string;
	orgId: string;
	path: string;
	result?: unknown;
	status: number;
	tenantUserId: string;
}

export interface SecurityFixturePaths {
	changesRepository: string;
	codebaseRepository: string;
}

declare global {
	interface Window {
		__securityProof: {
			calls: () => SecurityCall[];
			clearCalls: () => void;
			connected: () => boolean;
			failNext: (failure: {
				message: string;
				method: string;
				path: string;
				status: number;
			}) => void;
			mount: (input: {
				appHtml: string;
				orgId: string;
				screen: "findings" | "repositories" | "scans";
				tenantUserId: string;
			}) => void;
		};
	}
}

export async function mountSecurity(
	page: Page,
	screen: "findings" | "repositories" | "scans" = "scans",
	tenantUserId = `security-proof-${randomUUID()}`
): Promise<{ companion: FrameLocator; tenantUserId: string }> {
	await page.goto("/security-companion-proof.html");
	await page.waitForSelector("body[data-harness-ready='1']");
	await page.evaluate(
		({ appHtml, mountScreen, userId }) =>
			window.__securityProof.mount({
				appHtml,
				orgId: "security-proof-org",
				screen: mountScreen,
				tenantUserId: userId,
			}),
		{
			appHtml: readFileSync(APP_HTML, "utf8"),
			mountScreen: screen,
			userId: tenantUserId,
		}
	);
	await expect
		.poll(() => page.evaluate(() => window.__securityProof.connected()), {
			timeout: 15_000,
		})
		.toBe(true);
	return { companion: page.frameLocator("iframe"), tenantUserId };
}

export async function fixturePaths(page: Page): Promise<SecurityFixturePaths> {
	// SAFETY: This proof host owns /__proof/fixtures and serializes both repository paths directly from its native path.join string values.
	return (await page.request
		.get("/__proof/fixtures")
		.then((response) => response.json())) as SecurityFixturePaths;
}

export async function calls(page: Page): Promise<SecurityCall[]> {
	return await page.evaluate(() => window.__securityProof.calls());
}

export async function clearCalls(page: Page): Promise<void> {
	await page.evaluate(() => window.__securityProof.clearCalls());
}

export async function capture(
	companion: FrameLocator,
	filename: string
): Promise<void> {
	await mkdir(EVIDENCE, { recursive: true });
	await companion.locator("body").screenshot({
		animations: "disabled",
		path: path.join(EVIDENCE, filename),
	});
}

export function requests(
	allCalls: SecurityCall[],
	method: string,
	pathName: string
): SecurityCall[] {
	return allCalls.filter(
		(call) => call.method === method && call.path === pathName
	);
}

export function detailStatus(companion: FrameLocator) {
	return companion
		.locator(".security-meta-item")
		.filter({ hasText: "Status" })
		.locator(".security-meta-value");
}
