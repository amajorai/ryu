import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The authoritative top-level `organizationKind` must reach Better Auth's
 * organization reads (`listOrganizations`, `getFullOrganization`), because
 * apps/web's `organizationKindOf` prefers it over a metadata key a racing
 * update can leave stale. Better Auth's adapter copies only DECLARED fields
 * into its output, so this proves the declaration on the real auth config and
 * that Better Auth's own writes never set the field.
 *
 * The config half always runs. The read/write half needs a Mongo and is
 * opt-in like the other native-Mongo proofs: set `RYU_AUTH_MONGODB_PROOF_URI`,
 * for example `mongodb://127.0.0.1:27019/ryu_auth_org_kind_output_proof`.
 */

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const authIndex = fileURLToPath(new URL("./index.ts", import.meta.url));
const dbIndex = fileURLToPath(import.meta.resolve("@ryu/db"));
const controlPlaneModels = fileURLToPath(
	import.meta.resolve("@ryu/db/models/control-plane.model")
);
const proofUri = process.env.RYU_AUTH_MONGODB_PROOF_URI;

function runAuthScript(source: string, databaseUrl: string): void {
	const run = spawnSync(process.execPath, ["-e", source], {
		cwd: repoRoot,
		encoding: "utf8",
		env: {
			...process.env,
			BETTER_AUTH_SECRET: "organization-kind-output-test-config-value",
			BETTER_AUTH_URL: "http://localhost:3000",
			DATABASE_URL: databaseUrl,
			NODE_ENV: "test",
			POLAR_ACCESS_TOKEN: "local-test",
			POLAR_BILLING_AUTHORITY: "local",
			POLAR_SERVER: "sandbox",
			POLAR_SUCCESS_URL: "http://localhost:3001/success",
			RYU_DIR: "/tmp/ryu-dev-headless",
			RYU_DB_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
			RYU_KEYCHAIN: "off",
			RYU_PROFILE: "dev",
			TURNSTILE_SECRET_KEY: "",
		},
		timeout: 120_000,
	});
	if (run.error) {
		throw run.error;
	}
	if (run.status !== 0) {
		throw new Error(
			`Auth script exited ${run.status}: ${run.stdout}\n${run.stderr}`
		);
	}
}

describe("organization kind in Better Auth organization reads", () => {
	test(
		"declares the top-level kind as a server-owned output field",
		() => {
			runAuthScript(
				`
				const { auth } = await import(${JSON.stringify(authIndex)});
				const organization = (auth.options.plugins ?? []).find(
					(plugin) => plugin.id === "organization"
				);
				const field =
					organization?.options?.schema?.organization?.additionalFields
						?.organizationKind;
				const ok =
					field?.type === "string" &&
					field.input === false &&
					field.required === false &&
					field.defaultValue === undefined;
				process.exit(ok ? 0 : 1);
			`,
				proofUri ?? "mongodb://127.0.0.1:27017/ryu-auth-org-kind-config-test"
			);
		},
		{ timeout: 180_000 }
	);

	test.skipIf(!proofUri)(
		"returns the authoritative kind over stale metadata and never writes it",
		() => {
			runAuthScript(
				`
				const { auth } = await import(${JSON.stringify(authIndex)});
				const { client, mongoClient } = await import(${JSON.stringify(dbIndex)});
				const { Organization } = await import(
					${JSON.stringify(controlPlaneModels)}
				);
				const { ObjectId } = Organization.base.Types;
				const fail = (message) => {
					console.error(message);
					process.exit(1);
				};
				await client.dropDatabase();
				const id = new ObjectId();
				// A family enable won the kind; a racing Better Auth update then
				// wrote back metadata read before it.
				await client.collection("organization").insertOne({
					_id: id,
					createdAt: new Date(),
					metadata: JSON.stringify({ organizationKind: "personal" }),
					name: "Family",
					organizationKind: "family",
					slug: "personal-owner",
				});
				const ctx = await auth.$context;
				const where = [{ field: "id", value: String(id) }];
				const read = await ctx.adapter.findOne({ model: "organization", where });
				if (read?.organizationKind !== "family") {
					fail("read lost the kind: " + JSON.stringify(read));
				}
				const listed = await ctx.adapter.findMany({ model: "organization", where });
				if (listed?.[0]?.organizationKind !== "family") {
					fail("list lost the kind: " + JSON.stringify(listed));
				}
				await ctx.adapter.update({
					model: "organization",
					update: {
						metadata: JSON.stringify({ organizationKind: "personal" }),
						name: "Renamed",
					},
					where,
				});
				const legacyId = new ObjectId();
				await ctx.adapter.create({
					data: {
						createdAt: new Date(),
						id: String(legacyId),
						metadata: JSON.stringify({ organizationKind: "personal" }),
						name: "Created",
						slug: "personal-created",
					},
					forceAllowId: true,
					model: "organization",
				});
				const stored = await client.collection("organization").findOne({ _id: id });
				if (stored?.organizationKind !== "family" || stored?.name !== "Renamed") {
					fail("update changed the kind: " + JSON.stringify(stored));
				}
				const created = await client
					.collection("organization")
					.findOne({ name: "Created" });
				if (!created || "organizationKind" in created) {
					fail("create wrote the kind: " + JSON.stringify(created));
				}
				await client.dropDatabase();
				await mongoClient.close();
				process.exit(0);
			`,
				proofUri ?? ""
			);
			expect(proofUri).toBeTruthy();
		},
		{ timeout: 180_000 }
	);
});
