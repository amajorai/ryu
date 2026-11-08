import { expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import { vaultTab } from "@/src/pages/VaultPage.model.ts";
import {
	emptySyncTargetForm,
	remotePathHint,
	storeSummary,
	syncStatus,
	syncTargetInput,
} from "./vault-sync-form.ts";

test("each platform builds Core's store body with only its own settings", () => {
	expect(
		syncTargetInput({
			...emptySyncTargetForm("github-actions"),
			name: "acme-ci",
			repository: " acme/app ",
			githubEnvironment: "",
			token: "ghp_x",
		})
	).toEqual({
		input: {
			name: "acme-ci",
			address: undefined,
			kind: "github-actions",
			authMethod: "token",
			repository: "acme/app",
			githubEnvironment: undefined,
			credentials: { token: "ghp_x" },
		},
	});
	const aws = syncTargetInput({
		...emptySyncTargetForm("aws-secrets-manager"),
		name: "aws",
		region: "eu-west-1",
		accessKeyId: "AKID",
		secretAccessKey: "s",
	});
	expect(aws).toMatchObject({
		input: {
			authMethod: "access-key",
			region: "eu-west-1",
			credentials: { accessKeyId: "AKID", secretAccessKey: "s" },
		},
	});
	const gcp = syncTargetInput({
		...emptySyncTargetForm("gcp-secret-manager"),
		name: "gcp",
		projectId: "proj-1",
		serviceAccountKey: '{"type":"service_account"}',
	});
	expect(gcp).toMatchObject({
		input: {
			authMethod: "service-account",
			credentials: { serviceAccountKey: '{"type":"service_account"}' },
		},
	});
	const vercel = syncTargetInput({
		...emptySyncTargetForm("vercel"),
		name: "web",
		projectId: "prj_1",
		token: "t",
		vercelTargets: ["production"],
	});
	expect(vercel).toMatchObject({ input: { vercelTargets: ["production"] } });
});

test("incomplete forms explain the first problem instead of sending", () => {
	const problem = (form: Parameters<typeof syncTargetInput>[0]) =>
		"problem" in syncTargetInput(form);
	expect(problem({ ...emptySyncTargetForm(), name: "Bad Name" })).toBe(true);
	expect(
		problem({
			...emptySyncTargetForm(),
			name: "ok",
			repository: "no-slash",
			token: "t",
		})
	).toBe(true);
	expect(
		problem({
			...emptySyncTargetForm("vercel"),
			name: "ok",
			projectId: "p",
			token: "t",
			vercelTargets: [],
		})
	).toBe(true);
	expect(
		problem({
			...emptySyncTargetForm("gcp-secret-manager"),
			name: "ok",
			projectId: "p",
			gcpAuth: "token",
		})
	).toBe(true);
});

test("summaries, prefix hints and sync status read the store and the last push", () => {
	expect(
		storeSummary({
			kind: "github-actions",
			repository: "acme/app",
			githubEnvironment: "prod",
		} as never)
	).toBe("acme/app · prod");
	expect(remotePathHint("aws-secrets-manager").label).toBe("Secret name");
	expect(remotePathHint("vercel").label).toBe("Name prefix (optional)");
	const tl = (source: string, values?: MessageValuesInput) =>
		formatMessage(source, values ?? {}, "en");
	const base = {
		lastCount: 3,
		lastError: null,
		lastPushAt: null,
		lastStatus: null,
	};
	expect(syncStatus(base as never, tl).tone).toBe("pending");
	expect(
		syncStatus({ ...base, lastPushAt: 1, lastStatus: "ok" } as never, tl).label
	).toBe("3 keys pushed");
	expect(
		syncStatus(
			{ ...base, lastCount: 1, lastPushAt: 1, lastStatus: "ok" } as never,
			tl
		).label
	).toBe("1 key pushed");
	expect(
		syncStatus(
			{
				...base,
				lastPushAt: 1,
				lastStatus: "error",
				lastError: "HTTP 403",
			} as never,
			tl
		)
	).toEqual({ label: "HTTP 403", tone: "error" });
	expect(vaultTab("syncs")).toBe("syncs");
	expect(vaultTab("nope")).toBe("secrets");
});
