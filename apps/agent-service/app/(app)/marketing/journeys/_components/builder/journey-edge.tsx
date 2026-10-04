"use client";

import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useInternalNode,
  type ConnectionLineComponentProps,
  type EdgeProps,
} from "@xyflow/react";
import { JOURNEY_NODE_COLORS } from "../journey-node-icon";
import type { JourneyFlowEdge, JourneyFlowNode } from "./canvas-mapping";
import styles from "../journeys.module.css";

/** Round caps on zero-length dashes draw a row of dots. */
const DOTS = { strokeDasharray: "0 11", strokeLinecap: "round" as const };

function JourneyEdgeComponent({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  label,
  selected,
}: EdgeProps<JourneyFlowEdge>) {
  const sourceNode = useInternalNode<JourneyFlowNode>(source);
  const targetNode = useInternalNode<JourneyFlowNode>(target);
  const from = JOURNEY_NODE_COLORS[sourceNode?.data.nodeType ?? "action"];
  const to = JOURNEY_NODE_COLORS[targetNode?.data.nodeType ?? "action"];
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  // userSpaceOnUse: a bounding-box gradient collapses on perfectly straight lines.
  const gradientId = `journey-edge-gradient-${id}`;

  return (
    <>
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1={sourceX}
          y1={sourceY}
          x2={targetX}
          y2={targetY}
        >
          <stop offset="0%" stopColor={from} />
          <stop offset="100%" stopColor={to} />
        </linearGradient>
      </defs>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={24}
        style={{ ...DOTS, stroke: `url(#${gradientId})`, strokeWidth: selected ? 7 : 5 }}
      />
      {label ? (
        <EdgeLabelRenderer>
          <div
            className={styles.edgeLabel}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const JourneyEdge = memo(JourneyEdgeComponent);

export function JourneyConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromPosition,
  toPosition,
  fromNode,
}: ConnectionLineComponentProps<JourneyFlowNode>) {
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    targetX: toX,
    targetY: toY,
    sourcePosition: fromPosition,
    targetPosition: toPosition,
  });
  return (
    <path
      d={path}
      fill="none"
      stroke={JOURNEY_NODE_COLORS[fromNode.data.nodeType]}
      strokeWidth={5}
      {...DOTS}
    />
  );
}
