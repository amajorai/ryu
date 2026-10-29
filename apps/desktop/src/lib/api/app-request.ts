import {
	type AppRequestInput,
	type MountedAppRequestPolicy,
	type MountedAppTransport,
	mountedAppRequest as sharedMountedAppRequest,
	ownAppRequest as sharedOwnAppRequest,
	requestValidatedMountedApp as sharedRequestValidatedMountedApp,
	type ValidatedMountedAppRequest,
} from "@ryuhq/core-client/app-request.ts";
import {
	type AppResponseValue,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json.ts";
import { z } from "zod";
import { ApiError, type ApiTarget, request } from "./client.ts";

export type {
	AppRequestInput,
	AppRequestMethod,
	MountedAppPathInput,
	MountedAppRequestPolicy,
	ValidatedMountedAppRequest,
} from "@ryuhq/core-client/app-request.ts";
export {
	resolveMountedAppPath,
	resolveOwnAppPath,
	validateMountedAppRequest,
} from "@ryuhq/core-client/app-request.ts";

const desktopApiErrorSchema = z.instanceof(ApiError);

// Retain Desktop's error type, server reason, scoped credentials and HTTP metrics.
const desktopTransport: MountedAppTransport = {
	request: (target, input) =>
		request(
			target,
			input.path,
			{
				body: input.body,
				method: input.method,
				signal: input.signal,
			},
			appResponseValueSchema
		).then(appResponseValueSchema.parse),
	isRetryableReadError: (error) => {
		const parsed = desktopApiErrorSchema.safeParse(error);
		return (
			parsed.success &&
			(parsed.data.status === 502 || parsed.data.status === 503)
		);
	},
};

export function requestValidatedMountedApp(
	target: ApiTarget,
	input: ValidatedMountedAppRequest
): Promise<AppResponseValue> {
	return sharedRequestValidatedMountedApp(target, input, desktopTransport);
}
export function mountedAppRequest(
	target: ApiTarget,
	input: AppRequestInput,
	policy: MountedAppRequestPolicy
): Promise<AppResponseValue> {
	return sharedMountedAppRequest(target, input, policy, desktopTransport);
}
export function ownAppRequest(
	target: ApiTarget,
	pluginId: string,
	input: AppRequestInput
): Promise<AppResponseValue> {
	return sharedOwnAppRequest(target, pluginId, input, desktopTransport);
}

export { mountedAppPathInputSchema } from "@ryuhq/core-client/app-request.ts";
export type {
	AppRequestValue,
	AppResponseValue,
} from "@ryuhq/core-client/app-request-json.ts";
export {
	appRequestValueSchema,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json.ts";
