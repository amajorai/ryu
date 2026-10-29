import { expect, test } from "bun:test";
import { appBackupResponseSchema } from "./backup-records.ts";

test("app backup replies validate full catalog/operation records without cloning snapshots", () => {
	const scope = {
		appId: "notes",
		kind: "app",
		namespace: "drafts",
		tenant: "server-derived",
	};
	const backup = {
		bytes: 20,
		createdAt: "2026-10-06T00:00:00Z",
		id: "backup",
		objectKey: "snapshots/backup",
		scope,
		sha256: "digest",
		sourceNodeId: "node",
		version: 1,
	};
	const operation = {
		action: "create",
		backup,
		completedAt: null,
		createdAt: "2026-10-06T00:00:00Z",
		destinationId: "destination",
		error: null,
		id: "operation",
		result: { future: ["metadata", null] },
		scope,
		status: "future_status",
	};
	const destinations = [{ id: "destination", name: "Shared backup" }];
	const records = [backup];
	expect(
		appBackupResponseSchema("backups.destinations").parse(destinations)
	).toBe(destinations);
	expect(appBackupResponseSchema("backups.create").parse(operation)).toBe(
		operation
	);
	expect(appBackupResponseSchema("backups.get").parse(operation)).toBe(
		operation
	);
	expect(appBackupResponseSchema("backups.list").parse(records)).toBe(records);
	expect(
		appBackupResponseSchema("backups.create").safeParse({ id: "incomplete" })
			.success
	).toBe(false);
	expect(
		appBackupResponseSchema("backups.list").safeParse([
			{ ...backup, bytes: "20" },
		]).success
	).toBe(false);
});

test("restored app snapshots may be any JSON value and retain their original identity", () => {
	for (const snapshot of [null, true, 3, "draft", [1, { draft: "text" }]]) {
		expect(appBackupResponseSchema("backups.restore").parse(snapshot)).toBe(
			snapshot
		);
	}
	expect(
		appBackupResponseSchema("backups.restore").safeParse({
			callback: () => null,
		}).success
	).toBe(false);
});
