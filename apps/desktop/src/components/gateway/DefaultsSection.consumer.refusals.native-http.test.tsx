// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared native-HTTP ledger and conservation helpers run only inside this file's real bun:test cases and hooks.
import { expect, test } from "bun:test";
import { act } from "react";
import type { NodeDefaultModel } from "@/src/hooks/useNodeDefaultModel.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	acknowledged,
	assertUnmountedQueries,
	button,
	chooseCustomModel,
	currentNode,
	draftInput,
	evalInput,
	localControl,
	localWrites,
	mount,
	nodeDefaultModelQueryKey,
	queryClient,
	resolveNodeDefaultModel,
	setNode,
	toTarget,
	until,
	useNodeStore,
} from "./DefaultsSection.consumer.native-http.test-support.tsx";
import { registerDefaultsSectionConsumerHooks } from "./DefaultsSection.consumer.native-http-hooks.test-support.tsx";
import { server } from "./DefaultsSection.consumer.native-http-peer.test-support.tsx";
import {
	allowed,
	bodyReadStarts,
	calls,
	independentlyReadRecords,
	live,
	localKey,
	selection,
} from "./DefaultsSection.consumer.native-http-store.test-support.tsx";

registerDefaultsSectionConsumerHooks();

test("refused returning-credential reads retire both open and fresh automatic eval models until the real Defaults Retry acknowledges recovery", async () => {
	await mount();
	const original = await independentlyReadRecords();
	const foreignTarget: ApiTarget = {
		url: `${server.url.origin}/foreign`,
		token: "defaults-foreign-bearer",
		userJwt: "defaults-foreign-jwt",
	};
	const foreignKey = nodeDefaultModelQueryKey(foreignTarget);
	expect(
		await queryClient.fetchQuery<NodeDefaultModel>({
			queryKey: foreignKey,
			queryFn: () => resolveNodeDefaultModel(foreignTarget),
			staleTime: 60 * 1000,
		})
	).toEqual({ agentId: undefined, model: "foreign-model" });
	const foreignReads = calls.filter((call) => call.owner === "foreign");
	expect(foreignReads).toHaveLength(1);
	expect(foreignReads[0]).toMatchObject({
		method: "GET",
		bearer: "Bearer defaults-foreign-bearer",
		delegation: "defaults-foreign-jwt",
		url: `${foreignTarget.url}/api/preferences/${localKey}`,
		body: null,
		status: 200,
	});
	expect(acknowledged(foreignReads[0]!)?.text).toBe(
		JSON.stringify({ key: localKey, value: original.foreign[localKey] })
	);
	const foreignCache = () => {
		const state = queryClient.getQueryState(foreignKey);
		if (!state) {
			throw new Error("Missing genuinely fetched foreign refusal-proof cache");
		}
		return {
			data: state.data,
			dataUpdatedAt: state.dataUpdatedAt,
			isInvalidated: state.isInvalidated,
			status: state.status,
			fetchStatus: state.fetchStatus,
		};
	};
	const foreignCacheBefore = foreignCache();
	const nodeA = currentNode();
	const keyA = nodeDefaultModelQueryKey(toTarget(nodeA));
	const cachedA = queryClient.getQueryState(keyA);
	expect(cachedA?.data).toEqual({ agentId: undefined, model: "model-a" });
	expect(cachedA?.status).toBe("success");
	expect(cachedA?.isInvalidated).toBe(false);
	const cachedAUpdatedAt = cachedA!.dataUpdatedAt;
	const automaticInput = evalInput();
	const draft = draftInput();
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(draft, "Edited refusal proof draft");
		draft.dispatchEvent(new Event("input", { bubbles: true }));
	});
	const nodeB = currentNode("defaults-b-bearer", "defaults-a-jwt");
	allowed.set(`Bearer ${nodeB.token}|${nodeB.userJwt}`, "a");
	await setNode(nodeB);
	await until(
		() =>
			document
				.querySelector('[aria-label="Default local agent or model"]')
				?.textContent?.includes("model-a") === true &&
			queryClient.getQueryState(nodeDefaultModelQueryKey(toTarget(nodeB)))
				?.status === "success",
		"New credentials did not acknowledge the node-wide starting default before the refusal proof"
	);
	await chooseCustomModel("model-b");
	await until(
		() =>
			localWrites().length === 1 &&
			acknowledged(localWrites()[0]!) !== undefined &&
			!localControl().disabled &&
			automaticInput.value === "model-b" &&
			queryClient.getQueryState(nodeDefaultModelQueryKey(toTarget(nodeB)))
				?.fetchStatus === "idle",
		"The actual B save did not acknowledge and refresh the already-open automatic consumer"
	);
	const save = localWrites()[0]!;
	expect(save).toMatchObject({
		owner: "a",
		bearer: `Bearer ${nodeB.token}`,
		delegation: nodeB.userJwt,
		body: { value: JSON.stringify(selection("model-b")) },
		status: 200,
	});
	expect(acknowledged(save)?.text).toBe(
		JSON.stringify({ ok: true, key: localKey })
	);
	const saved = {
		...original,
		a: { ...original.a, [localKey]: JSON.stringify(selection("model-b")) },
	};
	expect(await independentlyReadRecords()).toEqual(saved);
	expect(evalInput()).toBe(automaticInput);
	expect(foreignCache()).toEqual(foreignCacheBefore);
	expect(calls.filter((call) => call.owner === "foreign")).toEqual(
		foreignReads
	);

	// The original automatic field stays mounted and unedited. A second real
	// consumer starts on return A; both observe the same genuine QueryClient.
	// Actual failed HTTP bodies, rather than a fabricated empty/default DTO,
	// must settle the installed retry1 before either field can run.
	draft.focus();
	live.refuseLocalReadCredentials = {
		bearer: "Bearer defaults-a-bearer",
		delegation: "defaults-a-jwt",
	};
	live.showFreshRefusalEvals = true;
	const beforeReturn = calls.length;
	expect(Date.now() - cachedAUpdatedAt).toBeLessThan(60 * 1000);
	await setNode(nodeA);
	const refusedReads = () =>
		calls
			.slice(beforeReturn)
			.filter(
				(call) =>
					call.method === "GET" &&
					new URL(call.url).pathname.endsWith(`/${localKey}`)
			);
	await until(
		() =>
			refusedReads().length === 3 &&
			refusedReads().every((call) => acknowledged(call) !== undefined) &&
			queryClient.getQueryState(keyA)?.status === "error" &&
			queryClient.getQueryState(keyA)?.fetchStatus === "idle" &&
			live.container?.textContent?.includes(
				"Could not load the saved defaults. Retry before making changes."
			) === true,
		"The actual producer and both installed query retry attempts did not consume their native HTTP503 refusals"
	);
	const failures = refusedReads();
	expect(failures).toHaveLength(3);
	for (const read of failures) {
		expect(read).toMatchObject({
			owner: "a",
			method: "GET",
			bearer: "Bearer defaults-a-bearer",
			delegation: "defaults-a-jwt",
			body: null,
			status: 503,
		});
		expect(bodyReadStarts).toContain(read.id);
		expect(acknowledged(read)?.text).toBe(
			JSON.stringify({ error: "Owned preference read refused" })
		);
	}
	const consumers = () =>
		(["automatic", "fresh"] as const).map((name) => {
			const view = live.container?.querySelector<HTMLDivElement>(
				`[data-defaults-proof-evals="${name}"]`
			);
			const input = view?.querySelector<HTMLInputElement>("#eval-model");
			const run = [
				...(view?.querySelectorAll<HTMLButtonElement>("button") ?? []),
			].find((item) => item.textContent?.trim() === "Run evals");
			if (!(view && input && run)) {
				throw new Error(`Missing actual ${name} refusal-proof eval consumer`);
			}
			return { view, input, run };
		});
	expect(evalInput()).toBe(automaticInput);
	expect(consumers().map(({ input }) => input.value)).toEqual(["", ""]);
	expect(consumers().map(({ run }) => run.disabled)).toEqual([true, true]);
	await act(async () => {
		for (const { run } of consumers()) {
			run.click();
		}
	});
	expect(
		calls.some((call) => call.url.endsWith("/api/gateway/evals/run"))
	).toBe(false);
	expect(
		document.querySelector('[aria-label="Default local agent or model"]')
	).toBeNull();
	expect(button("Retry").disabled).toBe(false);
	expect(draftInput()).toBe(draft);
	expect(draft.value).toBe("Edited refusal proof draft");
	expect(document.activeElement).toBe(draft);
	expect(await independentlyReadRecords()).toEqual(saved);
	expect(foreignCache()).toEqual(foreignCacheBefore);
	expect(calls.filter((call) => call.owner === "foreign")).toEqual(
		foreignReads
	);

	live.refuseLocalReadCredentials = null;
	const beforeRetry = calls.length;
	await act(async () => button("Retry").click());
	const recoveryReads = () =>
		calls
			.slice(beforeRetry)
			.filter(
				(call) =>
					call.method === "GET" &&
					new URL(call.url).pathname.endsWith(`/${localKey}`)
			);
	await until(
		() =>
			recoveryReads().length === 2 &&
			recoveryReads().every((call) => acknowledged(call) !== undefined) &&
			queryClient.getQueryState(keyA)?.status === "success" &&
			queryClient.getQueryState(keyA)?.fetchStatus === "idle" &&
			consumers().every(
				({ input, run }) => input.value === "model-b" && !run.disabled
			) &&
			document
				.querySelector('[aria-label="Default local agent or model"]')
				?.textContent?.includes("model-b") === true,
		"The real Defaults Retry did not acknowledge both stored defaults and the recovered automatic-model query"
	);
	expect(recoveryReads()).toHaveLength(2);
	for (const read of recoveryReads()) {
		expect(read).toMatchObject({
			owner: "a",
			method: "GET",
			bearer: "Bearer defaults-a-bearer",
			delegation: "defaults-a-jwt",
			body: null,
			status: 200,
		});
		expect(acknowledged(read)?.text).toBe(
			JSON.stringify({ key: localKey, value: saved.a[localKey] })
		);
	}
	expect(live.container?.textContent).not.toContain(
		"Could not load the saved defaults. Retry before making changes."
	);
	expect(evalInput()).toBe(automaticInput);
	for (const { view, run } of consumers()) {
		const beforeRun = calls.length;
		await act(async () => run.click());
		await until(
			() =>
				calls
					.slice(beforeRun)
					.some(
						(call) =>
							call.url.endsWith("/api/gateway/evals/run") &&
							acknowledged(call) !== undefined
					),
			"Recovered actual eval consumer did not consume its native inference refusal"
		);
		const request = calls
			.slice(beforeRun)
			.find((call) => call.url.endsWith("/api/gateway/evals/run"))!;
		expect(request).toMatchObject({
			owner: "a",
			method: "POST",
			bearer: "Bearer defaults-a-bearer",
			delegation: "defaults-a-jwt",
			body: {
				agent_id: null,
				model: "model-b",
				dataset: [],
				evaluators: [],
				code_evaluators: [],
			},
			status: 503,
		});
		expect(acknowledged(request)?.text).toBe(
			JSON.stringify({ error: "Owned inference provider unavailable" })
		);
		await until(
			() => view.textContent?.includes("503") === true && !run.disabled,
			"That actual recovered eval consumer did not render its acknowledged HTTP503 error and permit retry"
		);
	}
	await until(
		() =>
			consumers().every(
				({ input, run }) => input.value === "model-b" && !run.disabled
			),
		"Actual eval refusal did not leave both recovered consumers available for retry"
	);
	expect(localWrites()).toEqual([save]);
	expect(await independentlyReadRecords()).toEqual(saved);
	expect(foreignCache()).toEqual(foreignCacheBefore);
	expect(calls.filter((call) => call.owner === "foreign")).toEqual(
		foreignReads
	);
	expect(draftInput()).toBe(draft);
	expect(draft.value).toBe("Edited refusal proof draft");
	expect(localStorage.getItem("defaults-proof-unrelated")).toBe("preserved");
	expect(localStorage.getItem("ryu:timezone")).toBe("Asia/Tokyo");
	expect(useNodeStore.getState().getActiveNode()).toEqual(nodeA);
	await assertUnmountedQueries();
});
