// biome-ignore-all lint/suspicious/noMisplacedAssertion: Shared native-HTTP ledger and conservation helpers run only inside this file's real bun:test cases and hooks.
import { expect, test } from "bun:test";
import { act } from "react";
import {
	acknowledged,
	assertActualEvalRequest,
	assertIndependentForeignDefault,
	assertUnmountedQueries,
	chooseCustomModel,
	currentNode,
	draftInput,
	evalInput,
	localControl,
	localWrites,
	mount,
	newlyOpenEvals,
	observedRoot,
	queryClient,
	setLaneAgentSelection,
	setNode,
	toTarget,
	tree,
	until,
	useNodeStore,
} from "./DefaultsSection.consumer.native-http.test-support.tsx";
import { registerDefaultsSectionConsumerHooks } from "./DefaultsSection.consumer.native-http-hooks.test-support.tsx";
import {
	allowed,
	calls,
	independentlyReadRecords,
	live,
	localKey,
	selection,
} from "./DefaultsSection.consumer.native-http-store.test-support.tsx";

registerDefaultsSectionConsumerHooks();

test("actual local-default keyboard save conserves refused state, retries durably and feeds a newly opened eval consumer", async () => {
	await mount();
	const original = await independentlyReadRecords();
	await assertIndependentForeignDefault(original);
	const draft = draftInput();
	live.refusedLocalWrites = 1;
	await chooseCustomModel("model-next");
	await until(
		() =>
			localWrites().length === 1 &&
			acknowledged(localWrites()[0]!) !== undefined &&
			!localControl().disabled,
		"Refused actual default write did not settle"
	);
	expect(localWrites()[0]).toMatchObject({
		owner: "a",
		bearer: "Bearer defaults-a-bearer",
		delegation: "defaults-a-jwt",
		body: { value: JSON.stringify(selection("model-next")) },
		status: 503,
	});
	expect(acknowledged(localWrites()[0]!)?.text).toBe(
		JSON.stringify({ error: "Owned preference write refused" })
	);
	expect(await independentlyReadRecords()).toEqual(original);
	expect(localControl().textContent).toContain("model-a");
	expect(evalInput().value).toBe("model-a");
	await until(
		() => document.body.textContent!.includes("Couldn't save the default"),
		"Real Toaster did not explain the refused save"
	);
	await chooseCustomModel("model-next");
	await until(
		() =>
			localWrites().length === 2 &&
			acknowledged(localWrites()[1]!) !== undefined &&
			!localControl().disabled,
		"Retry did not consume its actual native acknowledgment"
	);
	expect(localWrites()[1]).toMatchObject({
		owner: "a",
		body: { value: JSON.stringify(selection("model-next")) },
		status: 200,
	});
	expect(acknowledged(localWrites()[1]!)?.text).toBe(
		JSON.stringify({ ok: true, key: localKey })
	);
	expect(await independentlyReadRecords()).toEqual({
		...original,
		a: { ...original.a, [localKey]: JSON.stringify(selection("model-next")) },
	});
	expect(localControl().textContent).toContain("model-next");
	expect(draftInput()).toBe(draft);
	expect(draft.value).toBe("Unsent defaults proof draft");
	await newlyOpenEvals();
	await until(
		() => evalInput().value === "model-next",
		"An acknowledged local default was hidden by the old model query cache"
	);
	await assertActualEvalRequest("a", "model-next");
	expect(localStorage.getItem("defaults-proof-unrelated")).toBe("preserved");
	expect(localStorage.getItem("ryu:timezone")).toBe("Asia/Tokyo");
	await assertUnmountedQueries();
	// A fresh renderer with an independent cache reads the file-backed peer again.
	queryClient.clear();
	const saved = await independentlyReadRecords();
	expect(saved.a[localKey]).toBe(JSON.stringify(selection("model-next")));
	live.showEvals = false;
	live.container = document.createElement("div");
	document.body.append(live.container);
	live.root = observedRoot(live.container);
	await act(async () => live.root!.render(tree()));
	await until(
		() =>
			document
				.querySelector('[aria-label="Default local agent or model"]')
				?.textContent?.includes("model-next") === true,
		"Independent settings remount did not read the acknowledged saved model"
	);
	expect(await independentlyReadRecords()).toEqual(saved);
});

