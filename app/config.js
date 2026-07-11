(function (root) {
  "use strict";

  // Deployers may replace values before `npm run build`. Keep provider URLs,
  // attribution, disclosure text, and offline-cache permission together.
  const supplied = root.GEOTAG_CONFIG || {};
  const defaults = {
    appVersion: "0.2.0",
    buildId: root.GEOTAG_BUILD_ID || "development",
    privacyDefault: "local",
    navigationBaseUrl: "",
    maxFiles: 25,
    maxFileBytes: 30 * 1024 * 1024,
    maxPixels: 40 * 1000 * 1000,
    processingConcurrency: 2,
    providers: {
      osm: {
        enabled: true,
        label: "OpenStreetMap Standard",
        url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        maxZoom: 19,
        attributionHtml: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
        attributionText: "© OpenStreetMap contributors",
        disclosure: "Visible map tiles reveal tile coordinates, your IP address, and this site's browser referrer to tile.openstreetmap.org.",
        allowOfflineCache: false,
        reportIssueUrl: "https://www.openstreetmap.org/fixthemap"
      },
      satellite: {
        enabled: false,
        label: "Approved satellite service (not configured)",
        url: "",
        maxZoom: 19,
        attributionHtml: "",
        attributionText: "",
        disclosure: "Configure an approved internal or commercial satellite provider at deployment time.",
        allowOfflineCache: false,
        reportIssueUrl: ""
      },
      topo: {
        enabled: false,
        label: "Approved topographic service (not configured)",
        url: "",
        maxZoom: 17,
        attributionHtml: "",
        attributionText: "",
        disclosure: "Configure an approved internal or commercial topographic provider at deployment time.",
        allowOfflineCache: false,
        reportIssueUrl: ""
      }
    },
    geocoder: {
      enabled: false,
      label: "No approved address provider configured",
      url: "",
      attributionText: "",
      disclosure: "Address lookup is disabled until deployment supplies an approved, centrally rate-limited provider.",
      minIntervalMs: 1100
    }
  };

  const providerKeys = new Set([...Object.keys(defaults.providers), ...Object.keys(supplied.providers || {})]);
  const providers = Object.fromEntries([...providerKeys].map(key => [
    key,
    { ...(defaults.providers[key] || {}), ...((supplied.providers || {})[key] || {}) }
  ]));

  root.GEOTAG_CONFIG = {
    ...defaults,
    ...supplied,
    // Local-first is a product invariant, not a deployer preference.
    privacyDefault: "local",
    providers,
    geocoder: { ...defaults.geocoder, ...(supplied.geocoder || {}) }
  };
})(typeof self !== "undefined" ? self : window);
