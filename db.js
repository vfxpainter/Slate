/* Sulat — IndexedDB layer.
   Stores: folders, notes, images, meta.
   Images live in their own store so note records stay small and lists stay fast. */
(function (global) {
  'use strict';

  // The database name is a storage address, not a label. It stays 'slate'
  // from before the app was renamed to Sulat -- changing it would point the
  // app at a new, empty database and every existing note would vanish.
  var DB_NAME = 'slate';
  var DB_VERSION = 2;

  // Stamped on every note so a later change to the note shape can tell which
  // records it still has to convert. Bump this when the shape changes.
  var SCHEMA = 1;
  var _db = null;

  function uid() {
    // time-ordered id: sorts chronologically, no collisions in practice
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = req.result;
        if (!db.objectStoreNames.contains('folders')) {
          var f = db.createObjectStore('folders', { keyPath: 'id' });
          f.createIndex('parentId', 'parentId');
        }
        if (!db.objectStoreNames.contains('notes')) {
          var n = db.createObjectStore('notes', { keyPath: 'id' });
          n.createIndex('folderId', 'folderId');
          n.createIndex('updatedAt', 'updatedAt');
          n.createIndex('deletedAt', 'deletedAt');
        }
        if (!db.objectStoreNames.contains('images')) {
          db.createObjectStore('images', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        // v2: daily snapshots, keyed by date, kept on the device
        if (!db.objectStoreNames.contains('backups')) {
          db.createObjectStore('backups', { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { _db = req.result; resolve(_db); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(stores, mode) {
    return open().then(function (db) { return db.transaction(stores, mode); });
  }

  function wrap(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function all(store) {
    return tx([store], 'readonly').then(function (t) {
      return wrap(t.objectStore(store).getAll());
    });
  }

  function get(store, key) {
    return tx([store], 'readonly').then(function (t) {
      return wrap(t.objectStore(store).get(key));
    });
  }

  function put(store, value) {
    return tx([store], 'readwrite').then(function (t) {
      var p = wrap(t.objectStore(store).put(value));
      return p.then(function () { return value; });
    });
  }

  function del(store, key) {
    return tx([store], 'readwrite').then(function (t) {
      return wrap(t.objectStore(store).delete(key));
    });
  }

  function putMany(store, values) {
    if (!values.length) return Promise.resolve();
    return tx([store], 'readwrite').then(function (t) {
      var s = t.objectStore(store);
      values.forEach(function (v) { s.put(v); });
      return new Promise(function (res, rej) {
        t.oncomplete = function () { res(); };
        t.onerror = function () { rej(t.error); };
      });
    });
  }

  /* ---------- domain helpers ---------- */

  function blankNote(type, folderId) {
    var now = Date.now();
    var n = {
      id: uid(),
      schema: SCHEMA,
      type: type || 'text',
      title: '',
      folderId: folderId || null,
      body: '',
      items: [],
      map: { nodes: [], edges: [] },
      images: [],
      tags: [],
      pinned: false,
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    };
    if (n.type === 'mindmap') {
      // noteId is reserved for turning a node into its own note later on.
      // Nothing reads it yet; it just has to survive a round trip.
      n.map.nodes.push({ id: uid(), text: 'Start here', x: 0, y: 0, noteId: null });
    }
    return n;
  }

  function blankFolder(name, parentId) {
    return {
      id: uid(),
      name: name || 'New folder',
      parentId: parentId || null,
      order: Date.now(),
      createdAt: Date.now()
    };
  }

  // Store an image blob; returns the image record (without the blob copy).
  function addImage(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        var rec = {
          id: uid(),
          blob: blob,
          type: blob.type || 'image/png',
          w: img.naturalWidth,
          h: img.naturalHeight,
          size: blob.size,
          createdAt: Date.now()
        };
        URL.revokeObjectURL(url);
        put('images', rec).then(function () { resolve(rec); }, reject);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Not a readable image'));
      };
      img.src = url;
    });
  }

  // Stamp any note saved before schema tracking existed. Only touches records
  // that need it, so a library that is already current costs one read.
  function migrateNotes() {
    return all('notes').then(function (notes) {
      var stale = notes.filter(function (n) { return n.schema !== SCHEMA; });
      if (!stale.length) return { checked: notes.length, migrated: 0 };
      stale.forEach(function (n) { n.schema = SCHEMA; });
      return putMany('notes', stale).then(function () {
        return { checked: notes.length, migrated: stale.length };
      });
    });
  }

  // Delete images no longer referenced by any note (incl. trashed notes).
  function collectGarbage() {
    return Promise.all([all('notes'), all('images'), all('backups')]).then(function (r) {
      var used = Object.create(null);

      r[0].forEach(function (n) {
        (n.images || []).forEach(function (id) { used[id] = true; });
        // a picture pinned to a mindmap node counts as in use as well
        var nodes = (n.map && n.map.nodes) || [];
        nodes.forEach(function (nd) { if (nd.image) used[nd.image] = true; });
      });

      // Snapshots hold image ids rather than copies, so anything they still
      // point at has to survive, or restoring one would come back blank.
      r[2].forEach(function (row) {
        try {
          var b = JSON.parse(row.json);
          (b.images || []).forEach(function (im) { used[im.id] = true; });
        } catch (e) { /* skip a damaged row rather than delete everything */ }
      });

      var orphans = r[1].filter(function (im) { return !used[im.id]; });
      return Promise.all(orphans.map(function (im) { return del('images', im.id); }))
        .then(function () { return orphans.length; });
    });
  }

  function estimate() {
    if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(null);
    return navigator.storage.estimate().catch(function () { return null; });
  }

  global.DB = {
    SCHEMA: SCHEMA,
    uid: uid,
    open: open,
    all: all,
    get: get,
    put: put,
    del: del,
    putMany: putMany,
    blankNote: blankNote,
    blankFolder: blankFolder,
    migrateNotes: migrateNotes,
    addImage: addImage,
    collectGarbage: collectGarbage,
    estimate: estimate
  };
})(window);
