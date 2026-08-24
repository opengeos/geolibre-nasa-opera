import {
  GeoAgentControl,
  type GeoAgentControlOptions,
  type GeoAgentState,
} from "maplibre-gl-geoagent";
import type { Model } from "@strands-agents/sdk";
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
type DeploymentEnv = Record<string, string | undefined>;
type GeoAgentProviderModelFactory = (
  providerId: string,
  modelId: string,
  apiKey: string,
  bedrockRegion: string,
  baseUrl: string,
) => Promise<Model>;
type GeoAgentModelFactoryPatchPoint = {
  createProviderModel?: GeoAgentProviderModelFactory;
};

/**
 * Where the OPERA search UI lives:
 * - `"docked"` — a native right-sidebar panel the host renders and manages
 *   (`app.registerRightPanel`). The default for fresh activations.
 * - `"floating"` — the original draggable MapLibre control overlaid on the map.
 *   Kept for backward compatibility (projects saved before docking existed keep
 *   floating), and selectable at runtime from the plugin's toolbar menu.
 * The GeoAgent chat companion is always a floating map control in both modes.
 */
type PanelMode = "docked" | "floating";

interface NasaOperaProjectState {
  opera?: Partial<OperaState>;
  geoAgent?: Partial<GeoAgentState>;
  /** Persisted panel mode; absent in projects saved before docking existed. */
  panelMode?: PanelMode;
}

/** Stable ids for the host-managed right panel and toolbar menu. */
const RIGHT_PANEL_ID = "geolibre-nasa-opera-panel";
const TOOLBAR_MENU_ID = "geolibre-nasa-opera-menu";
const GEOAGENT_AOI_CLASS = "opera-geoagent-aoi";

let operaControl: OperaControl | null = null;
let geoAgentControl: GeoAgentControl | null = null;
let position: GeoLibreMapControlPosition = "top-left";
// The requested mode. Fresh activations default to docked; a restored project
// without an explicit `panelMode` falls back to floating (see applyProjectState).
let panelMode: PanelMode = "docked";
// The mode the OPERA UI is actually mounted in right now, or null when not
// mounted. May differ from `panelMode` when a host cannot provide a right panel
// and docking gracefully falls back to floating.
let mountedMode: PanelMode | null = null;
let unregisterRightPanel: (() => void) | null = null;
let disposeToolbarMenu: (() => void) | null = null;
let pendingOperaState: Partial<OperaState> | null = null;
let pendingGeoAgentState: Partial<GeoAgentState> | null = null;
const GEOAGENT_STORAGE_PREFIX = "geolibre.nasa-opera.geoagent";
const MANAGED_PROXY_API_KEY = "geolibre-managed-proxy";

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
    ...(app.addLayerGroup
      ? {
          addLayerGroup: (name: string, layerIds?: string[]) =>
            app.addLayerGroup?.(name, layerIds) ?? "",
        }
      : {}),
    ...(app.removeLayerGroup
      ? { removeLayerGroup: (id: string) => app.removeLayerGroup?.(id) }
      : {}),
    activatePlugin: async (pluginId, state) =>
      (await app.activatePlugin?.(pluginId, state)) ?? false,
    queryOvertureFeatures: (query) => {
      if (!app.queryOvertureFeatures) {
        return Promise.reject(
          new Error("This GeoLibre host does not expose Overture queries."),
        );
      }
      return app.queryOvertureFeatures(query);
    },
    fitBounds: (bounds) => app.fitBounds?.(bounds),
    getMapBounds: () => readMapBounds(app),
    exportTextFile: (filename, content, options) =>
      app.exportTextFile?.(filename, content, options),
    getProjectSnapshot: () => app.getProjectSnapshot?.(),
    onAgentAoiChange: () => syncGeoAgentAoiControls(),
    // In docked mode, agent actions that need the UI visible ask the host to
    // reveal the right panel instead of driving the floating panel.
    onRequestReveal: () => app.openRightPanel?.(RIGHT_PANEL_ID),
  });

  if (pendingOperaState) next.setState(pendingOperaState);
  return next;
}

/**
 * OpenAI key optionally bundled at build time from `OPENAI_API_KEY` (via a Vite
 * `define`; empty when not set). When present it prefills the GeoAgent so users
 * need not enter a key. A key saved in the panel/sessionStorage still takes
 * precedence, so users can override the bundled key. See src/vite-env.d.ts.
 */
