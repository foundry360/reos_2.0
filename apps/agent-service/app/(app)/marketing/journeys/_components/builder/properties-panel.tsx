"use client";

import { journeyNodeTypeDefinition } from "@/lib/journeys/journey-node-types";
import {
  JOURNEY_DESCRIPTION_MAX,
  JOURNEY_NAME_MAX,
  JOURNEY_NODE_DESCRIPTION_MAX,
  JOURNEY_NODE_NAME_MAX,
} from "@/lib/journeys/journey-validation";
import Link from "next/link";
import type { JourneyNodeConfig } from "@/lib/journeys/journey-types";
import type { TriggerEventType } from "@/lib/journeys/runtime/contracts";
import { JourneyNodeIcon } from "../journey-node-icon";
import type { JourneyFlowNode } from "./canvas-mapping";
import { NodeConfigForm, type JourneyOption, type StepOption } from "./node-config-form";
import shell from "@/components/shell/shell.module.css";
import styles from "../journeys.module.css";

interface PropertiesPanelProps {
  selectedNode: JourneyFlowNode | null;
  selectedCount: number;
  journeyName: string;
  journeyDescription: string;
  nodeCount: number;
  connectionCount: number;
  onJourneyChange: (patch: { name?: string; description?: string }) => void;
  onNodeChange: (id: string, patch: NodePatch) => void;
  onDeleteNode: (id: string) => void;
  hiddenOnSmall: boolean;
  agentOptions: { id: string; label: string }[];
  journeyOptions: JourneyOption[];
  stepOptions: Array<StepOption & { nodeId: string }>;
  triggerEvent: TriggerEventType | null;
  appointmentTriggersOnly: boolean;
  runsHref: string;
}

export type NodePatch = { name?: string; description?: string; config?: JourneyNodeConfig };

export function PropertiesPanel({
  selectedNode,
  selectedCount,
  journeyName,
  journeyDescription,
  nodeCount,
  connectionCount,
  onJourneyChange,
  onNodeChange,
  onDeleteNode,
  hiddenOnSmall,
  agentOptions,
  journeyOptions,
  stepOptions,
  triggerEvent,
  appointmentTriggersOnly,
  runsHref,
}: PropertiesPanelProps) {
  const className = `${styles.panel} ${hiddenOnSmall ? styles.panelHidden : ""}`;

  if (selectedCount > 1) {
    return (
      <aside className={className} aria-label="Properties">
        <div className={styles.panelHeader}>
          <h2 className={styles.panelTitle}>{selectedCount} nodes selected</h2>
        </div>
        <p className={styles.panelEmpty}>
          Select a single node to edit its details. Press Delete to remove the selection.
        </p>
      </aside>
    );
  }

  if (selectedNode) {
    const definition = journeyNodeTypeDefinition(selectedNode.data.nodeType);
    return (
      <aside className={className} aria-label="Node properties">
        <div className={styles.panelHeader}>
          <JourneyNodeIcon type={selectedNode.data.nodeType} />
          <div>
            <h2 className={styles.panelTitle}>{definition.label}</h2>
            <p className={styles.panelSubtitle}>{definition.description}</p>
          </div>
        </div>
        <div className={styles.panelBody}>
          <div className={shell.field}>
            <label className={shell.label} htmlFor="journey-node-name">
              Name
            </label>
            <input
              id="journey-node-name"
              className={shell.input}
              value={selectedNode.data.name}
              maxLength={JOURNEY_NODE_NAME_MAX}
              placeholder={definition.label}
              onChange={(event) => onNodeChange(selectedNode.id, { name: event.target.value })}
            />
          </div>
          <div className={shell.field}>
            <label className={shell.label} htmlFor="journey-node-description">
              Description
            </label>
            <textarea
              id="journey-node-description"
              className={shell.textarea}
              rows={4}
              value={selectedNode.data.description}
              maxLength={JOURNEY_NODE_DESCRIPTION_MAX}
              placeholder={definition.description}
              onChange={(event) =>
                onNodeChange(selectedNode.id, { description: event.target.value })
              }
            />
          </div>
          <NodeConfigForm
            key={selectedNode.id}
            nodeId={selectedNode.id}
            nodeType={selectedNode.data.nodeType}
            config={selectedNode.data.config}
            onChange={(config) => onNodeChange(selectedNode.id, { config })}
            agentOptions={agentOptions}
            journeyOptions={journeyOptions}
            stepOptions={stepOptions.filter((option) => option.nodeId !== selectedNode.id)}
            triggerEvent={triggerEvent}
            appointmentTriggersOnly={appointmentTriggersOnly}
          />
        </div>
        <div className={styles.panelFooter}>
          <button
            type="button"
            className={`${shell.btnSecondary} ${shell.btnPill} ${styles.panelDeleteBtn}`}
            onClick={() => onDeleteNode(selectedNode.id)}
          >
            Delete node
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className={className} aria-label="Journey details">
      <div className={styles.panelHeader}>
        <div>
          <h2 className={styles.panelTitle}>Journey details</h2>
          <p className={styles.panelSubtitle}>Select a node on the canvas to edit it.</p>
        </div>
      </div>
      <div className={styles.panelBody}>
        <div className={shell.field}>
          <label className={shell.label} htmlFor="journey-name">
            Journey name
          </label>
          <input
            id="journey-name"
            className={shell.input}
            value={journeyName}
            maxLength={JOURNEY_NAME_MAX}
            onChange={(event) => onJourneyChange({ name: event.target.value })}
          />
        </div>
        <div className={shell.field}>
          <label className={shell.label} htmlFor="journey-description">
            Description
          </label>
          <textarea
            id="journey-description"
            className={shell.textarea}
            rows={4}
            value={journeyDescription}
            maxLength={JOURNEY_DESCRIPTION_MAX}
            placeholder="What should this journey accomplish?"
            onChange={(event) => onJourneyChange({ description: event.target.value })}
          />
        </div>
        <div className={styles.panelStats}>
          <div className={styles.panelStat}>
            <span className={styles.panelStatValue}>{nodeCount}</span>
            <span className={styles.panelStatLabel}>Nodes</span>
          </div>
          <div className={styles.panelStat}>
            <span className={styles.panelStatValue}>{connectionCount}</span>
            <span className={styles.panelStatLabel}>Connections</span>
          </div>
        </div>
        <p className={styles.panelNote}>
          Hover a step and drag from the dot on its right edge to the left edge of the next step.
          Conditions exit right for Yes and down for No. Press Delete to remove a selected step or
          connection.
        </p>
        <Link href={runsHref} className={`${shell.btnSecondary} ${shell.btnPill} ${styles.panelDeleteBtn}`}>
          View run history
        </Link>
      </div>
    </aside>
  );
}
