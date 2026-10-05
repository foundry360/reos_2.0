"use client";

import "@xyflow/react/dist/style.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type DefaultEdgeOptions,
  type Edge,
  type OnConnectEnd,
} from "@xyflow/react";
import { formatStableDateTime } from "@/components/shell/relative-time";
import { saveJourneyAction, setJourneyStatusAction } from "@/lib/journeys/journey-actions";
import { journeyNodeTypeDefinition } from "@/lib/journeys/journey-node-types";
import {
  connectionLabel,
  nextJourneyStatus,
  type JourneyDefinition,
  type JourneyNodeType,
  type JourneyStatus,
} from "@/lib/journeys/journey-types";
import {
  connectionRejectionReason,
  validateJourneyName,
} from "@/lib/journeys/journey-validation";
import { JourneyStatusBadge } from "../journey-status-badge";
import {
  toFlowEdges,
  toFlowNodes,
  toJourneyGraph,
  type JourneyFlowEdge,
  type JourneyFlowNode,
} from "./canvas-mapping";
import { JourneyConnectionLine, JourneyEdge } from "./journey-edge";
import { JourneyNodeView } from "./journey-node-view";
import { JOURNEY_NODE_COLORS } from "../journey-node-icon";
import { LeaveJourneyModal } from "./leave-journey-modal";
import { NodePicker } from "./node-picker";
import { PropertiesPanel, type NodePatch } from "./properties-panel";
import { isTriggerEventType, nodeReferenceKey } from "@/lib/journeys/runtime/contracts";
import { knownOutputFields, referenceableSteps, stepKeys } from "@/lib/journeys/runtime/graph";
import shell from "@/components/shell/shell.module.css";
import styles from "../journeys.module.css";

const NODE_TYPES = { journey: JourneyNodeView };
const EDGE_TYPES = { journey: JourneyEdge };

const DEFAULT_EDGE_OPTIONS: DefaultEdgeOptions = { type: "journey" };

const BANNER_MS = 3500;

const STATUS_BANNER: Record<JourneyStatus, string> = {
  active: "Journey activated",
  paused: "Journey paused",
  draft: "Journey restored to draft",
  archived: "Journey archived",
};

function snapshotOf(
  name: string,
  description: string,
  nodes: JourneyFlowNode[],
  edges: JourneyFlowEdge[],
): string {
  return JSON.stringify({
    name: name.trim(),
    description: description.trim(),
    graph: toJourneyGraph(nodes, edges),
  });
}

function IconBack() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface JourneyBuilderProps {
  journey: JourneyDefinition;
  agentOptions: { id: string; label: string }[];
}

export function JourneyBuilder(props: JourneyBuilderProps) {
  return (
    <ReactFlowProvider>
      <JourneyBuilderCanvas {...props} />
    </ReactFlowProvider>
  );
}

