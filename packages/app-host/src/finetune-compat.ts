import type { HostServices } from "./rpc.ts";

// The legacy `finetune.*` host-API family. Host API 1.x is additive-only, so these
// method names stay in the shared vocabulary until the next major bump, but Core no
// longer bridges them (the `host.finetune_*` verbs are gone). Each unary verb is
// now the SAME request onto the calling companion's OWN sidecar through the generic
// ext-proxy (`/api/ext/<plugin id>/*`, relative to its `http.mount`), and the
// progress stream is that sidecar's SSE route. The host still derives the plugin id;
// the frame only supplies a job id, which is path-encoded here.

type AppRequestService = NonNullable<HostServices["appRequest"]>;

export type FinetuneCompatServices = Pick<
	HostServices,
	| "finetuneAdapters"
	| "finetuneCancel"
	| "finetuneCapability"
	| "finetuneGet"
	| "finetuneList"
	| "finetuneMerge"
	| "finetuneStart"
>;

/** One job's sub-path under the sidecar mount. */
export function finetuneJobPath(id: string): string {
	return `/${encodeURIComponent(id)}`;
}

/** The sidecar's live-progress SSE route for one job, relative to its mount. */
export function finetuneStreamPath(id: string): string {
	return `${finetuneJobPath(id)}/stream`;
}

/** Serve the unary `finetune.*` verbs from the host's own-app request forwarder. */
export function finetuneServicesViaAppRequest(
	appRequest: AppRequestService
): FinetuneCompatServices {
	return {
		finetuneAdapters: () => appRequest({ method: "GET", path: "/adapters" }),
		finetuneCancel: ({ id }) =>
			appRequest({ method: "DELETE", path: finetuneJobPath(id) }),
		finetuneCapability: () =>
			appRequest({ method: "GET", path: "/capability" }),
		finetuneGet: ({ id }) =>
			appRequest({ method: "GET", path: finetuneJobPath(id) }),
		finetuneList: () => appRequest({ method: "GET", path: "/list" }),
		finetuneMerge: (input) =>
			appRequest({ body: input, method: "POST", path: "/merge" }),
		finetuneStart: (input) =>
			appRequest({ body: input, method: "POST", path: "/start" }),
	};
}
