import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// The updater pubkey baked into `tauri.conf.json` MUST be the public half of the
// minisign key that CI signs releases with (`TAURI_SIGNING_PRIVATE_KEY` on the
// PUBLIC repo, whose public half is committed as `.tauri/ryu-updater.key.pub`).
//
// This drifted once and broke auto-update for every user across v0.1.5 → v0.1.12:
// somebody ran `tauri signer generate` locally, pasted the new public key into the
// conf, and set the PRIVATE repo's secret — while the public repo (the one that
// actually builds and publishes the release assets) kept signing with the original
// key. Every shipped `.sig` then failed verification with
// "the signature was created with a different key than the one provided", and
// because the private half of the pasted key never left that laptop the mismatch
// could only ever be fixed forward.
//
// A mismatch here is unrecoverable in the field — clients verify with the key baked
// into the build they already installed — so it has to fail before the release, not
// after.
const DESKTOP_ROOT = join(import.meta.dir, "..");

describe("updater signing key", () => {
	it("conf pubkey is the committed public half of the CI signing key", () => {
		const conf = z
			.object({
				plugins: z.object({ updater: z.object({ pubkey: z.string() }) }),
			})
			.parse(
				JSON.parse(
					readFileSync(join(DESKTOP_ROOT, "src-tauri/tauri.conf.json"), "utf8")
				)
			);
		const committed = readFileSync(
			join(DESKTOP_ROOT, ".tauri/ryu-updater.key.pub"),
			"utf8"
		).trim();

		expect(conf.plugins.updater.pubkey).toBe(committed);
	});

	it("that key is the minisign key id releases are signed with", () => {
		const committed = readFileSync(
			join(DESKTOP_ROOT, ".tauri/ryu-updater.key.pub"),
			"utf8"
		).trim();
		// minisign public key file: comment line, then base64 of
		// <2-byte alg><8-byte little-endian key id><32-byte ed25519 key>.
		const [, keyLine] = Buffer.from(committed, "base64")
			.toString("utf8")
			.split("\n");
		const keyId = Buffer.from(keyLine, "base64")
			.subarray(2, 10)
			.reverse()
			.toString("hex")
			.toUpperCase();

		expect(keyId).toBe("7750BF04445B1201");
	});
});
