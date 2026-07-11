(function (root) {
  "use strict";

  const encoder = new TextEncoder();

  function abortError(message) {
    return new DOMException(message || "Cancelled", "AbortError");
  }

  class TaskQueue {
    constructor({ concurrency = 1, minIntervalMs = 0, onProgress = null } = {}) {
      this.concurrency = Math.max(1, concurrency);
      this.minIntervalMs = Math.max(0, minIntervalMs);
      this.onProgress = onProgress;
      this.pending = [];
      this.active = 0;
      this.completed = 0;
      this.lastStart = 0;
      this.timer = null;
    }

    enqueue(task, { signal } = {}) {
      if (signal && signal.aborted) return Promise.reject(abortError());
      return new Promise((resolve, reject) => {
        const job = { task, signal, resolve, reject, cancelled: false };
        if (signal) {
          job.onAbort = () => {
            job.cancelled = true;
            const index = this.pending.indexOf(job);
            if (index >= 0) {
              this.pending.splice(index, 1);
              reject(abortError());
              this._notify();
            }
          };
          signal.addEventListener("abort", job.onAbort, { once: true });
        }
        this.pending.push(job);
        this._notify();
        this._drain();
      });
    }

    cancelPending(message) {
      const jobs = this.pending.splice(0);
      for (const job of jobs) {
        job.cancelled = true;
        if (job.signal && job.onAbort) job.signal.removeEventListener("abort", job.onAbort);
        job.reject(abortError(message));
      }
      this._notify();
    }

    _notify() {
      if (this.onProgress) {
        this.onProgress({ pending: this.pending.length, active: this.active, completed: this.completed });
      }
    }

    _drain() {
      if (this.timer || this.active >= this.concurrency || !this.pending.length) return;
      const wait = Math.max(0, this.minIntervalMs - (Date.now() - this.lastStart));
      if (wait) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this._drain();
        }, wait);
        return;
      }
      const job = this.pending.shift();
      if (!job || job.cancelled || (job.signal && job.signal.aborted)) {
        if (job && !job.cancelled) job.reject(abortError());
        this._notify();
        this._drain();
        return;
      }
      this.active += 1;
      this.lastStart = Date.now();
      this._notify();
      Promise.resolve()
        .then(() => job.task(job.signal))
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active -= 1;
          this.completed += 1;
          if (job.signal && job.onAbort) job.signal.removeEventListener("abort", job.onAbort);
          this._notify();
          this._drain();
        });
      this._drain();
    }
  }

  function coordinateDecimals(accuracyMeters) {
    if (!Number.isFinite(accuracyMeters) || accuracyMeters <= 0) return 5;
    return Math.max(3, Math.min(6, Math.ceil(Math.log10(111320 / accuracyMeters))));
  }

  function formatCoordinate(value, accuracyMeters) {
    return Number(value).toFixed(coordinateDecimals(accuracyMeters));
  }

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const toRad = value => value * Math.PI / 180;
    const p1 = toRad(lat1), p2 = toRad(lat2);
    const dp = toRad(lat2 - lat1), dl = toRad(lon2 - lon1);
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function navigationUrl(config, record) {
    const lat = Number(record.lat), lon = Number(record.lon);
    if (config.navigationBaseUrl) {
      const url = new URL(config.navigationBaseUrl, root.location ? root.location.href : "https://example.invalid/");
      url.searchParams.set("lat", String(lat));
      url.searchParams.set("lon", String(lon));
      url.searchParams.set("id", record.recordId || "");
      return url.href;
    }
    return `geo:${lat},${lon}?q=${lat},${lon}(${encodeURIComponent(record.recordId || "GeoTag")})`;
  }

  function shareText(config, record) {
    const accuracy = Number.isFinite(record.accuracy) ? ` (±${Math.round(record.accuracy)} m)` : "";
    return [
      record.recordId || "GeoTag record",
      `${formatCoordinate(record.lat, record.accuracy)}, ${formatCoordinate(record.lon, record.accuracy)}${accuracy}`,
      navigationUrl(config, record)
    ].join("\n");
  }

  function csvCell(value) {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function recordsToCsv(records) {
    const keys = ["recordId", "sourceFilename", "capturedAt", "timezone", "latitude", "longitude", "originalLatitude", "originalLongitude", "accuracyMeters", "displacementMeters", "adjustmentReason", "caption", "mapProvider", "appVersion", "navigationUrl"];
    return [keys.join(","), ...records.map(record => keys.map(key => csvCell(record[key])).join(","))].join("\r\n") + "\r\n";
  }

  function recordsToGeoJson(records) {
    return {
      type: "FeatureCollection",
      features: records.map(record => ({
        type: "Feature",
        id: record.recordId,
        geometry: { type: "Point", coordinates: [record.longitude, record.latitude] },
        properties: Object.fromEntries(Object.entries(record).filter(([key]) => !["latitude", "longitude"].includes(key)))
      }))
    };
  }

  function crcTable() {
    if (crcTable.value) return crcTable.value;
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    crcTable.value = table;
    return table;
  }

  function crc32(bytes) {
    const table = crcTable();
    let crc = 0xffffffff;
    for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  function zipHeader(size, nameLength, crc, offset, central, date) {
    const length = central ? 46 : 30;
    const bytes = new Uint8Array(length);
    const view = new DataView(bytes.buffer);
    let p = 0;
    const u16 = value => { view.setUint16(p, value, true); p += 2; };
    const u32 = value => { view.setUint32(p, value >>> 0, true); p += 4; };
    u32(central ? 0x02014b50 : 0x04034b50);
    if (central) u16(20);
    u16(20); u16(0); u16(0); u16(date.time); u16(date.date); u32(crc);
    u32(size); u32(size); u16(nameLength); u16(0);
    if (central) { u16(0); u16(0); u16(0); u32(0); u32(offset); }
    return bytes;
  }

  async function createZip(entries) {
    const local = [], central = [];
    let offset = 0;
    for (const entry of entries) {
      const name = encoder.encode(entry.name.replace(/\\/g, "/"));
      const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(await entry.data.arrayBuffer());
      const crc = crc32(data), stamp = dosDateTime(entry.date);
      const localHeader = zipHeader(data.length, name.length, crc, offset, false, stamp);
      local.push(localHeader, name, data);
      central.push(zipHeader(data.length, name.length, crc, offset, true, stamp), name);
      offset += localHeader.length + name.length + data.length;
    }
    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const view = new DataView(end.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, entries.length, true);
    view.setUint16(10, entries.length, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, offset, true);
    return new Blob([...local, ...central, end], { type: "application/zip" });
  }

  function concatBytes(parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
  }

  async function createPdf(jpegPages) {
    const objects = new Map();
    const pageIds = jpegPages.map((_, index) => 3 + index * 3);
    objects.set(1, encoder.encode("<< /Type /Catalog /Pages 2 0 R >>"));
    objects.set(2, encoder.encode(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`));

    for (let index = 0; index < jpegPages.length; index += 1) {
      const page = jpegPages[index];
      const pageId = 3 + index * 3, imageId = pageId + 1, contentId = pageId + 2;
      const maxW = 564, maxH = 744;
      const scale = Math.min(maxW / page.width, maxH / page.height);
      const width = page.width * scale, height = page.height * scale;
      const x = (612 - width) / 2, y = (792 - height) / 2;
      const content = encoder.encode(`q ${width.toFixed(2)} 0 0 ${height.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im0 Do Q`);
      objects.set(pageId, encoder.encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`));
      objects.set(imageId, concatBytes([
        encoder.encode(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`),
        page.bytes,
        encoder.encode("\nendstream")
      ]));
      objects.set(contentId, concatBytes([
        encoder.encode(`<< /Length ${content.length} >>\nstream\n`), content, encoder.encode("\nendstream")
      ]));
    }

    const parts = [encoder.encode("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n")];
    const offsets = [0];
    let length = parts[0].length;
    const maxId = Math.max(...objects.keys());
    for (let id = 1; id <= maxId; id += 1) {
      offsets[id] = length;
      const part = concatBytes([encoder.encode(`${id} 0 obj\n`), objects.get(id), encoder.encode("\nendobj\n")]);
      parts.push(part); length += part.length;
    }
    const xrefOffset = length;
    const rows = ["0000000000 65535 f \n", ...offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`)];
    parts.push(encoder.encode(`xref\n0 ${maxId + 1}\n${rows.join("")}trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
    return new Blob(parts, { type: "application/pdf" });
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  root.GeoTagRuntime = {
    TaskQueue,
    coordinateDecimals,
    formatCoordinate,
    haversineMeters,
    navigationUrl,
    shareText,
    recordsToCsv,
    recordsToGeoJson,
    createZip,
    createPdf,
    downloadBlob
  };
})(typeof window !== "undefined" ? window : globalThis);
