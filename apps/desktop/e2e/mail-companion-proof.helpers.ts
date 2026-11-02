import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import type {
	MailProofApi,
	MailProofCall,
	MailProofState,
} from "./harness/mail-companion-proof.types.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for mail-companion-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export const appHtmlPath = `${tmpdir()}/ryu-mail-companion-ui-build/index.html`;
export const evidenceDirectory = proofEvidencePath(
	"test-coverage-sweep-20260924/evidence"
);

declare global {
	interface Window {
		__mailProof: MailProofApi;
	}
}

export async function openHost(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForSelector("body[data-harness-ready='1']");
}

export async function mountMail(
	page: Page,
	options: {
		emptyInboxes?: boolean;
		failure?: { message: string; method: string };
	} = {}
): Promise<FrameLocator> {
	await openHost(page);
	if (options.failure) {
		await page.evaluate((input) => {
			window.__mailProof.failNext(input.method, input.message);
		}, options.failure);
	}
	const appHtml = await readFile(appHtmlPath, "utf8");
	await page.evaluate((input) => window.__mailProof.mount(input), {
		appHtml,
		emptyInboxes: options.emptyInboxes,
	});
	await expect
		.poll(() => page.evaluate(() => window.__mailProof.connected()), {
			timeout: 15_000,
		})
		.toBe(true);
	const companion = page.frameLocator('iframe[title="Mail proof"]');
	await expect(
		companion.getByRole("heading", { name: "Agent Inboxes" })
	).toBeVisible();
	return companion;
}

export async function calls(page: Page): Promise<MailProofCall[]> {
	return page.evaluate(() => window.__mailProof.calls());
}

export async function state(page: Page): Promise<MailProofState> {
	return page.evaluate(() => window.__mailProof.state());
}

export async function waitForCall(
	page: Page,
	method: string,
	path?: string,
	index = -1
): Promise<MailProofCall> {
	await expect
		.poll(async () => {
			const matching = (await calls(page)).filter(
				(call) =>
					call.method === method && (path === undefined || call.path === path)
			);
			return matching.at(index)?.status ?? 0;
		})
		.toBeGreaterThan(0);
	const matching = (await calls(page)).filter(
		(call) =>
			call.method === method && (path === undefined || call.path === path)
	);
	const call = matching.at(index);
	if (!call) {
		throw new Error(
			`No Mail fixture call was captured for ${method} ${path ?? ""}.`
		);
	}
	return call;
}

export async function capture(
	companion: FrameLocator,
	filename: string
): Promise<void> {
	await mkdir(evidenceDirectory, { recursive: true });
	await companion.locator("body").screenshot({
		path: path.join(evidenceDirectory, filename),
	});
}
