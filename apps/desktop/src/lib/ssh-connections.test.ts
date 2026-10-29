import { beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	loadSshConnections,
	normalizeSshConnection,
	SSH_CONNECTIONS_STORAGE_KEY,
	saveSshConnections,
} from "./ssh-connections.ts";

if (!globalThis.document) {
	GlobalRegistrator.register();
}

beforeEach(() => {
	localStorage.removeItem(SSH_CONNECTIONS_STORAGE_KEY);
});

describe("SSH connection profiles", () => {
	test("round-trips connection metadata without private-key contents", () => {
		const connections = [
			{
				auth: "identity" as const,
				host: "server.example.com",
				identityFile: "~/.ssh/id_ed25519",
				id: "server-1",
				name: "Build server",
				port: 2222,
				username: "deploy",
			},
		];

		saveSshConnections(connections);

		expect(loadSshConnections()).toEqual(connections);
		expect(localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY)).not.toContain(
			"PRIVATE KEY"
		);
	});

	test("drops malformed records and duplicate ids", () => {
		localStorage.setItem(
			SSH_CONNECTIONS_STORAGE_KEY,
			JSON.stringify([
				{
					auth: "none",
					host: "host.example.com",
					id: "same",
					name: "First",
					port: 22,
					username: "user",
				},
				{
					host: "host.example.com",
					id: "same",
					name: "Duplicate",
					port: 22,
					username: "user",
				},
				{
					host: "bad host",
					name: "Invalid",
					port: 22,
				},
			])
		);

		expect(loadSshConnections()).toHaveLength(1);
		expect(loadSshConnections()[0]?.name).toBe("First");
	});
});

test("stored profiles preserve legacy coercion, trimming, optional usernames and paths", () => {
	const base = {
		name: " Work server ",
		host: " [::1] ",
		id: " stable-id ",
		port: "22",
		auth: "future-auth",
		identityFile: " ~/.ssh/identity ",
		future: "retained only in storage",
	};
	expect(normalizeSshConnection(base)).toEqual({
		name: "Work server",
		host: "[::1]",
		id: "stable-id",
		port: 22,
		auth: "none",
		username: "",
		identityFile: "~/.ssh/identity",
	});
	for (const port of [true, "1", [22], 65_535]) {
		expect(normalizeSshConnection({ ...base, port })?.port).toBe(Number(port));
	}
	for (const invalid of [
		{ ...base, host: "-host; command" },
		{ ...base, name: "server\u0000" },
		{ ...base, username: "user name" },
		{ ...base, port: 0 },
		{ ...base, port: 65_536 },
		{ ...base, port: 22.5 },
		{ ...base, port: "not-a-port" },
	]) {
		expect(normalizeSshConnection(invalid)).toBeNull();
	}
	expect(
		normalizeSshConnection({ ...base, identityFile: "path\u007f" })
			?.identityFile
	).toBeUndefined();
	expect(normalizeSshConnection({ ...base, id: "invalid id" })?.id).toMatch(
		/^[a-f0-9-]{36}$|^ssh-\d+-\d+$/
	);
});

test("a blank or whitespace-only username means no username and survives a save and reload", () => {
	const plain = {
		auth: "none" as const,
		host: "plain.example.test",
		id: "plain-host",
		name: "Plain host",
		port: 22,
	};
	for (const username of ["", "   ", "\t "]) {
		expect(normalizeSshConnection({ ...plain, username })).toEqual({
			...plain,
			username: "",
		});
	}
	// Blank is the only new "absent" form: malformed usernames are still refused.
	for (const username of ["user name", "ops\u0000", "\u0000", 42, null]) {
		expect(normalizeSshConnection({ ...plain, username })).toBeNull();
	}

	const keyed = {
		auth: "identity" as const,
		host: "keys.example.test",
		id: "keys-host",
		identityFile: "~/.ssh/id_ed25519",
		name: "Key host",
		port: 2222,
		username: "ops",
	};
	saveSshConnections([{ ...plain, username: "" }, keyed]);
	expect(loadSshConnections()).toEqual([{ ...plain, username: "" }, keyed]);

	localStorage.setItem(
		SSH_CONNECTIONS_STORAGE_KEY,
		JSON.stringify([{ ...plain, username: "  " }])
	);
	expect(loadSshConnections()).toEqual([{ ...plain, username: "" }]);
});
