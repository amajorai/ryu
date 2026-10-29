// followCollaborationAccount: which account Yjs snapshots belong to, and when
// the legacy plaintext snapshots are sealed under it.

import { beforeEach, describe, expect, mock, test } from "bun:test";

const swept: Array<string | null | undefined> = [];
const accounts: Array<string | null> = [];
const released: Array<string | null> = [];
let keptOnRelease = 0;

mock.module("./yjs-persistence.ts", () => ({
	migrateLegacyYjsSnapshots: (account?: string | null) => {
		swept.push(account);
		return Promise.resolve(0);
	},
	setCollaborationAccount: (account: string | null) => {
		accounts.push(account);
	},
}));
mock.module("./yjs-provider.ts", () => ({
	releaseCollaborationAccount: (account: string | null) => {
		released.push(account);
		return Promise.resolve({ cleared: 0, kept: keptOnRelease });
	},
}));
mock.module("@ryu/ui/components/sileo.tsx", () => ({
	toast: { warning: () => undefined },
}));

const { followCollaborationAccount } = await import(
	"./collaboration-account.ts"
);

const flush = () => new Promise((done) => setTimeout(done, 0));

function start(initial: string | null) {
	let active = initial;
	let notify: () => void = () => undefined;
	const reported: number[] = [];
	const ready = followCollaborationAccount(
		{
			getActiveCollaborationAccountId: () => active,
			onActiveTokenChange: (listener) => {
				notify = listener;
			},
			vaultHydrated: Promise.resolve(),
		},
		(kept) => reported.push(kept)
	);
	return {
		ready,
		reported,
		change(next: string | null) {
			active = next;
			notify();
		},
	};
}

describe("followCollaborationAccount", () => {
	beforeEach(() => {
		swept.length = 0;
		accounts.length = 0;
		released.length = 0;
		keptOnRelease = 0;
	});

	test("seals legacy snapshots under the signed-in account at startup", async () => {
		await start("user-a").ready;
		expect(accounts).toEqual(["user-a"]);
		expect(swept).toEqual(["user-a"]);
	});

	test("does not sweep while nobody is signed in, then sweeps for the first account", async () => {
		const run = start(null);
		await run.ready;
		expect(swept).toEqual([]);

		keptOnRelease = 2;
		run.change("user-a");
		await flush();
		expect(accounts).toEqual([null, "user-a"]);
		expect(swept).toEqual(["user-a"]);
		// Releasing the signed-out (anonymous) segment is not "that account".
		expect(released).toEqual([null]);
		expect(run.reported).toEqual([]);
	});

	test("sweeps once, and tells the user about a previous account's kept edits", async () => {
		const run = start("user-a");
		await run.ready;
		keptOnRelease = 1;
		run.change("user-b");
		await flush();
		expect(swept).toEqual(["user-a"]);
		expect(released).toEqual(["user-a"]);
		expect(run.reported).toEqual([1]);
	});

	test("never uses a placeholder account (null) as the account, and waits for the real id", async () => {
		const run = start(null);
		await run.ready;
		// Still a placeholder: the change event reports no real account.
		run.change(null);
		await flush();
		expect(swept).toEqual([]);
		expect(released).toEqual([]);

		run.change("real-user");
		await flush();
		expect(accounts).toEqual([null, "real-user"]);
		expect(swept).toEqual(["real-user"]);
		expect(run.reported).toEqual([]);
	});
});