for (const credential of ["Bearer", "JWT"] as const) {
	test(`same-URL ${credential}-only authority change rereads the acknowledged node default and transports it from the actual eval consumer`, async () => {
		await mount();
		const original = await independentlyReadRecords();
		await assertIndependentForeignDefault(original);
		const draft = draftInput();
		draft.focus();
		// Core preferences belong to the node. A genuine independent SDK writer
		// updates that one node before credentials rotate; there is no fabricated
		// per-user preference namespace at the same URL.
		const beforeExternalWrite = calls.length;
		await act(async () => {
			expect(
				await setLaneAgentSelection(
					toTarget(currentNode()),
					"local",
					selection("model-b")
				)
			).toBe(true);
		});
		const externalWrite = calls
			.slice(beforeExternalWrite)
			.find(
				(call) => call.method === "PUT" && call.url.endsWith(`/${localKey}`)
			);
		expect(externalWrite).toBeDefined();
		expect(externalWrite).toMatchObject({
			owner: "a",
			bearer: "Bearer defaults-a-bearer",
			delegation: "defaults-a-jwt",
			body: { value: JSON.stringify(selection("model-b")) },
			status: 200,
		});
		expect(acknowledged(externalWrite!)?.text).toBe(
			JSON.stringify({ ok: true, key: localKey })
		);
		const updated = {
			...original,
			a: { ...original.a, [localKey]: JSON.stringify(selection("model-b")) },
		};
		expect(await independentlyReadRecords()).toEqual(updated);
		const node =
			credential === "Bearer"
				? currentNode("defaults-b-bearer", "defaults-a-jwt")
				: currentNode("defaults-a-bearer", "defaults-b-jwt");
		allowed.set(`Bearer ${node.token}|${node.userJwt}`, "a");
		const before = calls.length;
		await setNode(node);
		await until(
			() =>
				document
					.querySelector('[aria-label="Default local agent or model"]')
					?.textContent?.includes("model-b") === true,
			"Actual setting did not reread the node's saved default under new credentials"
		);
		expect(draftInput()).toBe(draft);
		expect(document.activeElement).toBe(draft);
		expect(draft.value).toBe("Unsent defaults proof draft");
		await until(
			() => evalInput().value === "model-b",
			`The actual eval model cache reused the old ${credential} authority`
		);
		const reads = calls
			.slice(before)
			.filter((call) => new URL(call.url).pathname.endsWith(`/${localKey}`));
		// One read belongs to the real settings producer, the other to the real
		// model query. A refreshed old-credential cache is not new admission.
		expect(reads).toHaveLength(2);
		for (const read of reads) {
			expect(read).toMatchObject({
				owner: "a",
				method: "GET",
				bearer: `Bearer ${node.token}`,
				delegation: node.userJwt,
				body: null,
				status: 200,
			});
			expect(acknowledged(read)?.text).toBe(
				JSON.stringify({ key: localKey, value: updated.a[localKey] })
			);
		}
		await assertActualEvalRequest("a", "model-b");
		const run = [...calls]
			.reverse()
			.find((call) => call.url.endsWith("/api/gateway/evals/run"));
		expect(run).toMatchObject({
			bearer: `Bearer ${node.token}`,
			delegation: node.userJwt,
		});
		expect(localWrites()).toEqual([externalWrite!]);
		expect(await independentlyReadRecords()).toEqual(updated);
		expect(useNodeStore.getState().getActiveNode()).toEqual(node);
		expect(localStorage.getItem("defaults-proof-unrelated")).toBe("preserved");
		expect(localStorage.getItem("ryu:timezone")).toBe("Asia/Tokyo");
		await assertUnmountedQueries();
	});
}
