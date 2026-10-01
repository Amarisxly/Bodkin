/* The Daily Lineup — on-device storage.
   Issues and images live in IndexedDB on this device. The API mirrors the small
   slice of the db / assets calls the page uses, so the page code stays the same. */
(function () {
  const DB_NAME = "daily-lineup", DB_VER = 1;

  function openIDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains("issues")) d.createObjectStore("issues", { keyPath: "id" });
        if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs", { keyPath: "id" });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  const tx = (idb, store, mode, fn) => new Promise((res, rej) => {
    const t = idb.transaction(store, mode), s = t.objectStore(store);
    let out; const r = fn(s);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = t.onabort = () => rej(t.error || new Error("IndexedDB transaction failed"));
  });
  const uid = () => {
    const a = new Uint8Array(12); crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, "0")).join("");
  };
  const err = (code, message) => Object.assign(new Error(message), { code });

  async function open() {
    const idb = await openIDB();
    try { await navigator.storage?.persist?.(); } catch {}

    const urls = new Map();            // blob id -> object URL
    const all = await tx(idb, "blobs", "readonly", s => s.getAll());
    (all || []).forEach(r => urls.set(r.id, URL.createObjectURL(r.blob)));
    const blobUrl = id => urls.get(id) || "";

    const listeners = new Set();
    async function emit() {
      const rows = await tx(idb, "issues", "readonly", s => s.getAll());
      const snap = { docs: (rows || []).map(r => { const { id, ...rest } = r; return { id, exists: true, data: () => rest }; }) };
      listeners.forEach(fn => { try { fn(snap); } catch (e) { console.error(e); } });
    }

    const docRef = id => ({
      id,
      async get() { const r = await tx(idb, "issues", "readonly", s => s.get(id)); if (!r) return { id, exists: false, data: () => undefined }; const { id: _, ...rest } = r; return { id, exists: true, data: () => rest }; },
      async set(data) { await tx(idb, "issues", "readwrite", s => s.put({ ...data, id })); emit(); },
      async update(data) {
        const cur = await tx(idb, "issues", "readonly", s => s.get(id));
        if (!cur) throw err("invalid_argument", "Document does not exist");
        await tx(idb, "issues", "readwrite", s => s.put({ ...cur, ...data, id })); emit();
      },
      async delete() { await tx(idb, "issues", "readwrite", s => s.delete(id)); emit(); }
    });

    const db = {
      doc(path) { const [col, id] = path.split("/"); if (col !== "issues" || !id) throw new TypeError("Unsupported path " + path); return docRef(id); },
      collection(path) {
        if (path !== "issues") throw new TypeError("Unsupported collection " + path);
        return {
          doc: id => docRef(id || uid()),
          async add(data) { const r = docRef(uid()); await r.set(data); return r; },
          onSnapshot(next) { listeners.add(next); emit(); return () => listeners.delete(next); }
        };
      }
    };

    const assets = {
      async upload(blob, opts = {}) {
        if (!(blob instanceof Blob) || !blob.size) throw err("invalid_request", "Empty file");
        const type = opts.type || blob.type || "application/octet-stream";
        const id = uid();
        const stored = blob.type === type ? blob : new Blob([blob], { type });
        try { await tx(idb, "blobs", "readwrite", s => s.put({ id, blob: stored, type, createdAt: Date.now() })); }
        catch (e) { throw err(e && e.name === "QuotaExceededError" ? "quota_or_state" : "upstream_error", String(e && e.message || e)); }
        const url = URL.createObjectURL(stored); urls.set(id, url);
        return { id, url, sizeBytes: stored.size, contentType: type };
      },
      async delete(id) {
        await tx(idb, "blobs", "readwrite", s => s.delete(id));
        const u = urls.get(id); if (u) URL.revokeObjectURL(u); urls.delete(id);
        return { deleted: true };
      }
    };

    /* raw access for backup / restore */
    const raw = {
      issues: () => tx(idb, "issues", "readonly", s => s.getAll()),
      blob: async id => (await tx(idb, "blobs", "readonly", s => s.get(id)))?.blob || null,
      hasBlob: async id => !!(await tx(idb, "blobs", "readonly", s => s.getKey(id))),
      async putBlob(id, blob) { await tx(idb, "blobs", "readwrite", s => s.put({ id, blob, type: blob.type, createdAt: Date.now() })); if (!urls.has(id)) urls.set(id, URL.createObjectURL(blob)); },
      getIssue: id => tx(idb, "issues", "readonly", s => s.get(id)),
      putIssue: row => tx(idb, "issues", "readwrite", s => s.put(row)),
      refresh: emit,
      async usage() { try { const e = await navigator.storage.estimate(); return e; } catch { return null; } },
      async persisted() { try { return await navigator.storage.persisted(); } catch { return false; } }
    };

    return { db, assets, blobUrl, raw };
  }

  window.LocalStore = { open };
})();
