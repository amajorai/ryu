import { type ComponentProps, useMemo } from "react";
import { islandFor } from "./game3d-ground.tsx";
import { IsoStage, type IsoView } from "./game3d-stage.tsx";
import {
	TILE,
	WAREHOUSE_BOUNDS,
	WarehouseDioramaScene,
} from "./warehouse-diorama.tsx";
import { WarehouseList } from "./warehouse-list.tsx";

/**
 * The Warehouse floor: the isometric diorama, or the plain list of pickers
 * and orders without WebGL. Split out of `warehouse-interface.tsx`.
 */

type SceneProps = ComponentProps<typeof WarehouseDioramaScene>;
type ListProps = ComponentProps<typeof WarehouseList>;

interface WarehouseFloorProps {
	actors: SceneProps["actors"];
	art: SceneProps["art"];
	fadedIds: SceneProps["fadedIds"];
	fill: number;
	highlightedOrderId: string | null;
	insets: ComponentProps<typeof IsoStage>["insets"];
	isoView: IsoView;
	listActs: ListProps["acts"];
	looks: SceneProps["looks"];
	night: boolean;
	onPickTab: SceneProps["onPickTab"];
	onSelectOrder: ListProps["onSelectOrder"];
	onSelectPicker: SceneProps["onSelectPicker"];
	orders: SceneProps["orders"];
	paused: boolean;
	pickers: SceneProps["pickers"];
	placement: SceneProps["placement"];
	reduceMotion: boolean;
	selectedAgentId: string | null;
}

export function WarehouseFloor({
	actors,
	art,
	fadedIds,
	fill,
	highlightedOrderId,
	insets,
	isoView,
	listActs,
	looks,
	night,
	onPickTab,
	onSelectOrder,
	onSelectPicker,
	orders,
	paused,
	pickers,
	placement,
	reduceMotion,
	selectedAgentId,
}: WarehouseFloorProps) {
	const shape = useMemo(
		() =>
			islandFor(
				WAREHOUSE_BOUNDS.maxX - WAREHOUSE_BOUNDS.minX,
				WAREHOUSE_BOUNDS.maxZ - WAREHOUSE_BOUNDS.minZ,
				TILE * 2.4
			),
		[]
	);
	return (
		<IsoStage
			animate={!paused}
			bounds={{ ...WAREHOUSE_BOUNDS, top: 2.7 }}
			fallback={
				<WarehouseList
					acts={listActs}
					fadedIds={fadedIds}
					onPickTab={onPickTab}
					onSelectOrder={onSelectOrder}
					onSelectPicker={onSelectPicker}
					orders={orders}
					pickers={pickers}
					selectedAgentId={selectedAgentId}
					selectedOrderId={highlightedOrderId}
				/>
			}
			fill={fill}
			insets={insets}
			label="Warehouse diorama: pickers in their aisles and an order box per conversation. Tab or the arrow keys move between pickers and zones; drag to pan, plus and minus to zoom."
			night={night}
			reducedMotion={reduceMotion}
			view={isoView}
		>
			{({ quality, theme }) => (
				<WarehouseDioramaScene
					actors={actors}
					art={art}
					fadedIds={fadedIds}
					looks={looks}
					night={night}
					onPickTab={onPickTab}
					onSelectPicker={onSelectPicker}
					orders={orders}
					pickers={pickers}
					placement={placement}
					quality={quality}
					reducedMotion={reduceMotion}
					running={!paused}
					selectedAgentId={selectedAgentId}
					selectedOrder={orders.find(
						(order) => order.id === highlightedOrderId
					)}
					shape={shape}
					theme={theme}
				/>
			)}
		</IsoStage>
	);
}
