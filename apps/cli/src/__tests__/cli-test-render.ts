import {
	createTestRenderer,
	type TestRendererOptions,
} from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { act, type ReactNode } from "react";

type TestSetup = Awaited<ReturnType<typeof createTestRenderer>>;
interface ReactActEnvironment {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
}
const actEnvironment: typeof globalThis & ReactActEnvironment = globalThis;

function setActEnvironment(enabled: boolean): void {
	actEnvironment.IS_REACT_ACT_ENVIRONMENT = enabled;
}

/** Render a CLI surface with React updates flushed inside OpenTUI's test act scope. */
export async function testRender(
	node: ReactNode,
	options: TestRendererOptions = {}
): Promise<TestSetup> {
	setActEnvironment(true);
	const setup = await createTestRenderer(options);
	const mountedRoot = createRoot(setup.renderer);
	let root: ReturnType<typeof createRoot> | null = mountedRoot;
	await act(async () => {
		mountedRoot.render(node);
		await new Promise((resolve) => setTimeout(resolve, 0));
		await setup.renderOnce();
	});

	const renderOnce = setup.renderOnce.bind(setup);
	setup.renderOnce = async () => {
		await act(async () => {
			await renderOnce();
		});
	};

	const flush = setup.flush.bind(setup);
	setup.flush = async (options) => {
		await act(async () => {
			await flush(options);
		});
	};

	const waitFor = setup.waitFor.bind(setup);
	setup.waitFor = async (predicate, options) => {
		await act(async () => {
			await waitFor(predicate, options);
		});
	};

	const waitForFrame = setup.waitForFrame.bind(setup);
	setup.waitForFrame = async (predicate, options) => {
		let frame = "";
		await act(async () => {
			frame = await waitForFrame(predicate, options);
		});
		return frame;
	};

	const waitForVisualIdle = setup.waitForVisualIdle.bind(setup);
	setup.waitForVisualIdle = async (options) => {
		await act(async () => {
			await waitForVisualIdle(options);
		});
	};

	const pressKeys = setup.mockInput.pressKeys.bind(setup.mockInput);
	setup.mockInput.pressKeys = async (...args) => {
		await act(async () => {
			await pressKeys(...args);
		});
	};
	const typeText = setup.mockInput.typeText.bind(setup.mockInput);
	setup.mockInput.typeText = async (...args) => {
		await act(async () => {
			await typeText(...args);
		});
	};
	const pasteBracketedText = setup.mockInput.pasteBracketedText.bind(
		setup.mockInput
	);
	setup.mockInput.pasteBracketedText = async (...args) => {
		await act(async () => {
			await pasteBracketedText(...args);
		});
	};
	const pressKey = setup.mockInput.pressKey.bind(setup.mockInput);
	setup.mockInput.pressKey = (...args) => {
		act(() => {
			pressKey(...args);
		});
	};
	const pressEnter = setup.mockInput.pressEnter.bind(setup.mockInput);
	setup.mockInput.pressEnter = (...args) => {
		act(() => {
			pressEnter(...args);
		});
	};
	const pressEscape = setup.mockInput.pressEscape.bind(setup.mockInput);
	setup.mockInput.pressEscape = (...args) => {
		act(() => {
			pressEscape(...args);
		});
	};
	const pressTab = setup.mockInput.pressTab.bind(setup.mockInput);
	setup.mockInput.pressTab = (...args) => {
		act(() => {
			pressTab(...args);
		});
	};
	const pressBackspace = setup.mockInput.pressBackspace.bind(setup.mockInput);
	setup.mockInput.pressBackspace = (...args) => {
		act(() => {
			pressBackspace(...args);
		});
	};
	const pressArrow = setup.mockInput.pressArrow.bind(setup.mockInput);
	setup.mockInput.pressArrow = (...args) => {
		act(() => {
			pressArrow(...args);
		});
	};
	const pressCtrlC = setup.mockInput.pressCtrlC.bind(setup.mockInput);
	setup.mockInput.pressCtrlC = (...args) => {
		act(() => {
			pressCtrlC(...args);
		});
	};
	const moveTo = setup.mockMouse.moveTo.bind(setup.mockMouse);
	setup.mockMouse.moveTo = async (...args) => {
		await act(async () => {
			await moveTo(...args);
		});
	};
	const click = setup.mockMouse.click.bind(setup.mockMouse);
	setup.mockMouse.click = async (...args) => {
		await act(async () => {
			await click(...args);
		});
	};
	const doubleClick = setup.mockMouse.doubleClick.bind(setup.mockMouse);
	setup.mockMouse.doubleClick = async (...args) => {
		await act(async () => {
			await doubleClick(...args);
		});
	};
	const pressDown = setup.mockMouse.pressDown.bind(setup.mockMouse);
	setup.mockMouse.pressDown = async (...args) => {
		await act(async () => {
			await pressDown(...args);
		});
	};
	const release = setup.mockMouse.release.bind(setup.mockMouse);
	setup.mockMouse.release = async (...args) => {
		await act(async () => {
			await release(...args);
		});
	};
	const drag = setup.mockMouse.drag.bind(setup.mockMouse);
	setup.mockMouse.drag = async (...args) => {
		await act(async () => {
			await drag(...args);
		});
	};
	const scroll = setup.mockMouse.scroll.bind(setup.mockMouse);
	setup.mockMouse.scroll = async (...args) => {
		await act(async () => {
			await scroll(...args);
		});
	};
	const emitMouseEvent = setup.mockMouse.emitMouseEvent.bind(setup.mockMouse);
	setup.mockMouse.emitMouseEvent = async (...args) => {
		await act(async () => {
			await emitMouseEvent(...args);
		});
	};
	const keyInput = setup.renderer.keyInput;
	const emit = keyInput.emit.bind(keyInput);
	keyInput.emit = (event, ...args) => {
		let emitted = false;
		act(() => {
			emitted = emit(event, ...args);
		});
		return emitted;
	};

	const destroy = setup.renderer.destroy.bind(setup.renderer);
	setup.renderer.destroy = () => {
		try {
			if (root) {
				const mountedRoot = root;
				act(() => mountedRoot.unmount());
				root = null;
			}
			return destroy();
		} finally {
			// Keep the React act environment configured between sequential Bun tests.
			setActEnvironment(true);
		}
	};
	return setup;
}
