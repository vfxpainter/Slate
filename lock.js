/* Sulat - locking a note.

   A locked note is genuinely encrypted, not just hidden: its text, list items,
   mindmap and attached images are packed into one payload, encrypted with
   AES-GCM under a key derived from your password (PBKDF2, 250k rounds), and
   the plaintext is removed from the database. The image blobs are pulled into
   the payload and deleted from the image store too, so nothing readable is
   left behind — including inside a backup file, which carries only the
   ciphertext.

   This is a vault, not a session lock: unlocking decrypts the note back to
   normal until you lock it again. There is no recovery — lose the password
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

  /* `recoveryCode` is optional. When given, the same payload is encrypted a
     second time under it, so either the password or the code opens the note.
     Two locks on one door -- not a master key we hold. */
  function lock(note, passphrase, recoveryCode) {
    if (!ok()) return Promise.reject(new Error('This browser has no Web Crypto support.'));
    if (!passphrase) return Promise.reject(new Error('A password is required.'));

    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var rSalt = crypto.getRandomValues(new Uint8Array(16));
    var rIv = crypto.getRandomValues(new Uint8Array(12));

    return collectPayload(note).then(function (payload) {
      var enc = new TextEncoder();
      var plain = enc.encode(JSON.stringify(payload));

      var rec = recoveryCode
        ? deriveKey(normaliseCode(recoveryCode), rSalt).then(function (rKey) {
            return crypto.subtle.encrypt({ name: 'AES-GCM', iv: rIv }, rKey, plain);
          }).then(function (rCt) {
            return { salt: b64(rSalt), iv: b64(rIv), ct: b64(rCt) };
          })
        : Promise.resolve(null);

      return deriveKey(passphrase, salt).then(function (key) {
        return crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: iv }, key, plain
        ).then(function (ct) {
          return rec.then(function (recovery) {
          // Only now that the ciphertext exists do we throw the plaintext away.
          var imageIds = payload.images.map(function (p) { return p.id; });
          note.enc = { v: VERSION, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
          if (recovery) note.enc.rec = recovery;
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
    });
  }

  /* Accepts either the password or the recovery code -- whichever the person
     still has. Both are tried before giving up, so they do not have to tell us
     which one they are typing. */
  function unlock(note, secret) {
    if (!ok()) return Promise.reject(new Error('This browser has no Web Crypto support.'));
    if (!note.enc) return Promise.reject(new Error('That note is not locked.'));

    function tryKey(pass, saltB64, ivB64, ctB64) {
      return deriveKey(pass, unb64(saltB64)).then(function (key) {
        return crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: unb64(ivB64) }, key, unb64(ctB64)
        );
      });
    }

    var e = note.enc;
    return tryKey(secret, e.salt, e.iv, e.ct).catch(function () {
      if (!e.rec) throw new Error('Wrong password.');
      return tryKey(normaliseCode(secret), e.rec.salt, e.rec.iv, e.rec.ct);
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
      // AES-GCM fails authentication on a wrong key: neither secret fitted
      throw new Error('Wrong password or recovery code.');
    });
  }

  /* ---------- encrypting a whole backup ----------
     Same primitives as a locked note: AES-GCM under a PBKDF2 key. What is
     different is the stakes. A backup password protects a copy, not the
     original -- your notes stay on the device in the clear -- so forgetting it
     costs you that one file and nothing else. That is why there is a plain
     "wrong password" answer here rather than a warning about losing everything.

     The envelope carries a verifier: a short known string encrypted under the
     same key. Checking it lets import say "wrong password" straight away
     instead of handing back a megabyte of noise. */
  var VERIFY = 'sulat-backup-v1';

  function encryptBundle(text, password) {
    if (!ok()) return Promise.reject(new Error('This browser cannot encrypt.'));
    if (!password) return Promise.reject(new Error('A password is required.'));
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var vIv = crypto.getRandomValues(new Uint8Array(12));
    var enc = new TextEncoder();
    return deriveKey(password, salt).then(function (key) {
      return Promise.all([
        crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(text)),
        crypto.subtle.encrypt({ name: 'AES-GCM', iv: vIv }, key, enc.encode(VERIFY))
      ]);
    }).then(function (parts) {
      return {
        format: 'sulat-encrypted',
        version: 1,
        kdf: { name: 'PBKDF2', hash: 'SHA-256', rounds: ROUNDS, salt: b64(salt) },
        verify: { iv: b64(vIv), data: b64(new Uint8Array(parts[1])) },
        iv: b64(iv),
        data: b64(new Uint8Array(parts[0]))
      };
    });
  }

  function decryptBundle(env, password) {
    if (!ok()) return Promise.reject(new Error('This browser cannot decrypt.'));
    var dec = new TextDecoder();
    var salt = unb64(env.kdf && env.kdf.salt);
    return deriveKey(password, salt).then(function (key) {
      return crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: unb64(env.verify.iv) }, key, unb64(env.verify.data)
      ).then(function (v) {
        if (dec.decode(v) !== VERIFY) throw new Error('Wrong password.');
        return crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: unb64(env.iv) }, key, unb64(env.data)
        );
      }).catch(function () { throw new Error('Wrong password.'); });
    }).then(function (buf) { return dec.decode(buf); });
  }

  /* ---------- a way back into a locked note ----------
     A recovery code is a second key to the same note, not a back door: the
     note is simply encrypted twice, once under the password and once under a
     long random code you keep somewhere safe. Nobody who lacks both can read
     it, and we cannot recover it for you either.

     Ambiguous characters are left out of the alphabet, because this gets
     written down and read back by a person. */
  var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function makeRecoveryCode() {
    var bytes = crypto.getRandomValues(new Uint8Array(20));
    var out = [];
    for (var i = 0; i < bytes.length; i++) {
      out.push(CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]);
      if (out.length % 5 === 4 && i < bytes.length - 1) out.push('-');
    }
    return out.join('');
  }

  function normaliseCode(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  global.Lock = {
    available: ok,
    lock: lock,
    unlock: unlock,
    encryptBundle: encryptBundle,
    decryptBundle: decryptBundle,
    makeRecoveryCode: makeRecoveryCode,
    normaliseCode: normaliseCode
  };
})(window);
