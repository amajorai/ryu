import type { RyuNodeClient } from "./client.ts";
import type { ActionRuntime } from "./runtime.ts";
import type { ActionInputs, VaultSecretRef } from "./types.ts";

/** Group references so each (environment, folder) is one export request. */
export function groupVaultRefs(refs: VaultSecretRef[]): Array<{
	environment: string | null;
	path: string;
	refs: VaultSecretRef[];
}> {
	const groups = new Map<
		string,
		{ environment: string | null; path: string; refs: VaultSecretRef[] }
	>();
	for (const ref of refs) {
		const key = `${ref.environment ?? ""}\u0000${ref.path}`;
		const group = groups.get(key) ?? {
			environment: ref.environment,
			path: ref.path,
			refs: [],
		};
		group.refs.push(ref);
		groups.set(key, group);
	}
	return [...groups.values()];
}

/** Mask a value for the job log. Multi-line values are also masked line by
 *  line, because the runner matches masks per output line. */
function maskValue(runtime: ActionRuntime, value: string): void {
	runtime.setSecret(value);
	const lines = value.split(/\r?\n/).filter((line) => line.trim().length > 0);
	if (lines.length > 1) {
		for (const line of lines) {
			runtime.setSecret(line);
		}
	}
}

async function vaultToken(
	client: RyuNodeClient,
	inputs: ActionInputs,
	runtime: ActionRuntime
): Promise<string> {
	if (inputs.vaultRoleId && inputs.vaultSecretId) {
		runtime.setSecret(inputs.vaultSecretId);
		const login = await client.vaultLogin(
			{ roleId: inputs.vaultRoleId, secretId: inputs.vaultSecretId },
			inputs.timeoutMs
		);
		runtime.setSecret(login.token);
		return login.token;
	}
	if (!inputs.vaultJwtIdentity) {
		throw new Error(
			"Input 'secrets' needs 'vault-role-id' and 'vault-secret-id', or 'vault-jwt-identity'."
		);
	}
	if (!runtime.getIDToken) {
		throw new Error("GitHub OIDC tokens are unavailable in this runtime.");
	}
	let jwt: string;
	try {
		jwt = await runtime.getIDToken(inputs.vaultJwtAudience ?? undefined);
	} catch (error) {
		throw new Error(
			`Could not get a GitHub OIDC token (the job needs 'permissions: id-token: write'): ${error instanceof Error ? error.message : String(error)}`
		);
	}
	runtime.setSecret(jwt);
	const login = await client.vaultLogin(
		{ identity: inputs.vaultJwtIdentity, jwt },
		inputs.timeoutMs
	);
	runtime.setSecret(login.token);
	return login.token;
}

/**
 * Log in with the configured machine identity, fetch each listed value from
 * `/api/vault/agent/export`, and export it as a masked environment variable.
 * Returns the exported variable names (never values). The short-lived token is
 * revoked afterwards on a best-effort basis.
 */
export async function exportVaultSecrets(
	client: RyuNodeClient,
	inputs: ActionInputs,
	runtime: ActionRuntime
): Promise<string[]> {
	if (inputs.secrets.length === 0) {
		return [];
	}
	const token = await vaultToken(client, inputs, runtime);
	try {
		const resolved: Array<{ name: string; value: string }> = [];
		const missing: string[] = [];
		for (const group of groupVaultRefs(inputs.secrets)) {
			const values = await client.vaultExport(
				token,
				{
					environment: group.environment,
					names: group.refs.map((ref) => ref.name),
					path: group.path,
				},
				inputs.timeoutMs
			);
			for (const ref of group.refs) {
				const value = values[ref.name];
				if (value === undefined) {
					missing.push(ref.reference);
				} else {
					resolved.push({ name: ref.name, value });
				}
			}
		}
		if (missing.length > 0) {
			throw new Error(
				`The vault token cannot read: ${missing.join(", ")}. Check the names and the machine identity's policies (agent routes read node-scoped values).`
			);
		}
		// Mask everything before exporting anything.
		for (const { value } of resolved) {
			maskValue(runtime, value);
		}
		for (const { name, value } of resolved) {
			runtime.exportVariable(name, value);
		}
		runtime.info(
			`Exported ${resolved.length} vault secret(s) as masked variables.`
		);
		return resolved.map(({ name }) => name);
	} finally {
		try {
			await client.vaultRevoke(token, inputs.timeoutMs);
		} catch (error) {
			runtime.warning(
				`Could not revoke the vault token: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
}
