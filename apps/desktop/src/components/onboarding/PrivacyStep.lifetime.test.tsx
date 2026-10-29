import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ButtonHTMLAttributes, ReactNode } from "react";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

interface Target {
	token: string | null;
	url: string;
	userJwt: string | null;
}
type PreferenceKey =
	| "product-analytics-enabled"
	| "community-stats-enabled"
	| "crash-reports-enabled"
	| "diagnostics-export-enabled";

const reads: Array<{
	target: Target;
	key: PreferenceKey;
	response: Deferred<boolean>;
	resolved: boolean;
}> = [];
const writes: Array<{
	target: Target;
	key: PreferenceKey;
	value: boolean;
	response: Deferred<boolean>;
	resolved: boolean;
}> = [];
const analyticsGates: boolean[] = [];
const crashGates: boolean[] = [];
const switchHandlers = new Map<string, (value: boolean) => void>();
interface ActiveNode {
	name: string;
	token: string | null;
	url: string;
	userJwt: string | null;
}

const nodeA: ActiveNode = {
	name: "privacy-test-A",
	url: "https://privacy-a.test",
	token: "token-A",
	userJwt: null,
};
const nodeB: ActiveNode = {
	name: "privacy-test-B",
	url: "https://privacy-b.test",
	token: "token-B",
	userJwt: "delegation-B",
};
const cloudJwtOld: ActiveNode = {
	name: "privacy-test-cloud",
	url: "https://privacy-cloud.test",
	token: null,
	userJwt: "delegation-old",
};
const cloudJwtCurrent: ActiveNode = {
	...cloudJwtOld,
	userJwt: "delegation-current",
};
const cloudJwtNext: ActiveNode = { ...cloudJwtOld, userJwt: "delegation-next" };
let activeNode: ActiveNode = nodeA;
const activeNodeListeners = new Set<() => void>();

const { act, createElement, useSyncExternalStore } = await import("react");

function useTestActiveNode() {
	return useSyncExternalStore(
		(listener) => {
			activeNodeListeners.add(listener);
			return () => activeNodeListeners.delete(listener);
		},
		() => activeNode,
		() => activeNode
	);
}

function read(target: Target, key: PreferenceKey) {
	const response = deferred<boolean>();
	reads.push({ target: { ...target }, key, response, resolved: false });
	return response.promise;
}

function write(target: Target, key: PreferenceKey, value: boolean) {
	const response = deferred<boolean>();
	writes.push({ target: { ...target }, key, value, response, resolved: false });
	return response.promise;
}

