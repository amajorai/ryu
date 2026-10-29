// Type-level assertions for `ryu.box`'s resource namespaces and their
// object-mode projections. `expectTypeOf` is checked by `tsc --noEmit`
// (check-types); at runtime it is a no-op.

import { describe, expect, expectTypeOf, test } from "bun:test";
import type {
	BoxAPI,
	BoxEvent,
	BoxFileEntry,
	BoxProcess,
	BoxPromptRun,
	BoxSnapshot,
	BoxStreamEvent,
	BoxUsage,
} from "@ryuhq/client";
import type { RyuResult } from "../result.ts";
import { Ryu } from "../ryu.ts";
import type {
	BOX_CANONICAL_METHODS,
	BoxEventsNamespace,
	BoxFilesNamespace,
	BoxPreviewsNamespace,
	BoxProcessesNamespace,
	BoxPromptsNamespace,
	BoxRun,
	BoxSecretsNamespace,
	BoxSnapshotsNamespace,
} from "./namespace.ts";

type CanonicalTable = typeof BOX_CANONICAL_METHODS;

/** What the runtime table says `ryu.box.<group>` holds: each verb typed as the BoxAPI method it calls. */
type FromTable<Group extends string> = {
	-readonly [Path in keyof CanonicalTable as Path extends `${Group}.${infer Verb}`
		? Verb
		: never]: BoxAPI[CanonicalTable[Path]];
};

/** A namespace interface's named members (a mapped type drops the call signature). */
type Members<Namespace> = { [Key in keyof Namespace]: Namespace[Key] };

describe("ryu.box resource namespaces", () => {
	const throwing = new Ryu({ env: {} });
	const objects = new Ryu({ env: {}, result: "object" });

	test("each namespace interface matches the runtime table, key for key and type for type", () => {
		expectTypeOf<Members<BoxEventsNamespace>>().toEqualTypeOf<
			FromTable<"events">
		>();
		expectTypeOf<Members<BoxFilesNamespace>>().toEqualTypeOf<
			FromTable<"files">
		>();
		expectTypeOf<Members<BoxPreviewsNamespace>>().toEqualTypeOf<
			FromTable<"previews">
		>();
		expectTypeOf<Members<BoxProcessesNamespace>>().toEqualTypeOf<
			FromTable<"processes">
		>();
		expectTypeOf<Members<BoxPromptsNamespace>>().toEqualTypeOf<
			FromTable<"prompts">
		>();
		expectTypeOf<Members<BoxSecretsNamespace>>().toEqualTypeOf<
			FromTable<"secrets">
		>();
		expectTypeOf<Members<BoxSnapshotsNamespace>>().toEqualTypeOf<
			FromTable<"snapshots">
		>();
		expectTypeOf(throwing.box.files.read).returns.toEqualTypeOf<
			Promise<Uint8Array>
		>();
		expect(throwing.resultMode).toBe("throw");
	});

	test("canonical methods keep the BoxAPI signatures in throw mode", () => {
		expectTypeOf(throwing.box.files.readText).parameters.toEqualTypeOf<
			Parameters<BoxAPI["readTextFile"]>
		>();
		expectTypeOf(throwing.box.files.list).returns.toEqualTypeOf<
			Promise<BoxFileEntry[]>
		>();
		expectTypeOf(throwing.box.processes.list).returns.toEqualTypeOf<
			Promise<BoxProcess[]>
		>();
		expectTypeOf(throwing.box.processes.followLogs).returns.toEqualTypeOf<
			AsyncGenerator<BoxStreamEvent>
		>();
		expectTypeOf(throwing.box.snapshots.create).parameters.toEqualTypeOf<
			Parameters<BoxAPI["snapshot"]>
		>();
		expectTypeOf(throwing.box.secrets.set).parameters.toEqualTypeOf<
			Parameters<BoxAPI["putSecret"]>
		>();
		expectTypeOf(throwing.box.prompts.cancel).returns.toEqualTypeOf<
			Promise<BoxPromptRun>
		>();
		expectTypeOf(throwing.box.events.follow).returns.toEqualTypeOf<
			AsyncGenerator<BoxEvent>
		>();
		expectTypeOf(throwing.box.usage).returns.toEqualTypeOf<Promise<BoxUsage>>();
		expect(throwing.resultMode).toBe("throw");
	});

	test("deprecated flat aliases have the same types as their canonical form", () => {
		expectTypeOf(throwing.box.readTextFile).toEqualTypeOf(
			throwing.box.files.readText
		);
		expectTypeOf(throwing.box.listSnapshots).toEqualTypeOf(
			throwing.box.snapshots.list
		);
		expectTypeOf(throwing.box.spawn).toEqualTypeOf(
			throwing.box.processes.spawn
		);
		expectTypeOf(throwing.box.processes).parameters.toEqualTypeOf<
			Parameters<BoxAPI["processes"]>
		>();
		expectTypeOf(throwing.box.prompts).returns.toEqualTypeOf<
			Promise<BoxPromptRun[]>
		>();
	});

	test("object mode and ryu.safe project every sub-namespace, callable ones included", () => {
		expectTypeOf(objects.box.files.readText).returns.toEqualTypeOf<
			Promise<RyuResult<string>>
		>();
		expectTypeOf(objects.box.snapshots.get).returns.toEqualTypeOf<
			Promise<RyuResult<BoxSnapshot>>
		>();
		expectTypeOf(objects.box.secrets.delete).returns.toEqualTypeOf<
			Promise<RyuResult<void>>
		>();
		expectTypeOf(objects.box.previews.list).parameters.toEqualTypeOf<
			Parameters<BoxAPI["listPreviews"]>
		>();
		expectTypeOf(objects.box.processes.list).returns.toEqualTypeOf<
			Promise<RyuResult<BoxProcess[]>>
		>();
		expectTypeOf(objects.box.processes).returns.toEqualTypeOf<
			Promise<RyuResult<BoxProcess[]>>
		>();
		expectTypeOf(objects.box.prompts.get).returns.toEqualTypeOf<
			Promise<RyuResult<BoxPromptRun>>
		>();
		expectTypeOf(objects.box.events.follow).returns.toEqualTypeOf<
			AsyncGenerator<BoxEvent>
		>();
		expectTypeOf(objects.box.execStream).returns.toEqualTypeOf<
			AsyncGenerator<BoxStreamEvent>
		>();
		expectTypeOf(objects.box.run).returns.toEqualTypeOf<
			Promise<RyuResult<BoxRun>>
		>();
		expectTypeOf(throwing.safe.box.files.write).returns.toEqualTypeOf<
			Promise<RyuResult<void>>
		>();
		expectTypeOf(throwing.safe.box.processes.kill).returns.toEqualTypeOf<
			Promise<RyuResult<BoxProcess>>
		>();
		expectTypeOf(objects.box.with({}).snapshots.list).returns.toEqualTypeOf<
			Promise<RyuResult<BoxSnapshot[]>>
		>();
		expect(objects.resultMode).toBe("object");
	});
});
