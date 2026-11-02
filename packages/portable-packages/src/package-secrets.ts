import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	scryptSync,
} from "node:crypto";
import { z } from "zod";
import { nativeJsonSchema } from "./native-json.ts";
import {
	bytesFromString,
	canonicalJson,
	stringFromBytes,
} from "./package-manifest.ts";
import {
	type PackageTree,
	type RyuPackageManifest,
	SECRETS_FILE,
	type SecretEnvelope,
} from "./package-types.ts";

const secretEnvelopeValidation: z.ZodType<SecretEnvelope> = z.object({
	algorithm: z.literal("aes-256-gcm"),
	ciphertext: z.string(),
	kdf: z.literal("scrypt"),
	nonce: z.string(),
	packageId: z.string(),
	packageVersion: z.string(),
	salt: z.string(),
	tag: z.string(),
	version: z.literal(1),
});
const secretEnvelopeSchema = z.custom<SecretEnvelope>(
	(value) => secretEnvelopeValidation.safeParse(value).success
);

const SECRET_PREFIX = "RYU-SECRETS-V1\n";
const SECRET_KEY_BYTES = 32;
const SECRET_NONCE_BYTES = 12;
const SECRET_SALT_BYTES = 16;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SECRET_AAD_PREFIX = "ryu.portable-package.secrets.v1:";

function packageAad(
	manifest: Pick<RyuPackageManifest, "id" | "version">
): Buffer {
	return Buffer.from(
		`${SECRET_AAD_PREFIX}${manifest.id}:${manifest.version}`,
		"utf8"
	);
}

export function encryptSecrets(
	value: z.core.util.JSONType,
	passphrase: string,
	manifest: Pick<RyuPackageManifest, "id" | "version">
): Uint8Array {
	if (!passphrase) {
		throw new Error("A passphrase is required to encrypt package secrets");
	}
	const salt = randomBytes(SECRET_SALT_BYTES);
	const nonce = randomBytes(SECRET_NONCE_BYTES);
	const key = scryptSync(passphrase, salt, SECRET_KEY_BYTES, {
		maxmem: 64 * 1024 * 1024,
		N: SCRYPT_N,
		p: SCRYPT_P,
		r: SCRYPT_R,
	});
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const aad = packageAad(manifest);
	cipher.setAAD(aad);
	const ciphertext = Buffer.concat([
		cipher.update(JSON.stringify(value), "utf8"),
		cipher.final(),
	]);
	const envelope: SecretEnvelope = {
		algorithm: "aes-256-gcm",
		ciphertext: ciphertext.toString("base64url"),
		kdf: "scrypt",
		nonce: nonce.toString("base64url"),
		packageId: manifest.id,
		packageVersion: manifest.version,
		salt: salt.toString("base64url"),
		tag: cipher.getAuthTag().toString("base64url"),
		version: 1,
	};
	return bytesFromString(`${SECRET_PREFIX}${canonicalJson(envelope)}\n`);
}

export function decryptSecrets(
	data: Uint8Array,
	passphrase: string,
	manifest: Pick<RyuPackageManifest, "id" | "version">
): z.core.util.JSONType {
	if (!passphrase) {
		throw new Error("A passphrase is required to decrypt package secrets");
	}
	const raw = stringFromBytes(data);
	if (!raw.startsWith(SECRET_PREFIX)) {
		throw new Error("Unsupported package secret envelope");
	}
	const remainder = raw.slice(SECRET_PREFIX.length).trim();
	let payload: z.core.util.JSONType;
	try {
		payload = nativeJsonSchema.parse(JSON.parse(remainder));
	} catch {
		throw new Error("Malformed package secret envelope");
	}
	const binding = z.object({
		version: z.literal(1),
		algorithm: z.literal("aes-256-gcm"),
		kdf: z.literal("scrypt"),
		packageId: z.literal(manifest.id),
		packageVersion: z.literal(manifest.version),
	});
	if (!binding.safeParse(payload).success) {
		throw new Error(
			"Package secret envelope does not match the package manifest"
		);
	}
	let envelope: SecretEnvelope;
	try {
		envelope = secretEnvelopeSchema.parse(payload);
	} catch {
		throw new Error("Malformed package secret envelope");
	}
	const salt = Buffer.from(envelope.salt, "base64url");
	const nonce = Buffer.from(envelope.nonce, "base64url");
	const tag = Buffer.from(envelope.tag, "base64url");
	const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
	const key = scryptSync(passphrase, salt, SECRET_KEY_BYTES, {
		maxmem: 64 * 1024 * 1024,
		N: SCRYPT_N,
		p: SCRYPT_P,
		r: SCRYPT_R,
	});
	const decipher = createDecipheriv("aes-256-gcm", key, nonce);
	decipher.setAAD(packageAad(manifest));
	decipher.setAuthTag(tag);
	try {
		const plaintext = Buffer.concat([
			decipher.update(ciphertext),
			decipher.final(),
		]).toString("utf8");
		return nativeJsonSchema.parse(JSON.parse(plaintext));
	} catch {
		throw new Error(
			"Unable to decrypt package secrets: the unlock key is incorrect"
		);
	}
}

export function hasEncryptedSecrets(tree: PackageTree): boolean {
	return SECRETS_FILE in tree.files;
}

export function withEncryptedSecrets(
	tree: PackageTree,
	value: z.core.util.JSONType,
	passphrase: string
): PackageTree {
	return {
		files: {
			...tree.files,
			[SECRETS_FILE]: encryptSecrets(value, passphrase, tree.manifest),
		},
		manifest: {
			...tree.manifest,
			security: {
				...tree.manifest.security,
				containsSecrets: true,
				privateContent: true,
				redacted: false,
			},
		},
	};
}