mock.module("@/src/lib/api/preferences.ts", () => ({
	getProductAnalyticsEnabled: (target: Target) =>
		read(target, "product-analytics-enabled"),
	getCommunityStatsEnabled: (target: Target) =>
		read(target, "community-stats-enabled"),
	getCrashReportsEnabled: (target: Target) =>
		read(target, "crash-reports-enabled"),
	getDiagnosticsExportEnabled: (target: Target) =>
		read(target, "diagnostics-export-enabled"),
	setProductAnalyticsEnabled: (target: Target, value: boolean) =>
		write(target, "product-analytics-enabled", value),
	setCommunityStatsEnabled: (target: Target, value: boolean) =>
		write(target, "community-stats-enabled", value),
	setCrashReportsEnabled: (target: Target, value: boolean) =>
		write(target, "crash-reports-enabled", value),
	setDiagnosticsExportEnabled: (target: Target, value: boolean) =>
		write(target, "diagnostics-export-enabled", value),
}));
mock.module("@/src/lib/analytics.ts", () => ({
	setAnalyticsEnabled: (value: boolean) => analyticsGates.push(value),
}));
mock.module("@/src/lib/crash.ts", () => ({
	setCrashReportingEnabled: (value: boolean) => crashGates.push(value),
}));
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: useTestActiveNode,
}));
mock.module("@/lib/auth-client.ts", () => ({
	FRONTEND_URL: "https://ryu.test",
}));
mock.module("@/src/lib/tauri-bridge.ts", () => ({
	openExternal: () => undefined,
}));
mock.module("@/src/components/onboarding/RyuOnboardingPersona.tsx", () => ({
	RyuOnboardingAvatar: () => null,
}));
mock.module("@/src/components/settings/privacy-disclosure-state.ts", () => ({
	acknowledgePrivacyDisclosure: () => undefined,
	PRIVACY_DOCS_PATH: "/docs/privacy",
}));
mock.module("@ryu/blocks/desktop/onboarding", () => ({
	ONBOARDING_CONTENT_DELAY_MS: 0,
}));
mock.module("@ryu/ui/components/button", () => ({
	Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
		<button {...props}>{children}</button>
	),
}));
mock.module("@ryu/ui/components/page-header", () => ({
	PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
mock.module("@ryu/ui/components/sileo", () => ({
	toast: { error: () => undefined },
}));
mock.module("@ryu/ui/components/stagger-reveal", () => ({
	StaggerReveal: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
mock.module("@ryu/ui/components/switch", () => ({
	Switch: ({
		checked,
		disabled,
		id,
		"aria-label": label,
		onCheckedChange,
	}: {
		checked: boolean;
		disabled?: boolean;
		id: string;
		"aria-label": string;
		onCheckedChange: (value: boolean) => void;
	}) => {
		switchHandlers.set(id, onCheckedChange);
		return (
			<button
				aria-checked={checked}
				aria-label={label}
				disabled={disabled}
				id={id}
				onClick={() => onCheckedChange(!checked)}
				role="switch"
				type="button"
			/>
		);
	},
}));
mock.module("@/src/components/settings/shared/settings-items.tsx", () => ({
	SettingsGroup: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
	SettingsItem: ({
		actions,
		description,
		title,
	}: {
		actions: ReactNode;
		description: string;
		title: string;
	}) => (
		<div>
			<span>{title}</span>
			{actions}
			<p>{description}</p>
		</div>
	),
}));

const { createRoot } = await import("react-dom/client");
const { PrivacyStep } = await import("./PrivacyStep.tsx");

const roots: ReturnType<typeof createRoot>[] = [];
const containers: HTMLElement[] = [];
const unmountedRoots = new Set<ReturnType<typeof createRoot>>();

function setActiveNode(node: ActiveNode) {
	activeNode = node;
	for (const listener of activeNodeListeners) {
		listener();
	}
}

async function mount(onContinue: () => void = () => {}) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	containers.push(container);
	roots.push(root);
	await act(async () => {
		root.render(createElement(PrivacyStep, { onContinue }));
	});
	return { container, root };
}

async function resolveReads(
	url: string,
	values: Record<PreferenceKey, boolean>
) {
	const pending = reads.filter(
		(call) => call.target.url === url && !call.resolved
	);
	if (pending.length !== 4) {
		throw new Error(
			`Expected four unresolved preference reads for ${url}; found ${pending.length}`
		);
	}
	await act(async () => {
		for (const call of pending) {
			call.resolved = true;
			call.response.resolve(values[call.key]);
		}
		await Promise.resolve();
	});
}

function sameTarget(left: Target, right: Target) {
	return (
		left.url === right.url &&
		left.token === right.token &&
		left.userJwt === right.userJwt
	);
}

async function resolveReadsForTarget(
	target: Target,
	values: Record<PreferenceKey, boolean>
) {
	const pending = reads.filter(
		(call) => sameTarget(call.target, target) && !call.resolved
	);
	if (pending.length !== 4) {
		throw new Error(
			`Expected four unresolved preference reads for ${target.url} with selected credentials; found ${pending.length}`
		);
	}
	await act(async () => {
		for (const call of pending) {
			call.resolved = true;
			call.response.resolve(values[call.key]);
		}
		await Promise.resolve();
	});
}

async function resolveWrite(index: number) {
	await act(async () => {
		const call = writes[index];
		if (call && !call.resolved) {
			call.resolved = true;
			call.response.resolve(true);
		}
		await Promise.resolve();
	});
}

function switchFor(container: HTMLElement, id: string) {
	const element = container.querySelector<HTMLButtonElement>(`#${id}`);
	if (!element) {
		throw new Error(`Missing switch ${id}`);
	}
	return element;
}

afterEach(async () => {
	for (const root of roots.splice(0).reverse()) {
		if (!unmountedRoots.has(root)) {
			await act(async () => root.unmount());
		}
	}
	unmountedRoots.clear();
	for (const container of containers.splice(0)) {
		container.remove();
	}
	reads.length = 0;
	writes.length = 0;
	analyticsGates.length = 0;
	crashGates.length = 0;
	switchHandlers.clear();
	setActiveNode(nodeA);
});

test("late reads from a previous node cannot ready or overwrite the active node", async () => {
	setActiveNode(nodeA);
	let continued = 0;
	const { container } = await mount(() => continued++);
	expect(reads.filter((call) => call.target.url === nodeA.url)).toHaveLength(4);

	await act(async () => {
		setActiveNode(nodeB);
	});
	const nodeBReads = reads.filter((call) => call.target.url === nodeB.url);
	expect(nodeBReads).toHaveLength(4);
	expect(
		nodeBReads.every(
			(call) =>
				call.target.token === nodeB.token &&
				call.target.userJwt === nodeB.userJwt
		)
	).toBe(true);
	await resolveReads(nodeA.url, {
		"product-analytics-enabled": true,
		"community-stats-enabled": true,
		"crash-reports-enabled": true,
		"diagnostics-export-enabled": false,
	});
	const finish = [...container.querySelectorAll("button")].find(
		(button) => button.textContent === "Get started"
	);
	expect(finish?.disabled).toBe(true);
	finish?.click();
	expect(continued).toBe(0);

	await resolveReads(nodeB.url, {
		"product-analytics-enabled": false,
		"community-stats-enabled": true,
		"crash-reports-enabled": false,
		"diagnostics-export-enabled": true,
	});
	expect(
		switchFor(container, "onboarding-product-analytics").getAttribute(
			"aria-checked"
		)
	).toBe("false");
	expect(
		switchFor(container, "onboarding-crash-reports").getAttribute(
			"aria-checked"
		)
	).toBe("false");
	expect(analyticsGates).toEqual([false]);
	expect(crashGates).toEqual([false]);
	expect(writes).toEqual([]);
	finish?.click();
	expect(continued).toBe(1);
});

test("an old target write acknowledgement cannot alter the new target or complete setup", async () => {
	setActiveNode(nodeA);
	let continued = 0;
	const { container } = await mount(() => continued++);
	await resolveReads(nodeA.url, {
		"product-analytics-enabled": true,
		"community-stats-enabled": true,
		"crash-reports-enabled": true,
		"diagnostics-export-enabled": false,
	});

	const analytics = switchFor(container, "onboarding-product-analytics");
	await act(async () => analytics.click());
	expect(writes).toHaveLength(1);
	expect(writes[0]).toMatchObject({
		target: { url: nodeA.url, token: nodeA.token, userJwt: nodeA.userJwt },
		value: false,
	});

	await act(async () => setActiveNode(nodeB));
	const finish = [...container.querySelectorAll("button")].find(
		(button) => button.textContent === "Get started"
	);
	expect(finish?.disabled).toBe(true);
	finish?.click();
	expect(continued).toBe(0);
	await resolveWrite(0);
	expect(continued).toBe(0);
	expect(writes).toHaveLength(1);

	await resolveReads(nodeB.url, {
		"product-analytics-enabled": true,
		"community-stats-enabled": false,
		"crash-reports-enabled": true,
		"diagnostics-export-enabled": false,
	});
	expect(
		switchFor(container, "onboarding-product-analytics").getAttribute(
			"aria-checked"
		)
	).toBe("true");
	expect(analyticsGates).toEqual([true, false, true]);
	expect(writes).toHaveLength(1);
	expect(finish?.disabled).toBe(false);
	finish?.click();
	expect(continued).toBe(1);
});

test("a pending read after unmount cannot overwrite a fresh mount", async () => {
	setActiveNode(nodeA);
	const first = await mount();
	await act(async () => first.root.unmount());
	unmountedRoots.add(first.root);

	setActiveNode(nodeB);
	const second = await mount();
	await resolveReads(nodeB.url, {
		"product-analytics-enabled": false,
		"community-stats-enabled": true,
		"crash-reports-enabled": false,
		"diagnostics-export-enabled": true,
	});
	await resolveReads(nodeA.url, {
		"product-analytics-enabled": true,
		"community-stats-enabled": false,
		"crash-reports-enabled": true,
		"diagnostics-export-enabled": false,
	});
	expect(
		switchFor(second.container, "onboarding-product-analytics").getAttribute(
			"aria-checked"
		)
	).toBe("false");
	expect(
		switchFor(second.container, "onboarding-community-stats").getAttribute(
			"aria-checked"
		)
	).toBe("true");
	expect(analyticsGates).toEqual([false]);
	expect(crashGates).toEqual([false]);
});

test("unmount during a pending write prevents stale UI completion and same-batch duplicate writes", async () => {
	setActiveNode(nodeA);
	let continued = 0;
	const first = await mount(() => continued++);
	await resolveReads(nodeA.url, {
		"product-analytics-enabled": true,
		"community-stats-enabled": true,
		"crash-reports-enabled": true,
		"diagnostics-export-enabled": false,
	});

	const analytics = switchFor(first.container, "onboarding-product-analytics");
	await act(async () => {
		const change = switchHandlers.get("onboarding-product-analytics");
		if (!change) {
			throw new Error("Product analytics switch handler did not mount");
		}
		change(false);
		change(true);
		await Promise.resolve();
	});
	expect(writes).toHaveLength(1);
	expect(writes[0]).toMatchObject({
		key: "product-analytics-enabled",
		value: false,
	});
	expect(analytics.disabled).toBe(true);

	await act(async () => first.root.unmount());
	unmountedRoots.add(first.root);
	setActiveNode(nodeB);
	const second = await mount(() => continued++);
	const nodeBReads = reads.filter((call) => call.target.url === nodeB.url);
	expect(nodeBReads).toHaveLength(4);
	expect(
		nodeBReads.every(
			(call) =>
				call.target.token === nodeB.token &&
				call.target.userJwt === nodeB.userJwt
		)
	).toBe(true);
	await resolveReads(nodeB.url, {
		"product-analytics-enabled": true,
		"community-stats-enabled": true,
		"crash-reports-enabled": true,
		"diagnostics-export-enabled": false,
	});
	await resolveWrite(0);
	expect(continued).toBe(0);
	expect(
		switchFor(second.container, "onboarding-product-analytics").getAttribute(
			"aria-checked"
		)
	).toBe("true");
	expect(analyticsGates).toEqual([true, false, true]);
	expect(writes).toHaveLength(1);
});

test("same-node user JWT rotation supersedes privacy reads and pending writes", async () => {
	setActiveNode(cloudJwtOld);
	let continued = 0;
	const { container } = await mount(() => continued++);
	expect(
		reads.filter((call) => sameTarget(call.target, cloudJwtOld))
	).toHaveLength(4);

	await act(async () => setActiveNode(cloudJwtCurrent));
	const currentReads = reads.filter((call) =>
		sameTarget(call.target, cloudJwtCurrent)
	);
	expect(currentReads).toHaveLength(4);
	expect(
		currentReads.every(
			(call) =>
				call.target.url === cloudJwtOld.url &&
				call.target.token === null &&
				call.target.userJwt === cloudJwtCurrent.userJwt
		)
	).toBe(true);
	await resolveReadsForTarget(cloudJwtOld, {
		"product-analytics-enabled": true,
		"community-stats-enabled": true,
		"crash-reports-enabled": true,
		"diagnostics-export-enabled": false,
	});
	const finish = [...container.querySelectorAll("button")].find(
		(button) => button.textContent === "Get started"
	);
	expect(finish?.disabled).toBe(true);
	finish?.click();
	expect(continued).toBe(0);

	await resolveReadsForTarget(cloudJwtCurrent, {
		"product-analytics-enabled": false,
		"community-stats-enabled": true,
		"crash-reports-enabled": true,
		"diagnostics-export-enabled": false,
	});
	expect(
		switchFor(container, "onboarding-product-analytics").getAttribute(
			"aria-checked"
		)
	).toBe("false");
	await act(async () =>
		switchFor(container, "onboarding-product-analytics").click()
	);
	expect(writes).toHaveLength(1);
	expect(writes[0]).toMatchObject({
		target: {
			url: cloudJwtCurrent.url,
			token: null,
			userJwt: cloudJwtCurrent.userJwt,
		},
		value: true,
	});

	await act(async () => setActiveNode(cloudJwtNext));
	const nextReads = reads.filter((call) =>
		sameTarget(call.target, cloudJwtNext)
	);
	expect(nextReads).toHaveLength(4);
	expect(
		nextReads.every(
			(call) =>
				call.target.url === cloudJwtCurrent.url &&
				call.target.token === null &&
				call.target.userJwt === cloudJwtNext.userJwt
		)
	).toBe(true);
	expect(finish?.disabled).toBe(true);
	finish?.click();
	expect(continued).toBe(0);

	await resolveWrite(0);
	expect(finish?.disabled).toBe(true);
	expect(continued).toBe(0);
	await resolveReadsForTarget(cloudJwtNext, {
		"product-analytics-enabled": false,
		"community-stats-enabled": true,
		"crash-reports-enabled": true,
		"diagnostics-export-enabled": false,
	});
	expect(
		switchFor(container, "onboarding-product-analytics").getAttribute(
			"aria-checked"
		)
	).toBe("false");
	expect(writes).toHaveLength(1);
	expect(analyticsGates).toEqual([false, true, false]);
	expect(finish?.disabled).toBe(false);
	finish?.click();
	expect(continued).toBe(1);
});
