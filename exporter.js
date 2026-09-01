/* Sulat - export & import.
   PDF goes through the browser print pipeline (Save as PDF) because it gives
   real pagination and typography without shipping a PDF library. Everything
   else is generated as a Blob and downloaded. */
(function (global) {
  'use strict';

  var BUNDLE_FORMAT = 'sulat-bundle';
  // 'slate-bundle' is what the app wrote before it was renamed; backups
  // made back then must still import.
  var BUNDLE_FORMATS = ['sulat-bundle', 'slate-bundle'];
  var BUNDLE_VERSION = 1;

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function slug(s, fallback) {
    var out = String(s || '').trim().toLowerCase()
      .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 60);
    return out || fallback || 'sulat';
  }

  function stamp() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function download(filename, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }

  function dataURLToBlob(dataURL) {
    var parts = String(dataURL).split(',');
    var mime = (parts[0].match(/:(.*?);/) || [null, 'image/png'])[1];
    var bin = atob(parts[1]);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  // Resolve every image referenced by the given notes into { id: dataURL }.
  function resolveImages(notes) {
    var ids = [];
    notes.forEach(function (n) {
      (n.images || []).forEach(function (id) {
        if (ids.indexOf(id) === -1) ids.push(id);
      });
    });
    return Promise.all(ids.map(function (id) {
      return DB.get('images', id).then(function (rec) {
        if (!rec || !rec.blob) return null;
        return blobToDataURL(rec.blob).then(function (u) {
          return { id: id, url: u, w: rec.w, h: rec.h };
        });
      }).catch(function () { return null; });
    })).then(function (list) {
      var map = {};
      list.forEach(function (r) { if (r) map[r.id] = r; });
      return map;
    });
  }

  // Just the sizes, for a bundle that only needs to name its images.
  function listImageMeta(notes) {
    var ids = [];
    notes.forEach(function (n) {
      (n.images || []).forEach(function (id) { if (ids.indexOf(id) === -1) ids.push(id); });
      var nodes = (n.map && n.map.nodes) || [];
      nodes.forEach(function (nd) {
        if (nd.image && ids.indexOf(nd.image) === -1) ids.push(nd.image);
      });
    });
    return Promise.all(ids.map(function (id) {
      return DB.get('images', id).then(function (rec) {
        return rec ? { id: id, w: rec.w, h: rec.h } : null;
      }).catch(function () { return null; });
    })).then(function (list) {
      var map = {};
      list.forEach(function (r) { if (r) map[r.id] = r; });
      return map;
    });
  }

  /* ---------- plain text / markdown ---------- */

  function noteToMarkdown(note, opts) {
    opts = opts || {};
    var out = [];
    out.push('# ' + (note.title || 'Untitled'));
    out.push('');
    if (opts.dates !== false) {
      out.push('*' + (opts.fmtDate ? opts.fmtDate(note.updatedAt)
                                   : new Date(note.updatedAt).toLocaleString()) + '*');
      out.push('');
    }
    if (note.type === 'list') {
      (note.items || []).forEach(function (it) {
        var indent = '  '.repeat(it.indent || 0);
        out.push(indent + '- [' + (it.done ? 'x' : ' ') + '] ' + (it.done ? '~~' + it.text + '~~' : it.text));
      });
    } else if (note.type === 'mindmap') {
      out.push(mapToOutline(note.map, '  '));
    } else {
      out.push(note.body || '');
    }
    if ((note.images || []).length) {
      out.push('');
      out.push('---');
      out.push('');
      out.push('_' + note.images.length + ' image' + (note.images.length === 1 ? '' : 's') +
        ' attached (kept in the .json backup; not embedded in Markdown)._');
    }
    return out.join('\n');
  }

  function noteToText(note) {
    var out = [];
    out.push(note.title || 'Untitled');
    out.push('='.repeat(Math.max(3, (note.title || 'Untitled').length)));
    out.push('');
    if (note.type === 'list') {
      (note.items || []).forEach(function (it) {
        out.push('  '.repeat(it.indent || 0) + (it.done ? '[x] ' : '[ ] ') + it.text);
      });
    } else if (note.type === 'mindmap') {
      out.push(mapToOutline(note.map, '  '));
    } else {
      out.push(note.body || '');
    }
    return out.join('\n');
  }

  // Flatten a mindmap into an indented outline. Roots = nodes with no parent
  // edge; anything left over (cycles / islands) is appended so nothing is lost.
  function mapToOutline(map, pad) {
    if (!map || !map.nodes || !map.nodes.length) return '';
    var nodes = {}, childOf = {}, hasParent = {};
    map.nodes.forEach(function (n) { nodes[n.id] = n; childOf[n.id] = []; });
    (map.edges || []).forEach(function (e) {
      if (!nodes[e.a] || !nodes[e.b]) return;
      childOf[e.a].push(e.b);
      hasParent[e.b] = true;
    });
    var lines = [], seen = {};
    function walk(id, depth) {
      if (seen[id] || depth > 24) return;
      seen[id] = true;
      lines.push(pad.repeat(depth) + '- ' + (nodes[id].text || ''));
      childOf[id].forEach(function (c) { walk(c, depth + 1); });
    }
    map.nodes.forEach(function (n) { if (!hasParent[n.id]) walk(n.id, 0); });
    map.nodes.forEach(function (n) { if (!seen[n.id]) walk(n.id, 0); });
    return lines.join('\n');
  }

  /* ---------- HTML rendering (shared by .html export and print/PDF) ---------- */

  function noteBodyHTML(note, imgs, opts) {
    var h = [];
    if (note.type === 'list') {
      h.push('<ul class="s-list">');
      (note.items || []).forEach(function (it) {
        h.push('<li class="lvl-' + Math.min(4, it.indent || 0) + (it.done ? ' done' : '') + '">' +
          '<span class="box">' + (it.done ? '&#10003;' : '') + '</span>' +
          '<span class="txt">' + esc(it.text) + '</span></li>');
      });
      h.push('</ul>');
    } else if (note.type === 'mindmap') {
      // Exports land on white paper, so always render the light palette and
      // hand over the resolved data URIs for any images pinned to nodes.
      var dark = !!(opts && opts.mapDark);
      var mc = mapColors(dark);
      var svg = global.Mindmap && global.Mindmap.toSVG
        ? global.Mindmap.toSVG(note.map, {
            node: mc.node, border: mc.border, edge: mc.edge, text: mc.text,
            background: mc.background, dark: dark, images: imgs,
            fontStack: contentFont().stack, fontSize: contentFont().size
          })
        : '';
      if (svg) h.push('<div class="s-map">' + svg + '</div>');
      var outline = mapToOutline(note.map, '    ');
      if (outline) h.push('<pre class="s-outline">' + esc(outline) + '</pre>');
    } else if (note.bodyHtml) {
      // Rich body: swap each data-img reference for the embedded picture,
      // keeping the width and float the note gave it so the text still wraps.
      h.push(note.bodyHtml.replace(/<img\b[^>]*>/gi, function (tag) {
        var m = tag.match(/data-img="([^"]+)"/);
        var rec = m && imgs[m[1]];
        if (!rec) return '';
        var cls = (tag.match(/class="([^"]*)"/) || [null, 'ni ni-center'])[1];
        var w = (tag.match(/width:\s*([\d.]+%)/) || [null, '60%'])[1];
        return '<img class="' + cls + '" style="width:' + w + '" src="' + rec.url + '" alt="">';
      }));
    } else {
      var paras = String(note.body || '').split(/\n{2,}/);
      paras.forEach(function (p) {
        if (!p.trim()) return;
        h.push('<p>' + esc(p).replace(/\n/g, '<br>') + '</p>');
      });
    }
    // only images that were never placed in the text get the strip at the end
    var placedIds = note.bodyHtml
      ? (note.bodyHtml.match(/data-img="([^"]+)"/g) || []).map(function (x) {
          return x.slice(10, -1);
        })
      : [];
    var pics = (note.images || []).filter(function (id) {
      return placedIds.indexOf(id) === -1;
    }).map(function (id) { return imgs[id]; }).filter(Boolean);
    if (pics.length) {
      h.push('<div class="s-gal">');
      pics.forEach(function (p) { h.push('<img src="' + p.url + '" alt="">'); });
      h.push('</div>');
    }
    return h.join('\n');
  }

  var DOC_CSS = [
    '*{box-sizing:border-box}',
    'body{margin:0;background:#fff;color:#1a1a1a;font:16px/1.65 Georgia,"Iowan Old Style",serif;}',
    '.doc{max-width:44rem;margin:0 auto;padding:2.4rem 1.6rem 3rem}',
    '.s-note{margin:0 0 2.6rem}',
    '.s-note+.s-note{border-top:1px solid #e3e0d9;padding-top:2rem}',
    'h1.s-title{font:600 1.7rem/1.3 system-ui,sans-serif;margin:0 0 .3rem;color:#111}',
    '.s-meta{font:0.78rem/1.4 system-ui,sans-serif;color:#7a7770;margin:0 0 1.2rem;',
      'text-transform:uppercase;letter-spacing:.06em}',
    'p{margin:0 0 1rem;white-space:normal}',
    'ul.s-list{list-style:none;margin:0;padding:0;font-family:system-ui,sans-serif;font-size:.98rem}',
    'ul.s-list li{display:flex;gap:.6rem;align-items:flex-start;padding:.24rem 0}',
    'ul.s-list li .box{flex:0 0 1.05em;height:1.05em;margin-top:.28em;border:1.5px solid #9a978f;',
      'border-radius:3px;font-size:.8em;line-height:1;text-align:center;color:#3a3a3a}',
    'ul.s-list li.done .txt{text-decoration:line-through;color:#8a8780}',
    'ul.s-list li.done .box{background:#e8e5de}',
    // a guide line makes the main/sub relationship obvious on paper
    '.lvl-1,.lvl-2,.lvl-3,.lvl-4{border-left:1.5px solid #ddd9d0}',
    '.lvl-1{margin-left:1.1rem;padding-left:.6rem}',
    '.lvl-2{margin-left:2.4rem;padding-left:.6rem}',
    '.lvl-3{margin-left:3.7rem;padding-left:.6rem}',
    '.lvl-4{margin-left:5rem;padding-left:.6rem}',
    '.s-map{margin:0 0 1rem}.s-map svg{max-width:100%;height:auto}',
    '.s-outline{font:0.9rem/1.6 system-ui,sans-serif;white-space:pre-wrap;color:#3a382f;',
      'background:#f7f5f0;padding:.9rem 1rem;border-radius:6px;border:1px solid #e8e4dc}',
    '.s-gal{display:flex;flex-wrap:wrap;gap:.7rem;margin:1rem 0 0}',
    'img.ni{max-width:100%;height:auto;border-radius:6px;border:1px solid #e3e0d9}',
    'img.ni-left{float:left;margin:.25em 1.1em .6em 0}',
    'img.ni-right{float:right;margin:.25em 0 .6em 1.1em}',
    'img.ni-center{display:block;margin:.8em auto}',
    'img.ni-full{display:block;margin:.8em 0;width:100%}',
    '.s-note::after{content:"";display:block;clear:both}',
    '.s-gal img{max-width:100%;border-radius:6px;border:1px solid #e3e0d9}',
    '.s-folder{font:600 .8rem/1 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;',
      'color:#8a8780;margin:0 0 .4rem}',
    'a{color:#8a5a2b;text-decoration:underline}'
  ].join('');

  // Kept separate so it can sit at the top level rather than nested inside
  // another @media print block when we inject the print stylesheet.
  var DOC_CSS_PRINT = [
    '@page{margin:0}',
    '@media print{.s-note{break-inside:auto}h1.s-title{break-after:avoid}',
      '.s-gal img{break-inside:avoid}',
      '.doc{padding:16mm 15mm;max-width:none}}'
  ].join('');

  // Exports should read in whatever typeface the app is set to.
  function contentFontRules() {
    var cs = getComputedStyle(document.documentElement);
    var fam = (cs.getPropertyValue('--content-font') || '').trim();
    var size = (cs.getPropertyValue('--content-size') || '').trim();
    if (!fam && !size) return '';
    return '.doc{' + (fam ? 'font-family:' + fam + ';' : '') +
           (size ? 'font-size:' + size + ';' : '') + '}' +
           (fam ? 'h1.s-title,ul.s-list,.s-outline{font-family:' + fam + '}' : '');
  }

  // Colours for a mindmap on the page or in a picture, either way up.
  function mapColors(dark) {
    return dark
      ? { node: '#242730', border: '#4d515d', edge: '#767b88',
          text: '#e9e6df', background: '#14151a' }
      : { node: '#ffffff', border: '#c9c6bf', edge: '#8b8f9a',
          text: '#151515', background: '#ffffff' };
  }

  function contentFont() {
    var cs = getComputedStyle(document.documentElement);
    return {
      stack: (cs.getPropertyValue('--content-font') || '').trim() || undefined,
      size: parseInt((cs.getPropertyValue('--content-size') || '').trim(), 10) || undefined
    };
  }

  function buildDocHTML(notes, imgs, opts) {
    opts = opts || {};
    var body = notes.map(function (n) {
      var head = '';
      if (opts.folderName && opts.folderName[n.id]) {
        head = '<div class="s-folder">' + esc(opts.folderName[n.id]) + '</div>';
      }
      var meta = '';
      if (opts.dates !== false) {
        var when = opts.fmtDate ? opts.fmtDate(n.updatedAt) : new Date(n.updatedAt).toLocaleString();
        meta = '<div class="s-meta">' + esc(n.type) + ' &middot; updated ' + esc(when) + '</div>';
      }
      return '<article class="s-note">' + head +
        '<h1 class="s-title">' + esc(n.title || 'Untitled') + '</h1>' + meta +
        noteBodyHTML(n, imgs, opts) + '</article>';
    }).join('\n');
    return '<div class="doc">' + body + '</div>';
  }

  function standaloneHTML(title, inner) {
    return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + esc(title) + '</title><style>' + DOC_CSS + contentFontRules() +
      DOC_CSS_PRINT + '</style></head><body>' +
      inner + '</body></html>';
  }

  /* ---------- mindmap as a picture ----------
     The SVG is already vector, so rasterising it at a multiple of its natural
     size gives a genuinely sharp PNG/JPEG rather than a screenshot of the
     canvas at whatever zoom happened to be on screen. */

  function mapToImageBlob(note, format, scale, dark) {
    scale = scale || 3;
    return resolveImages([note]).then(function (imgs) {
      var f = contentFont();
      var mc = mapColors(dark);
      var svg = global.Mindmap.toSVG(note.map, {
        node: mc.node, border: mc.border, edge: mc.edge, text: mc.text,
        background: mc.background, dark: dark, images: imgs,
        fontStack: f.stack, fontSize: f.size
      });
      if (!svg) throw new Error('That mindmap has no nodes yet.');

      var dims = svg.match(/width="(\d+)"\s+height="(\d+)"/);
      var w = dims ? parseInt(dims[1], 10) : 1200;
      var h = dims ? parseInt(dims[2], 10) : 800;

      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(w * scale));
          c.height = Math.max(1, Math.round(h * scale));
          var ctx = c.getContext('2d');
          // JPEG has no alpha, so the background has to be painted in
          ctx.fillStyle = mapColors(dark).background;
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          c.toBlob(function (b) {
            if (b) resolve({ blob: b, w: c.width, h: c.height });
            else reject(new Error('The browser could not encode that image.'));
          }, format === 'jpeg' ? 'image/jpeg' : 'image/png',
             format === 'jpeg' ? 0.92 : undefined);
        };
        img.onerror = function () { reject(new Error('Could not render the mindmap.')); };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      });
    });
  }

  /* ---------- public export entry points ---------- */

  function exportNotes(notes, format, opts) {
    opts = opts || {};
    var name = opts.name || (notes.length === 1 ? slug(notes[0].title, 'note') : 'sulat-' + stamp());

    if (format === 'md') {
      // must not be passed straight to map(): the index would land in `opts`
      var md = notes.map(function (n) { return noteToMarkdown(n, opts); }).join('\n\n---\n\n');
      download(name + '.md', new Blob([md], { type: 'text/markdown;charset=utf-8' }));
      return Promise.resolve();
    }
    if (format === 'txt') {
      var txt = notes.map(noteToText).join('\n\n' + '-'.repeat(40) + '\n\n');
      download(name + '.txt', new Blob([txt], { type: 'text/plain;charset=utf-8' }));
      return Promise.resolve();
    }
    if (format === 'html') {
      return resolveImages(notes).then(function (imgs) {
        var doc = standaloneHTML(notes.length === 1 ? (notes[0].title || 'Note') : 'Sulat export',
          buildDocHTML(notes, imgs, opts));
        download(name + '.html', new Blob([doc], { type: 'text/html;charset=utf-8' }));
      });
    }
    if (format === 'png' || format === 'jpeg') {
      var maps = notes.filter(function (n) { return n.type === 'mindmap'; });
      if (!maps.length) return Promise.reject(new Error('Only mindmaps export as a picture.'));
      return mapToImageBlob(maps[0], format, opts.scale || 3, opts.mapDark).then(function (r) {
        download(name + (format === 'jpeg' ? '.jpg' : '.png'), r.blob);
        return r;
      });
    }
    if (format === 'pdf') {
      return printNotes(notes, opts);
    }
    if (format === 'json') {
      return exportBundle(notes, name);
    }
    return Promise.reject(new Error('Unknown format: ' + format));
  }

  // Render into a hidden print container, then hand off to the browser.
  function printNotes(notes, opts) {
    opts = opts || {};
    return resolveImages(notes).then(function (imgs) {
      var root = document.getElementById('printRoot');
      var style = document.getElementById('printStyle');
      if (!style) {
        style = document.createElement('style');
        style.id = 'printStyle';
        document.head.appendChild(style);
      }
      style.textContent =
        '@media print{' +
          'body>#app,body>.toast,body>dialog,body>.lightbox{display:none !important}' +
          '.print-root{display:block !important}' +
          DOC_CSS + contentFontRules() +
        '}' + DOC_CSS_PRINT;
      root.innerHTML = buildDocHTML(notes, imgs, opts);

      // Chrome seeds the "Save as PDF" file name from document.title.
      var prevTitle = document.title;
      // prefer the note's real title over the slugged download name
      var wanted = opts.docTitle ||
        (notes.length === 1 ? (notes[0].title || 'Untitled') : 'Sulat export');
      document.title = wanted;

      return new Promise(function (resolve) {
        var done = false;
        function finish() {
          if (done) return;
          done = true;
          document.title = prevTitle;
          window.removeEventListener('afterprint', finish);
          setTimeout(function () { root.innerHTML = ''; }, 500);
          resolve();
        }
        window.addEventListener('afterprint', finish);
        // Give embedded data-URL images a tick to decode before printing.
        setTimeout(function () {
          window.print();
          setTimeout(finish, 60000);
        }, 250);
      });
    });
  }

  /* ---------- full backup bundle ---------- */

  /* Assemble the whole library into one plain object.

     `inlineImages: false` writes image ids only. That is what a daily snapshot
     uses: the picture already sits in the images store, and copying it into
     every snapshot would multiply the largest thing in the database by the
     number of days kept. Garbage collection is taught to spare anything a
     snapshot still points at, so the reference stays good. */
  function buildBundle(notesOrNull, opts) {
    var inline = !opts || opts.inlineImages !== false;
    var pFolders = DB.all('folders');
    var pNotes = notesOrNull ? Promise.resolve(notesOrNull) : DB.all('notes');
    return Promise.all([pFolders, pNotes]).then(function (r) {
      var folders = r[0], notes = r[1];
      var pImgs = inline ? resolveImages(notes) : listImageMeta(notes);
      return pImgs.then(function (imgs) {
        return {
          format: BUNDLE_FORMAT,
          version: BUNDLE_VERSION,
          exportedAt: new Date().toISOString(),
          counts: { notes: notes.length, folders: folders.length, images: Object.keys(imgs).length },
          folders: folders,
          notes: notes.map(function (n) {
            var c = {};
            for (var k in n) if (Object.prototype.hasOwnProperty.call(n, k)) c[k] = n[k];
            return c;
          }),
          imagesInline: inline,
          images: Object.keys(imgs).map(function (id) {
            var rec = { id: id, w: imgs[id].w, h: imgs[id].h };
            if (inline) rec.data = imgs[id].url;
            return rec;
          })
        };
      });
    });
  }

  function exportBundle(notesOrNull, name) {
    return buildBundle(notesOrNull).then(function (bundle) {
      download((name || 'sulat-backup-' + stamp()) + '.json',
        new Blob([JSON.stringify(bundle)], { type: 'application/json' }));
      return bundle.counts;
    });
  }

  /* ---------- daily snapshots kept on the device ----------
     Images are included, so a snapshot restores a note exactly as it was --
     a note whose picture is missing is only half a note. The cost is real, so
     only a handful are kept and the oldest are dropped once they add up. */

  var KEEP_SNAPSHOTS = 30;                  // a month: they are text-sized now
  var SNAPSHOT_BUDGET = 25 * 1024 * 1024;   // and still capped, just in case

  function today() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function listSnapshots() {
    return DB.all('backups').then(function (rows) {
      return rows.sort(function (a, b) { return b.id < a.id ? -1 : 1; });
    });
  }

  function pruneSnapshots() {
    return listSnapshots().then(function (rows) {
      var keep = [], total = 0;
      var doomed = [];
      rows.forEach(function (r, i) {
        total += r.bytes || 0;
        if (i < KEEP_SNAPSHOTS && total <= SNAPSHOT_BUDGET) keep.push(r);
        else doomed.push(r);
      });
      return Promise.all(doomed.map(function (r) { return DB.del('backups', r.id); }))
        .then(function () { return { kept: keep.length, dropped: doomed.length }; });
    });
  }

  // Takes at most one snapshot a day, and only when there is something to keep.
  function autoBackup(force) {
    var id = today();
    return DB.get('backups', id).then(function (existing) {
      if (existing && !force) return { skipped: true, id: id };
      return DB.all('notes').then(function (notes) {
        if (!notes.length) return { skipped: true, empty: true };
        return buildBundle(null, { inlineImages: false }).then(function (bundle) {
          var json = JSON.stringify(bundle);
          return DB.put('backups', {
            id: id,
            takenAt: Date.now(),
            bytes: json.length,
            counts: bundle.counts,
            json: json
          }).then(pruneSnapshots).then(function (p) {
            return { id: id, bytes: json.length, counts: bundle.counts, prune: p };
          });
        });
      });
    });
  }

  /* A snapshot on disk must be self-contained, so the images are folded back
     in at the moment it is saved out. */
  function snapshotBlob(row) {
    var bundle = JSON.parse(row.json);
    if (bundle.imagesInline) return Promise.resolve(blobOf(bundle));
    return Promise.all((bundle.images || []).map(function (im) {
      return DB.get('images', im.id).then(function (rec) {
        if (!rec || !rec.blob) return null;
        return blobToDataURL(rec.blob).then(function (u) {
          return { id: im.id, w: im.w, h: im.h, data: u };
        });
      }).catch(function () { return null; });
    })).then(function (list) {
      bundle.images = list.filter(Boolean);
      bundle.imagesInline = true;
      return blobOf(bundle);
    });
  }

  function blobOf(bundle) {
    return new Blob([JSON.stringify(bundle)], { type: 'application/json' });
  }

  // Every image id any snapshot still points at, so cleanup spares them.
  function snapshotImageIds() {
    return DB.all('backups').then(function (rows) {
      var ids = {};
      rows.forEach(function (r) {
        try {
          var b = JSON.parse(r.json);
          (b.images || []).forEach(function (im) { ids[im.id] = true; });
        } catch (e) { /* a damaged row should not block cleanup */ }
      });
      return Object.keys(ids);
    });
  }

  function folderKey(name) {
    return String(name || '').trim().toLowerCase();
  }

  /* Decide where each incoming folder lands, without ever creating a second
     folder that has the same name in the same place as one that already
     exists. Two folders are "the same" purely by (parent, name) -- a folder
     carries no content of its own, so consolidating them loses nothing.

     Returns { idMap, toInsert }: idMap maps every incoming folder id to the
     id it should actually use (an existing folder's id if it merged, or its
     own id if it is genuinely new); toInsert lists only the rows that still
     need to be written, with parentId already resolved to a final id. */
  function resolveFolderMerges(existingFolders, incomingFolders) {
    var byParent = {};                       // parentId ('' for root) -> {nameKey: id}
    function bucket(parentId) {
      var k = parentId || '';
      return byParent[k] || (byParent[k] = {});
    }
    existingFolders.forEach(function (f) {
      bucket(f.parentId)[folderKey(f.name)] = f.id;
    });

    var byIncomingId = {};
    incomingFolders.forEach(function (f) { byIncomingId[f.id] = f; });

    var idMap = {}, toInsert = [];
    var pending = incomingFolders.slice();
    var guard = 0;
    // Parents have to be resolved before their children, so this makes
    // repeated passes rather than assuming the array arrives in tree order.
    while (pending.length && guard++ < 64) {
      var next = [];
      pending.forEach(function (f) {
        var parentPending = f.parentId && byIncomingId[f.parentId] && !idMap.hasOwnProperty(f.parentId);
        if (parentPending) { next.push(f); return; }

        var finalParentId = (f.parentId && idMap.hasOwnProperty(f.parentId))
          ? idMap[f.parentId] : (f.parentId || null);
        var slot = bucket(finalParentId);
        var key = folderKey(f.name);

        if (slot[key]) {
          idMap[f.id] = slot[key];           // an equivalent folder already exists
        } else {
          idMap[f.id] = f.id;                // stays new, keeps its own id
          slot[key] = f.id;                  // so incoming siblings with the same name also merge together
          toInsert.push({
            id: f.id, name: f.name, parentId: finalParentId,
            order: f.order || Date.now(), createdAt: f.createdAt || Date.now()
          });
        }
      });
      if (next.length === pending.length) {
        // a parent cycle in the input: stop chasing it and take the rest as roots
        next.forEach(function (f) {
          idMap[f.id] = f.id;
          toInsert.push({ id: f.id, name: f.name, parentId: null,
            order: f.order || Date.now(), createdAt: f.createdAt || Date.now() });
        });
        next = [];
      }
      pending = next;
    }
    return { idMap: idMap, toInsert: toInsert };
  }

  // A note's content, independent of id, timestamps or which folder it is
  // filed in -- two notes with the same fingerprint hold nothing different.
  function noteFingerprint(n) {
    return JSON.stringify({
      type: n.type, title: (n.title || '').trim(),
      body: n.body || '', bodyHtml: n.bodyHtml || '',
      items: n.items || [], map: n.map || null,
      images: (n.images || []).slice().sort(),
      tags: (n.tags || []).slice().sort(),
      enc: n.enc || null
    });
  }

  // Merge a bundle in. A note that exists on both sides (same id) resolves to
  // whichever copy was edited last. Folders merge by (parent, name) so
  // importing never creates a second "Ideas" or "Work". A note that arrives
  // under a new id but with byte-identical content to one already here is
  // recognised as the same note rather than added again.
  function importBundle(file) {
    return file.text().then(function (txt) {
      var b;
      try { b = JSON.parse(txt); } catch (e) { throw new Error('That file is not valid JSON.'); }
      if (!b || BUNDLE_FORMATS.indexOf(b.format) < 0) throw new Error('Not a Sulat backup file.');
      if ((b.version || 0) > BUNDLE_VERSION) throw new Error('That backup is from a newer version of Sulat.');

      var images = (b.images || []).map(function (im) {
        return { id: im.id, blob: dataURLToBlob(im.data), type: 'image/png', w: im.w, h: im.h, createdAt: Date.now() };
      });
      var notes = (b.notes || []).map(function (n) {
        var out = {
          id: n.id || DB.uid(),
          type: n.type || 'text',
          title: n.title || '',
          folderId: n.folderId || null,
          body: n.body || '',
          items: n.items || [],
          map: n.map || { nodes: [], edges: [] },
          images: n.images || [],
          tags: Array.isArray(n.tags) ? n.tags : [],
          pinned: !!n.pinned,
          createdAt: n.createdAt || Date.now(),
          updatedAt: n.updatedAt || Date.now(),
          deletedAt: n.deletedAt || null
        };
        // Carry the optional fields through too. Dropping these would silently
        // lose image layout on restore, and make a locked note unrecoverable.
        if (n.bodyHtml) out.bodyHtml = n.bodyHtml;
        if (n.locked) out.locked = true;
        if (n.enc) out.enc = n.enc;
        // Keep the version stamp: dropping it would make a note from an older
        // build look current, and the migration would skip it.
        if (n.schema) out.schema = n.schema;
        return out;
      });
      return DB.all('folders').then(function (myFolders) {
        var fm = resolveFolderMerges(myFolders, b.folders || []);
        notes.forEach(function (n) {
          if (n.folderId && fm.idMap.hasOwnProperty(n.folderId)) n.folderId = fm.idMap[n.folderId];
        });

        // Merge, don't overwrite. Importing is how two devices exchange notes,
        // so a note that exists on both must resolve to whichever copy was
        // edited last -- otherwise importing an older backup silently
        // destroys newer work on the receiving device.
        return DB.all('notes').then(function (mine) {
          var byId = {}, fingerprints = {};
          mine.forEach(function (n) {
            byId[n.id] = n;
            fingerprints[noteFingerprint(n)] = true;
          });

          var fresh = [], added = 0, updated = 0, kept = 0;
          notes.forEach(function (n) {
            var have = byId[n.id];
            if (have) {
              if ((n.updatedAt || 0) > (have.updatedAt || 0)) { fresh.push(n); updated++; }
              else { kept++; }              // local copy is newer or identical
              return;
            }
            // A different id but the same content is the same note arriving
            // twice -- most often the untouched starter notes from an older
            // build, before they carried a stable id of their own.
            if (fingerprints[noteFingerprint(n)]) { kept++; return; }
            fresh.push(n);
            added++;
          });

          // image blobs are immutable and keyed by id, so only add missing ones
          return DB.all('images').then(function (haveImgs) {
            var known = {};
            haveImgs.forEach(function (im) { known[im.id] = true; });
            var newImages = images.filter(function (im) { return !known[im.id]; });

            return DB.putMany('folders', fm.toInsert)
              .then(function () { return DB.putMany('images', newImages); })
              .then(function () { return DB.putMany('notes', fresh); })
              .then(function () {
                return {
                  notes: added + updated,
                  added: added, updated: updated, kept: kept,
                  folders: fm.toInsert.length,
                  images: newImages.length
                };
              });
          });
        });
      });
    });
  }

  global.Exporter = {
    exportNotes: exportNotes,
    exportBundle: exportBundle,
    autoBackup: autoBackup,
    listSnapshots: listSnapshots,
    snapshotImageIds: snapshotImageIds,
    snapshotBlob: snapshotBlob,
    importBundle: importBundle,
    printNotes: printNotes,
    mapToImageBlob: mapToImageBlob,
    noteToMarkdown: noteToMarkdown,
    mapToOutline: mapToOutline,
    resolveImages: resolveImages,
    blobToDataURL: blobToDataURL,
    download: download,
    slug: slug,
    stamp: stamp,
    esc: esc
  };
})(window);
