/* Quiz Studio Pro 7 — Phase 12: Reliable Versioned IndexedDB Template, Asset & Project Store */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.QuizTemplateStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DB_NAME = 'quiz-studio-pro-v2-db';
  const DB_VERSION = 2;
  const LEGACY_TEMPLATE_KEY = 'quizstudiopro_templates_v1';

  let memFallback = {
    templates: new Map(),
    assets: new Map(),
    projects: new Map()
  };

  function hasIndexedDb() {
    return typeof indexedDB !== 'undefined' && indexedDB && typeof indexedDB.open === 'function';
  }

  function openDb() {
    if (!hasIndexedDb()) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('templates')) db.createObjectStore('templates', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function txPut(storeName, record) {
    const db = await openDb();
    if (!db) {
      memFallback[storeName].set(record.id, structuredClone(record));
      return record;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  async function txGet(storeName, id) {
    const db = await openDb();
    if (!db) {
      return memFallback[storeName].get(id) || null;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function txGetAll(storeName) {
    const db = await openDb();
    if (!db) {
      return Array.from(memFallback[storeName].values());
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function txDelete(storeName, id) {
    const db = await openDb();
    if (!db) {
      memFallback[storeName].delete(id);
      return true;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('Delete transaction failed'));
    });
  }

  function makeId(prefix = 'tpl') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Separates heavy base64 assets out of template JSON into the dedicated `assets` store,
   * replacing inline payloads with `assetId` references and keeping scene JSON compact and reliable.
   */
  async function extractAndSaveAssets(scene, templateId) {
    if (!scene || typeof scene !== 'object') return [];
    const savedRefs = [];
    const assets = scene.assets && typeof scene.assets === 'object' ? scene.assets : {};
    for (const [key, data] of Object.entries(assets)) {
      if (typeof data === 'string' && data.length > 0) {
        const assetId = `${templateId}__${key}`;
        await txPut('assets', {
          id: assetId,
          templateId,
          key,
          data,
          size: data.length,
          updatedAt: new Date().toISOString()
        });
        savedRefs.push(key);
      }
    }
    return savedRefs;
  }

  async function hydrateAssetsForTemplate(template) {
    if (!template || !template.scene) return template;
    const out = structuredClone(template);
    out.scene.assets = out.scene.assets || {};
    const assetKeys = Array.isArray(out.assetKeys) ? out.assetKeys : [];
    for (const key of assetKeys) {
      if (!out.scene.assets[key]) {
        const assetRec = await txGet('assets', `${out.id}__${key}`);
        if (assetRec && assetRec.data) {
          out.scene.assets[key] = assetRec.data;
        }
      }
    }
    if (out.scene.theme && out.scene.theme.bgImage && !out.scene.assets.theme_bg) {
      out.scene.assets.theme_bg = out.scene.theme.bgImage;
    }
    return out;
  }

  /**
   * Saves a single template individually (NEVER uses store.clear()), awaits `tx.oncomplete`,
   * stores its binary/image assets, and verifies read-back before returning.
   */
  async function saveTemplate(templateData) {
    const id = (templateData && templateData.id) ? String(templateData.id) : makeId('tpl');
    const name = (templateData && templateData.name && String(templateData.name).trim())
      ? String(templateData.name).trim().slice(0, 80)
      : 'Untitled Template';

    const assetKeys = templateData.scene ? await extractAndSaveAssets(templateData.scene, id) : [];
    const strippedScene = templateData.scene ? structuredClone(templateData.scene) : null;
    if (strippedScene && strippedScene.assets) {
      // Keep small assets inline for synchronous fallback, offload large assets (>2048 bytes) via asset store
      for (const [k, v] of Object.entries(strippedScene.assets)) {
        if (typeof v === 'string' && v.length > 2048) delete strippedScene.assets[k];
      }
    }

    const record = {
      ...structuredClone(templateData),
      id,
      name,
      schemaVersion: 2,
      assetKeys,
      scene: strippedScene,
      updatedAt: new Date().toISOString(),
      createdAt: templateData.createdAt || new Date().toISOString()
    };

    await txPut('templates', record);
    const verified = await txGet('templates', id);
    if (!verified || verified.id !== id) {
      throw new Error('Template persistence verification failed after write');
    }
    return hydrateAssetsForTemplate(verified);
  }

  async function listTemplates() {
    const all = await txGetAll('templates');
    all.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    const hydrated = [];
    for (const t of all) {
      hydrated.push(await hydrateAssetsForTemplate(t));
    }
    return hydrated;
  }

  async function getTemplate(id) {
    const raw = await txGet('templates', id);
    return raw ? hydrateAssetsForTemplate(raw) : null;
  }

  async function renameTemplate(id, newName) {
    const existing = await getTemplate(id);
    if (!existing) throw new Error('Template not found');
    existing.name = String(newName || '').trim().slice(0, 80) || existing.name;
    return saveTemplate(existing);
  }

  async function duplicateTemplate(id) {
    const existing = await getTemplate(id);
    if (!existing) throw new Error('Template not found');
    const copy = structuredClone(existing);
    copy.id = makeId('tpl');
    copy.name = `${existing.name} (Copy)`.slice(0, 80);
    copy.createdAt = new Date().toISOString();
    return saveTemplate(copy);
  }

  async function deleteTemplate(id) {
    const existing = await txGet('templates', id);
    if (existing && Array.isArray(existing.assetKeys)) {
      for (const k of existing.assetKeys) {
        await txDelete('assets', `${id}__${k}`).catch(() => {});
      }
    }
    return txDelete('templates', id);
  }

  async function migrateLegacyTemplates() {
    if (typeof localStorage === 'undefined') return [];
    let legacyRaw = [];
    try {
      legacyRaw = JSON.parse(localStorage.getItem(LEGACY_TEMPLATE_KEY) || '[]');
    } catch (_) {
      legacyRaw = [];
    }
    if (!Array.isArray(legacyRaw) || !legacyRaw.length) return [];
    const existing = await txGetAll('templates');
    const existingNames = new Set(existing.map(t => t.name + '|' + (t.legacySourceIndex || '')));
    const migrated = [];
    for (let i = 0; i < legacyRaw.length; i++) {
      const t = legacyRaw[i];
      if (!t || !t.name) continue;
      if (existing.some(e => e.id === t.id || (e.isLegacyMigrated && e.name === t.name))) continue;
      if (existingNames.has(t.name + '|' + i)) continue;
      const saved = await saveTemplate({
        ...t,
        id: t.id || makeId('legacy_tpl'),
        isLegacyMigrated: true,
        legacySourceIndex: i
      });
      migrated.push(saved);
    }
    return migrated;
  }

  async function exportTemplateBundle(id) {
    const tpl = await getTemplate(id);
    if (!tpl) throw new Error('Template not found');
    return {
      app: 'Quiz Studio Pro 7 Template',
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      template: tpl
    };
  }

  async function importTemplateBundle(bundle) {
    const raw = (bundle && bundle.template) ? bundle.template : bundle;
    if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !raw.name.trim()) {
      throw new Error('Invalid template JSON schema');
    }
    return saveTemplate({
      ...raw,
      id: makeId('imp_tpl'),
      name: raw.name.trim().slice(0, 80)
    });
  }

  function resetMemoryFallbackForTests() {
    memFallback = {
      templates: new Map(),
      assets: new Map(),
      projects: new Map()
    };
  }

  return {
    DB_NAME,
    DB_VERSION,
    saveTemplate,
    listTemplates,
    getTemplate,
    renameTemplate,
    duplicateTemplate,
    deleteTemplate,
    migrateLegacyTemplates,
    exportTemplateBundle,
    importTemplateBundle,
    resetMemoryFallbackForTests
  };
});
