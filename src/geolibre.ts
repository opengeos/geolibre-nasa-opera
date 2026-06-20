import { OperaControl, type OperaState } from "./lib/core/OperaControl";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "./lib/geolibre/host-api";
import type { BBox } from "./lib/opera/types";
import "./lib/styles/plugin-control.css";

// Bind the host API generic to this plugin's concrete control type.
type AppAPI = GeoLibreAppAPI<OperaControl>;

let control: OperaControl | null = null;
let position: GeoLibreMapControlPosition = "top-left";
let pendingState: Partial<OperaState> | null = null;

function createControl(app: AppAPI): OperaControl {
  const next = new OperaControl({
    // Open the panel immediately when the user activates the plugin so the
    // search UI is visible right away, rather than only pinning the toolbar
    // icon. A restored project (or a prior session) can still start collapsed
    // by carrying `collapsed: true` in its saved state.
    collapsed: pendingState?.collapsed ?? false,
    panelWidth: pendingState?.panelWidth ?? 340,
    title: "NASA OPERA",
    // Bind host capabilities; each degrades to a no-op when the host (or
    // standalone usage) does not provide it.
    addGeoJsonLayer: (name, data) => app.addGeoJsonLayer?.(name, data),
    registerLayer: (layer) => app.registerExternalNativeLayer?.(layer),
    unregisterLayer: (id) => app.unregisterExternalNativeLayer?.(id),
    fitBounds: (bounds) => app.fitBounds?.(bounds),
    getMapBounds: () => readMapBounds(app),
  });

  if (pendingState) next.setState(pendingState);
  return next;
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

export const plugin: GeoLibrePlugin<OperaControl> = {
  id: "geolibre-nasa-opera",
  name: "NASA OPERA",
  version: "0.2.1",
  activate(app) {
    control = control ?? createControl(app);
    const added = app.addMapControl(control, position);
    if (!added) {
      control = null;
      return false;
    }
  },
  deactivate(app) {
    if (!control) return;
    pendingState = control.getState();
    app.removeMapControl(control);
    control = null;
  },
  getMapControlPosition() {
    return position;
  },
  setMapControlPosition(app, nextPosition) {
    position = nextPosition;
    if (!control) return;
    app.removeMapControl(control);
    const added = app.addMapControl(control, position);
    if (!added) {
      pendingState = control.getState();
      control = null;
      return false;
    }
  },
  getProjectState() {
    return control?.getState() ?? pendingState ?? undefined;
  },
  applyProjectState(_app, state) {
    if (!isOperaState(state)) return false;
    pendingState = state;
    control?.setState(state);
  },
};

export default plugin;
