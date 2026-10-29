import { parseCloudEnvironmentState } from "@ryuhq/protocol/cloud-environments";
import { type ApiTarget, request } from "./client.ts";
import {
	type CloudGithubInput,
	cloudGithubEnvelopeSchema,
	cloudGithubRepositorySchema,
	cloudGithubStateProjectionSchema,
} from "./cloud-account-wire-contracts.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";

export interface CloudGithubConnection {
	connected: boolean;
	login: string | null;
	repositories: { fullName: string; private: boolean }[];
	vaultKey: string | null;
}

export function parseCloudGithubConnection(
	value: CloudGithubInput
): CloudGithubConnection {
	const parsed = cloudGithubEnvelopeSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error("Invalid GitHub connection response");
	}
	const metadata = parsed.data;
	if (metadata.connected && !(metadata.login && metadata.vaultKey)) {
		throw new Error("GitHub connection metadata is incomplete");
	}
	const repositories = metadata.repositories.map((repository) => {
		const decoded = cloudGithubRepositorySchema.safeParse(repository);
		if (!decoded.success) {
			throw new Error("Invalid GitHub repository metadata");
		}
		return decoded.data;
	});
	return {
		connected: metadata.connected,
		login: metadata.login,
		vaultKey: metadata.vaultKey,
		repositories,
	};
}

export async function fetchCloudGithub(
	target: ApiTarget,
	signal?: AbortSignal
) {
	return parseCloudGithubConnection(
		await request(
			target,
			"/api/cloud-environments/github",
			{
				signal,
			},
			gatewayJsonValueSchema
		)
	);
}

export async function connectCloudGithub(
	target: ApiTarget,
	token: string,
	revision: number
) {
	const response = await request(
		target,
		"/api/cloud-environments/github",
		{ method: "POST", body: { token, revision } },
		gatewayJsonValueSchema
	);
	const connection = parseCloudGithubConnection(response);
	const state = cloudGithubStateProjectionSchema.safeParse(response);
	if (state.success && state.data.present) {
		parseCloudEnvironmentState(state.data.state);
	}
	return connection;
}
