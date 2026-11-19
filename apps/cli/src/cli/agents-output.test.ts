// `ryu-cli agents show` renders every label, mode description, account note
// and pending-request hint through the CLI translator, so a language pack
// changes the whole card rather than only the headline. The stub catalogs
// stand in for packs that do not carry these sentences yet.
import { describe, expect, mock, test } from "bun:test";
import { type CliTranslator, createCliTranslator } from "../i18n/translate.ts";
import type { AgentIdentityView } from "./agents-core.ts";

const german = createCliTranslator("de", {
	"Agent: {name} ({id})": "Agent: {name} ({id})",
	"Engine: {engine}": "Engine: {engine}",
	"How it works: {title}": "So funktioniert es: {title}",
	Both: "Beides",
	"Its own identity": "Eigene Identität",
	"Has its own accounts, and can also use the ones of yours you allow.":
		"Hat eigene Konten und kann auch die Ihren nutzen, die Sie erlauben.",
	"Its engine runs in a sandbox that hides Ryu's own data.":
		"Seine Engine läuft in einer Sandbox, die Ryus eigene Daten verbirgt.",
	"App request: {mode}. A newer version of this agent's app asks for it; nothing changes until you choose.":
		"App-Anfrage: {mode}. Eine neuere Version der App dieses Agents fordert das an; bis Sie wählen, ändert sich nichts.",
	"Accept: ryu-cli agents identity {id} {mode}":
		"Annehmen: ryu-cli agents identity {id} {mode}",
	"Dismiss and keep {mode}: ryu-cli agents identity {id} dismiss":
		"Ablehnen und {mode} behalten: ryu-cli agents identity {id} dismiss",
	"Account access: {headline}": "Kontozugriff: {headline}",
	"Limited to {count, plural, one {# account} other {# accounts}}":
		"Beschränkt auf {count, plural, one {# Konto} other {# Konten}}",
	"Only these accounts can be used. Accounts you connect later are not added automatically.":
		"Nur diese Konten können genutzt werden. Später verbundene Konten werden nicht automatisch hinzugefügt.",
	"Model providers": "Modellanbieter",
	"Its own logins": "Eigene Anmeldungen",
	Other: "Sonstige",
	"not a key Core recognises, so it allows nothing":
		"kein Schlüssel, den Core kennt, daher erlaubt er nichts",
	"Agent '{id}' is locked. Unlock it before changing how it works or its account access.":
		"Agent „{id}“ ist gesperrt. Entsperren Sie ihn, bevor Sie seine Arbeitsweise oder seinen Kontozugriff ändern.",
});

const japanese = createCliTranslator("ja", {
	"Account access: {headline}": "アカウントへのアクセス: {headline}",
	"No limit": "制限なし",
	"Limited: no accounts": "制限あり: アカウントなし",
	"It can use every account of yours you've connected, and Treg. Accounts you connect later are included.":
		"接続済みのすべてのアカウントと Treg を使えます。後で接続するアカウントも含まれます。",
	"It can't use any accounts, or Treg.": "どのアカウントも Treg も使えません。",
	"Acts as you": "あなたとして動作",
	"Works on your behalf with the accounts you've connected.":
		"接続済みのアカウントであなたの代わりに作業します。",
	"How it works: {title}": "動作のしかた: {title}",
	"not used: it acts as you": "未使用: あなたとして動作します",
});

// Every helper reads the translator the module was mocked with; switching
// `active` lets one file cover two languages.
let active: CliTranslator = german;
mock.module("../i18n/translate.ts", () => ({
	CLI_FORMAT_LOCALE: "de",
	CLI_LOCALE: "de",
	get CLI_TRANSLATOR() {
		return active;
	},
	createCliTranslator,
	tf: (source: string, values: Readonly<Record<string, string | number>>) =>
		active.tf(source, values),
	tr: (value: string) => active.tr(value),
	trMessage: (value: string) => active.trMessage(value),
	translateProps: <Props>(props: Props) => active.translateProps(props),
}));
const { describeAccess, describeAgent, requireEditable } = await import(
	"./agents-output.ts"
);
const { accountKeyUnusedReason } = await import("../core/agentIdentity.ts");

const INDENT = " ".repeat(16);

function view(overrides: Partial<AgentIdentityView> = {}): AgentIdentityView {
	return {
		accountAccess: null,
		engine: "acp:pi",
		id: "scout",
		identityMode: "managed",
		locked: false,
		name: "Scout",
		pendingIdentityMode: null,
		updatedAt: null,
		...overrides,
	};
}

describe("describeAgent in German", () => {
	test("translates the mode, the app request and the account notes", () => {
		active = german;
		const lines = describeAgent(
			view({
				accountAccess: ["provider:openai", "agent:v1", "bogus"],
				identityMode: "mixed",
				pendingIdentityMode: "individual",
			})
		).split("\n");
		expect(lines.slice(0, 9)).toEqual([
			"Agent: Scout (scout)",
			"Engine: acp:pi",
			"So funktioniert es: Beides (mixed)",
			`${INDENT}Hat eigene Konten und kann auch die Ihren nutzen, die Sie erlauben. Seine Engine läuft in einer Sandbox, die Ryus eigene Daten verbirgt.`,
			"App-Anfrage: Eigene Identität (individual). Eine neuere Version der App dieses Agents fordert das an; bis Sie wählen, ändert sich nichts.",
			`${INDENT}Annehmen: ryu-cli agents identity scout individual`,
			`${INDENT}Ablehnen und Beides (mixed) behalten: ryu-cli agents identity scout dismiss`,
			"Kontozugriff: Beschränkt auf 3 Konten",
			`${INDENT}Nur diese Konten können genutzt werden. Später verbundene Konten werden nicht automatisch hinzugefügt.`,
		]);
		const table = lines.slice(9).join("\n");
		expect(table).toContain("Modellanbieter");
		expect(table).toContain("Eigene Anmeldungen");
		expect(table).toMatch(
			/bogus +Sonstige +kein Schlüssel, den Core kennt, daher erlaubt er nichts/u
		);
		expect(table).not.toContain("Other");
	});

	test("refuses a locked agent in German", () => {
		active = german;
		expect(() => requireEditable(view({ locked: true }))).toThrow(
			"Agent „scout“ ist gesperrt. Entsperren Sie ihn, bevor Sie seine Arbeitsweise oder seinen Kontozugriff ändern."
		);
	});
});

describe("account access in Japanese", () => {
	test("the no-limit note follows the headline", () => {
		active = japanese;
		expect(describeAccess(view())).toEqual([
			"アカウントへのアクセス: 制限なし",
			`${INDENT}接続済みのすべてのアカウントと Treg を使えます。後で接続するアカウントも含まれます。`,
		]);
	});

	test("an empty allowlist says nothing can be used", () => {
		active = japanese;
		expect(describeAccess(view({ accountAccess: [] }))).toEqual([
			"アカウントへのアクセス: 制限あり: アカウントなし",
			`${INDENT}どのアカウントも Treg も使えません。`,
		]);
	});

	test("the mode line and an unused key's reason are Japanese", () => {
		active = japanese;
		const card = describeAgent(view()).split("\n");
		expect(card[2]).toBe("動作のしかた: あなたとして動作 (managed)");
		expect(card[3]).toBe(
			`${INDENT}接続済みのアカウントであなたの代わりに作業します。`
		);
		expect(accountKeyUnusedReason("agent:v1", "managed")).toBe(
			"未使用: あなたとして動作します"
		);
	});
});