function JourneyBuilderCanvas({ journey, agentOptions }: JourneyBuilderProps) {
  const reactFlow = useReactFlow<JourneyFlowNode, JourneyFlowEdge>();
  const canvasRef = useRef<HTMLDivElement>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<JourneyFlowNode>(toFlowNodes(journey));
  const [edges, setEdges, onEdgesChange] = useEdgesState<JourneyFlowEdge>(toFlowEdges(journey));
  const [name, setName] = useState(journey.name);
  const [description, setDescription] = useState(journey.description);
  const [status, setStatus] = useState(journey.status);
  const [version, setVersion] = useState(journey.version);
  const [savedSnapshot, setSavedSnapshot] = useState(() =>
    snapshotOf(journey.name, journey.description, toFlowNodes(journey), toFlowEdges(journey)),
  );
  const [lastSavedAt, setLastSavedAt] = useState(journey.updatedAt);
  const [saving, setSaving] = useState(false);
  const [statusPending, setStatusPending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const router = useRouter();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const stayOnPage = useCallback(() => setPendingHref(null), []);

  const dirty = useMemo(
    () => snapshotOf(name, description, nodes, edges) !== savedSnapshot,
    [name, description, nodes, edges, savedSnapshot],
  );

  const selectedNodes = nodes.filter((node) => node.selected);
  const selectedNode = selectedNodes.length === 1 ? selectedNodes[0] : null;
  const lifecycle = nextJourneyStatus(status);

  const selectedConditionId = selectedNode?.data.nodeType === "condition" ? selectedNode.id : null;
  const stepOptions = useMemo(() => {
    if (!selectedConditionId) return [];
    const graph = toJourneyGraph(nodes, edges);
    const legacyKeys = stepKeys(graph.nodes);
    const seen = new Map<string, number>();
    return referenceableSteps(graph, selectedConditionId).map((node) => {
      const base = node.name.trim() || journeyNodeTypeDefinition(node.type).label;
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      return {
        nodeId: node.id,
        key: nodeReferenceKey(node.id),
        legacyKey: legacyKeys.get(node.id),
        label: count > 1 ? `${base} (${count})` : base,
        outputs: knownOutputFields(node),
      };
    });
  }, [nodes, edges, selectedConditionId]);
  const triggerEvent = useMemo(() => {
    const event = nodes.find((node) => node.data.nodeType === "trigger")?.data.config.event;
    return isTriggerEventType(event) ? event : null;
  }, [nodes]);

  useEffect(() => {
    if (!banner) return;
    const timer = window.setTimeout(() => setBanner(null), BANNER_MS);
    return () => window.clearTimeout(timer);
  }, [banner]);

  const currentGraph = useCallback(
    () => toJourneyGraph(reactFlow.getNodes(), reactFlow.getEdges()),
    [reactFlow],
  );

  const save = useCallback(async (): Promise<boolean> => {
    if (saving) return false;
    const nameProblem = validateJourneyName(name);
    if (nameProblem) {
      setSaveError(nameProblem);
      setBanner(nameProblem);
      return false;
    }

    const snapshot = snapshotOf(name, description, nodes, edges);
    setSaving(true);
    setSaveError(null);
    const result = await saveJourneyAction({
      journeyId: journey.id,
      name,
      description,
      graph: toJourneyGraph(nodes, edges),
      expectedVersion: version,
    });
    setSaving(false);

    if (!result.ok || result.version === undefined) {
      const message = result.error ?? "Could not save the journey.";
      setSaveError(message);
      setBanner(message);
      return false;
    }

    setVersion(result.version);
    setSavedSnapshot(snapshot);
    setLastSavedAt(result.updatedAt ?? new Date().toISOString());
    setBanner("Journey saved");
    return true;
  }, [saving, name, description, nodes, edges, journey.id, version]);

  const saveRef = useRef(save);
  saveRef.current = save;

  async function changeStatus() {
    // An archived journey can't be saved; Restore doesn't need the canvas saved first.
    if (dirty && status !== "archived" && !(await save())) return;
    setStatusPending(true);
    const result = await setJourneyStatusAction({ journeyId: journey.id, status: lifecycle.status });
    setStatusPending(false);
    if (!result.ok || !result.status) {
      setBanner(result.error ?? "Could not update the journey status.");
      return;
    }
    setStatus(result.status);
    setBanner(STATUS_BANNER[result.status]);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveRef.current();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    // Capture phase runs before Next's <Link> handler, so cancelling here keeps the user on the page.
    function onClickCapture(event: MouseEvent) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      const anchor = (event.target as HTMLElement | null)?.closest("a[href]") as
        | HTMLAnchorElement
        | null;
      if (!anchor || anchor.target === "_blank") return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      event.preventDefault();
      event.stopPropagation();
      setPendingHref(`${url.pathname}${url.search}${url.hash}`);
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClickCapture, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClickCapture, true);
    };
  }, [dirty]);

  const isValidConnection = useCallback(
    (connection: Connection | Edge) =>
      connectionRejectionReason(currentGraph(), {
        sourceNodeId: connection.source,
        targetNodeId: connection.target,
        sourceHandle: connection.sourceHandle ?? null,
      }) === null,
    [currentGraph],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((current) =>
        addEdge(
          {
            ...connection,
            id: crypto.randomUUID(),
            type: "journey",
            label: connectionLabel(connection.sourceHandle),
          },
          current,
        ),
      );
    },
    [setEdges],
  );

  const onConnectEnd: OnConnectEnd = useCallback(
    (_event, state) => {
      if (state.isValid || !state.fromNode || !state.toNode) return;
      const fromIsSource = state.fromHandle?.type !== "target";
      const reason = connectionRejectionReason(currentGraph(), {
        sourceNodeId: fromIsSource ? state.fromNode.id : state.toNode.id,
        targetNodeId: fromIsSource ? state.toNode.id : state.fromNode.id,
      });
      if (reason) setBanner(reason);
    },
    [currentGraph],
  );

  const addNode = useCallback(
    (type: JourneyNodeType) => {
      const definition = journeyNodeTypeDefinition(type);
      const bounds = canvasRef.current?.getBoundingClientRect();
      const center = bounds
        ? reactFlow.screenToFlowPosition({
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2,
          })
        : { x: 0, y: 0 };
      const offset = (reactFlow.getNodes().length % 6) * 32;
      const node: JourneyFlowNode = {
        id: crypto.randomUUID(),
        type: "journey",
        position: { x: center.x - 28 + offset, y: center.y - 28 + offset },
        selected: true,
        data: {
          nodeType: type,
          name: definition.label,
          description: "",
          config: definition.defaultConfig(),
        },
      };
      setNodes((current) => [...current.map((entry) => ({ ...entry, selected: false })), node]);
      setEdges((current) =>
        current.some((edge) => edge.selected)
          ? current.map((edge) => ({ ...edge, selected: false }))
          : current,
      );
    },
    [reactFlow, setNodes, setEdges],
  );

  const updateNode = useCallback(
    (id: string, patch: NodePatch) => {
      setNodes((current) =>
        current.map((node) => (node.id === id ? { ...node, data: { ...node.data, ...patch } } : node)),
      );
    },
    [setNodes],
  );

  const deleteNode = useCallback(
    (id: string) => {
      void reactFlow.deleteElements({ nodes: [{ id }] });
    },
    [reactFlow],
  );

  const saveStateLabel = saving
    ? "Saving…"
    : saveError && dirty
      ? "Save failed"
      : dirty
        ? "Unsaved changes"
        : `Saved ${formatStableDateTime(lastSavedAt)}`;
  const saveStateClass =
    saveError && dirty ? styles.saveStateError : dirty ? styles.saveStateDirty : "";

  return (
    <div className={styles.builder}>
      <header className={styles.builderHeader}>
        <div className={styles.builderTitleBlock}>
          <Link href="/marketing/journeys" className={styles.builderBack} aria-label="Back to journeys">
            <IconBack />
          </Link>
          <div className={styles.builderTitleText}>
            <p className={styles.builderEyebrow}>Journey Builder</p>
            <div className={styles.builderTitleRow}>
              <h1 className={styles.builderTitle}>{name.trim() || "Untitled journey"}</h1>
              <JourneyStatusBadge status={status} />
            </div>
          </div>
        </div>

        <div className={styles.builderActions}>
          <span className={`${styles.saveState} ${saveStateClass}`} role="status" aria-live="polite">
            <span className={styles.saveStateDot} aria-hidden />
            {saveStateLabel}
          </span>
          <Link href={`/marketing/journeys/${journey.id}/runs`} className={`${shell.btnSecondary} ${shell.btnPill}`}>
            Runs
          </Link>
          <button
            type="button"
            className={`${shell.btnSecondary} ${shell.btnPill}`}
            onClick={() => void changeStatus()}
            disabled={statusPending || saving}
            title={dirty && status !== "archived" ? "Saves your changes first" : undefined}
          >
            {statusPending ? "Updating…" : lifecycle.label}
          </button>
          <button
            type="button"
            className={`${shell.btnPrimary} ${shell.btnPill}`}
            onClick={() => void save()}
            disabled={saving || !dirty}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      <div className={styles.builderBody}>
        <div className={styles.canvas} ref={canvasRef}>
          <div className={styles.canvasToolbar}>
            <NodePicker onPick={addNode} />
          </div>

          {banner ? (
            <div className={styles.banner} role="status">
              {banner}
            </div>
          ) : null}

          {nodes.length === 0 ? (
            <div className={styles.canvasEmpty}>
              <div className={styles.canvasEmptyCard}>
                <p className={styles.canvasEmptyTitle}>Start your journey</p>
                <p className={styles.canvasEmptyText}>
                  Every journey begins with a Trigger, the event that starts it. Add one, then
                  connect AI, Condition, and Action steps to its right.
                </p>
                <button
                  type="button"
                  className={`${shell.btnPrimary} ${shell.btnPill}`}
                  onClick={() => addNode("trigger")}
                >
                  Add Trigger
                </button>
              </div>
            </div>
          ) : null}

          <ReactFlow<JourneyFlowNode, JourneyFlowEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectEnd={onConnectEnd}
            isValidConnection={isValidConnection}
            defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
            connectionLineComponent={JourneyConnectionLine}
            deleteKeyCode={["Backspace", "Delete"]}
            snapToGrid
            snapGrid={[16, 16]}
            minZoom={0.25}
            maxZoom={2}
            fitView={nodes.length > 0}
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} />
            <Controls showInteractive={false} position="bottom-left" />
            <MiniMap<JourneyFlowNode>
              pannable
              zoomable
              position="bottom-right"
              nodeColor={(node) => JOURNEY_NODE_COLORS[node.data.nodeType]}
              nodeBorderRadius={6}
            />
          </ReactFlow>
        </div>

        <PropertiesPanel
          selectedNode={selectedNode}
          selectedCount={selectedNodes.length}
          journeyName={name}
          journeyDescription={description}
          nodeCount={nodes.length}
          connectionCount={edges.length}
          onJourneyChange={(patch) => {
            if (patch.name !== undefined) setName(patch.name);
            if (patch.description !== undefined) setDescription(patch.description);
          }}
          onNodeChange={updateNode}
          onDeleteNode={deleteNode}
          hiddenOnSmall={selectedNodes.length === 0}
          agentOptions={agentOptions}
          stepOptions={stepOptions}
          triggerEvent={triggerEvent}
          runsHref={`/marketing/journeys/${journey.id}/runs`}
        />
      </div>

      <LeaveJourneyModal
        open={pendingHref !== null}
        onStay={stayOnPage}
        onLeave={() => {
          if (pendingHref) router.push(pendingHref);
          setPendingHref(null);
        }}
      />
    </div>
  );
}
