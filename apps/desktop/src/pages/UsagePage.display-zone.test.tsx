import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

// The computer is on New York time and the person chose Tokyo. At NOW it is
// still June 10 in New York and already June 11 in Tokyo, so the range the
// Usage page asks Core for on first load shows which zone's days it counts.
const NativeResponse = globalThis.Response;
const nativeFetch = globalThis.fetch;
// Bun's native fetch rejects happy-dom's AbortSignal, and the page forwards its
// effect's signal into that fetch.
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
	Reflect.set(globalThis, "AbortController", NativeAbortController);
	Reflect.set(globalThis, "AbortSignal", NativeAbortSignal);
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);
process.env.TZ = "America/New_York";
globalThis.fetch = nativeFetch;
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { createRoot } = await import("react-dom/client");
const { default: UsagePage } = await import("@/src/pages/UsagePage.tsx");
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { resetTimezone, setTimezonePreference } = await import(
	"@ryu/ui/lib/timezone.ts"
);

const requests: string[] = [];
const core = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (request: Request): Response => {
		const url = new URL(request.url);
		requests.push(`${request.method} ${url.pathname}${url.search}`);
		return NativeResponse.json({ error: "Unsupported" }, { status: 404 });
	},
});
const initialStore = useNodeStore.getState();

// 2026-06-10T20:00Z is Wednesday 16:00 in New York and Thursday 05:00 in Tokyo.
const NOW = "2026-06-10T20:00:00.000Z";

const client = new QueryClient({
	defaultOptions: { queries: { gcTime: 0, retry: false } },
});
let mounted: { container: HTMLElement; root: Root } | undefined;
beforeEach(() => {
	setSystemTime(new Date(NOW));
	requests.length = 0;
	useNodeStore.setState({
		defaultNode: "usage",
		autoSelect: false,
		autoSelectedNode: null,
		tabOverrides: {},
		nodes: [
			{
				name: "usage",
				url: `${core.url.origin}/node`,
				token: "usage-token",
				userJwt: null,
			},
		],
	});
});
afterEach(async () => {
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
	resetTimezone();
	setSystemTime();
	useNodeStore.setState(initialStore, true);
});
afterAll(async () => {
	core.stop(true);
	globalThis.fetch = nativeFetch;
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function mountUsage(): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<UsagePage />
			</QueryClientProvider>
		);
	});
	return container;
}

/** The `from` and `until` of the usage rollup request, once the page has sent it. */
async function rollupRange(): Promise<{ from: string; until: string }> {
	// Counted attempts, not a wall-clock deadline: the system clock is frozen here.
	for (let attempt = 0; attempt < 250; attempt++) {
		const path = requests.find((entry) =>
			entry.includes("/api/gateway/audit/usage?")
		);
		if (path) {
			const query = new URL(path.split(" ")[1] ?? "", "http://core")
				.searchParams;
			return {
				from: query.get("from") ?? "",
				until: query.get("until") ?? "",
			};
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
	}
	throw new Error(`The page never asked for usage: ${requests.join(", ")}`);
}

async function chooseThisNode(container: HTMLElement): Promise<void> {
	const findNode = () =>
		[...container.querySelectorAll("button")].find(
			(candidate) => candidate.textContent?.trim() === "This node"
		);
	// The scope control renders after the page's first effects settle.
	for (let attempt = 0; attempt < 250 && !findNode(); attempt++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
	}
	const node = findNode();
	if (!node) {
		throw new Error("The usage scope control has no This node choice");
	}
	await act(async () => {
		node.click();
	});
}

test("first loads the last 30 display-zone days, ending when Tokyo's today ends", async () => {
	setTimezonePreference("Asia/Tokyo");
	await chooseThisNode(await mountUsage());
	// Tokyo's May 13 through June 11, so 00:00 Tokyo on May 13 (May 12 15:00Z)
	// up to 00:00 Tokyo on June 12 (June 11 15:00Z).
	expect(await rollupRange()).toEqual({
		from: "2026-05-12T15:00:00.000Z",
		until: "2026-06-11T15:00:00.000Z",
	});
});

test("first loads the same 30 days from the computer's midnight when the display zone follows it", async () => {
	await chooseThisNode(await mountUsage());
	// New York's May 12 through June 10: 00:00 EDT is 04:00Z.
	expect(await rollupRange()).toEqual({
		from: "2026-05-12T04:00:00.000Z",
		until: "2026-06-11T04:00:00.000Z",
	});
});
