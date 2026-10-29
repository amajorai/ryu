import { z } from "zod";

declare const window: Window;

import { Toaster } from "@ryu/ui/components/sileo.tsx";
import {
	isNativeNumber,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import PrivatePackageShareDialog from "../../src/components/marketplace/PrivatePackageShareDialog.tsx";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

interface ApiCall {
	body: unknown;
	method: string;
	path: string;
}

interface ShareCodeFixture {
	code: string;
	created_at: string;
	customer_organization_id: string | null;
	expires_at: string;
	id: string;
	item_id: string;
	item_kind: string;
	item_version: string;
	label: string | null;
	max_redemptions: number;
	redemption_count: number;
	revoked_at: string | null;
}

interface DeferredCreate {
	promise: Promise<void>;
	release: () => void;
}

interface PrivatePackageShareFixture {
	failNextCreate: (message?: string) => void;
	failNextRevoke: (message?: string) => void;
	holdNextCreate: () => void;
	releaseCreate: () => void;
}

interface PrivatePackageShareProofWindow extends Window {
	__privatePackageShareCalls: ApiCall[];
	__privatePackageShareFixture: PrivatePackageShareFixture;
	__privatePackageShareRecords: ShareCodeFixture[];
}

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function parseBody(init?: RequestInit) {
	if (!isNativeText(init?.body)) {
		return null;
	}
	try {
		return parseProofJson(init.body);
	} catch {
		return init.body;
	}
}

const proofWindow =
	/* SAFETY: This module initializes these private capture, record, and callback holders from the complete locally typed arrays and fixture methods below; captured HTTP bodies remain unknown. */ window as PrivatePackageShareProofWindow;
const apiCalls: ApiCall[] = [];
const records: ShareCodeFixture[] = [];
let createFailure: string | null = null;
let revokeFailure: string | null = null;
let deferredCreate: DeferredCreate | null = null;
let releaseHeldCreate: (() => void) | null = null;
let nextShareCodeId = 1;

proofWindow.__privatePackageShareCalls = apiCalls;
proofWindow.__privatePackageShareRecords = records;
proofWindow.__privatePackageShareFixture = {
	failNextCreate: (message = "Fixture create failed.") => {
		createFailure = message;
	},
	failNextRevoke: (message = "Fixture revoke failed.") => {
		revokeFailure = message;
	},
	holdNextCreate: () => {
		let release: Parameters<ConstructorParameters<typeof Promise<void>>[0]>[0] =
			() => undefined;
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		releaseHeldCreate = release;
		deferredCreate = { promise, release };
	},
	releaseCreate: () => {
		releaseHeldCreate?.();
		releaseHeldCreate = null;
	},
};

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
	const rawUrl = input instanceof Request ? input.url : String(input);
	const url = new URL(rawUrl, window.location.origin);
	const method = init?.method ?? "GET";
	const path = url.pathname;
	apiCalls.push({ body: parseBody(init), method, path });

	if (path.endsWith("/api/marketplace/share-codes") && method === "POST") {
		const gate = deferredCreate;
		if (gate) {
			deferredCreate = null;
			await gate.promise;
		}
		if (createFailure) {
			const message = createFailure;
			createFailure = null;
			return json({ message }, 503);
		}
		const requestBody = z
			.record(z.string(), z.json())
			.safeParse(parseBody(init));
		if (!requestBody.success) {
			return json({ message: "Fixture expected a create request body." }, 400);
		}
		// SAFETY: The preceding request guard rejects null and non-objects; members stay unknown before existing scalar checks.
		const body = requestBody.data;
		const shareCode: ShareCodeFixture = {
			code: "7K4MX2QP9F6D",
			created_at: "2026-09-28T00:00:00.000Z",
			customer_organization_id: isNativeText(body.customerOrganizationId)
				? body.customerOrganizationId
				: null,
			expires_at: isNativeText(body.expiresAt)
				? body.expiresAt
				: "2026-10-05T00:00:00.000Z",
			id: `share-code-fixture-${nextShareCodeId}`,
			item_id: isNativeText(body.id) ? body.id : "",
			item_kind: isNativeText(body.kind) ? body.kind : "bundle",
			item_version: "2.1.0",
			label: isNativeText(body.label) ? body.label : null,
			max_redemptions: isNativeNumber(body.maxRedemptions)
				? body.maxRedemptions
				: 1,
			redemption_count: 0,
			revoked_at: null,
		};
		nextShareCodeId += 1;
		records.push(shareCode);
		return json({ code: shareCode.code, shareCode });
	}

	const revokeMatch = path.match(
		/\/api\/marketplace\/share-codes\/([^/]+)\/revoke$/
	);
	if (revokeMatch && method === "POST") {
		if (revokeFailure) {
			const message = revokeFailure;
			revokeFailure = null;
			return json({ message }, 503);
		}
		const id = decodeURIComponent(revokeMatch[1] ?? "");
		const record = records.find((candidate) => candidate.id === id);
		if (!record) {
			return json({ message: "Fixture share code was not found." }, 404);
		}
		record.revoked_at = "2026-09-28T01:00:00.000Z";
		return json({ ok: true });
	}

	return json(
		{ message: `Unexpected local fixture request: ${method} ${path}` },
		404
	);
};

function Story() {
	const [open, setOpen] = useState(true);
	return (
		<main className="min-h-screen bg-muted/40 px-6 py-10 text-foreground sm:px-10">
			<div className="mx-auto max-w-4xl">
				<header className="mb-8">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-label">
						Marketplace · publisher handoff
					</p>
					<h1 className="mt-2 font-semibold text-3xl tracking-tight">
						Share a private release
					</h1>
					<p className="mt-3 max-w-2xl text-muted-foreground">
						Create a time-limited fixture code for a signed Marketplace release.
						This local proof does not redeem codes or contact recipients.
					</p>
				</header>
				<section
					className="rounded-3xl border bg-card p-6 shadow-sm"
					data-testid="private-package-share-proof"
				>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div>
							<p className="font-medium">Publisher workspace</p>
							<p className="mt-1 text-muted-foreground text-sm">
								Local fixture · no customer data
							</p>
						</div>
						<button
							className="rounded-md border bg-background px-3 py-2 text-sm"
							onClick={() => setOpen(true)}
							type="button"
						>
							Open publisher share
						</button>
					</div>
				</section>
			</div>
			<PrivatePackageShareDialog onClose={() => setOpen(false)} open={open} />
			<Toaster />
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
