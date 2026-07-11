# Release checklist

- [ ] Update `app/config.js` `appVersion` and verify provider disclosures.
- [ ] Run `npm ci && npm run ci`.
- [ ] Run `npm run sbom` and review dependency hashes/licenses.
- [ ] Confirm `sw-assets.js` and `sbom.spdx.json` pass their generated-file
      freshness checks in `npm run ci`.
- [ ] Test an installed-PWA update from the previous release and accept the
      **Update available** prompt.
- [ ] Test Local coordinates mode with outbound requests blocked.
- [ ] Test online tile readiness, incomplete-tile warning, and attribution.
- [ ] Test manual coordinates, device location, camera input, and share target.
- [ ] Test keyboard-only use, 200% zoom, reduced motion, and both Playwright
      desktop/mobile projects.
- [ ] Verify `_headers` on the deployed host.
- [ ] Confirm `npm run check:deploy` includes only intended static assets and
      parses `_headers` without warnings.
- [ ] Require the `CI / trust` check and one approving review on protected
      `main`; block force pushes and branch deletion.
- [ ] Create a signed `vX.Y.Z` tag. The release workflow publishes the SBOM.
