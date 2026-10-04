"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { journeyNodeTypeDefinition } from "@/lib/journeys/journey-node-types";
import { CONDITION_HANDLES } from "@/lib/journeys/journey-types";
import { JourneyNodeGlyph, NODE_TYPE_CLASS } from "../journey-node-icon";
import type { JourneyFlowNode } from "./canvas-mapping";
import styles from "../journeys.module.css";

function JourneyNodeViewComponent({ data, selected }: NodeProps<JourneyFlowNode>) {
  const definition = journeyNodeTypeDefinition(data.nodeType);
  const isCondition = data.nodeType === "condition";
  const label = data.name || definition.label;

  return (
    <div
      className={`${styles.node} ${NODE_TYPE_CLASS[data.nodeType]} ${
        selected ? styles.nodeSelected : ""
      }`}
      title={data.description || definition.description}
    >
      {definition.acceptsIncoming ? (
        <Handle type="target" position={Position.Left} className={styles.handle} />
      ) : null}

      <div className={isCondition ? styles.nodeDiamond : styles.nodeTile}>
        <span className={styles.nodeGlyph}>
          <JourneyNodeGlyph type={data.nodeType} size={26} />
        </span>
      </div>

      <p className={styles.nodeLabel}>{label}</p>

      {isCondition ? (
        <>
          <Handle
            id={CONDITION_HANDLES.yes}
            type="source"
            position={Position.Right}
            className={styles.handle}
          />
          <Handle
            id={CONDITION_HANDLES.no}
            type="source"
            position={Position.Bottom}
            className={`${styles.handle} ${styles.handleNo}`}
          />
        </>
      ) : definition.acceptsOutgoing ? (
        <Handle type="source" position={Position.Right} className={styles.handle} />
      ) : null}
    </div>
  );
}

export const JourneyNodeView = memo(JourneyNodeViewComponent);
