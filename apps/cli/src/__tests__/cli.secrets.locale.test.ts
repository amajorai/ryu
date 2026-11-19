// `ryu-cli secrets` output under a German translator: empty lists, decision
// confirmations and the shared-values warning are whole catalog sentences, so
// none of them stays English when the CLI runs in another language.
import { describe, expect, mock, test } from "bun:test";
import { createCliTranslator } from "../i18n/translate.ts";

// Pin the CLI to a German stub catalog before any command module loads, the
// way LANG=de_DE.UTF-8 does at startup; the shipped catalog has no entries
// for these sentences yet.
const german = createCliTranslator("de", {
	"No secrets.": "Keine Secrets.",
	"No password-manager grants.": "Keine Passwortmanager-Freigaben.",
	"No applied change requests.": "Keine angewendeten Änderungsanfragen.",
	"The broker reads current values on every request, so --watch is not needed with --broker.":
		"Der Broker liest bei jeder Anfrage die aktuellen Werte, daher ist --watch mit --broker nicht nötig.",
	"Rejected {id}.": "{id} abgelehnt.",
	"Approved card approval {id} (grant for {subject} at {merchant}, {uses, plural, one {# use} other {# uses}}).":
		"Kartenfreigabe {id} genehmigt (Freigabe für {subject} bei {merchant}, {uses, plural, one {# Nutzung} other {# Nutzungen}}).",
	"Approved card approval {id} (grant for the requester at {merchant}).":
		"Kartenfreigabe {id} genehmigt (Freigabe für die anfragende Stelle bei {merchant}).",
	"Rejected card approval {id}.": "Kartenfreigabe {id} abgelehnt.",
	"Warning: Team and Organization values are missing because the control plane couldn't be reached ({sharedError}). Only your own and this node's values were used.":
		"Warnung: Team- und Organisationswerte fehlen, weil die Steuerungsebene nicht erreichbar war ({sharedError}). Es wurden nur deine eigenen Werte und die dieses Knotens verwendet.",
});
mock.module("../i18n/translate.ts", () => ({
	CLI_FORMAT_LOCALE: "de",
	CLI_LOCALE: "de",
	CLI_TRANSLATOR: german,
	createCliTranslator,
	tf: german.tf,
	tr: german.tr,
	trMessage: german.trMessage,
	translateProps: german.translateProps,
}));
const { fakeNode, json, jsonExport, listBody, runSecrets } = await import(
	"./secrets-fixture.ts"
);

const T = "2030-01-01T00:00:00Z";
const cardApproval = {
	id: "cap_1",
	itemId: "itm_1",
	environment: "default",
	path: "/",
	key: "visa",
	brand: "visa",
	last4: "4242",
	channel: "broker",
	merchantHost: "shop.example.com",
	requester: "broker_session:bvs_1",
	agent: "machine:m1",
	status: "approved",
	mode: "grant",
	uses: 0,
	requestedAt: T,
	requestExpiresAt: T,
};

function cardNode(approval: Record<string, unknown>) {
	return fakeNode({
		"POST /api/vault/cards/approvals/cap_1/approve": json({ approval }),
		"POST /api/vault/cards/approvals/cap_1/reject": json({
			approval: { ...cardApproval, status: "rejected", mode: undefined },
		}),
	});
}

describe("ryu-cli secrets under a German translator", () => {
	test("an empty list says so in German", async () => {
		const node = fakeNode({ "GET /api/vault/secrets": json(listBody([])) });
		const result = await runSecrets(["list"], node);
		expect(result.code).toBe(0);
		expect(result.out).toBe("Keine Secrets.\n");
	});

	test("an empty password-manager grant list says so in German", async () => {
		const node = fakeNode({
			"GET /api/vault/password-managers/grants": json({ grants: [] }),
		});
		const result = await runSecrets(["pm", "grants"], node);
		expect(result.code).toBe(0);
		expect(result.out).toBe("Keine Passwortmanager-Freigaben.\n");
	});

	test("an empty change-request list names its status in German", async () => {
		const node = fakeNode({
			"GET /api/vault/change-requests": json({
				changeRequests: [],
				sharedError: null,
			}),
		});
		const result = await runSecrets(
			["approvals", "list", "--status", "applied"],
			node
		);
		expect(result.code).toBe(0);
		expect(result.out).toBe("Keine angewendeten Änderungsanfragen.\n");
		expect(node.calls[0]?.path).toBe(
			"/api/vault/change-requests?status=applied"
		);
	});

	test("run --broker --watch explains the redundant flag in German", async () => {
		const node = fakeNode({});
		const result = await runSecrets(
			["run", "--broker", "github", "--watch", "--", "true"],
			node
		);
		expect(result.err).toStartWith(
			"Der Broker liest bei jeder Anfrage die aktuellen Werte, daher ist --watch mit --broker nicht nötig.\n"
		);
	});

	test("pm approvals reject confirms in German", async () => {
		const node = fakeNode({
			"POST /api/vault/password-managers/approvals/pma_1/reject": json({
				rejected: true,
			}),
		});
		const result = await runSecrets(
			["pm", "approvals", "reject", "pma_1"],
			node
		);
		expect(result.code).toBe(0);
		expect(result.out).toBe("pma_1 abgelehnt.\n");
	});

	test("cards approvals approve names the grant and its uses in German", async () => {
		const node = cardNode({
			...cardApproval,
			grantSubject: "machine:m1",
			maxUses: 1,
		});
		const result = await runSecrets(
			["cards", "approvals", "approve", "cap_1", "--mode", "grant"],
			node
		);
		expect(result.code).toBe(0);
		expect(result.out).toBe(
			"Kartenfreigabe cap_1 genehmigt (Freigabe für machine:m1 bei shop.example.com, 1 Nutzung).\n"
		);
	});

	test("a grant without a subject names the requester as a whole sentence", async () => {
		const node = cardNode(cardApproval);
		const result = await runSecrets(
			["cards", "approvals", "approve", "cap_1", "--mode", "grant"],
			node
		);
		expect(result.out).toBe(
			"Kartenfreigabe cap_1 genehmigt (Freigabe für die anfragende Stelle bei shop.example.com).\n"
		);
	});

	test("cards approvals reject confirms in German", async () => {
		const node = cardNode(cardApproval);
		const result = await runSecrets(
			["cards", "approvals", "reject", "cap_1"],
			node
		);
		expect(result.out).toBe("Kartenfreigabe cap_1 abgelehnt.\n");
	});

	test("export warns in German when shared values are missing", async () => {
		const node = fakeNode({
			"POST /api/vault/export": json({
				...jsonExport({ API_KEY: "k" }),
				sharedError: "vault_shared_unreachable: the control plane answered 503",
			}),
		});
		const result = await runSecrets(
			["export", "--no-project", "--format", "json"],
			node
		);
		expect(result.code).toBe(0);
		expect(result.out).toBe('{"API_KEY":"k"}\n');
		expect(result.err).toBe(
			"Warnung: Team- und Organisationswerte fehlen, weil die Steuerungsebene nicht erreichbar war (vault_shared_unreachable: the control plane answered 503). Es wurden nur deine eigenen Werte und die dieses Knotens verwendet.\n"
		);
	});
});
