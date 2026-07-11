"use strict";

if ("serviceWorker" in navigator) {
  const updateBar = document.getElementById("updateBar");
  const reloadButton = document.getElementById("updateReload");
  let registration = null;
  let reloadRequested = false;

  function showUpdate(worker) {
    if (!worker) return;
    updateBar.classList.add("show");
    reloadButton.onclick = () => {
      reloadRequested = true;
      worker.postMessage({ type: "SKIP_WAITING" });
    };
  }

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadRequested) location.reload();
  });

  window.addEventListener("load", async () => {
    try {
      registration = await navigator.serviceWorker.register("sw.js");
      if (registration.waiting && navigator.serviceWorker.controller) showUpdate(registration.waiting);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdate(worker);
        });
      });
      registration.update().catch(() => {});
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") registration.update().catch(() => {});
      });
    } catch (error) {
      console.warn("Service-worker registration failed", error);
    }
  });
}
