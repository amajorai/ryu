// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared native-HTTP ledger and conservation helpers run only inside this file's real bun:test cases and hooks.
import { expect, test } from "bun:test";
import { act } from "react";
import {
	activeNodeAcknowledged,
	checked,
	click,
	consentSwitch,
	consumeAll,
	expectLocalConserved,
	expectWrite,
	first,
	getMemorySettings,
	input,
	isAnalyticsConfigured,
	isAnalyticsEnabled,
	isCrashReportingConfigured,
	isCrashReportingEnabled,
	MemoryTab,
	memoryReads,
	mount,
	onlyWrite,
	openUsagePage,
	PrivacySettings,
	privacyReads,
	privacySwitch,
	recallSwitch,
	sameNodeDifferentJwt,
	second,
	select,
	setDraft,
	settledAct,
	unmount,
} from "./GeneralConsumers.native-http.test-support.tsx";
// The loopback peer the support modules start; imported here so its setup
// is visibly part of this suite, in the order the support chain runs it.
import "./GeneralConsumers.native-http-peer.test-support.tsx";
import {
	freshGateBoot,
	registerGeneralConsumersHooks,
} from "./GeneralConsumers.native-http-hooks.test-support.tsx";
import {
	calls,
	heldReply,
	rawDocument,
	readDocument,
	recordSchema,
} from "./GeneralConsumers.native-http-store.test-support.tsx";

registerGeneralConsumersHooks();

test("JWT-only Memory selection retires old delegated consent and retries only the current user", async () => {
	const aBefore = rawDocument("a");
	const bBefore = rawDocument("b");
	await mount(<MemoryTab />);
	await memoryReads(first, 0);
	expect(activeNodeAcknowledged(first)).toBe(true);
	expect(checked(consentSwitch())).toBe(false);
	const originalConsentControl = consentSwitch();
	// Genuine independent SDK read establishes that delegated B data is actually
	// available. Only later producer reads count as the rotation acknowledgment.
	expect(await getMemorySettings(sameNodeDifferentJwt)).toEqual({
		includeSensitiveTopics: true,
	});
	await consumeAll();
	expect(readDocument("a").consent["delegation-b"]).toBe(true);
	const rotationMarker = calls.length;
	await act(async () => {
		select(sameNodeDifferentJwt);
	});
	await settledAct(
		() => activeNodeAcknowledged(sameNodeDifferentJwt),
		"real active-node consumer selects JWT B at unchanged URL/token/name"
	);
	await settledAct(
		() =>
			calls
				.slice(rotationMarker)
				.some(
					(entry) =>
						entry.path === "/api/memory/settings" &&
						entry.jwt === "delegation-b" &&
						entry.method === "GET" &&
						entry.bodyConsumed &&
						entry.status === 200
				),
		"fresh genuine delegated B Memory consent read"
	);
	expect(consentSwitch()).toBe(originalConsentControl);
	expect(checked(consentSwitch())).toBe(true);
	expect(rawDocument("a")).toBe(aBefore);
	expect(rawDocument("b")).toBe(bBefore);
	const refused = heldReply(
		(call) =>
			call.node === "a" &&
			call.jwt === "delegation-b" &&
			call.path === "/api/memory/settings" &&
			call.method === "PUT",
		503
	);
	const refusalMarker = calls.length;
	await click(consentSwitch());
	const refusalCall = await refused.arrived;
	expect(refusalCall.body).toEqual({ include_sensitive_topics: false });
	refused.release();
	await consumeAll(refusalMarker);
	await settledAct(
		() =>
			checked(consentSwitch()) &&
			document.body.textContent?.includes(
				"Couldn't save sensitive-memory consent"
			) === true,
		"real save refusal restores current B consent and visible error"
	);
	expectWrite(
		onlyWrite(refusalMarker),
		"a",
		"delegation-b",
		"/api/memory/settings",
		{ include_sensitive_topics: false },
		503
	);
	expect(rawDocument("a")).toBe(aBefore);
	expect(rawDocument("b")).toBe(bBefore);
	expectLocalConserved();
	const retryMarker = calls.length;
	await click(consentSwitch());
	await consumeAll(retryMarker);
	expectWrite(
		onlyWrite(retryMarker),
		"a",
		"delegation-b",
		"/api/memory/settings",
		{ include_sensitive_topics: false },
		200
	);
	const expected = recordSchema.parse(JSON.parse(aBefore));
	expected.consent["delegation-b"] = false;
	expect(readDocument("a")).toEqual(expected);
	expect(rawDocument("b")).toBe(bBefore);
	expect(checked(consentSwitch())).toBe(false);
	expectLocalConserved();
	await unmount();
	const reloadMarker = calls.length;
	await mount(<MemoryTab />);
	await memoryReads(sameNodeDifferentJwt, reloadMarker);
	expect(checked(consentSwitch())).toBe(false);
	expect(readDocument("a")).toEqual(expected);
	expect(rawDocument("b")).toBe(bBefore);
	expectLocalConserved();
}, 20_000);

