import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

// Wire owner: crates/gateway/contracts/src/composio_billing.rs. Optional fields
// retain serde defaults; the HTTP fixture serializes their original omissions.
interface ComposioUsage {
	authSource: "ownApp" | "managedApp" | "instant";
	directExecution?: boolean;
	kind: "toolCall" | "triggerEvent" | "meta";
	premiumChargeMicroUsd?: number | null;
	proxyExecution?: boolean;
	sandboxExecution?: boolean;
	sharedConnection?: boolean;
}

// Native publishers: api/budget.rs and pipeline/mod.rs; amounts are u64
// serialized as JSON numbers, including integers beyond JS's safe range.
const nativeAmountSchema = z.number().refine(Number.isInteger).nonnegative();
const nativeDebitSchema = z.looseObject({
	orgId: z.string(),
	amountMicroUsd: nativeAmountSchema,
	reason: z.string(),
	refId: z.string(),
});
const nativeChargeResponseSchema = z.looseObject({
	accepted: z.literal(true),
	tool_calls: nativeAmountSchema,
	provider: z.string(),
	tool_id: z.string().nullable(),
	cost_micro_usd: nativeAmountSchema,
	composioCharge: z.object({
		baseMicroUsd: nativeAmountSchema,
		addonsMicroUsd: nativeAmountSchema,
		premiumMicroUsd: nativeAmountSchema,
		totalMicroUsd: nativeAmountSchema,
	}),
	currency: z.literal("USD"),
	unit: z.literal("micro_usd"),
});

