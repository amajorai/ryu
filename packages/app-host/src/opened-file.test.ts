import { expect, test } from "bun:test";
import {
	assertOpenedFileUri,
	type OpenedFileAccess,
	type OpenedFileSnapshot,
} from "./opened-file.ts";
import type { RouteClaim } from "./rpc.ts";
import {
	type Capability,
	CapabilityError,
	capabilitiesFromGrants,
	dispatchRpc,
	GRANT_CAPABILITY,
	type HostServices,
} from "./rpc.ts";

const snapshot = { uri: "file:selected", text: "content", revision: "1" };
const services: HostServices = {
	listAgents: async () => [],
	registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
	readOpenedFile: async () => snapshot,
};

test("selected file RPC is denied without host mount capability", async () => {
	await expect(
		dispatchRpc("files.read", [{ uri: snapshot.uri }], new Set(), services)
	).rejects.toThrow();
});

test("read-only selected file rejects writes and validates input", async () => {
	await expect(
		dispatchRpc(
			"files.read",
			[{ uri: snapshot.uri }],
			new Set(["file.access"]),
			services
		)
	).resolves.toEqual(snapshot);
	await expect(
		dispatchRpc(
			"files.write",
			[{ uri: snapshot.uri, text: "new", expectedRevision: "1" }],
			new Set(["file.access"]),
			services
		)
	).rejects.toThrow("read-only");
	await expect(
		dispatchRpc(
			"files.write",
			[{ uri: snapshot.uri }],
			new Set(["file.access"]),
			services
		)
	).rejects.toThrow("Saving requires");
});

test("manifest approvals cannot authorize selected-file reads or writes without a host mount", async () => {
	let effects = 0;
	const guardedServices: HostServices = {
		listAgents: async () => [],
		registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
		readOpenedFile: async () => {
			effects += 1;
			return snapshot;
		},
		writeOpenedFile: async () => {
			effects += 1;
			return snapshot;
		},
	};
	const capabilities = capabilitiesFromGrants([
		...Object.keys(GRANT_CAPABILITY),
		"file.access",
		"files:read",
		"files:write",
	]);
	expect(capabilities.has("file.access")).toBe(false);
	for (const method of ["files.read", "files.write"]) {
		await expect(
			dispatchRpc(
				method,
				[{ uri: snapshot.uri, text: "unapproved", expectedRevision: "1" }],
				capabilities,
				guardedServices
			)
		).rejects.toBeInstanceOf(CapabilityError);
	}
	expect(effects).toBe(0);
	await expect(
		dispatchRpc(
			"files.read",
			[{ uri: snapshot.uri }],
			new Set(["file.access"]),
			{
				listAgents: async () => [],
				registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
			}
		)
	).rejects.toMatchObject({
		code: "denied",
		message: "No file is open in this panel",
	});
	expect(effects).toBe(0);
});

test("host-opened file dispatch rejects foreign URIs and stale writes before explicit retry persists scoped readback", async () => {
	let state: OpenedFileSnapshot = { ...snapshot };
	let reads = 0;
	let writes = 0;
	const access: OpenedFileAccess = {
		uri: snapshot.uri,
		name: "selected.txt",
		editable: true,
		read: async () => {
			reads += 1;
			return { ...state };
		},
		write: async (text, expectedRevision) => {
			writes += 1;
			if (expectedRevision !== state.revision) {
				throw new Error("The opened file revision changed");
			}
			state = { uri: snapshot.uri, text, revision: "2" };
			return { ...state };
		},
	};
	// Match the production PluginHostPanel service boundary: every call validates
	// the opened URI before invoking its host-owned read/write implementation.
	const mountedServices: HostServices = {
		listAgents: async () => [],
		registerRoute: async (claim: RouteClaim) => ({ path: claim.path }),
		readOpenedFile: async ({ uri }) =>
			await assertOpenedFileUri(access, uri).read(),
		writeOpenedFile: async (input) => {
			const opened = assertOpenedFileUri(access, input.uri);
			if (input.text === undefined || !opened.write) {
				throw new Error("This file representation is read-only");
			}
			return await opened.write(input.text, input.expectedRevision);
		},
	};
	const capabilities = new Set<Capability>(["file.access"]);
	await expect(
		dispatchRpc(
			"files.read",
			[{ uri: "file:foreign" }],
			capabilities,
			mountedServices
		)
	).rejects.toThrow("Only the file opened in this panel is available");
	await expect(
		dispatchRpc(
			"files.write",
			[{ uri: "file:foreign", text: "foreign", expectedRevision: "1" }],
			capabilities,
			mountedServices
		)
	).rejects.toThrow("Only the file opened in this panel is available");
	expect({ reads, writes }).toEqual({ reads: 0, writes: 0 });
	expect(
		await dispatchRpc(
			"files.read",
			[{ uri: snapshot.uri }],
			capabilities,
			mountedServices
		)
	).toEqual(snapshot);
	await expect(
		dispatchRpc(
			"files.write",
			[{ uri: snapshot.uri, text: "replacement", expectedRevision: "old" }],
			capabilities,
			mountedServices
		)
	).rejects.toThrow("The opened file revision changed");
	expect(state).toEqual(snapshot);
	expect({ reads, writes }).toEqual({ reads: 1, writes: 1 });
	const expected = { uri: snapshot.uri, text: "replacement", revision: "2" };
	expect(
		await dispatchRpc(
			"files.write",
			[{ uri: snapshot.uri, text: "replacement", expectedRevision: "1" }],
			capabilities,
			mountedServices
		)
	).toEqual(expected);
	expect(
		await dispatchRpc(
			"files.read",
			[{ uri: snapshot.uri }],
			capabilities,
			mountedServices
		)
	).toEqual(expected);
	expect({ reads, writes }).toEqual({ reads: 2, writes: 2 });
});