const BUNDLED_OPENAI_API_KEY =
  typeof __OPERA_OPENAI_API_KEY__ === "string"
    ? __OPERA_OPENAI_API_KEY__.trim()
    : "";
const BUNDLED_CLI_PROXY_API_KEY =
  typeof __OPERA_CLI_PROXY_API_KEY__ === "string"
    ? __OPERA_CLI_PROXY_API_KEY__.trim()
    : "";
const BUNDLED_CLI_PROXY_URL =
  typeof __OPERA_CLI_PROXY_URL__ === "string"
    ? __OPERA_CLI_PROXY_URL__.trim()
    : "";

function browserOrigin(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const origin = window.location?.origin;
  return origin && origin !== "null" ? origin : undefined;
}

function proxyBaseUrl(proxyUrl: string, baseOrigin?: string): string {
  let normalized = proxyUrl.trim().replace(/\/+$/, "");
  if (baseOrigin && normalized.startsWith("/")) {
    normalized = new URL(normalized, baseOrigin).toString().replace(/\/+$/, "");
  }
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function readDeploymentEnv(): DeploymentEnv {
  if (typeof window === "undefined") return {};
  return (
    (
      window as unknown as {
        __GEOLIBRE_DEPLOYMENT_ENV__?: DeploymentEnv;
      }
    ).__GEOLIBRE_DEPLOYMENT_ENV__ ?? {}
  );
}

function readManagedProxyConfig(): { baseURL: string; modelId: string } | null {
  const env = readDeploymentEnv();
  const proxyUrl = env.VITE_GEOLIBRE_AI_URL?.trim();
  if (!proxyUrl) return null;
  return {
    baseURL: proxyBaseUrl(proxyUrl, browserOrigin()),
    modelId: env.VITE_GEOLIBRE_AI_MODEL?.trim() || "openai/gpt-5.6-luna",
  };
}

function storageSet(key: string, value: string): void {
  try {
    globalThis.sessionStorage?.setItem(key, value);
  } catch {
    // Ignore storage failures in private or restricted browser contexts.
  }
}

function seedProxyStorage(config: {
  baseURL: string;
  modelId: string;
  apiKey: string;
}): void {
  storageSet(`${GEOAGENT_STORAGE_PREFIX}.provider`, "openai-compatible");
  storageSet(
    `${GEOAGENT_STORAGE_PREFIX}.openai-compatible.api_key`,
    config.apiKey,
  );
  storageSet(
    `${GEOAGENT_STORAGE_PREFIX}.baseUrl.openai-compatible`,
    config.baseURL,
  );
  storageSet(
    `${GEOAGENT_STORAGE_PREFIX}.model.openai-compatible`,
    config.modelId,
  );
}

function managedProxyState(config: {
  baseURL: string;
  modelId: string;
}): Partial<GeoAgentState> {
  return {
    providerId: "openai-compatible",
    modelId: config.modelId,
    baseUrl: config.baseURL,
  };
}

/** Supply temporal and network-capability facts that the model cannot infer. */
function runtimeSystemPrompt(now = new Date()): string {
  const localDate = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(now);
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `Runtime facts and capability boundaries:
- Today's local date is ${localDate} (${year}-${month}-${day}). Use this date for every question involving today, current dates, relative dates, or recency. Never guess a different date from model training data.
- You have tool-mediated internet access, including GPT-native web search through search_realtime_disasters, NASA CMR/OPERA, titiler-cmr, supported imagery/catalog services, and map data services. You do not have unrestricted general-purpose web browsing outside those tools. Never use tavily_search unless the user explicitly asks for Tavily by name.
- If asked whether you have internet access, explain that you can search real-time disasters and access the other supported live services through tools. Do not claim unrestricted browsing, and do not imply that another service is reachable unless an available tool supports it.

${OPERA_AGENT_SYSTEM_PROMPT}`;
}

function installManagedProxyModelFactory(
  control: GeoAgentControl,
  config: { baseURL: string },
): void {
  const patchable = control as unknown as GeoAgentModelFactoryPatchPoint;
  const originalCreateProviderModel =
    patchable.createProviderModel?.bind(control);
  if (!originalCreateProviderModel) return;

  patchable.createProviderModel = async (
    providerId,
    modelId,
    apiKey,
    bedrockRegion,
    baseUrl,
  ) => {
    const normalizedBaseUrl = proxyBaseUrl(baseUrl);
    if (
      providerId === "openai-compatible" &&
      apiKey === MANAGED_PROXY_API_KEY &&
      normalizedBaseUrl === config.baseURL
    ) {
      const { OpenAIModel } = await import("@strands-agents/sdk/models/openai");
      return new OpenAIModel({
        api: "chat",
        apiKey,
        modelId,
        clientConfig: {
          baseURL: normalizedBaseUrl,
          defaultHeaders: { Authorization: null },
          dangerouslyAllowBrowser: true,
        },
      }) as unknown as Model;
    }
    return originalCreateProviderModel(
      providerId,
      modelId,
      apiKey,
      bedrockRegion,
      baseUrl,
    );
  };
}

function createGeoAgentControl(): GeoAgentControl {
  const managedProxy = readManagedProxyConfig();
  const bundledCliProxy =
    !managedProxy && BUNDLED_CLI_PROXY_API_KEY && BUNDLED_CLI_PROXY_URL
      ? {
          baseURL: proxyBaseUrl(BUNDLED_CLI_PROXY_URL),
          modelId: "gpt-5.6-luna",
          apiKey: BUNDLED_CLI_PROXY_API_KEY,
        }
      : null;
  const proxyConfig = managedProxy
    ? { ...managedProxy, apiKey: MANAGED_PROXY_API_KEY }
    : bundledCliProxy;
  if (proxyConfig) seedProxyStorage(proxyConfig);
  const geoAgentOptions: GeoAgentControlOptions = {
    ...(proxyConfig
      ? {
          defaultProvider: "openai-compatible",
          defaultModel: { "openai-compatible": proxyConfig.modelId },
          apiKeys: { "openai-compatible": proxyConfig.apiKey },
        }
      : BUNDLED_OPENAI_API_KEY
        ? { apiKeys: { "openai-responses": BUNDLED_OPENAI_API_KEY } }
        : {}),
    collapsed: pendingGeoAgentState?.collapsed ?? true,
    panelWidth: pendingGeoAgentState?.panelWidth ?? 410,
    panelHeight: pendingGeoAgentState?.panelHeight,
    title: "OPERA GeoAgent",
    storagePrefix: GEOAGENT_STORAGE_PREFIX,
    allowCodeExecutionDefault: pendingGeoAgentState?.allowCodeExecution ?? true,
    allowDestructiveToolsDefault:
      pendingGeoAgentState?.allowDestructiveTools ?? true,
    showPermissionToggles: false,
    customSystemPrompt: runtimeSystemPrompt(),
    customTools: () => createOperaAgentTools(() => operaControl),
  };
  const next = new GeoAgentControl({
    ...geoAgentOptions,
  });
  if (managedProxy) installManagedProxyModelFactory(next, managedProxy);

  if (pendingGeoAgentState) {
    next.setState({
      ...pendingGeoAgentState,
      ...(proxyConfig ? managedProxyState(proxyConfig) : {}),
    });
  } else if (proxyConfig) {
    next.setState(managedProxyState(proxyConfig));
  }
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

function aoiLabel(bbox: BBox | undefined): string {
  return bbox
    ? `AOI: ${bbox.map((value) => value.toFixed(4)).join(", ")}`
    : "No precise AOI";
}

function syncGeoAgentAoiControls(): void {
  const panel = geoAgentControl?.getPanel();
  const controls = panel?.querySelector<HTMLElement>(`.${GEOAGENT_AOI_CLASS}`);
  if (!controls) return;
  const bbox = operaControl?.getAgentAoi();
  const draw = controls.querySelector<HTMLButtonElement>(
    ".opera-geoagent-aoi-draw",
  );
  const clear = controls.querySelector<HTMLButtonElement>(
    ".opera-geoagent-aoi-clear",
  );
  const status = controls.querySelector<HTMLOutputElement>(
    ".opera-geoagent-aoi-status",
  );
  if (draw) draw.textContent = bbox ? "Redraw AOI" : "Draw AOI";
  if (clear) clear.disabled = !bbox;
  if (status) {
    status.textContent = aoiLabel(bbox);
    status.title = bbox?.join(", ") ?? "";
  }
}

function enhanceGeoAgentAoiControls(): void {
  const panel = geoAgentControl?.getPanel();
  const form = panel?.querySelector<HTMLFormElement>(".geoagent-form");
  if (!panel || !form || panel.querySelector(`.${GEOAGENT_AOI_CLASS}`)) {
    syncGeoAgentAoiControls();
    return;
  }

  const controls = document.createElement("div");
  controls.className = GEOAGENT_AOI_CLASS;

  const draw = document.createElement("button");
  draw.type = "button";
  draw.className = "opera-geoagent-aoi-draw secondary";
  draw.title = "Draw a precise analysis area on the map";
  draw.addEventListener("click", () => {
    const drawing = operaControl?.toggleAgentAoiDraw() ?? false;
    draw.textContent = drawing ? "Cancel draw" : "Draw AOI";
    const status = controls.querySelector<HTMLOutputElement>(
      ".opera-geoagent-aoi-status",
    );
    if (drawing && status) status.textContent = "Drag a rectangle on the map";
    if (!drawing) syncGeoAgentAoiControls();
  });

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "opera-geoagent-aoi-clear secondary";
  clear.textContent = "Clear AOI";
  clear.title = "Remove the current analysis area";
  clear.addEventListener("click", () => operaControl?.clearAgentAoi());

  const status = document.createElement("output");
  status.className = "opera-geoagent-aoi-status";
  status.setAttribute("aria-live", "polite");

  controls.append(draw, clear, status);
  form.parentElement?.insertBefore(controls, form);
  syncGeoAgentAoiControls();
}

// --- Mount / unmount ------------------------------------------------------

/** Add the GeoAgent companion as a floating map control (used in both modes). */
function mountGeoAgent(app: AppAPI, pos: GeoLibreMapControlPosition): boolean {
  geoAgentControl = geoAgentControl ?? createGeoAgentControl();
  const added = app.addMapControl(geoAgentControl, pos);
  if (!added) {
    geoAgentControl = null;
    return false;
  }
  enhanceGeoAgentAoiControls();
  return true;
}

/**
 * Mount the OPERA search UI as a host-managed docked right panel. Falls back to
 * floating when the host lacks a right sidebar or a map is not yet available.
 */
function mountDocked(app: AppAPI): boolean {
  const map = app.getMap?.();
  if (!app.registerRightPanel || !map) return mountFloating(app);

  operaControl = operaControl ?? createControl(app);
  const control = operaControl;
  unregisterRightPanel = app.registerRightPanel({
    id: RIGHT_PANEL_ID,
    title: "NASA OPERA",
    defaultWidth: pendingOperaState?.panelWidth ?? 340,
    render(container) {
      control.renderDocked(container, map);
      return () => control.teardownDocked();
    },
  });

  // Reveal immediately unless the saved state says the panel was collapsed.
  if (pendingOperaState?.collapsed) app.collapseRightPanel?.(RIGHT_PANEL_ID);
  else app.openRightPanel?.(RIGHT_PANEL_ID);

  // The GeoAgent chat companion stays floating alongside the docked panel.
  mountGeoAgent(app, companionPosition(position));
  mountedMode = "docked";
  return true;
}

/** Mount the OPERA search UI and GeoAgent companion as floating map controls. */
function mountFloating(app: AppAPI): boolean {
  operaControl = operaControl ?? createControl(app);
  const added = app.addMapControl(operaControl, position);
  if (!added) {
    operaControl = null;
    return false;
  }
  if (!mountGeoAgent(app, companionPosition(position))) {
    app.removeMapControl(operaControl);
    operaControl = null;
    return false;
  }
  mountedMode = "floating";
  return true;
}

/** Mount the OPERA UI in the currently requested {@link panelMode}. */
function mountOpera(app: AppAPI): boolean {
  return panelMode === "docked" ? mountDocked(app) : mountFloating(app);
}

/** Capture state and remove whichever OPERA + GeoAgent UI is mounted. */
function unmountOpera(app: AppAPI): void {
  if (geoAgentControl) {
    pendingGeoAgentState = geoAgentControl.getState();
    app.removeMapControl(geoAgentControl);
    geoAgentControl = null;
  }
  if (operaControl) {
    // Capture form state before tearing down the DOM the fields live in.
    pendingOperaState = operaControl.getState();
    if (mountedMode === "docked") {
      app.closeRightPanel?.(RIGHT_PANEL_ID);
      unregisterRightPanel?.();
      unregisterRightPanel = null;
    } else {
      app.removeMapControl(operaControl);
    }
    operaControl = null;
  }
  mountedMode = null;
}

/** Switch panel modes at runtime, remounting the UI if it is already up. */
function setPanelMode(app: AppAPI, mode: PanelMode): void {
  if (mode === panelMode && (mountedMode === null || mountedMode === mode)) {
    return;
  }
  const wasMounted = mountedMode !== null;
  if (wasMounted) unmountOpera(app);
  panelMode = mode;
  if (wasMounted) mountOpera(app);
  refreshToolbarMenu(app);
}

/** Reveal the OPERA panel regardless of mode (used by the toolbar menu). */
function revealOpera(app: AppAPI): void {
  if (mountedMode === "docked") app.openRightPanel?.(RIGHT_PANEL_ID);
  else operaControl?.expand();
}

// --- Toolbar menu ---------------------------------------------------------

/** (Re)register the Dock/Float/Open toolbar menu, or null if unsupported. */
function registerToolbarMenu(app: AppAPI): (() => void) | null {
  if (!app.registerToolbarMenu) return null;
  const canDock = typeof app.registerRightPanel === "function";
  return app.registerToolbarMenu({
    id: TOOLBAR_MENU_ID,
    label: "NASA OPERA",
    items: [
      {
        id: "dock",
        label: panelMode === "docked" ? "Dock panel ✓" : "Dock panel",
        // Disable on hosts without a right sidebar so it is not a no-op.
        disabled: !canDock || panelMode === "docked",
        onSelect: () => setPanelMode(app, "docked"),
      },
      {
        id: "float",
        label: panelMode === "floating" ? "Float panel ✓" : "Float panel",
        disabled: panelMode === "floating",
        onSelect: () => setPanelMode(app, "floating"),
      },
      { type: "separator" },
      {
        id: "open",
        label: "Open panel",
        onSelect: () => revealOpera(app),
      },
    ],
  });
}

/** Re-register the toolbar menu so its checkmarks/disabled flags reflect mode. */
function refreshToolbarMenu(app: AppAPI): void {
  disposeToolbarMenu?.();
  disposeToolbarMenu = registerToolbarMenu(app);
}

/**
 * Resolve the requested mode from a saved preference and apply it. An explicit
 * `panelMode` wins; its absence means the project predates docking, so it stays
 * floating for backward compatibility. Remounts if the UI is already up in a
 * different mode (i.e. applyProjectState arrived after activate).
 */
function applyPanelModePreference(app: AppAPI, saved: unknown): void {
  const next: PanelMode =
    saved === "docked" || saved === "floating" ? saved : "floating";
  if (mountedMode !== null && mountedMode !== next) {
    setPanelMode(app, next);
  } else {
    panelMode = next;
  }
}

// --- State guards ---------------------------------------------------------

function isOperaState(value: unknown): value is Partial<OperaState> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNasaOperaProjectState(
  value: unknown,
): value is NasaOperaProjectState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return "opera" in value || "geoAgent" in value || "panelMode" in value;
}

export const plugin: GeoLibrePlugin<GeoLibreControl> = {
  id: "geolibre-nasa-opera",
  name: "NASA OPERA",
  version: "0.3.0",
  activate(app) {
    if (!mountOpera(app)) return false;
    disposeToolbarMenu = registerToolbarMenu(app);
  },
  deactivate(app) {
    disposeToolbarMenu?.();
    disposeToolbarMenu = null;
    unmountOpera(app);
  },
  getMapControlPosition() {
    return position;
  },
  setMapControlPosition(app, nextPosition) {
    position = nextPosition;
    // A docked panel lives in the right sidebar, so the map-corner position only
    // applies while floating. (The stored value is still used when switching to
    // floating mode later, and by the GeoAgent companion.)
    if (mountedMode !== "floating" || !operaControl) return;
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
      mountedMode = null;
      return false;
    }
  },
  getProjectState() {
    return {
      opera: operaControl?.getState() ?? pendingOperaState ?? undefined,
      geoAgent:
        geoAgentControl?.getState() ?? pendingGeoAgentState ?? undefined,
      panelMode,
    } satisfies NasaOperaProjectState;
  },
  applyProjectState(app, state) {
    if (isNasaOperaProjectState(state)) {
      pendingOperaState = isOperaState(state.opera) ? state.opera : null;
      pendingGeoAgentState =
        state.geoAgent && typeof state.geoAgent === "object"
          ? state.geoAgent
          : null;
      applyPanelModePreference(app, state.panelMode);
      if (pendingOperaState) operaControl?.setState(pendingOperaState);
      if (pendingGeoAgentState) geoAgentControl?.setState(pendingGeoAgentState);
      return;
    }

    // Backward compatibility with projects saved before the GeoAgent companion
    // control existed, where the plugin state was the OPERA control state. Such
    // projects also predate docking, so they open floating.
    if (!isOperaState(state)) return false;
    pendingOperaState = state;
    applyPanelModePreference(app, undefined);
    operaControl?.setState(state);
  },
};

export default plugin;
