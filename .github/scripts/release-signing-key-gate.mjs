#!/usr/bin/env node
// .github/scripts/release-signing-key-gate.mjs
//
// The release workflow's "Release signing public key must be set" step.
//
// Core's self-update and Desktop's runtime install check the publisher's
// signature over a release's SHA256SUMS only when a public key is compiled in:
// the build-time RYU_RELEASE_SIGNING_PUBKEY value, else the key file
// apps/core/src/update/release_signing.pub. With neither, that check is off.
// `promote` makes what this workflow builds the stable release, so the
// `desktop` and `build` jobs run this right after checkout and stop while there
// is no key. It needs no private key.
//
// The key is read the way those builds read it: a variable that is not blank is
// used as it is and never falls back to the key file; `#` lines and PEM armour
// are dropped; the rest is base64 of an Ed25519 SubjectPublicKeyInfo or of the
// raw 32 bytes.
//
// Passing this gate does not sign anything. A build that carries the key
// refuses every update until the release also holds SHA256SUMS and
// SHA256SUMS.sig made with the matching private key, which this repository
// does not hold.
//
// Environment: RYU_RELEASE_SIGNING_PUBKEY (the repository variable; may be
// empty). Run from the repository root.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const KEY_FILE = "apps/core/src/update/release_signing.pub";
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export const EMPTY_KEY_MESSAGE =
	"No release signing public key for this build. Set the repository variable " +
	"RYU_RELEASE_SIGNING_PUBKEY (Settings, Secrets and variables, Actions, " +
	"Variables) to the PEM public key that verifies the release's " +
	"SHA256SUMS.sig. Core and Desktop built without it skip the signed " +
	"SHA256SUMS check on update, so this workflow does not build them.";

export const VALUE_WITHOUT_KEY_MESSAGE =
	"RYU_RELEASE_SIGNING_PUBKEY is set but holds no key (only comment lines or " +
	"PEM armour). Core and Desktop take the variable whenever it is not blank " +
	`and do not fall back to ${KEY_FILE}, so this build would compile in no ` +
	"key. Put the whole PEM public key in the variable, or clear it to use the " +
	"key file.";

/**
 * The raw 32-byte Ed25519 key in `text`, or null for blank or comment-only
 * text. Throws on anything else that is not a key, like the Rust parser.
 */
export function parseReleaseKey(text) {
	const body = String(text ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(
			(line) => line && !line.startsWith("#") && !line.startsWith("-----")
		)
		.join("");
	if (!body) {
		return null;
	}
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length % 4 !== 0) {
		throw new Error("is not base64");
	}
	const der = Buffer.from(body, "base64");
	const hasPrefix =
		der.length === SPKI_PREFIX.length + 32 &&
		der.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX);
	const raw = hasPrefix ? der.subarray(SPKI_PREFIX.length) : der;
	if (raw.length !== 32) {
		throw new Error("is not an Ed25519 public key");
	}
	return raw;
}

function parseNamed(name, text, errors) {
	try {
		return parseReleaseKey(text);
	} catch (error) {
		errors.push(`${name} ${error.message}`);
		return null;
	}
}

/**
 * Decide whether Core and Desktop may be built. `buildValue` is the repository
 * variable, `keyFileText` the key file's text. Returns the key the build would
 * compile in and every error found.
 */
export function hubReleaseKeyGate({ buildValue, keyFileText }) {
	const errors = [];
	const fromBuild = parseNamed(
		"RYU_RELEASE_SIGNING_PUBKEY",
		buildValue,
		errors
	);
	const fromFile = parseNamed(KEY_FILE, keyFileText, errors);
	if (errors.length) {
		return { key: null, errors };
	}
	if (!fromBuild && String(buildValue ?? "").trim()) {
		return { key: null, errors: [VALUE_WITHOUT_KEY_MESSAGE] };
	}
	const key = fromBuild ?? fromFile;
	if (!key) {
		return { key: null, errors: [EMPTY_KEY_MESSAGE] };
	}
	if (fromBuild && fromFile && !fromBuild.equals(fromFile)) {
		return {
			key: null,
			errors: [
				`RYU_RELEASE_SIGNING_PUBKEY differs from the key in ${KEY_FILE}; clients would trust a key the release is not signed with.`,
			],
		};
	}
	return { key, errors };
}

/** Short fingerprint for the log: SHA-256 of the raw key, first 16 hex digits. */
export function fingerprint(key) {
	return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function fail(errors) {
	for (const error of errors) {
		console.error(`::error::release signing key gate - ${error}`);
	}
	process.exit(1);
}

function main() {
	if (!existsSync(KEY_FILE)) {
		// Every tree this gate ships in carries the key file, so its absence
		// means the wrong checkout or working directory. Never a pass.
		fail([`${KEY_FILE} is missing from this checkout.`]);
	}
	const result = hubReleaseKeyGate({
		buildValue: process.env.RYU_RELEASE_SIGNING_PUBKEY ?? "",
		keyFileText: readFileSync(KEY_FILE, "utf8"),
	});
	if (result.errors.length) {
		fail(result.errors);
	}
	console.log(
		`release signing key present (sha256 ${fingerprint(result.key)}). Core and Desktop built here require a signed SHA256SUMS on every release they update to.`
	);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main();
}
