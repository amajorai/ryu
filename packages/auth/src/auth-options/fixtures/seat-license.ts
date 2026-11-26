import { generateKeyPairSync, sign } from "node:crypto";

/**
 * A vendor-style RS256 license for the seat path tests, signed with a key made
 * for this process. `installSeatLicense` puts it where the env module reads it
 * and must run before that module is first imported.
 */
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
});

function encode(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** A signed license for `organizationId` that states `seats`. */
export function seatLicense(organizationId: string, seats: number): string {
	const input = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
		aud: "ryu-enterprise",
		capabilities: ["enterprise.scim"],
		organizationId,
		plan: "enterprise",
		seats,
	})}`;
	const signature = sign("RSA-SHA256", Buffer.from(input), privateKey).toString(
		"base64url"
	);
	return `${input}.${signature}`;
}

/** Configure the process env with a license for `organizationId`. */
export function installSeatLicense(
	organizationId: string,
	seats: number
): void {
	process.env.RYU_ENTERPRISE_LICENSE = seatLicense(organizationId, seats);
	process.env.RYU_ENTERPRISE_LICENSE_PUBLIC_KEY = publicKey
		.export({ type: "spki", format: "pem" })
		.toString();
}