test("a failed former-node auto-recall write cannot restore its old value or error on selected node B", async () => {
	const aBefore = rawDocument("a");
	const bBefore = rawDocument("b");
	await mount(<MemoryTab />);
	await memoryReads(first, 0);
	expect(checked(recallSwitch())).toBe(true);
	expect(input("Snippets recalled per reply").value).toBe("4");
	const old = heldReply(
		(call) =>
			call.node === "a" &&
			call.path === "/api/preferences/auto-recall-enabled" &&
			call.method === "PUT",
		503
	);
	await click(recallSwitch());
	const oldCall = await old.arrived;
	expect(oldCall.body).toEqual({ value: "false" });
	expect(rawDocument("a")).toBe(aBefore);
	const draft = await setDraft();
	const switchNode = recallSwitch();
	const selectionMarker = calls.length;
	await act(async () => {
		select(second);
	});
	await memoryReads(second, selectionMarker);
	expect(activeNodeAcknowledged(second)).toBe(true);
	expect(recallSwitch()).toBe(switchNode);
	expect(checked(recallSwitch())).toBe(false);
	expect(input("Snippets recalled per reply").value).toBe("7");
	expect(document.activeElement).toBe(draft);
	expect(draft.value).toBe("unsent native draft");
	old.release();
	await consumeAll();
	expectWrite(
		oldCall,
		"a",
		"delegation-a",
		"/api/preferences/auto-recall-enabled",
		{ value: "false" },
		503
	);
	// This negative boundary follows the genuine old client body receipt and act
	// settlement, rather than elapsed sleep or mere server-response release.
	expect(checked(recallSwitch())).toBe(false);
	expect(input("Snippets recalled per reply").value).toBe("7");
	expect(document.body.textContent?.includes("Couldn't save auto-recall")).toBe(
		false
	);
	expect(recallSwitch().getAttribute("aria-disabled")).not.toBe("true");
	expect(document.activeElement).toBe(draft);
	expect(input("Search query")).toBe(draft);
	expect(draft.value).toBe("unsent native draft");
	expect(rawDocument("a")).toBe(aBefore);
	expect(rawDocument("b")).toBe(bBefore);
	expectLocalConserved();
	const refusal = heldReply(
		(call) =>
			call.node === "b" &&
			call.path === "/api/preferences/auto-recall-enabled" &&
			call.method === "PUT",
		503
	);
	const refusalMarker = calls.length;
	await click(recallSwitch());
	await refusal.arrived;
	refusal.release();
	await consumeAll(refusalMarker);
	await settledAct(
		() =>
			!checked(recallSwitch()) &&
			document.body.textContent?.includes("Couldn't save auto-recall") === true,
		"selected B refused write retains false and shows actual error"
	);
	expectWrite(
		onlyWrite(refusalMarker),
		"b",
		"delegation-b",
		"/api/preferences/auto-recall-enabled",
		{ value: "true" },
		503
	);
	expect(rawDocument("a")).toBe(aBefore);
	expect(rawDocument("b")).toBe(bBefore);
	const retryMarker = calls.length;
	await click(recallSwitch());
	await consumeAll(retryMarker);
	expectWrite(
		onlyWrite(retryMarker),
		"b",
		"delegation-b",
		"/api/preferences/auto-recall-enabled",
		{ value: "true" },
		200
	);
	const expected = recordSchema.parse(JSON.parse(bBefore));
	expected.preferences["auto-recall-enabled"] = "true";
	expect(readDocument("b")).toEqual(expected);
	expect(rawDocument("a")).toBe(aBefore);
	expectLocalConserved();
	await unmount();
	const reloadMarker = calls.length;
	await mount(<MemoryTab />);
	await memoryReads(second, reloadMarker);
	expect(checked(recallSwitch())).toBe(true);
	expect(input("Snippets recalled per reply").value).toBe("7");
	expect(readDocument("b")).toEqual(expected);
	expect(rawDocument("a")).toBe(aBefore);
	expectLocalConserved();
}, 20_000);

