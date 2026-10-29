import { describe, expect, test } from "bun:test";
import {
	finetuneServicesViaAppRequest,
	finetuneStreamPath,
} from "./finetune-compat.ts";
import type { AppRequestPayload, RpcJsonResponse } from "./rpc.ts";

function recordingAppRequest(reply: RpcJsonResponse) {
	const requests: AppRequestPayload[] = [];
	const appRequest = (input: AppRequestPayload) => {
		requests.push(input);
		return Promise.resolve(reply);
	};
	return { appRequest, requests };
}

describe("finetune host-API compatibility over the own-app forwarder", () => {
	test("maps every unary verb onto the sidecar's mount-relative route", async () => {
		const reply = { future: ["sidecar-owned"] };
		const { appRequest, requests } = recordingAppRequest(reply);
		const services = finetuneServicesViaAppRequest(appRequest);
		const spec = { base_model_id: "base", dataset: { samples: [] } };
		const merge = { adapter_name: "lora" };

		expect(await services.finetuneCapability?.()).toBe(reply);
		expect(await services.finetuneList?.()).toBe(reply);
		expect(await services.finetuneAdapters?.()).toBe(reply);
		expect(await services.finetuneGet?.({ id: "job-1" })).toBe(reply);
		expect(await services.finetuneCancel?.({ id: "job-1" })).toBe(reply);
		expect(await services.finetuneStart?.(spec)).toBe(reply);
		expect(await services.finetuneMerge?.(merge)).toBe(reply);

		expect(requests).toEqual([
			{ method: "GET", path: "/capability" },
			{ method: "GET", path: "/list" },
			{ method: "GET", path: "/adapters" },
			{ method: "GET", path: "/job-1" },
			{ method: "DELETE", path: "/job-1" },
			{ body: spec, method: "POST", path: "/start" },
			{ body: merge, method: "POST", path: "/merge" },
		]);
		// The worker-owned spec is forwarded by reference, never reshaped.
		expect(requests[5]?.body).toBe(spec);
	});

	test("path-encodes job ids so a frame cannot climb out of its job route", async () => {
		const { appRequest, requests } = recordingAppRequest(undefined);
		const services = finetuneServicesViaAppRequest(appRequest);
		await services.finetuneGet?.({ id: "../list" });
		await services.finetuneCancel?.({ id: "a/b" });
		expect(requests.map((request) => request.path)).toEqual([
			"/..%2Flist",
			"/a%2Fb",
		]);
		expect(finetuneStreamPath("a/b")).toBe("/a%2Fb/stream");
		expect(finetuneStreamPath("job-1")).toBe("/job-1/stream");
	});
});
