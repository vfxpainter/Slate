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

  /* ---------- when IndexedDB is not allowed ----------
     Chrome gives a page opened straight off the disk (file://) an opaque
     origin and refuses IndexedDB there -- which is exactly how the single-file
     build gets used on a machine where nothing can be installed. Failing there
     would look like the app working until the first reload, then losing
     everything, so fall back to localStorage instead.

     It is a fallback, not a choice: perhaps 5 MB against IndexedDB's hundreds,
     and blobs have to be held as text. Images cost about a third more that way,
     so a library with photographs will fill it. isFallback() lets the app say
     so rather than let someone find out the hard way. */

  var KEY_PATH = { folders: 'id', notes: 'id', images: 'id', backups: 'id', meta: 'key' };
  var LS_PREFIX = 'sulat-store-';
  var _mode = null;                     // 'idb' | 'local', decided once

  function lsRead(store) {
    try { return JSON.parse(localStorage.getItem(LS_PREFIX + store) || '{}'); }
    catch (e) { return {}; }
  }

  function lsWrite(store, obj) {
    try {
      localStorage.setItem(LS_PREFIX + store, JSON.stringify(obj));
    } catch (e) {
      throw new Error('This copy of Sulat is out of space. Export a backup, ' +
                      'then remove some images or notes.');
    }
  }

  // Blobs do not survive JSON, so images travel as data URLs in this mode.
  function deflate(value) {
    if (!value || !(value.blob instanceof Blob)) return Promise.resolve(value);
    return blobToDataURL(value.blob).then(function (url) {
      var copy = {};
      for (var k in value) if (k !== 'blob') copy[k] = value[k];
      copy._blobURL = url;
      return copy;
    });
  }

  function inflate(value) {
    if (!value || !value._blobURL) return Promise.resolve(value);
    return fetch(value._blobURL).then(function (r) { return r.blob(); })
      .then(function (blob) {
        var copy = {};
        for (var k in value) if (k !== '_blobURL') copy[k] = value[k];
        copy.blob = blob;
        return copy;
      });
  }

  function blobToDataURL(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(fr.error); };
      fr.readAsDataURL(blob);
    });
  }

  var LOCAL = {
    all: function (store) {
      var obj = lsRead(store);
      return Promise.all(Object.keys(obj).map(function (k) { return inflate(obj[k]); }));
    },
    get: function (store, key) {
      return inflate(lsRead(store)[key]);
    },
    put: function (store, value) {
      return deflate(value).then(function (flat) {
        var obj = lsRead(store);
        obj[value[KEY_PATH[store] || 'id']] = flat;
        lsWrite(store, obj);
        return value;
      });
    },
    del: function (store, key) {
      var obj = lsRead(store);
      delete obj[key];
      lsWrite(store, obj);
      return Promise.resolve();
    },
    putMany: function (store, values) {
      return Promise.all(values.map(deflate)).then(function (flats) {
        var obj = lsRead(store);
        flats.forEach(function (f, i) {
          obj[values[i][KEY_PATH[store] || 'id']] = f;
        });
        lsWrite(store, obj);
      });
    }
  };

  /* Settle on a backend once, on the first call.

     This probes with open() rather than a bare indexedDB.open: a second opener
     that does not build the object stores would create the database empty, and
     because the version then already matches, the real open() would skip its
     upgrade and every transaction afterwards would fail on a missing store.

     An opaque origin throws synchronously in some builds and errors
     asynchronously in others, so both paths are caught; the timeout covers a
     third case, where the request neither succeeds nor errors. */
  var _probe = null;

  function backend() {
    if (_mode) return Promise.resolve(_mode);
    if (_probe) return _probe;
    _probe = new Promise(function (resolve) {
      var settled = false;
      function pick(m) { if (!settled) { settled = true; _mode = m; resolve(m); } }
      setTimeout(function () { pick('local'); }, 5000);
      try {
        open().then(function () { pick('idb'); }, function () { pick('local'); });
      } catch (e) {
        pick('local');
      }
    });
    return _probe;
  }

  function isFallback() { return _mode === 'local'; }

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
    return backend().then(function (m) {
      if (m === 'local') return LOCAL.all(store);
      return tx([store], 'readonly').then(function (t) {
        return wrap(t.objectStore(store).getAll());
      });
    });
  }

  function get(store, key) {
    return backend().then(function (m) {
      if (m === 'local') return LOCAL.get(store, key);
      return tx([store], 'readonly').then(function (t) {
        return wrap(t.objectStore(store).get(key));
      });
    });
  }

  function put(store, value) {
    return backend().then(function (m) {
      if (m === 'local') return LOCAL.put(store, value);
      return tx([store], 'readwrite').then(function (t) {
        var p = wrap(t.objectStore(store).put(value));
        return p.then(function () { return value; });
      });
    });
  }

  function del(store, key) {
    return backend().then(function (m) {
      if (m === 'local') return LOCAL.del(store, key);
      return tx([store], 'readwrite').then(function (t) {
        return wrap(t.objectStore(store).delete(key));
      });
    });
  }

  function putMany(store, values) {
    if (!values.length) return Promise.resolve();
    return backend().then(function (m) {
      if (m === 'local') return LOCAL.putMany(store, values);
      return putManyIDB(store, values);
    });
  }

  function putManyIDB(store, values) {
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

  /* ---------- shrink a picture on the way in ----------
     A phone camera file is several megabytes and far larger than anything the
     app ever draws, and every one of those bytes lands in your backup at a
     further +33% once it is written as base64. Re-encode anything oversized
     to WebP at a sane ceiling. The original is kept whenever re-encoding does
     not actually help, so this can never make a file bigger. */
  var IMG_MAX_DIM = 2048;
  var IMG_KEEP_UNDER = 300 * 1024;      // small files are left completely alone

  function shrinkImage(blob) {
    if (!blob || blob.size < IMG_KEEP_UNDER) return Promise.resolve(blob);
    if (typeof createImageBitmap !== 'function') return Promise.resolve(blob);
    return createImageBitmap(blob).then(function (bm) {
      var scale = Math.min(1, IMG_MAX_DIM / Math.max(bm.width, bm.height));
      var w = Math.max(1, Math.round(bm.width * scale));
      var h = Math.max(1, Math.round(bm.height * scale));
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(bm, 0, 0, w, h);
      bm.close && bm.close();
      return new Promise(function (res) {
        c.toBlob(function (out) {
          // only take the new one if it is genuinely smaller
          res(out && out.size < blob.size ? out : blob);
        }, 'image/webp', 0.82);
      });
    }).catch(function () { return blob; });   // unreadable: store what we were given
  }

  // Store an image blob; returns the image record (without the blob copy).
  function addImage(rawBlob) {
    return shrinkImage(rawBlob).then(function (blob) { return storeImage(blob); });
  }

  function storeImage(blob) {
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
    if (isFallback()) {
      // navigator.storage does not describe localStorage, so measure it.
      var used = 0;
      try {
        for (var k in localStorage) {
          if (k.indexOf(LS_PREFIX) === 0) used += (localStorage[k] || '').length * 2;
        }
      } catch (e) { return Promise.resolve(null); }
      return Promise.resolve({ usage: used, quota: 5 * 1024 * 1024, fallback: true });
    }
    if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(null);
    return navigator.storage.estimate().catch(function () { return null; });
  }

  global.DB = {
    SCHEMA: SCHEMA,
    uid: uid,
    open: open,
    isFallback: isFallback,
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