test("Privacy analytics enable keeps the shipping live gate off until durable acknowledgment and recovers after refusal", async () => {
	expect(isAnalyticsConfigured()).toBe(false);
	expect(isCrashReportingConfigured()).toBe(false);
	const aBefore = rawDocument("a");
	const bBefore = rawDocument("b");
	await mount(<PrivacySettings />);
	await privacyReads(0);
	await openUsagePage();
	expect(checked(privacySwitch())).toBe(false);
	expect(isAnalyticsEnabled()).toBe(false);
	expect(isCrashReportingEnabled()).toBe(false);
	expect(localStorage.getItem("ryu:product-analytics-enabled")).toBe("false");
	expect(localStorage.getItem("ryu:crash-reports-enabled")).toBe("false");
	const rejected = heldReply(
		(call) =>
			call.node === "a" &&
			call.path === "/api/preferences/product-analytics-enabled" &&
			call.method === "PUT",
		503
	);
	const refusalMarker = calls.length;
	await click(privacySwitch());
	const refusalCall = await rejected.arrived;
	expect(refusalCall.body).toEqual({ value: "true" });
	expect(refusalCall.status).toBeNull();
	expect(rawDocument("a")).toBe(aBefore);
	expect(rawDocument("b")).toBe(bBefore);
	expect(
		privacySwitch().getAttribute("aria-disabled") === "true" ||
			privacySwitch().hasAttribute("disabled")
	).toBe(true);
	// Positive held-handler admission proves the enable action is in flight, but
	// the acknowledged durable choice remains disabled. Do not arm collection yet.
	expect(isAnalyticsEnabled()).toBe(false);
	expect(localStorage.getItem("ryu:product-analytics-enabled")).toBe("false");
	expect(isCrashReportingEnabled()).toBe(false);
	expectLocalConserved();
	rejected.release();
	await consumeAll(refusalMarker);
	await settledAct(
		() =>
			!checked(privacySwitch()) &&
			document.body.textContent?.includes(
				"Couldn't save your analytics choice"
			) === true,
		"actual Privacy refused enable/error recovery"
	);
	expectWrite(
		onlyWrite(refusalMarker),
		"a",
		"delegation-a",
		"/api/preferences/product-analytics-enabled",
		{ value: "true" },
		503
	);
	expect(isAnalyticsEnabled()).toBe(false);
	expect(localStorage.getItem("ryu:product-analytics-enabled")).toBe("false");
	expect(rawDocument("a")).toBe(aBefore);
	expect(rawDocument("b")).toBe(bBefore);
	expectLocalConserved();
	const retryMarker = calls.length;
	await click(privacySwitch());
	await consumeAll(retryMarker);
	expectWrite(
		onlyWrite(retryMarker),
		"a",
		"delegation-a",
		"/api/preferences/product-analytics-enabled",
		{ value: "true" },
		200
	);
	expect(checked(privacySwitch())).toBe(true);
	expect(isAnalyticsEnabled()).toBe(true);
	expect(localStorage.getItem("ryu:product-analytics-enabled")).toBe("true");
	const expected = recordSchema.parse(JSON.parse(aBefore));
	expected.preferences["product-analytics-enabled"] = "true";
	expect(readDocument("a")).toEqual(expected);
	expect(rawDocument("b")).toBe(bBefore);
	expect(isCrashReportingEnabled()).toBe(false);
	expect(localStorage.getItem("ryu:crash-reports-enabled")).toBe("false");
	expectLocalConserved();
	await unmount();
	// A genuine fresh process imports the unchanged gate modules after restoring
	// exactly the saved native Storage bytes. Its startup seed is independent of
	// this process's module cache; it makes no claim about physical browser storage.
	const boot = await freshGateBoot();
	expect(boot.analytics).toBe(true);
	expect(boot.crash).toBe(false);
	const reloadMarker = calls.length;
	await mount(<PrivacySettings />);
	await privacyReads(reloadMarker);
	await openUsagePage();
	expect(checked(privacySwitch())).toBe(true);
	expect(isAnalyticsEnabled()).toBe(true);
	expect(readDocument("a")).toEqual(expected);
	expect(rawDocument("b")).toBe(bBefore);
	expect(isCrashReportingEnabled()).toBe(false);
	expectLocalConserved();
}, 25_000);
