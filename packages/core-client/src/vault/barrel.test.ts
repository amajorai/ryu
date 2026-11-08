import { expect, test } from "bun:test";
import * as vault from "../vault.ts";
import * as agentRoutes from "./agent-routes.ts";
import * as audit from "./audit.ts";
import * as broker from "./broker.ts";
import * as cards from "./cards.ts";
import * as changeRequests from "./change-requests.ts";
import * as codecsHuman from "./codecs-human.ts";
import * as codecsHumanEngines from "./codecs-human-engines.ts";
import * as codecsMachine from "./codecs-machine.ts";
import * as codecsReply from "./codecs-reply.ts";
import * as dynamic from "./dynamic.ts";
import * as environments from "./environments.ts";
import * as internal from "./internal.ts";
import * as items from "./items.ts";
import * as machineIdentities from "./machine-identities.ts";
import * as passwordManager from "./password-manager.ts";
import * as pki from "./pki.ts";
import * as policies from "./policies.ts";
import * as references from "./references.ts";
import * as seal from "./seal.ts";
import * as shared from "./shared.ts";
import * as ssh from "./ssh.ts";
import * as tokens from "./tokens.ts";
import * as totp from "./totp.ts";
import * as transfer from "./transfer.ts";
import * as transit from "./transit.ts";
import * as valueTypes from "./value-types.ts";
import * as values from "./values.ts";

const areaModules = {
	agentRoutes,
	audit,
	broker,
	cards,
	changeRequests,
	dynamic,
	environments,
	items,
	machineIdentities,
	passwordManager,
	pki,
	policies,
	references,
	seal,
	shared,
	ssh,
	tokens,
	totp,
	transfer,
	transit,
	values,
	valueTypes,
};

const codecModules = {
	codecsHuman,
	codecsHumanEngines,
	codecsMachine,
	codecsReply,
};

test("the barrel re-exports every area module's runtime exports unchanged", () => {
	const barrel: Record<string, unknown> = vault;
	for (const [area, module] of Object.entries(areaModules)) {
		for (const [name, value] of Object.entries(module)) {
			expect({ area, name, same: barrel[name] === value }).toEqual({
				area,
				name,
				same: true,
			});
		}
	}
});

test("the barrel exposes only the public codec constants", () => {
	const barrel: Record<string, unknown> = vault;
	const codecNames = Object.values(codecModules).flatMap((module) =>
		Object.keys(module)
	);
	const public_ = codecNames.filter((name) => name in barrel).sort();
	expect(public_).toEqual([
		"VAULT_TOKEN_HEADER",
		"VAULT_TRANSIT_KEY_TYPES",
		"VAULT_WRAP_TTL_HEADER",
	]);
	expect(vault.VAULT_TOKEN_HEADER).toBe("x-ryu-vault-token");
});

test("request helpers stay internal to the vault modules", () => {
	const barrel: Record<string, unknown> = vault;
	for (const name of Object.keys(internal)) {
		expect({ name, exported: name in barrel }).toEqual({
			name,
			exported: false,
		});
	}
	expect(internal.secretPath("A B", "/reveal")).toBe(
		"/api/vault/secrets/A%20B/reveal"
	);
	expect(internal.query({ environment: "dev", path: undefined })).toBe(
		"?environment=dev"
	);
	expect(internal.query({})).toBe("");
});
