// apps/desktop/src/components/billing/AccountLimitNotice.test.tsx
//
// The row an account list shows for the limit on connected accounts per
// provider: the count at 9, the reason and the license button at 10 and 12,
// no button on the licensed limit, and the free limit when no entitlement is
// mounted.
//
// Mocking: `@/src/contexts/entitlement-context.tsx` is replaced by a stand-in
// the tests set, so the row is driven without the billing client behind the
// real provider. `null` stands for "no provider mounted" and throws, as the
// real hook does.

import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface Entitlement {
	requestUpgrade: () => void;
	verdict: { plan: string | null } | null;
}
let entitlement: Entitlement | null = null;

mock.module("@/src/contexts/entitlement-context.tsx", () => ({
	useEntitlementContext: () => {
		if (!entitlement) {
			throw new Error("no EntitlementProvider");
		}
		return entitlement;
	},
}));

const { createRoot } = await import("react-dom/client");
const { AccountLimitNotice, ProviderAccountLimit } = await import(
	"./AccountLimitNotice.tsx"
);

const roots: Root[] = [];

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	entitlement = null;
});

async function mount(node: ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(node);
	});
}

const notice = () =>
	document.querySelector<HTMLElement>('[data-testid="account-limit-notice"]');
const countText = () =>
	notice()?.querySelector('[data-slot="account-count"]')?.textContent;
const reason = () => notice()?.querySelector('[role="status"]')?.textContent;
const button = () => notice()?.querySelector("button") ?? null;

test("with no account the row is not shown", async () => {
	await mount(<AccountLimitNotice count={0} limit={10} />);
	expect(notice()).toBeNull();
});

test("9 of 10 shows the count only", async () => {
	await mount(
		<AccountLimitNotice count={9} limit={10} onUpgrade={() => undefined} />
	);
	expect(notice()?.dataset.state).toBe("below");
	expect(countText()).toBe("9 of 10 accounts");
	expect(reason()).toBeUndefined();
	expect(button()).toBeNull();
});

test("10 of 10 says why and the button opens the paywall", async () => {
	let opened = 0;
	await mount(
		<AccountLimitNotice
			count={10}
			limit={10}
			onUpgrade={() => {
				opened += 1;
			}}
		/>
	);
	expect(notice()?.dataset.state).toBe("full");
	expect(countText()).toBe("10 of 10 accounts");
	expect(reason()).toBe(
		"This provider has the most accounts the free plan allows. Remove one, or get a license to connect up to 50."
	);
	expect(button()?.textContent).toBe("Get a license");
	await act(async () => {
		button()?.click();
	});
	expect(opened).toBe(1);
});

test("12 of 10 keeps every account and says how many must go", async () => {
	await mount(
		<AccountLimitNotice count={12} limit={10} onUpgrade={() => undefined} />
	);
	expect(notice()?.dataset.state).toBe("over");
	expect(countText()).toBe("12 of 10 accounts");
	expect(reason()).toContain(
		"They all keep working. Remove 3 to add a new one"
	);
	expect(button()?.textContent).toBe("Get a license");
});

test("50 of 50 on a license says why and offers no license", async () => {
	await mount(
		<AccountLimitNotice count={50} limit={50} onUpgrade={() => undefined} />
	);
	expect(notice()?.dataset.state).toBe("full");
	expect(reason()).toBe(
		"This provider already has the most accounts your plan allows. Remove one to add another."
	);
	expect(button()).toBeNull();
});

test("with no entitlement mounted the free limit applies and nothing is offered", async () => {
	entitlement = null;
	await mount(<ProviderAccountLimit count={10} />);
	expect(countText()).toBe("10 of 10 accounts");
	expect(notice()?.dataset.state).toBe("full");
	expect(button()).toBeNull();
});

test("a free entitlement shows the free limit and opens the paywall", async () => {
	let opened = 0;
	entitlement = {
		requestUpgrade: () => {
			opened += 1;
		},
		verdict: { plan: null },
	};
	await mount(<ProviderAccountLimit count={11} />);
	expect(countText()).toBe("11 of 10 accounts");
	await act(async () => {
		button()?.click();
	});
	expect(opened).toBe(1);
});

test("a license raises the limit the row shows", async () => {
	entitlement = {
		requestUpgrade: () => undefined,
		verdict: { plan: "desktop-license" },
	};
	await mount(<ProviderAccountLimit count={11} />);
	expect(countText()).toBe("11 of 50 accounts");
	expect(notice()?.dataset.state).toBe("below");
	expect(reason()).toBeUndefined();
});
