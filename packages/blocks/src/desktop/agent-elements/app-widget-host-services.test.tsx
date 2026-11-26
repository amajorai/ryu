import { expect, test } from "bun:test";
import {
	createOpenExternalAsk,
	type ExternalDestination,
	OPEN_EXTERNAL_MAX_PROMPTS,
	type OpenExternalAsk,
} from "@ryu/app-host/open-external-gate";
import {
	CodedRpcError,
	dispatchRpc,
	type HostServices,
} from "@ryu/app-host/rpc";
import { renderToStaticMarkup } from "react-dom/server";
import { useWidgetHostServices } from "./app-widget-host-services.ts";

// `ui.openExternal` needs no grant, so a widget frame with an EMPTY granted set
// reaches the shell's opener. These go through the real widget services and the
// real RPC gate: the opener must stay untouched until the person says yes to the
// shell's own prompt.

type Options = Parameters<typeof useWidgetHostServices>[0];

const LOOKALIKE_HOST =
	"accounts.google.com.signin.session-check.security-update.example-login.net";
const NO_GRANTS: ReadonlySet<never> = new Set();

/** Build the per-widget services the way AppWidget does, with a spy as the
 *  shell opener. The hook only memoizes, so one static render is enough. */
function widgetServices(askOpenExternal: OpenExternalAsk): {
	opened: string[];
	services: HostServices;
} {
	const opened: string[] = [];
	const built: { services: HostServices | null } = { services: null };
	const options = {
		askOpenExternal,
		data: null,
		fileAccess: undefined,
		globalsRef: { current: null },
		i18n: null,
		modalTemplateRef: { current: null },
		openExternalShell: (href: string) => {
			opened.push(href);
		},
		pushGlobals: () => undefined,
		services: undefined,
		setClosed: () => undefined,
		setDisplayMode: () => undefined,
		setHeight: () => undefined,
		stateStore: {},
		toastHost: {},
	} as unknown as Options;
	function Harness() {
		built.services = useWidgetHostServices(options);
		return null;
	}
	renderToStaticMarkup(<Harness />);
	if (!built.services) {
		throw new Error("the widget services were not built");
	}
	return { opened, services: built.services };
}

/** A prompt the test answers by hand, recording what the person was shown. */
function manualPrompt() {
	const shown: ExternalDestination[] = [];
	const answers: Array<(accepted: boolean) => void> = [];
	const ask = createOpenExternalAsk({
		confirm: (destination) => {
			shown.push(destination);
			return new Promise<boolean>((resolve) => {
				answers.push(resolve);
			});
		},
		lock: { open: false },
	});
	return { answers, ask, shown };
}

async function codeOf(work: Promise<unknown>): Promise<string> {
	try {
		await work;
	} catch (error) {
		return error instanceof CodedRpcError ? error.code : "not coded";
	}
	return "resolved";
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("a widget with no grants opens nothing until the person accepts the shell's prompt", async () => {
	const prompt = manualPrompt();
	const { opened, services } = widgetServices(prompt.ask);
	const call = dispatchRpc(
		"ui.openExternal",
		["https://example.com/x"],
		NO_GRANTS,
		services
	);
	await settle();
	expect(opened).toEqual([]);
	expect(prompt.shown).toHaveLength(1);
	prompt.answers[0]?.(true);
	await call;
	expect(opened).toEqual(["https://example.com/x"]);
});

test("declining the prompt opens nothing and the call is denied", async () => {
	const prompt = manualPrompt();
	const { opened, services } = widgetServices(prompt.ask);
	const call = codeOf(
		dispatchRpc(
			"ui.openExternal",
			[{ href: "https://example.com/x" }],
			NO_GRANTS,
			services
		)
	);
	await settle();
	prompt.answers[0]?.(false);
	expect(await call).toBe("denied");
	expect(opened).toEqual([]);
});

test("the prompt shows the whole host of a lookalike address", async () => {
	const prompt = manualPrompt();
	const { opened, services } = widgetServices(prompt.ask);
	const call = codeOf(
		dispatchRpc(
			"ui.openExternal",
			[`https://${LOOKALIKE_HOST}/login?d=${"a".repeat(300)}`],
			NO_GRANTS,
			services
		)
	);
	await settle();
	expect(prompt.shown.map((destination) => destination.host)).toEqual([
		LOOKALIKE_HOST,
	]);
	expect(
		prompt.shown[0]?.display.startsWith(`https://${LOOKALIKE_HOST}/`)
	).toBe(true);
	prompt.answers[0]?.(false);
	await call;
	expect(opened).toEqual([]);
});

test("one widget frame cannot raise more prompts than the limit", async () => {
	let asked = 0;
	const ask = createOpenExternalAsk({
		confirm: () => {
			asked += 1;
			return Promise.resolve(true);
		},
		lock: { open: false },
	});
	const { opened, services } = widgetServices(ask);
	for (let index = 0; index < OPEN_EXTERNAL_MAX_PROMPTS; index += 1) {
		await dispatchRpc(
			"ui.openExternal",
			[`https://example.com/${index}`],
			NO_GRANTS,
			services
		);
	}
	expect(
		await codeOf(
			dispatchRpc(
				"ui.openExternal",
				["https://example.com/one-more"],
				NO_GRANTS,
				services
			)
		)
	).toBe("over_budget");
	expect(asked).toBe(OPEN_EXTERNAL_MAX_PROMPTS);
	expect(opened).toHaveLength(OPEN_EXTERNAL_MAX_PROMPTS);
});

test("without the shell's prompt wired, a widget opens nothing", async () => {
	const { opened, services } = widgetServices(
		undefined as unknown as OpenExternalAsk
	);
	expect(
		await codeOf(
			dispatchRpc(
				"ui.openExternal",
				["https://example.com/x"],
				NO_GRANTS,
				services
			)
		)
	).toBe("server_error");
	expect(opened).toEqual([]);
});

// The URL parser drops the leading space and reads the backslash as a slash:
// the host is example.com and the rest is a path. An opener that parsed the
// raw string by other rules could read `example.com\` as a user name.
const RAW_HREF = " https://example.com\\@evil.example/x";
const SHOWN_HREF = "https://example.com/@evil.example/x";

test("the shell opener receives the address the prompt showed, not the string the service was given", async () => {
	const prompt = manualPrompt();
	const { opened, services } = widgetServices(prompt.ask);
	// The service itself, as the RPC gate calls it, with a string no parser has
	// rewritten yet.
	const call = services.openExternal?.({ href: RAW_HREF });
	await settle();
	expect(opened).toEqual([]);
	expect(prompt.shown.map((destination) => destination.host)).toEqual([
		"example.com",
	]);
	expect(prompt.shown.map((destination) => destination.href)).toEqual([
		SHOWN_HREF,
	]);
	prompt.answers[0]?.(true);
	await call;
	expect(opened).toEqual([SHOWN_HREF]);
});

test("through the RPC gate a frame's raw string reaches the opener as the prompt showed it", async () => {
	const prompt = manualPrompt();
	const { opened, services } = widgetServices(prompt.ask);
	const call = dispatchRpc("ui.openExternal", [RAW_HREF], NO_GRANTS, services);
	await settle();
	expect(prompt.shown.map((destination) => destination.href)).toEqual([
		SHOWN_HREF,
	]);
	prompt.answers[0]?.(true);
	await call;
	expect(opened).toEqual([SHOWN_HREF]);
});
