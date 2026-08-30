/* Slate - locking a note.

   A locked note is genuinely encrypted, not just hidden: its text, list items,
   mindmap and attached images are packed into one payload, encrypted with
   AES-GCM under a key derived from your passphrase (PBKDF2, 250k rounds), and
   the plaintext is removed from the database. The image blobs are pulled into
   the payload and deleted from the image store too, so nothing readable is
   left behind — including inside a backup file, which carries only the
   ciphertext.

   This is a vault, not a session lock: unlocking decrypts the note back to
   normal until you lock it again. There is no recovery — lose the passphrase
   and the content is gone. The UI says so before it locks anything. */
(function (global) {
  'use strict';

  var ROUNDS = 250000;
  var VERSION = 1;

  function ok() {
    return !!(global.crypto && global.crypto.subtle && global.TextEncoder);
  }

  function b64(buf) {
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function unb64(str) {
    var bin = atob(str), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function deriveKey(passphrase, salt) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey(
      'raw', enc.encode(passphrase), { name: 'PBKDF2' }, false, ['deriveKey']
    ).then(function (base) {
      return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: salt, iterations: ROUNDS, hash: 'SHA-256' },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
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

  function dataURLToBlob(url) {
    var parts = String(url).split(',');
    var mime = (parts[0].match(/:(.*?);/) || [null, 'image/png'])[1];
    var bin = atob(parts[1]), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  // Everything that must disappear when the note is locked.
  function collectPayload(note) {
    var ids = (note.images || []).slice();
    return Promise.all(ids.map(function (id) {
      return DB.get('images', id).then(function (rec) {
        if (!rec || !rec.blob) return null;
        return blobToDataURL(rec.blob).then(function (data) {
          return { id: id, w: rec.w, h: rec.h, type: rec.type, data: data };
        });
      }).catch(function () { return null; });
    })).then(function (pics) {
      return {
        body: note.body || '',
        bodyHtml: note.bodyHtml || '',
        items: note.items || [],
        map: note.map || { nodes: [], edges: [] },
        images: pics.filter(Boolean)
      };
    });
  }

  function lock(note, passphrase) {
    if (!ok()) return Promise.reject(new Error('This browser has no Web Crypto support.'));
    if (!passphrase) return Promise.reject(new Error('A passphrase is required.'));

    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv = crypto.getRandomValues(new Uint8Array(12));

    return collectPayload(note).then(function (payload) {
      return deriveKey(passphrase, salt).then(function (key) {
        var enc = new TextEncoder();
        return crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: iv }, key, enc.encode(JSON.stringify(payload))
        ).then(function (ct) {
          // Only now that the ciphertext exists do we throw the plaintext away.
          var imageIds = payload.images.map(function (p) { return p.id; });
          note.enc = { v: VERSION, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
          note.locked = true;
          note.body = '';
          note.bodyHtml = '';
          note.items = [];
          note.map = { nodes: [], edges: [] };
          note.images = [];
          return DB.put('notes', note).then(function () {
            return Promise.all(imageIds.map(function (id) { return DB.del('images', id); }));
          }).then(function () { return note; });
        });
      });
    });
  }

  function unlock(note, passphrase) {
    if (!ok()) return Promise.reject(new Error('This browser has no Web Crypto support.'));
    if (!note.enc) return Promise.reject(new Error('That note is not locked.'));

    var salt = unb64(note.enc.salt), iv = unb64(note.enc.iv), ct = unb64(note.enc.ct);
    return deriveKey(passphrase, salt).then(function (key) {
      return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ct);
    }).then(function (plain) {
      var payload = JSON.parse(new TextDecoder().decode(plain));
      var pics = payload.images || [];
      return Promise.all(pics.map(function (p) {
        return DB.put('images', {
          id: p.id, blob: dataURLToBlob(p.data), type: p.type || 'image/png',
          w: p.w, h: p.h, size: 0, createdAt: Date.now()
        });
      })).then(function () {
        note.body = payload.body || '';
        note.bodyHtml = payload.bodyHtml || '';
        note.items = payload.items || [];
        note.map = payload.map || { nodes: [], edges: [] };
        note.images = pics.map(function (p) { return p.id; });
        note.locked = false;
        delete note.enc;
        return DB.put('notes', note).then(function () { return note; });
      });
    }, function () {
      // AES-GCM fails authentication on a wrong key, so this is the wrong passphrase
      throw new Error('Wrong passphrase.');
    });
  }

  global.Lock = {
    available: ok,
    lock: lock,
    unlock: unlock
  };
})(window);
