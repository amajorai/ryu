// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared native-HTTP ledger and conservation helpers run only inside this file's real bun:test cases and hooks.
import { expect, test } from "bun:test";
import { act } from "react";
import type { NodeDefaultModel } from "@/src/hooks/useNodeDefaultModel.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	acknowledged,
	assertActualEvalRequest,
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
	tree,
	until,
	useNodeStore,
} from "./DefaultsSection.consumer.native-http.test-support.tsx";
import { registerDefaultsSectionConsumerHooks } from "./DefaultsSection.consumer.native-http-hooks.test-support.tsx";
import { server } from "./DefaultsSection.consumer.native-http-peer.test-support.tsx";
import {
	allowed,
	bodyReadStarts,
	calls,
	heldBodies,
	heldBodySnapshot,
	independentlyReadRecords,
	live,
	localKey,
	releaseHeldBodies,
	selection,
	settleNativeTransport,
} from "./DefaultsSection.consumer.native-http-store.test-support.tsx";

registerDefaultsSectionConsumerHooks();

test("returning to cached credentials after an acknowledged node-wide default save waits for actual response bodies before a fresh eval can run", async () => {
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
			throw new Error("Missing genuinely fetched foreign default cache");
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
	const cachedA = queryClient.getQueryState(
		nodeDefaultModelQueryKey(toTarget(nodeA))
	);
	expect(cachedA?.data).toEqual({ agentId: undefined, model: "model-a" });
	expect(cachedA?.status).toBe("success");
	expect(cachedA?.isInvalidated).toBe(false);
	const cachedAUpdatedAt = cachedA!.dataUpdatedAt;
	const draft = draftInput();
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
		"New credentials did not genuinely read the same node-wide starting model"
	);
	await chooseCustomModel("model-b");
	await until(
		() =>
			localWrites().length === 1 &&
			acknowledged(localWrites()[0]!) !== undefined &&
			!localControl().disabled &&
			evalInput().value === "model-b",
		"The real B producer save did not acknowledge and refresh its model consumer"
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
	expect(foreignCache()).toEqual(foreignCacheBefore);
	expect(calls.filter((call) => call.owner === "foreign")).toEqual(
		foreignReads
	);

	// Only reopen the genuine eval consumer. The real shared query cache and
	// mounted surrounding draft remain, including A's recent cached model-a.
	live.showEvals = false;
	await act(async () => live.root!.render(tree()));
	expect(live.container?.querySelector("#eval-model")).toBeNull();
	draft.focus();
	live.holdLocalReadCredentials = {
		bearer: "Bearer defaults-a-bearer",
		delegation: "defaults-a-jwt",
	};
	const beforeReturn = calls.length;
	live.evalGeneration += 1;
	live.showEvals = true;
	try {
		expect(Date.now() - cachedAUpdatedAt).toBeLessThan(60 * 1000);
		await setNode(nodeA);
		await act(async () => live.root!.render(tree()));
		await until(
			() =>
				heldBodies.length === 2 &&
				heldBodies.every((body) => bodyReadStarts.includes(body.id)),
			"Returning A did not start both genuine producer and model-query reads before using its cached default"
		);
		const returningReads = calls
			.slice(beforeReturn)
			.filter((call) => new URL(call.url).pathname.endsWith(`/${localKey}`));
		expect(returningReads).toHaveLength(2);
		for (const read of returningReads) {
			expect(read).toMatchObject({
				owner: "a",
				method: "GET",
				bearer: "Bearer defaults-a-bearer",
				delegation: "defaults-a-jwt",
				body: null,
				status: 200,
			});
			expect(bodyReadStarts).toContain(read.id);
			expect(acknowledged(read)).toBeUndefined();
		}
		expect(
			[...heldBodySnapshot()].sort((left, right) => left.id - right.id)
		).toEqual(
			[
				...returningReads.map((read) => ({
					id: read.id,
					text: JSON.stringify({ key: localKey, value: saved.a[localKey] }),
					released: false,
					cancelled: null,
				})),
			].sort((left, right) => left.id - right.id)
		);
		expect(
			queryClient.getQueryState(nodeDefaultModelQueryKey(toTarget(nodeA)))
				?.fetchStatus
		).toBe("fetching");
		expect(evalInput().value).toBe("");
		expect(button("Run evals").disabled).toBe(true);
		await act(async () => button("Run evals").click());
		expect(
			calls.some((call) => call.url.endsWith("/api/gateway/evals/run"))
		).toBe(false);
		expect(draftInput()).toBe(draft);
		expect(document.activeElement).toBe(draft);
		expect(draft.value).toBe("Unsent defaults proof draft");
		expect(foreignCache()).toEqual(foreignCacheBefore);
		expect(calls.filter((call) => call.owner === "foreign")).toEqual(
			foreignReads
		);
		expect(await independentlyReadRecords()).toEqual(saved);

		await act(async () => {
			releaseHeldBodies();
			await settleNativeTransport();
		});
		await until(
			() =>
				returningReads.every((read) => acknowledged(read) !== undefined) &&
				evalInput().value === "model-b" &&
				localControl().textContent?.includes("model-b") === true,
			"The fresh actual consumer did not follow the acknowledged held node-wide default"
		);
		for (const read of returningReads) {
			expect(acknowledged(read)?.text).toBe(
				JSON.stringify({ key: localKey, value: saved.a[localKey] })
			);
		}
		expect(
			heldBodies.every((body) => body.released && body.cancelled === null)
		).toBe(true);
		await assertActualEvalRequest("a", "model-b");
		expect(
			[...calls]
				.reverse()
				.find((call) => call.url.endsWith("/api/gateway/evals/run"))
		).toMatchObject({
			bearer: "Bearer defaults-a-bearer",
			delegation: "defaults-a-jwt",
		});
		expect(localWrites()).toEqual([save]);
		expect(foreignCache()).toEqual(foreignCacheBefore);
		expect(calls.filter((call) => call.owner === "foreign")).toEqual(
			foreignReads
		);
		expect(await independentlyReadRecords()).toEqual(saved);
		expect(draftInput()).toBe(draft);
		expect(document.activeElement).toBe(draft);
		expect(localStorage.getItem("defaults-proof-unrelated")).toBe("preserved");
		expect(localStorage.getItem("ryu:timezone")).toBe("Asia/Tokyo");
		expect(useNodeStore.getState().getActiveNode()).toEqual(nodeA);
	} finally {
		// An authentic baseline failure must still release its real network
		// bodies and await decoders before afterEach restores or resets anything.
		await act(async () => {
			releaseHeldBodies();
			await settleNativeTransport();
		});
	}
	await assertUnmountedQueries();
});
