"use client";

import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { useDirection } from "@ryu/ui/components/direction.tsx";
import { DirectionalIcon } from "@ryu/ui/components/directional-icon.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import useEmblaCarousel, {
	type UseEmblaCarouselType,
} from "embla-carousel-react";
import {
	type ComponentProps,
	createContext,
	type KeyboardEvent,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";

type CarouselApi = UseEmblaCarouselType[1];
type UseCarouselParameters = Parameters<typeof useEmblaCarousel>;
type CarouselOptions = UseCarouselParameters[0];
type CarouselPlugin = UseCarouselParameters[1];

interface CarouselProps {
	opts?: CarouselOptions;
	orientation?: "horizontal" | "vertical";
	plugins?: CarouselPlugin;
	setApi?: (api: CarouselApi) => void;
}

type CarouselContextProps = {
	carouselRef: ReturnType<typeof useEmblaCarousel>[0];
	api: ReturnType<typeof useEmblaCarousel>[1];
	scrollPrev: () => void;
	scrollNext: () => void;
	canScrollPrev: boolean;
	canScrollNext: boolean;
} & CarouselProps;

type CarouselDirection = "ltr" | "rtl";

/**
 * Which physical arrow key moves to the previous or next slide. Horizontal
 * carousels follow the reading direction, so under RTL ArrowLeft advances.
 */
function carouselKeyAction(
	key: string,
	direction: CarouselDirection
): "next" | "prev" | null {
	if (key !== "ArrowLeft" && key !== "ArrowRight") {
		return null;
	}
	const towardEnd = direction === "rtl" ? "ArrowLeft" : "ArrowRight";
	return key === towardEnd ? "next" : "prev";
}

const CarouselContext = createContext<CarouselContextProps | null>(null);

function useCarousel() {
	const context = useContext(CarouselContext);

	if (!context) {
		throw new Error("useCarousel must be used within a <Carousel />");
	}

	return context;
}

function Carousel({
	orientation = "horizontal",
	opts,
	setApi,
	plugins,
	className,
	children,
	...props
}: ComponentProps<"div"> & CarouselProps) {
	const contextDirection = useDirection();
	// An explicit Embla `direction` wins; otherwise follow the UI direction so
	// slide offsets and drag match an RTL container.
	const direction: CarouselDirection =
		opts?.direction ?? (contextDirection === "rtl" ? "rtl" : "ltr");
	const [carouselRef, api] = useEmblaCarousel(
		{
			...opts,
			axis: orientation === "horizontal" ? "x" : "y",
			direction,
		},
		plugins
	);
	const [canScrollPrev, setCanScrollPrev] = useState(false);
	const [canScrollNext, setCanScrollNext] = useState(false);

	const onSelect = useCallback((api: CarouselApi) => {
		if (!api) {
			return;
		}
		setCanScrollPrev(api.canScrollPrev());
		setCanScrollNext(api.canScrollNext());
	}, []);

	const scrollPrev = useCallback(() => {
		api?.scrollPrev();
	}, [api]);

	const scrollNext = useCallback(() => {
		api?.scrollNext();
	}, [api]);

	const handleKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			const action = carouselKeyAction(
				event.key,
				orientation === "horizontal" ? direction : "ltr"
			);
			if (!action) {
				return;
			}
			event.preventDefault();
			if (action === "next") {
				scrollNext();
			} else {
				scrollPrev();
			}
		},
		[direction, orientation, scrollPrev, scrollNext]
	);

	useEffect(() => {
		if (!(api && setApi)) {
			return;
		}
		setApi(api);
	}, [api, setApi]);

	useEffect(() => {
		if (!api) {
			return;
		}
		onSelect(api);
		api.on("reInit", onSelect);
		api.on("select", onSelect);

		return () => {
			api?.off("select", onSelect);
		};
	}, [api, onSelect]);

	return (
		<CarouselContext.Provider
			value={{
				carouselRef,
				api,
				opts,
				orientation:
					orientation || (opts?.axis === "y" ? "vertical" : "horizontal"),
				scrollPrev,
				scrollNext,
				canScrollPrev,
				canScrollNext,
			}}
		>
			<div
				aria-roledescription="carousel"
				className={cn("relative", className)}
				data-slot="carousel"
				dir={opts?.direction}
				onKeyDownCapture={handleKeyDown}
				role="region"
				{...props}
			>
				{children}
			</div>
		</CarouselContext.Provider>
	);
}

function CarouselContent({ className, ...props }: ComponentProps<"div">) {
	const { carouselRef, orientation } = useCarousel();

	return (
		<div
			className="overflow-hidden"
			data-slot="carousel-content"
			ref={carouselRef}
		>
			<div
				className={cn(
					"flex",
					orientation === "horizontal" ? "-ms-4" : "-mt-4 flex-col",
					className
				)}
				{...props}
			/>
		</div>
	);
}

function CarouselItem({ className, ...props }: ComponentProps<"div">) {
	const { orientation } = useCarousel();

	return (
		<div
			aria-roledescription="slide"
			className={cn(
				"min-w-0 shrink-0 grow-0 basis-full",
				orientation === "horizontal" ? "ps-4" : "pt-4",
				className
			)}
			data-slot="carousel-item"
			role="group"
			{...props}
		/>
	);
}

function CarouselPrevious({
	className,
	variant = "outline",
	size = "icon-sm",
	...props
}: ComponentProps<typeof Button>) {
	const { orientation, scrollPrev, canScrollPrev } = useCarousel();

	return (
		<Button
			className={cn(
				"absolute touch-manipulation rounded-full",
				orientation === "horizontal"
					? "-start-12 top-1/2 -translate-y-1/2"
					: "-top-12 left-1/2 -translate-x-1/2 rotate-90",
				className
			)}
			data-slot="carousel-previous"
			disabled={!canScrollPrev}
			onClick={scrollPrev}
			size={size}
			variant={variant}
			{...props}
		>
			{orientation === "horizontal" ? (
				<DirectionalIcon icon={ArrowLeft01Icon} strokeWidth={2} />
			) : (
				<HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
			)}
			<span className="sr-only">Previous slide</span>
		</Button>
	);
}

function CarouselNext({
	className,
	variant = "outline",
	size = "icon-sm",
	...props
}: ComponentProps<typeof Button>) {
	const { orientation, scrollNext, canScrollNext } = useCarousel();

	return (
		<Button
			className={cn(
				"absolute touch-manipulation rounded-full",
				orientation === "horizontal"
					? "-end-12 top-1/2 -translate-y-1/2"
					: "-bottom-12 left-1/2 -translate-x-1/2 rotate-90",
				className
			)}
			data-slot="carousel-next"
			disabled={!canScrollNext}
			onClick={scrollNext}
			size={size}
			variant={variant}
			{...props}
		>
			{orientation === "horizontal" ? (
				<DirectionalIcon icon={ArrowRight01Icon} strokeWidth={2} />
			) : (
				<HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
			)}
			<span className="sr-only">Next slide</span>
		</Button>
	);
}

export {
	Carousel,
	type CarouselApi,
	CarouselContent,
	CarouselItem,
	CarouselNext,
	CarouselPrevious,
	carouselKeyAction,
	useCarousel,
};
