// Dynamic-role provider schemas for `ryu secrets dynamic put ROLE FILE`.
//
// These mirror Core's `ProviderConfig` so a typo fails locally with the
// field's name (never its value) before the file reaches Core, which
// validates the configuration again.

import { z } from "zod";

const charsetSchema = z.enum(["alphanumeric", "hex", "base64url", "symbols"]);
const statements = z.array(z.string().min(1));

const sqlFields = {
	connectionUrl: z.string().min(1),
	creationStatements: statements.min(1),
	revocationStatements: statements.optional(),
	usernamePrefix: z.string().optional(),
	usernameTemplate: z.string().min(1).optional(),
};

export const providerSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("postgres"), ...sqlFields }),
	z.strictObject({
		kind: z.enum(["mysql", "mariadb"]),
		...sqlFields,
	}),
	z.strictObject({
		kind: z.literal("mssql"),
		...sqlFields,
		caPem: z.string().min(1).optional(),
	}),
	z.strictObject({
		kind: z.literal("mongodb"),
		connectionUrl: z.string().min(1),
		database: z.string().min(1).optional(),
		usernameTemplate: z.string().min(1).optional(),
		roles: z
			.array(
				z.strictObject({
					role: z.string().min(1),
					db: z.string().min(1).optional(),
				})
			)
			.min(1),
		usernamePrefix: z.string().optional(),
	}),
	z.strictObject({
		kind: z.enum(["redis", "valkey"]),
		connectionUrl: z.string().min(1),
		aclRules: z.array(z.string().min(1)).optional(),
		usernamePrefix: z.string().optional(),
		usernameTemplate: z.string().min(1).optional(),
	}),
	z.strictObject({
		kind: z.literal("aws-sts"),
		accessKeyId: z.string().min(1),
		secretAccessKey: z.string().min(1),
		region: z.string().min(1),
		roleArn: z.string().min(1),
		endpoint: z.string().optional(),
		sessionPolicy: z.string().optional(),
	}),
	z.strictObject({
		kind: z.literal("gcp"),
		credentials: z.string().min(1),
		serviceAccountEmail: z.string().min(1),
		secretType: z.enum(["serviceAccountKey", "accessToken"]).optional(),
		tokenScopes: z.array(z.string().min(1)).optional(),
	}),
	z.strictObject({
		kind: z.literal("azure"),
		tenantId: z.string().min(1),
		clientId: z.string().min(1),
		clientSecret: z.string().min(1),
		applicationObjectId: z.string().min(1),
		environment: z.enum(["public", "usGovernment", "china"]).optional(),
	}),
	z.strictObject({
		kind: z.literal("kubernetes"),
		host: z.string().min(1),
		serviceAccountJwt: z.string().min(1),
		namespace: z.string().min(1),
		caPem: z.string().min(1).optional(),
		serviceAccountName: z.string().min(1).optional(),
		kubernetesRoleName: z.string().min(1).optional(),
		kubernetesRoleType: z.enum(["Role", "ClusterRole"]).optional(),
		clusterRoleBinding: z.boolean().optional(),
		audiences: z.array(z.string().min(1)).optional(),
		usernamePrefix: z.string().optional(),
	}),
	z.strictObject({
		kind: z.literal("kubernetes-rules"),
		host: z.string().min(1),
		serviceAccountJwt: z.string().min(1),
		namespace: z.string().min(1),
		caPem: z.string().min(1).optional(),
		rules: z
			.array(
				z.strictObject({
					apiGroups: z.array(z.string()).optional(),
					resources: z.array(z.string().min(1)).optional(),
					resourceNames: z.array(z.string().min(1)).optional(),
					verbs: z.array(z.string().min(1)).min(1),
					nonResourceURLs: z.array(z.string().min(1)).optional(),
				})
			)
			.min(1),
		kubernetesRoleType: z.enum(["Role", "ClusterRole"]).optional(),
		clusterRoleBinding: z.boolean().optional(),
		audiences: z.array(z.string().min(1)).optional(),
		usernamePrefix: z.string().optional(),
	}),
	z.strictObject({
		kind: z.literal("aws-iam"),
		accessKeyId: z.string().min(1),
		secretAccessKey: z.string().min(1),
		policyArns: z.array(z.string().min(1)).optional(),
		policyDocument: z.string().min(1).optional(),
		iamGroups: z.array(z.string().min(1)).optional(),
		permissionsBoundaryArn: z.string().min(1).optional(),
		userPath: z.string().min(1).optional(),
		usernamePrefix: z.string().optional(),
		endpoint: z.string().optional(),
		region: z.string().min(1).optional(),
	}),
	z.strictObject({
		kind: z.literal("rabbitmq"),
		connectionUri: z.string().min(1),
		username: z.string().min(1),
		password: z.string().min(1),
		caPem: z.string().min(1).optional(),
		tags: z.string().optional(),
		vhosts: z.record(
			z.string().min(1),
			z.strictObject({
				configure: z.string().optional(),
				write: z.string().optional(),
				read: z.string().optional(),
			})
		),
		vhostTopics: z
			.record(
				z.string().min(1),
				z.record(
					z.string().min(1),
					z.strictObject({
						write: z.string().optional(),
						read: z.string().optional(),
					})
				)
			)
			.optional(),
		usernamePrefix: z.string().optional(),
	}),
	z.strictObject({
		kind: z.literal("webhook"),
		url: z.string().min(1),
		signingSecret: z.string().min(1),
	}),
	z.strictObject({
		kind: z.literal("random"),
		charset: charsetSchema,
		length: z.number().int().positive(),
		field: z.string().optional(),
	}),
]);
