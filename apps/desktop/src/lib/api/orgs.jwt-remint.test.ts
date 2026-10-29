import { afterEach, beforeEach, expect, test } from "bun:test";
import { TOKEN_KEY } from "@/lib/auth-client.ts";
import { clearRealtimeJwt, getRealtimeJwt } from "@/src/lib/realtime/jwt.ts";
import { setActiveOrg } from "./orgs.ts";

// An org switch must re-mint the Core user JWT: its signed ryu_flags claims
// name the org they were evaluated for, and set-active keeps the session token.
const nativeFetch = globalThis.fetch;
const storageDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	"localStorage"
);
const values = new Map<string, string>();
const storage: Storage = {
	get length() {
		return values.size;
	},
	clear: () => values.clear(),
	getItem: (key) => values.get(key) ?? null,
	key: (index) => [...values.keys()][index] ?? null,
	removeItem: (key) => {
		values.delete(key);
	},
	setItem: (key, value) => {
		values.set(key, value);
	},
};
let activeOrg = "org-a";
let mints = 0;
let setActiveStatus = 200;
let releaseMint: (() => void) | null = null;

function mintedToken(org: string): string {
	const payload = btoa(JSON.stringify({ ryu_flags_org: org, sub: "user" }));
	return `header.${payload.replaceAll("+", "-").replaceAll("/", "_")}.sig`;
}

async function route(
	input: Parameters<typeof fetch>[0],
	options?: RequestInit
): Promise<Response> {
	const url = new URL(input instanceof Request ? input.url : String(input));
	if (url.pathname.endsWith("/api/auth/organization/set-active")) {
		const body = JSON.parse(String(options?.body)) as {
			organizationId: string;
		};
		activeOrg = body.organizationId;
		return new Response("{}", { status: setActiveStatus });
	}
	if (url.pathname.endsWith("/api/auth/token")) {
		mints += 1;
		const org = activeOrg;
		if (releaseMint === null) {
			return Response.json({ token: mintedToken(org) });
		}
		await new Promise<void>((resolve) => {
			releaseMint = resolve;
		});
		return Response.json({ token: mintedToken(org) });
	}
	return new Response("{}", { status: 404 });
}

beforeEach(() => {
	clearRealtimeJwt();
	values.clear();
	values.set(TOKEN_KEY, "session");
	activeOrg = "org-a";
	mints = 0;
	setActiveStatus = 200;
	releaseMint = null;
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: storage,
	});
	globalThis.fetch = Object.assign(route, {
		preconnect: nativeFetch.preconnect,
	});
});

afterEach(() => {
	clearRealtimeJwt();
	globalThis.fetch = nativeFetch;
	if (storageDescriptor) {
		Object.defineProperty(globalThis, "localStorage", storageDescriptor);
	} else {
		Reflect.deleteProperty(globalThis, "localStorage");
	}
});

test("an org switch re-mints the Core JWT for the new org", async () => {
	expect(await getRealtimeJwt()).toBe(mintedToken("org-a"));
	expect(await getRealtimeJwt()).toBe(mintedToken("org-a"));
	expect(mints).toBe(1);

	await setActiveOrg("org-b");

	expect(await getRealtimeJwt()).toBe(mintedToken("org-b"));
	expect(mints).toBe(2);
});

test("a failed org switch still drops the cached Core JWT", async () => {
	await getRealtimeJwt();
	setActiveStatus = 500;
	await expect(setActiveOrg("org-b")).rejects.toThrow();
	await getRealtimeJwt();
	expect(mints).toBe(2);
});

test("a mint in flight during the switch is not cached afterwards", async () => {
	releaseMint = () => undefined;
	const pending = getRealtimeJwt();
	await setActiveOrg("org-b");
	const release = releaseMint as (() => void) | null;
	release?.();
	// The switch retired that exchange's generation: its token is neither
	// cached nor handed back, so nothing can use a claim made for org-a.
	expect(await pending).toBeNull();
	releaseMint = null;

	expect(await getRealtimeJwt()).toBe(mintedToken("org-b"));
	expect(mints).toBe(2);
});