for (const enabled of [false, true]) {
	test(`native Gateway ZDR rollout ${enabled ? "on" : "off"} debits exact costs uniformly and deduplicates retries`, async () => {
		const root = path.resolve(import.meta.dirname, "../../..");
		const work = path.join(root, ".tmp/composio-billing-http-proof");
		await mkdir(work, { recursive: true });
		let balance = 20_000;
		const seen = new Set<string>();
		const ledger: {
			amountMicroUsd: number;
			orgId: string;
			refId: string;
			duplicate: boolean;
		}[] = [];
		const wallet = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (new URL(request.url).pathname !== "/api/credits/debit") {
					return new Response("Not found", { status: 404 });
				}
				expect(request.headers.get("x-ryu-internal-secret")).toBe(
					"fixture-wallet-secret"
				);
				const body = nativeDebitSchema.parse(await request.json());
				const key = `${body.orgId}:${body.refId}`;
				const duplicate = seen.has(key);
				if (!duplicate) {
					seen.add(key);
					balance -= body.amountMicroUsd;
				}
				ledger.push({
					amountMicroUsd: body.amountMicroUsd,
					orgId: body.orgId,
					refId: body.refId,
					duplicate,
				});
				return Response.json({
					applied: !duplicate,
					duplicate,
					balanceMicroUsd: balance,
					wentNonPositive: balance <= 0,
				});
			},
		});
		const reservation = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("reserved"),
		});
		const port = reservation.port;
		reservation.stop(true);
		const master = `gwadm_${"a".repeat(64)}`;
		const configPath = path.join(work, "gateway.toml");
		await writeFile(
			configPath,
			`bind = "127.0.0.1:${port}"\n[auth]\nrequire_auth = true\nmaster_key = "${master}"\n[credits]\nenabled = true\nbase_url = "http://127.0.0.1:${wallet.port}"\ninternal_secret = "fixture-wallet-secret"\nmarkup_bps = 0\n[composio.billing]\nzeroDataRetention = ${enabled}\n`
		);
		const inheritedEnvironment = Object.fromEntries(
			[
				"PATH",
				"SystemRoot",
				"USERPROFILE",
				"APPDATA",
				"LOCALAPPDATA",
				"TEMP",
				"TMP",
			].flatMap((key) => {
				const value = process.env[key];
				return value ? [[key, value]] : [];
			})
		);
		const env = {
			GATEWAY_CONFIG: configPath,
			RYU_PROFILE: "dev",
			RYU_KEYCHAIN: "off",
			RYU_DIR: work,
			RUST_LOG: "warn",
			...inheritedEnvironment,
		};
		const child = Bun.spawn([path.join(root, "target/debug/ryu-gateway.exe")], {
			cwd: work,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		const origin = `http://127.0.0.1:${port}`;
		const deadline = Date.now() + 30_000;
		try {
			let ready = false;
			while (Date.now() < deadline) {
				ready = await fetch(`${origin}/health`)
					.then((response) => response.ok)
					.catch(() => false);
				if (ready) {
					break;
				}
				await Bun.sleep(100);
			}
			expect(ready).toBe(true);
			const charge = async (
				transaction: string,
				usage: ComposioUsage,
				orgId = "proof-org"
			) => {
				const response = await fetch(`${origin}/v1/budget/charge`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${master}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						org_id: orgId,
						provider: "composio",
						tool_calls: 1,
						transaction_id: transaction,
						request_id: transaction,
						composioUsage: usage,
					}),
				});
				expect(response.status).toBe(200);
				return nativeChargeResponseSchema.parse(await response.json());
			};
			const premium = await charge("log-proof", {
				kind: "toolCall",
				authSource: "managedApp",
				directExecution: true,
				premiumChargeMicroUsd: 8000,
			});
			expect(premium.composioCharge).toEqual({
				baseMicroUsd: 500,
				addonsMicroUsd: enabled ? 200 : 100,
				premiumMicroUsd: 8000,
				totalMicroUsd: enabled ? 8700 : 8600,
			});
			const trigger = {
				kind: "triggerEvent",
				authSource: "managedApp",
			} satisfies ComposioUsage;
			expect(
				(await charge("trigger:delivery-proof", trigger)).cost_micro_usd
			).toBe(5000);
			await charge("trigger:delivery-proof", trigger);
			const deliveryDeadline = Date.now() + 10_000;
			while (ledger.length < 3 && Date.now() < deliveryDeadline) {
				await Bun.sleep(50);
			}
			expect(ledger).toHaveLength(3);
			expect(balance).toBe(enabled ? 6300 : 6400);
			expect(ledger.filter((row) => row.duplicate)).toHaveLength(1);
			expect(ledger.every((row) => row.orgId === "proof-org")).toBe(true);
			const direct = {
				kind: "toolCall",
				authSource: "managedApp",
				directExecution: true,
			} satisfies ComposioUsage;
			expect(
				(await charge("log-other-org", direct, "other-org")).cost_micro_usd
			).toBe(enabled ? 700 : 600);
			const secondDeadline = Date.now() + 10_000;
			while (ledger.length < 4 && Date.now() < secondDeadline) {
				await Bun.sleep(50);
			}
			expect(ledger).toHaveLength(4);
			expect(
				ledger.find((row) => row.orgId === "other-org")?.amountMicroUsd
			).toBe(enabled ? 700 : 600);
			const proofDir = path.join(root, "docs/proof/composio-billing");
			await mkdir(proofDir, { recursive: true });
			const proof = {
				mode: "native Gateway with fixture wallet",
				composioZdrEnabled: enabled,
				startingBalanceMicroUsd: 20_000,
				endingBalanceMicroUsd: balance,
				premium: premium.composioCharge,
				ledger: ledger.sort(
					(a, b) =>
						a.refId.localeCompare(b.refId) ||
						Number(a.duplicate) - Number(b.duplicate)
				),
			};
			await writeFile(
				path.join(
					proofDir,
					`standard-zdr-ledger-${enabled ? "on" : "off"}.json`
				),
				`${JSON.stringify(proof, null, 2)}\n`
			);
		} finally {
			child.kill();
			await child.exited;
			wallet.stop(true);
			await Promise.all([stdout, stderr]);
		}
	}, 90_000);
}
