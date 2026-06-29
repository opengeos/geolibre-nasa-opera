import {
  GeoAgentControl,
  type GeoAgentState,
} from "maplibre-gl-geoagent";
import { OperaControl, type OperaState } from "./lib/core/OperaControl";
import type {
  GeoLibreAppAPI,
  GeoLibreControl,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "./lib/geolibre/host-api";
import type { BBox } from "./lib/opera/types";
import {
  createOperaAgentTools,
  OPERA_AGENT_SYSTEM_PROMPT,
} from "./lib/opera/agent-tools";
import "maplibre-gl-geoagent/style.css";
import "./lib/styles/plugin-control.css";

// This plugin owns two MapLibre controls: the OPERA search panel and a
// companion GeoAgent chat panel. Use the structural control type for host calls.
type AppAPI = GeoLibreAppAPI<GeoLibreControl>;

interface NasaOperaProjectState {
  opera?: Partial<OperaState>;
  geoAgent?: Partial<GeoAgentState>;
}

let operaControl: OperaControl | null = null;
let geoAgentControl: GeoAgentControl | null = null;
let position: GeoLibreMapControlPosition = "top-left";
let pendingOperaState: Partial<OperaState> | null = null;
let pendingGeoAgentState: Partial<GeoAgentState> | null = null;

function createControl(app: AppAPI): OperaControl {
  const next = new OperaControl({
    // Open the panel immediately when the user activates the plugin so the
    // search UI is visible right away, rather than only pinning the toolbar
    // icon. A restored project (or a prior session) can still start collapsed
    // by carrying `collapsed: true` in its saved state.
    collapsed: pendingOperaState?.collapsed ?? false,
    panelWidth: pendingOperaState?.panelWidth ?? 340,
    title: "NASA OPERA",
    // Bind host capabilities; each degrades to a no-op when the host (or
    // standalone usage) does not provide it.
    addGeoJsonLayer: (name, data) => app.addGeoJsonLayer?.(name, data),
    registerLayer: (layer) => app.registerExternalNativeLayer?.(layer),
    unregisterLayer: (id) => app.unregisterExternalNativeLayer?.(id),
    fitBounds: (bounds) => app.fitBounds?.(bounds),
    getMapBounds: () => readMapBounds(app),
  });

  if (pendingOperaState) next.setState(pendingOperaState);
  return next;
}

function createGeoAgentControl(): GeoAgentControl {
  const next = new GeoAgentControl({
    collapsed: pendingGeoAgentState?.collapsed ?? true,
    panelWidth: pendingGeoAgentState?.panelWidth ?? 410,
    panelHeight: pendingGeoAgentState?.panelHeight,
    title: "OPERA GeoAgent",
    storagePrefix: "geolibre.nasa-opera.geoagent",
    allowCodeExecutionDefault: pendingGeoAgentState?.allowCodeExecution ?? true,
    allowDestructiveToolsDefault:
      pendingGeoAgentState?.allowDestructiveTools ?? true,
    showPermissionToggles: false,
    customSystemPrompt: OPERA_AGENT_SYSTEM_PROMPT,
    customTools: () => createOperaAgentTools(() => operaControl),
  });

  if (pendingGeoAgentState) next.setState(pendingGeoAgentState);
  return next;
}

function companionPosition(
  primary: GeoLibreMapControlPosition,
): GeoLibreMapControlPosition {
  switch (primary) {
    case "top-right":
      return "top-left";
    case "bottom-left":
      return "bottom-right";
    case "bottom-right":
      return "bottom-left";
    case "top-left":
    default:
      return "top-right";
  }
}

/** Read the current map extent as a `[w, s, e, n]` box, or null. */
function readMapBounds(app: AppAPI): BBox | null {
  const map = app.getMap?.();
  if (!map) return null;
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}

function isOperaState(value: unknown): value is Partial<OperaState> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNasaOperaProjectState(
  value: unknown,
): value is NasaOperaProjectState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return "opera" in value || "geoAgent" in value;
}

export const plugin: GeoLibrePlugin<GeoLibreControl> = {
  id: "geolibre-nasa-opera",
  name: "NASA OPERA",
  version: "0.2.4",
  activate(app) {
    operaControl = operaControl ?? createControl(app);
    const added = app.addMapControl(operaControl, position);
    if (!added) {
      operaControl = null;
      return false;
    }

    geoAgentControl = geoAgentControl ?? createGeoAgentControl();
    const agentAdded = app.addMapControl(
      geoAgentControl,
      companionPosition(position),
    );
    if (!agentAdded) {
      app.removeMapControl(operaControl);
      operaControl = null;
      geoAgentControl = null;
      return false;
    }
  },
  deactivate(app) {
    if (geoAgentControl) {
      pendingGeoAgentState = geoAgentControl.getState();
      app.removeMapControl(geoAgentControl);
      geoAgentControl = null;
    }
    if (operaControl) {
      pendingOperaState = operaControl.getState();
      app.removeMapControl(operaControl);
      operaControl = null;
    }
  },
  getMapControlPosition() {
    return position;
  },
  setMapControlPosition(app, nextPosition) {
    position = nextPosition;
    if (!operaControl) return;
    if (geoAgentControl) app.removeMapControl(geoAgentControl);
    app.removeMapControl(operaControl);

    const added = app.addMapControl(operaControl, position);
    const agentAdded =
      !geoAgentControl ||
      app.addMapControl(geoAgentControl, companionPosition(position));
    if (!added || !agentAdded) {
      pendingOperaState = operaControl.getState();
      pendingGeoAgentState = geoAgentControl?.getState() ?? null;
      if (added) app.removeMapControl(operaControl);
      if (agentAdded && geoAgentControl) app.removeMapControl(geoAgentControl);
      operaControl = null;
      geoAgentControl = null;
      return false;
    }
  },
  getProjectState() {
    return {
      opera: operaControl?.getState() ?? pendingOperaState ?? undefined,
      geoAgent:
        geoAgentControl?.getState() ?? pendingGeoAgentState ?? undefined,
    } satisfies NasaOperaProjectState;
  },
  applyProjectState(_app, state) {
    if (isNasaOperaProjectState(state)) {
      pendingOperaState = isOperaState(state.opera) ? state.opera : null;
      pendingGeoAgentState =
        state.geoAgent && typeof state.geoAgent === "object"
          ? state.geoAgent
          : null;
      if (pendingOperaState) operaControl?.setState(pendingOperaState);
      if (pendingGeoAgentState) geoAgentControl?.setState(pendingGeoAgentState);
      return;
    }

    // Backward compatibility with projects saved before the GeoAgent companion
    // control existed, where the plugin state was the OPERA control state.
    if (!isOperaState(state)) return false;
    pendingOperaState = state;
    operaControl?.setState(state);
  },
};

export default plugin;
