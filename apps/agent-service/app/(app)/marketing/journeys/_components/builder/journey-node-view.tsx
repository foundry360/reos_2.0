"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { journeyNodeTypeDefinition } from "@/lib/journeys/journey-node-types";
import { JourneyNodeIcon, NODE_TYPE_CLASS } from "../journey-node-icon";
import type { JourneyFlowNode } from "./canvas-mapping";
import styles from "../journeys.module.css";

function JourneyNodeViewComponent({ data, selected }: NodeProps<JourneyFlowNode>) {
  const definition = journeyNodeTypeDefinition(data.nodeType);

  return (
    <div
      className={`${styles.node} ${NODE_TYPE_CLASS[data.nodeType]} ${
        selected ? styles.nodeSelected : ""
      }`}
    >
      {definition.acceptsIncoming ? (
        <Handle type="target" position={Position.Top} className={styles.handle} />
      ) : null}

      <div className={styles.nodeHeader}>
        <JourneyNodeIcon type={data.nodeType} />
        <div className={styles.nodeHeaderText}>
          <span className={styles.nodeTypeLabel}>{definition.label}</span>
          <p className={styles.nodeName}>{data.name || definition.label}</p>
        </div>
      </div>
      <p className={styles.nodeDescription}>{data.description || definition.description}</p>

      {definition.acceptsOutgoing ? (
        <Handle type="source" position={Position.Bottom} className={styles.handle} />
      ) : null}
    </div>
  );
}

export const JourneyNodeView = memo(JourneyNodeViewComponent);
