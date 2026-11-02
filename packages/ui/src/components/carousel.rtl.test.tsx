import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { DirectionProvider } = await import("./direction.tsx");
const {
	Carousel,
	CarouselContent,
	CarouselItem,
	CarouselNext,
	CarouselPrevious,
	carouselKeyAction,
} = await import("./carousel.tsx");
type CarouselApi = import("./carousel.tsx").CarouselApi;
type CarouselOptions = NonNullable<
	Parameters<typeof import("./carousel.tsx").Carousel>[0]["opts"]
>;

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function mountCarousel(direction: "ltr" | "rtl", opts?: CarouselOptions) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	let api: CarouselApi;
	await act(async () => {
		root.render(
			<DirectionProvider direction={direction}>
				<Carousel
					opts={opts}
					setApi={(next) => {
						api = next;
					}}
				>
					<CarouselContent>
						<CarouselItem>One</CarouselItem>
						<CarouselItem>Two</CarouselItem>
					</CarouselContent>
				</Carousel>
			</DirectionProvider>
		);
		await Promise.resolve();
	});
	const region = host.querySelector<HTMLElement>('[data-slot="carousel"]');
	if (!(api && region)) {
		throw new Error("carousel did not mount");
	}
	return {
		api,
		region,
		unmount: () => {
			act(() => root.unmount());
			host.remove();
		},
	};
}

function press(target: HTMLElement, key: string) {
	act(() => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

describe("Carousel reading direction", () => {
	test("Embla receives the UI direction", async () => {
		for (const direction of ["ltr", "rtl"] as const) {
			const mounted = await mountCarousel(direction);
			expect(mounted.api?.internalEngine().options.direction).toBe(direction);
			expect(mounted.region.hasAttribute("dir")).toBe(false);
			mounted.unmount();
		}
	});

	test("an explicit Embla direction wins and is mirrored onto the region", async () => {
		const mounted = await mountCarousel("rtl", { direction: "ltr" });
		expect(mounted.api?.internalEngine().options.direction).toBe("ltr");
		expect(mounted.region.getAttribute("dir")).toBe("ltr");
		mounted.unmount();
	});

	test("arrow keys follow the reading direction", async () => {
		const mounted = await mountCarousel("rtl");
		const api = mounted.api;
		if (!api) {
			throw new Error("no api");
		}
		const next = mock(() => undefined);
		const prev = mock(() => undefined);
		api.scrollNext = next;
		api.scrollPrev = prev;
		press(mounted.region, "ArrowLeft");
		expect(next).toHaveBeenCalledTimes(1);
		press(mounted.region, "ArrowRight");
		expect(prev).toHaveBeenCalledTimes(1);
		mounted.unmount();
	});

	test("the key mapping is unchanged in LTR", () => {
		expect(carouselKeyAction("ArrowRight", "ltr")).toBe("next");
		expect(carouselKeyAction("ArrowLeft", "ltr")).toBe("prev");
		expect(carouselKeyAction("ArrowLeft", "rtl")).toBe("next");
		expect(carouselKeyAction("ArrowRight", "rtl")).toBe("prev");
		expect(carouselKeyAction("Enter", "rtl")).toBeNull();
	});

	test("controls and spacing use logical sides with mirrored arrows", () => {
		const html = renderToStaticMarkup(
			<DirectionProvider direction="rtl">
				<Carousel>
					<CarouselContent>
						<CarouselItem>One</CarouselItem>
					</CarouselContent>
					<CarouselPrevious />
					<CarouselNext />
				</Carousel>
			</DirectionProvider>
		);
		expect(html).toContain("-start-12");
		expect(html).toContain("-end-12");
		expect(html).toContain("-ms-4");
		expect(html).toContain("ps-4");
		expect(html).not.toMatch(/-(?:left|right)-12|-ml-4|\bpl-4\b/);
		expect(html.match(/rtl:-scale-x-100/g)).toHaveLength(2);
	});

	test("vertical carousels keep unmirrored, rotated arrows", () => {
		const html = renderToStaticMarkup(
			<DirectionProvider direction="rtl">
				<Carousel orientation="vertical">
					<CarouselPrevious />
					<CarouselNext />
				</Carousel>
			</DirectionProvider>
		);
		expect(html).not.toContain("rtl:-scale-x-100");
	});
});
