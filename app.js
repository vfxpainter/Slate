/* Sulat - app controller.
   State lives in memory and is mirrored to IndexedDB on a debounce. The three
   panes (folders / list / editor) are re-rendered from that state; on narrow
   screens only one is visible at a time via [data-pane] on the shell.
   Every mutation goes through act() or the edit-burst helpers so that undo
   and redo cover the whole app, not just typing. */
(function () {
  'use strict';

  var SAVE_DELAY = 200;      // how long typing pauses before a write
  var TRASH_DAYS = 30;
  var VIEW_MODES = ['list', 'grid', 'large'];

  var S = {
    folders: [],
    notes: [],
    view: 'all',          // 'all' | 'pinned' | 'trash' | 'unfiled' | <folderId>
    note: null,
    q: '',
    expanded: {},
    viewMode: 'list',
    selecting: false,
    picked: {},           // noteId -> true, while selecting
    pickedItems: {},      // list-item id -> true, for dragging several at once
    map: null,            // live Mindmap instance
    mapNoteId: null,      // note the canvas currently holds
    editingNode: null,    // node whose text is being edited on the canvas
    font: { family: 'system', size: 16 },
    dateFormat: 'relative',
    uiScale: 100,         // per cent; scales the interface, this app only
    uiFont: 'system',     // typeface for menus, lists and buttons
    exportDates: false,   // folder + date line in exports; off by default
    sortBy: 'edited',     // edited | oldest | created | az | za | type
    autoCaps: true,       // capitalise the start of a sentence as you type
    leading: 1.65,        // line spacing for everything you write in
    keepPasteFormat: false,  // paste carries styling and lists only if asked
    imgMovable: false,    // pictures sit still until you unlock one
    pageWidth: 'full',    // reading | wide | full
    newStyle: 'row',      // row | menu -- how a new note is started
    layout: 'tabs',       // tabs (Notes / Lists / Mindmaps) | classic (sidebar)
    tab: 'text',          // text | list | mindmap | more -- the tab you are on
    tabViews: {},         // tab -> the folder you were last in there
    listScroll: 0,        // where the grid was scrolled when a note opened
    draftId: null,        // a new note, not saved until you put something in it
    hitQuery: '',         // the word to mark inside the note you opened
    hits: [],             // where it appears
    hitAt: 0,
    editingWas: '',       // what a node said before you started typing in it
    tabView: {},          // tab -> tiles | list | outline
    folderDeep: false,    // a folder shows its own notes, not its children's
    autoBackup: false,
    autoGap: '1h',        // one of AUTO_GAPS
    autoKeep: 30,         // how many snapshots to hold on to
    autoEncrypt: false,   // automatic backups carry the same password
    backupPassword: '',   // this session only; never written to disk
    lastAutoBackup: 0,
    paneW: { nav: 0, list: 0 },   // 0 = let the stylesheet decide
    imgURL: {},           // imageId -> object URL
    saveTimer: null,
    installPrompt: null
  };

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function esc(s) { return Exporter.esc(s); }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; },
      Math.min(2600, 1200 + String(msg).length * 30));
  }

  /* Date display. "relative" is the old behaviour (time today, then short
     dates); the rest always show the whole date. */
  var DATE_FORMATS = {
    relative:  { label: 'Relative (12:42 AM · Aug 29)' },
    ymd:       { label: '2026 August 29' },
    dmy:       { label: '29 August 2026' },
    mdy:       { label: 'August 29, 2026' },
    iso:       { label: '2026-08-29' },
    numeric:   { label: '29/08/2026' }
  };
  var DATE_KEYS = Object.keys(DATE_FORMATS);
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

  function pad2(n) { return String(n).padStart(2, '0'); }

  function fmtDate(ts, opts) {
    var d = new Date(ts);
    var fmt = (opts && opts.format) || S.dateFormat || 'relative';
    var withTime = opts && opts.time;
    // "full" always spells the date out. The relative style says "2:10 PM" for
    // anything today, which is no use on a note you are trying to date.
    if (opts && opts.full) {
      withTime = true;
      if (fmt === 'relative') fmt = 'mdy';
    }
    var time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    if (fmt === 'relative') {
      var now = new Date();
      if (d.toDateString() === now.toDateString()) return time;
      if (d.getFullYear() === now.getFullYear()) {
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      }
      return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
    }

    var y = d.getFullYear(), m = MONTHS[d.getMonth()], day = d.getDate();
    var out =
      fmt === 'ymd' ? y + ' ' + m + ' ' + day :
      fmt === 'dmy' ? day + ' ' + m + ' ' + y :
      fmt === 'mdy' ? m + ' ' + day + ', ' + y :
      fmt === 'iso' ? y + '-' + pad2(d.getMonth() + 1) + '-' + pad2(day) :
      /* numeric */   pad2(day) + '/' + pad2(d.getMonth() + 1) + '/' + y;
    return withTime ? out + ', ' + time : out;
  }

  var KIND = { text: '✎', list: '☑', mindmap: '✥' };

  /* The three tabs. Every folder belongs to exactly one of them and only ever
     holds that kind of note -- open a Mindmaps folder and everything in it is
     a mindmap. */
  var KINDS = ['text', 'list', 'mindmap'];
  var KIND_TAB = { text: 'Notes', list: 'Lists', mindmap: 'Mindmaps' };
  var KIND_ONE = { text: 'note', list: 'list', mindmap: 'mindmap' };
  var KIND_SHORT = { text: 'note', list: 'list', mindmap: 'map' };

  /* Typefaces are limited to families that ship with Windows and Android, so
     the app stays fully offline -- no webfont downloads. */
  var FONTS = {
    system:   { label: 'System sans', stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
    serif:    { label: 'Serif',       stack: 'Georgia, "Noto Serif", "Times New Roman", serif' },
    humanist: { label: 'Humanist',    stack: 'Calibri, Candara, "Segoe UI", "Noto Sans", sans-serif' },
    wide:     { label: 'Wide',        stack: 'Verdana, "Noto Sans", Tahoma, sans-serif' },
    mono:     { label: 'Monospace',   stack: 'Consolas, "Cascadia Mono", "Roboto Mono", "Courier New", monospace' }
  };
  var FONT_KEYS = Object.keys(FONTS);
  var SIZE_MIN = 12, SIZE_MAX = 26, SIZE_DEFAULT = 16;

  function fontStack() { return (FONTS[S.font.family] || FONTS.system).stack; }

  var SCALE_MIN = 85, SCALE_MAX = 175;

  /* Almost every size in the stylesheet is in rem, so setting the root font
     size scales the whole interface at once -- and only this app, unlike the
     phone's system-wide font setting. */
  function uiFontStack() { return (FONTS[S.uiFont] || FONTS.system).stack; }

  function applyUiFont() {
    document.documentElement.style.setProperty('--font-ui', uiFontStack());
    try { localStorage.setItem('slate-uifont', S.uiFont); } catch (e) { /* private mode */ }
  }

  function applyUiScale() {
    var pct = Math.max(SCALE_MIN, Math.min(SCALE_MAX, S.uiScale || 100));
    document.documentElement.style.fontSize = (16 * pct / 100) + 'px';
    try { localStorage.setItem('slate-uiscale', String(pct)); } catch (e) { /* private mode */ }
    if (S.note) autosize($('noteTitle'));
  }

  // One setting drives note text, list items, mindmap nodes and exports.
  function applyFont() {
    var root = document.documentElement;
    root.style.setProperty('--content-font', fontStack());
    root.style.setProperty('--content-size', S.font.size + 'px');
    root.style.setProperty('--content-leading', String(S.leading));
    $('app').dataset.pagewidth = S.pageWidth;
    $('app').dataset.newstyle = S.newStyle;
    $('app').dataset.layout = S.layout;
    if ($('newRow')) $('newRow').hidden = S.newStyle !== 'row';
    try {
      localStorage.setItem('slate-font', JSON.stringify(S.font));
      localStorage.setItem('slate-dateformat', S.dateFormat);
      localStorage.setItem('slate-exportmeta', S.exportDates ? '1' : '0');
      localStorage.setItem('slate-sortby', S.sortBy);
      localStorage.setItem('slate-autocaps', S.autoCaps ? '1' : '0');
      localStorage.setItem('slate-leading', String(S.leading));
      localStorage.setItem('slate-pastefmt', S.keepPasteFormat ? '1' : '0');
      localStorage.setItem('slate-imgmove', S.imgMovable ? '1' : '0');
      localStorage.setItem('slate-pagewidth', S.pageWidth);
      localStorage.setItem('slate-newstyle', S.newStyle);
      localStorage.setItem('slate-layout', S.layout);
      localStorage.setItem('slate-folderdeep', S.folderDeep ? '1' : '0');
    } catch (e) { /* private mode */ }
    if (S.map) S.map.setFont(fontStack(), S.font.size);
    // the rich editor grows on its own; nothing to resize
    if (S.note && S.note.type === 'list') {
      Array.prototype.forEach.call(document.querySelectorAll('#listItems .txt'), autosizeItem);
    }
    /* The title is a textarea with its height set from its content, so it has
       to be measured again whenever the type size changes -- otherwise a title
       that now wraps onto a second line keeps its old one-line box and the
       overflow is clipped straight through the date beneath it. */
    if (S.note) autosize($('noteTitle'));
  }

  function loadFontPref() {
    try {
      var saved = JSON.parse(localStorage.getItem('slate-font') || 'null');
      if (saved && FONTS[saved.family]) {
        S.font = {
          family: saved.family,
          size: Math.min(SIZE_MAX, Math.max(SIZE_MIN, parseInt(saved.size, 10) || SIZE_DEFAULT))
        };
      }
    } catch (e) { /* keep the default */ }
    var uf = localStorage.getItem('slate-uifont');
    if (uf && FONTS[uf]) S.uiFont = uf;
    var us = parseInt(localStorage.getItem('slate-uiscale'), 10);
    if (us) S.uiScale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, us));
    var df = localStorage.getItem('slate-dateformat');
    if (df && DATE_FORMATS[df]) S.dateFormat = df;
    // 'slate-exportdates' is the pre-change key. It was written as '1' on every
    // boot, so reading it would override the new default for everyone who had
    // ever opened the app. Read the new key only, and clear the old one.
    try { localStorage.removeItem('slate-exportdates'); } catch (e) { /* private mode */ }
    var ed = localStorage.getItem('slate-exportmeta');
    if (ed !== null) S.exportDates = ed !== '0';
    var sb = localStorage.getItem('slate-sortby');
    if (sb) S.sortBy = sb;
    var ab = localStorage.getItem('sulat-autobackup');
    if (ab !== null) S.autoBackup = ab === '1';
    S.lastAutoBackup = parseInt(localStorage.getItem('sulat-lastautobackup'), 10) || 0;
    var ag = localStorage.getItem('sulat-autogap');
    if (ag) S.autoGap = ag;
    var ak = parseInt(localStorage.getItem('sulat-autokeep'), 10);
    if (ak > 0) S.autoKeep = ak;
    if (window.Exporter) Exporter.setSnapshotLimit(S.autoKeep);
    S.autoEncrypt = localStorage.getItem('sulat-autoencrypt') === '1';
    var ac = localStorage.getItem('slate-autocaps');
    if (ac !== null) S.autoCaps = ac !== '0';
    var ld = parseFloat(localStorage.getItem('slate-leading'));
    if (ld >= 1.1 && ld <= 2.6) S.leading = ld;
    var pf = localStorage.getItem('slate-pastefmt');
    if (pf !== null) S.keepPasteFormat = pf === '1';
    var im = localStorage.getItem('slate-imgmove');
    if (im !== null) S.imgMovable = im === '1';
    var pw = localStorage.getItem('slate-pagewidth');
    if (pw === 'reading' || pw === 'wide' || pw === 'full') S.pageWidth = pw;
    var lay = localStorage.getItem('slate-layout');
    if (lay === 'tabs' || lay === 'classic') S.layout = lay;
    try {
      var tvm = JSON.parse(localStorage.getItem('slate-tabview') || 'null');
      if (tvm && typeof tvm === 'object') S.tabView = tvm;
    } catch (e) { /* back to tiles */ }
    var tb = localStorage.getItem('slate-tab');
    if (tb === 'text' || tb === 'list' || tb === 'mindmap' || tb === 'more') S.tab = tb;
    try {
      var tv = JSON.parse(localStorage.getItem('slate-tabviews') || 'null');
      if (tv && typeof tv === 'object') S.tabViews = tv;
    } catch (e) { /* a damaged value just means starting at the top */ }
    var ns = localStorage.getItem('slate-newstyle');
    if (ns === 'row' || ns === 'menu') S.newStyle = ns;
    var fd = localStorage.getItem('slate-folderdeep');
    if (fd !== null) S.folderDeep = fd === '1';
    try {
      var pw = JSON.parse(localStorage.getItem('slate-panew') || 'null');
      if (pw && typeof pw.nav === 'number') S.paneW = pw;
    } catch (e) { /* ignore a corrupt value */ }
  }

  /* ================= lookups ================= */

  function byNoteId(id) {
    for (var i = 0; i < S.notes.length; i++) if (S.notes[i].id === id) return S.notes[i];
    return null;
  }
  function folderById(id) {
    for (var i = 0; i < S.folders.length; i++) if (S.folders[i].id === id) return S.folders[i];
    return null;
  }
  function current(store, id) {
    return store === 'notes' ? byNoteId(id) : store === 'folders' ? folderById(id) : null;
  }

  function childFolders(parentId) {
    return S.folders.filter(function (f) { return (f.parentId || null) === (parentId || null); })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  function kindOf(n) { return (n && KINDS.indexOf(n.type) !== -1) ? n.type : 'text'; }
  function isKindTab(t) { return KINDS.indexOf(t) !== -1; }
  // the kind a new thing gets when nothing more specific says otherwise
  function currentKind() { return isKindTab(S.tab) ? S.tab : 'text'; }
  /* A folder that has not been given a type yet fits every tab. That only
     happens if sorting was skipped (no restore point could be saved), and
     showing it everywhere is safer than hiding it anywhere. */
  function folderFits(f, kind) { return !f.kind || f.kind === kind; }
  function sameName(a, b) {
    return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  }

  /* The folder of `kind` that stands in the same place as `folderId`: the
     same name, under the same-named parent, all the way up. Made if it does
     not exist yet (and added to `made`, so the caller can save it). This is
     how a Notes "Work" and a Mindmaps "Work" stay two separate folders while
     still reading as the same place. */
  function twinOf(folderId, kind, made) {
    var f = folderById(folderId);
    if (!f) return null;
    if (!f.kind || f.kind === kind) return f.id;
    var parent = f.parentId ? twinOf(f.parentId, kind, made) : null;
    for (var i = 0; i < S.folders.length; i++) {
      var x = S.folders[i];
      if (x.kind === kind && (x.parentId || null) === parent && sameName(x.name, f.name)) return x.id;
    }
    var nf = DB.blankFolder(f.name, parent);
    nf.kind = kind;
    if (f.color) nf.color = f.color;
    S.folders.push(nf);
    if (made) made.push(nf);
    return nf.id;
  }

  // Anything out of place: a folder with no type, a folder under a parent of
  // another type, or a note filed in a folder of another type.
  function needsTyping() {
    return S.folders.some(function (f) {
      var p = f.parentId ? folderById(f.parentId) : null;
      return !f.kind || (f.parentId && (!p || p.kind !== f.kind));
    }) || S.notes.some(function (n) {
      var f = n.folderId ? folderById(n.folderId) : null;
      return n.folderId && (!f || f.kind !== kindOf(n));
    });
  }

  /* Sort every folder into a tab. A folder that held more than one kind
     becomes one folder per kind, with the same name and colour, in the same
     place; an empty folder goes to all three tabs. Works on the data in
     memory and returns what changed -- nothing is written here. Throws if the
     result does not check out, so the caller can throw it all away. */
  function typeFolders() {
    var notesBefore = S.notes.length;
    var touchedF = {}, touchedN = {}, made = [];
    var untyped = S.folders.filter(function (f) { return !f.kind; });

    if (untyped.length) {
      var need = {};
      var needOf = function (f) {
        if (need[f.id]) return need[f.id];
        need[f.id] = {};                                   // guards against a cycle
        var set = {};
        if (f.kind) set[f.kind] = true;
        else {
          S.notes.forEach(function (n) { if (n.folderId === f.id) set[kindOf(n)] = true; });
          childFolders(f.id).forEach(function (c) {
            var cs = needOf(c);
            Object.keys(cs).forEach(function (k) { set[k] = true; });
          });
          if (!Object.keys(set).length) KINDS.forEach(function (k) { set[k] = true; });
        }
        need[f.id] = set;
        return set;
      };
      untyped.forEach(needOf);

      // parents before children, measured before anything moves
      var depth = {};
      untyped.forEach(function (f) { depth[f.id] = folderChain(f.id).length; });
      untyped.sort(function (a, b) { return depth[a.id] - depth[b.id]; });

      untyped.forEach(function (f) {
        f.kind = KINDS.filter(function (k) { return need[f.id][k]; })[0] || 'text';
        touchedF[f.id] = f;
      });
      untyped.forEach(function (f) {
        var par = f.parentId ? folderById(f.parentId) : null;
        if (par && par.kind !== f.kind) {
          f.parentId = twinOf(par.id, f.kind, made);
        }
      });
      untyped.forEach(function (f) {
        KINDS.forEach(function (k) {
          if (k !== f.kind && need[f.id][k]) twinOf(f.id, k, made);
        });
      });
    }

    // repairs, for anything an import or an older copy of Sulat left behind
    S.folders.slice().forEach(function (f) {
      if (!f.parentId) return;
      var par = folderById(f.parentId);
      if (!par) { f.parentId = null; touchedF[f.id] = f; }
      else if (par.kind !== f.kind) { f.parentId = twinOf(par.id, f.kind, made); touchedF[f.id] = f; }
    });
    S.notes.forEach(function (n) {
      if (!n.folderId) return;
      var f = folderById(n.folderId);
      if (!f) { n.folderId = null; touchedN[n.id] = n; }
      else if (f.kind !== kindOf(n)) { n.folderId = twinOf(f.id, kindOf(n), made); touchedN[n.id] = n; }
    });
    made.forEach(function (f) { touchedF[f.id] = f; });

    if (S.notes.length !== notesBefore || needsTyping()) {
      throw new Error('folder sort did not check out');
    }
    return {
      split: untyped.length,
      made: made.length,
      folders: Object.keys(touchedF).map(function (k) { return touchedF[k]; }),
      notes: Object.keys(touchedN).map(function (k) { return touchedN[k]; })
    };
  }

  /* Runs at start-up and after every import. The first time it has real work
     to do -- splitting mixed folders -- it saves a restore point before
     writing anything; if that fails, nothing is sorted and the folders show
     in every tab until it can be done safely. */
  function sortFoldersByType(afterImport) {
    if (!needsTyping()) return Promise.resolve(null);
    var splitting = S.folders.some(function (f) { return !f.kind; });
    var guard = (splitting && !afterImport)
      ? Exporter.snapshotNow('before-folder-split')
      : Promise.resolve({ skipped: true });
    return guard.then(function () {
      var r;
      try { r = typeFolders(); }
      catch (e) {
        console.error('Sulat:', e);
        return load().then(function () {
          toast('Folders were left as they are: the sort did not check out');
          return null;
        });
      }
      return DB.putMany('folders', r.folders).then(function () {
        return DB.putMany('notes', r.notes);
      }).then(function () {
        if (r.split && !afterImport) {
          toast('Folders sorted into Notes, Lists and Mindmaps · restore point saved');
        }
        return r;
      });
    }, function (e) {
      console.warn('Sulat: no restore point, folders not sorted —', e && e.message);
      toast('Could not save a restore point, so folders were not sorted yet');
      return null;
    });
  }

  // Every folder id at or below `id`, so a folder view includes subfolders.
  function subtreeIds(id) {
    var out = [id];
    childFolders(id).forEach(function (f) { out = out.concat(subtreeIds(f.id)); });
    return out;
  }

  /* The folders from the top down to this one. Used for the trail above the
     list and for lighting up the ancestors in the sidebar -- "which folder am
     I in" should never need working out. */
  function folderChain(id) {
    var out = [], guard = 0, f = folderById(id);
    while (f && guard++ < 32) {
      out.unshift(f);
      f = f.parentId ? folderById(f.parentId) : null;
    }
    return out;
  }

  function folderPath(id) {
    var names = [], guard = 0;
    var f = folderById(id);
    while (f && guard++ < 32) {
      names.unshift(f.name);
      f = f.parentId ? folderById(f.parentId) : null;
    }
    return names.join(' / ');
  }

  /* ---------- tags ----------
     A note keeps its own list of tag names. There is no separate tag table:
     with one person and one device, the join table Joplin needs for syncing
     would be bookkeeping without a payer. Renaming walks the notes instead. */

  function tagsOf(n) { return Array.isArray(n.tags) ? n.tags : []; }

  function normTag(t) {
    return String(t || '').trim().replace(/\s+/g, ' ').replace(/^#/, '').slice(0, 40);
  }

  // Every tag in use, with how many live notes carry it.
  function allTags() {
    var counts = {};
    liveNotes().forEach(function (n) {
      tagsOf(n).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    return Object.keys(counts).sort(function (a, b) {
      return a.toLowerCase().localeCompare(b.toLowerCase());
    }).map(function (t) { return { name: t, count: counts[t] }; });
  }

  function noteHasTag(n, tag) {
    return tagsOf(n).some(function (t) { return t.toLowerCase() === tag.toLowerCase(); });
  }

  function addTagTo(ids, tag) {
    tag = normTag(tag);
    if (!tag) return;
    act('Tag ' + plural(ids.length, 'note'), noteRefs(ids), function () {
      ids.forEach(function (id) {
        var n = byNoteId(id);
        if (!n || noteHasTag(n, tag)) return;
        n.tags = tagsOf(n).concat([tag]);
        n.updatedAt = Date.now();
      });
    }).then(function () {
      renderTree(); renderList(); renderMeta(); renderTagRow(); renderUndoButtons();
      toast('Tagged “' + tag + '”');
    });
  }

  function removeTagFrom(id, tag) {
    act('Remove tag', noteRefs([id]), function () {
      var n = byNoteId(id);
      if (!n) return;
      n.tags = tagsOf(n).filter(function (t) { return t.toLowerCase() !== tag.toLowerCase(); });
      n.updatedAt = Date.now();
    }).then(function () {
      renderTree(); renderList(); renderMeta(); renderTagRow(); renderUndoButtons();
    });
  }

  function renameTag(from, to) {
    to = normTag(to);
    if (!to) return;
    var hits = liveNotes().filter(function (n) { return noteHasTag(n, from); });
    if (!hits.length) return;
    act('Rename tag', noteRefs(hits.map(function (n) { return n.id; })), function () {
      hits.forEach(function (n) {
        n.tags = tagsOf(n).map(function (t) { return t.toLowerCase() === from.toLowerCase() ? to : t; })
          .filter(function (t, i, a) { return a.indexOf(t) === i; });
        n.updatedAt = Date.now();
      });
    }).then(function () {
      if (S.view === 'tag:' + from) S.view = 'tag:' + to;
      renderTree(); renderList(); renderMeta(); renderTagRow(); renderUndoButtons();
      toast('Renamed to “' + to + '”');
    });
  }

  function deleteTag(tag) {
    var hits = liveNotes().filter(function (n) { return noteHasTag(n, tag); });
    if (!hits.length) return;
    act('Delete tag', noteRefs(hits.map(function (n) { return n.id; })), function () {
      hits.forEach(function (n) {
        n.tags = tagsOf(n).filter(function (t) { return t.toLowerCase() !== tag.toLowerCase(); });
        n.updatedAt = Date.now();
      });
    }).then(function () {
      if (S.view === 'tag:' + tag) S.view = 'all';
      renderTree(); renderList(); renderMeta(); renderTagRow(); renderUndoButtons();
      toast('Tag removed from ' + plural(hits.length, 'note'));
    });
  }

  function liveNotes() {
    return S.notes.filter(function (n) { return !n.deletedAt; });
  }
  function countDirect(folderId) {
    return liveNotes().filter(function (n) { return n.folderId === folderId; }).length;
  }
  function countDeep(folderId) {
    var ids = subtreeIds(folderId);
    return liveNotes().filter(function (n) { return ids.indexOf(n.folderId) !== -1; }).length;
  }
  /* The number beside a folder counts what opening it would show, and nothing
     else. A parent that said 17 while its two children said 11 and 3 was
     counting notes you could not see in it, which is why the totals never
     added up to anything. */
  function countIn(folderId) {
    return S.folderDeep ? countDeep(folderId) : countDirect(folderId);
  }
  // "3 here - 17 including subfolders", for the tooltip on a parent folder
  function countHint(folderId) {
    var here = countDirect(folderId), all = countDeep(folderId);
    return here === all ? plural(here, 'note') + ' in this folder'
      : plural(here, 'note') + ' in this folder · ' + all + ' including subfolders';
  }

  /* ================= history plumbing ================= */

  function writeAll(refs) {
    return Promise.all(refs.map(function (r) {
      var v = current(r.store, r.id);
      return v ? DB.put(r.store, v) : DB.del(r.store, r.id);
    }));
  }

  // One undoable action. `refs` lists every row the mutation may touch.
  function act(label, refs, mutate) {
    closeBurst();
    var before = refs.map(function (r) { return History.rec(r.store, r.id, current(r.store, r.id)); });
    var result = mutate();
    var after = refs.map(function (r) { return History.rec(r.store, r.id, current(r.store, r.id)); });
    History.push(label, before, after);
    return writeAll(refs).then(function () { return result; });
  }

  function noteRefs(ids) {
    return ids.map(function (id) { return { store: 'notes', id: id }; });
  }

  // Typing and other rapid edits on the open note collapse into one step.
  function beginBurst(label) {
    if (!S.note) return;
    History.begin('note:' + S.note.id + ':' + label, label,
      [History.rec('notes', S.note.id, S.note)]);
  }
  function closeBurst() {
    if (!History.isOpen()) return;
    if (!S.note) { History.abandon(); return; }
    History.commitWith([History.rec('notes', S.note.id, S.note)]);
  }

  // A discrete edit of the open note: its own undo step.
  function editNote(label, mutate) {
    if (!S.note || S.note.locked) return Promise.resolve();
    return act(label, noteRefs([S.note.id]), mutate);
  }

  function applyRecords(records) {
    var openId = S.note ? S.note.id : null;
    clearTimeout(S.saveTimer);
    S.saveTimer = null;
    S.note = null;
    S.mapNoteId = null;
    return Promise.all(records.map(function (r) {
      return r.value ? DB.put(r.store, r.value) : DB.del(r.store, r.id);
    })).then(load).then(function () {
      S.picked = {};
      renderTree();
      renderList();
      renderSelectBar();
      if (openId && byNoteId(openId)) openNote(openId);
      else showEmpty();
      renderTagRow();
      renderStorage();
    });
  }

  function renderUndoButtons() {
    var u = $('undoBtn'), r = $('redoBtn');
    if (!u) return;
    u.disabled = !History.canUndo();
    r.disabled = !History.canRedo();
    u.title = History.canUndo() ? 'Undo ' + History.nextUndoLabel() + ' (Ctrl+Z)' : 'Nothing to undo';
    r.title = History.canRedo() ? 'Redo ' + History.nextRedoLabel() + ' (Ctrl+Shift+Z)' : 'Nothing to redo';
  }

  /* ================= data ================= */

  function load() {
    return Promise.all([DB.all('folders'), DB.all('notes')]).then(function (r) {
      S.folders = r[0];
      S.notes = r[1];
    });
  }

  /* Notes from before Sulat stopped saving untouched ones: nothing in them
     at all, and never edited after the moment they were made. They are
     removed rather than put in Trash, because there is nothing to keep. */
  function sweepBlankNotes() {
    var stale = S.notes.filter(function (n) {
      return !n.deletedAt && !n.locked && isBlankNote(n);
    });
    if (!stale.length) return Promise.resolve(0);
    var ids = stale.map(function (n) { return n.id; });
    S.notes = S.notes.filter(function (n) { return ids.indexOf(n.id) === -1; });
    return Promise.all(ids.map(function (id) { return DB.del('notes', id); }))
      .then(function () {
        console.info('Sulat: cleared', ids.length, 'empty note(s)');
        return ids.length;
      });
  }

  function purgeOldTrash() {
    var cut = Date.now() - TRASH_DAYS * 86400000;
    var stale = S.notes.filter(function (n) { return n.deletedAt && n.deletedAt < cut; });
    if (!stale.length) return Promise.resolve();
    S.notes = S.notes.filter(function (n) { return stale.indexOf(n) === -1; });
    return Promise.all(stale.map(function (n) { return DB.del('notes', n.id); }));
  }

  /* The word to mark: a plain search, not a "tag:" one. */
  function plainQuery() {
    var q = (S.q || '').trim();
    if (!q || /^tag:/i.test(q)) return '';
    return q;
  }

  function markText(node, text, q) {
    if (!q) { node.textContent = text; return node; }
    var low = String(text).toLowerCase(), needle = q.toLowerCase(), at = 0, i;
    node.textContent = '';
    while ((i = low.indexOf(needle, at)) !== -1) {
      if (i > at) node.appendChild(document.createTextNode(text.slice(at, i)));
      node.appendChild(el('mark', 'hit', text.substr(i, needle.length)));
      at = i + needle.length;
    }
    node.appendChild(document.createTextNode(text.slice(at)));
    return node;
  }

  function searchText(n) {
    if (n.locked) return ((n.title || '') + ' ' + tagsOf(n).join(' ')).toLowerCase();
    var parts = [n.title || '', n.body || '', tagsOf(n).join(' ')];
    (n.items || []).forEach(function (i) { parts.push(i.text || ''); });
    if (n.map && n.map.nodes) n.map.nodes.forEach(function (x) { parts.push(x.text || ''); });
    (n.pages || []).forEach(function (p) {
      parts.push(p.name || '');
      var c = p.content;
      if (!c) return;
      parts.push(c.body || '');
      (c.items || []).forEach(function (i) { parts.push(i.text || ''); });
      if (c.map && c.map.nodes) c.map.nodes.forEach(function (x) { parts.push(x.text || ''); });
    });
    return parts.join(' \n ').toLowerCase();
  }

  function visibleNotes() {
    var list;
    if (S.layout === 'tabs' && isKindTab(S.tab)) {
      /* One tab, one kind. Browsing shows what is filed right here; a search
         looks through this folder and everything below it. */
      var kind = S.tab, here = folderById(S.view) ? S.view : null;
      if (S.q) {
        var under = here ? subtreeIds(here) : null;
        list = liveNotes().filter(function (n) {
          return kindOf(n) === kind && (!under || under.indexOf(n.folderId) !== -1);
        });
      } else {
        list = liveNotes().filter(function (n) {
          return kindOf(n) === kind && (n.folderId || null) === here;
        });
      }
    } else if (S.view === 'trash') {
      list = S.notes.filter(function (n) { return !!n.deletedAt; });
    } else if (S.view === 'all') {
      list = liveNotes();
    } else if (S.view === 'pinned') {
      list = liveNotes().filter(function (n) { return n.pinned; });
    } else if (S.view === 'unfiled') {
      list = liveNotes().filter(function (n) { return !n.folderId; });
    } else if (S.view.indexOf('tag:') === 0) {
      var want = S.view.slice(4);
      list = liveNotes().filter(function (n) { return noteHasTag(n, want); });
    } else {
      var ids = S.folderDeep ? subtreeIds(S.view) : [S.view];
      list = liveNotes().filter(function (n) { return ids.indexOf(n.folderId) !== -1; });
    }
    if (S.q) {
      // "tag:work" narrows to a tag; anything else is a plain text search
      var m = S.q.match(/^tag:\s*(.+)$/i);
      if (m) {
        var t = m[1].trim();
        list = list.filter(function (n) { return noteHasTag(n, t); });
      } else {
        var q = S.q.toLowerCase();
        list = list.filter(function (n) { return searchText(n).indexOf(q) !== -1; });
      }
    }
    /* Pinned notes stay on top whatever the sort -- that is what pinning is
       for -- so the chosen order only decides the rest. */
    var KIND_ORDER = { text: 0, list: 1, mindmap: 2 };
    return list.sort(function (a, b) {
      // Compare pinned as booleans. A note that simply has no `pinned` field --
      // an imported one, say -- is undefined, and `undefined !== false` made the
      // comparator inconsistent, which scrambled the order for everything.
      var ap = !!a.pinned, bp = !!b.pinned;
      if (S.view !== 'trash' && ap !== bp) return ap ? -1 : 1;
      switch (S.sortBy) {
        case 'oldest':  return a.updatedAt - b.updatedAt;
        case 'created': return (b.createdAt || 0) - (a.createdAt || 0);
        case 'az':      return displayTitle(a).localeCompare(displayTitle(b));
        case 'za':      return displayTitle(b).localeCompare(displayTitle(a));
        case 'type':
          var d = (KIND_ORDER[a.type] || 0) - (KIND_ORDER[b.type] || 0);
          return d || (b.updatedAt - a.updatedAt);
        default:        return b.updatedAt - a.updatedAt;
      }
    });
  }

  /* ================= saving ================= */

  function touch() {
    if (!S.note) return;
    S.note.updatedAt = Date.now();
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(flush, SAVE_DELAY);
  }

  function flush() {
    clearTimeout(S.saveTimer);
    S.saveTimer = null;
    scheduleAutoBackup();
    if (!S.note) return Promise.resolve();
    var n = S.note;
    closeBurst();
    if (S.draftId === n.id) {
      if (isBlankNote(n)) { renderList(); return Promise.resolve(); }
      return commitDraft().then(function () {
        renderList();
        renderMeta();
        renderUndoButtons();
      });
    }
    return DB.put('notes', n).then(function () {
      renderList();
      renderMeta();
      renderUndoButtons();
    });
  }

  /* ================= folder tree ================= */

  function navItem(opts) {
    var cls = 'nav-item' + (opts.active ? ' active' : '');
    if (opts.depth) cls += ' child';
    if (opts.kids) cls += ' has-kids';
    if (opts.onPath && !opts.active) cls += ' on-path';
    var b = el('button', cls);
    if (opts.depth) b.style.setProperty('--d', String(opts.depth));

    /* Every folder keeps the twist's slot whether or not it has one to show.
       Without it a childless folder's name sat a notch left of its siblings',
       and one column of folders read as two ragged ones. */
    if (opts.folderId) {
      var t = el('span', 'twist' + (opts.kids ? (opts.twist ? ' open' : '') : ' blank'),
                 opts.kids ? '▶' : '');
      if (opts.kids) t.dataset.twist = opts.folderId;
      b.appendChild(t);
    } else if (opts.twist !== undefined) {
      var t0 = el('span', 'twist' + (opts.twist ? ' open' : ''), '▶');
      b.appendChild(t0);
    }
    var ico = el('span', 'ico', opts.icon || '');
    if (opts.color) ico.dataset.fcolor = opts.color;
    b.appendChild(ico);
    b.appendChild(el('span', 'name', opts.name));
    if (opts.kind) {
      var kk = el('span', 'fkind', KIND[opts.kind] || '');
      kk.title = KIND_TAB[opts.kind] || '';
      b.appendChild(kk);
    }
    if (opts.hint) b.title = opts.name + ' — ' + opts.hint;
    if (opts.count !== undefined && opts.count !== null) {
      b.appendChild(el('span', 'n', String(opts.count)));
    }
    if (opts.folderId) {
      var dot = el('span', 'edit-dot', '⋯');
      dot.dataset.folderMenu = opts.folderId;
      dot.title = 'Rename, nest, export or delete';
      b.appendChild(dot);
    }
    b.dataset.view = opts.view;
    return b;
  }

  function groupHeader(label, actionAttr, actionTitle) {
    var g = el('div', 'nav-group');
    g.appendChild(el('span', null, label));
    if (actionAttr) {
      var add = el('button', 'group-add', '＋');
      add.dataset.act = actionAttr;
      add.title = actionTitle;
      g.appendChild(add);
    }
    return g;
  }

  function renderTree() {
    var root = $('folderTree');
    root.innerHTML = '';

    root.appendChild(navItem({
      view: 'all', name: 'All notes', icon: '◫',
      count: liveNotes().length, active: S.view === 'all'
    }));
    root.appendChild(navItem({
      view: 'pinned', name: 'Pinned', icon: '⚑',
      count: liveNotes().filter(function (n) { return n.pinned; }).length,
      active: S.view === 'pinned'
    }));

    root.appendChild(groupHeader('Folders', 'new-folder', 'New folder'));

    /* One kind at a time, here as in the tabs. Listing every tab's folders
       together showed each split folder two or three times over -- a Notes,
       a Lists and a Mindmaps "GMA WORK!" one under another. */
    var treeKind = currentKind();
    var seg = el('div', 'kind-seg');
    KINDS.forEach(function (k) {
      var sb = el('button', 'kind-seg-btn' + (k === treeKind ? ' on' : ''), KIND_TAB[k]);
      sb.dataset.act = 'tree-kind';
      sb.dataset.kind = k;
      seg.appendChild(sb);
    });
    root.appendChild(seg);

    /* Light up the whole line of folders you are standing in, and open it, so
       the selected one is on screen with its parents visible above it. Landing
       in a subfolder with the branch collapsed is what made it hard to tell
       which folder the list belonged to. */
    var onPath = {};
    folderChain(S.view).forEach(function (f, i, all) {
      onPath[f.id] = true;
      if (i < all.length - 1) S.expanded[f.id] = true;
    });

    var any = false;
    (function walk(parentId, depth) {
      childFolders(parentId).filter(function (f) { return folderFits(f, treeKind); }).forEach(function (f) {
        any = true;
        var kids = childFolders(f.id).filter(function (x) { return folderFits(x, treeKind); });
        var item = navItem({
          view: f.id, name: f.name, icon: kids.length ? '▣' : '▢',
          count: countIn(f.id), hint: countHint(f.id),
          active: S.view === f.id, folderId: f.id, color: f.color || null,
          depth: depth, kids: kids.length > 0, onPath: !!onPath[f.id],
          twist: !!S.expanded[f.id]
        });
        root.appendChild(item);
        if (kids.length && S.expanded[f.id]) walk(f.id, depth + 1);
      });
    })(null, 0);

    if (!any) {
      var hint = el('div', 'nav-hint', 'No folders yet — use ＋ above, or drag a note here.');
      root.appendChild(hint);
    }

    var loose = liveNotes().filter(function (n) { return !n.folderId; }).length;
    if (loose) {
      root.appendChild(navItem({
        view: 'unfiled', name: 'Unfiled', icon: '◌', count: loose,
        active: S.view === 'unfiled'
      }));
    }

    var tags = allTags();
    if (tags.length) {
      root.appendChild(groupHeader('Tags'));
      tags.forEach(function (t) {
        var item = navItem({
          view: 'tag:' + t.name, name: t.name, icon: '#',
          count: t.count, active: S.view === 'tag:' + t.name
        });
        var dot = el('span', 'edit-dot', '⋯');
        dot.dataset.tagMenu = t.name;
        dot.title = 'Rename or remove this tag';
        item.appendChild(dot);
        root.appendChild(item);
      });
    }

    root.appendChild(groupHeader('Other'));
    root.appendChild(navItem({
      view: 'trash', name: 'Trash', icon: '⊘',
      count: S.notes.filter(function (n) { return n.deletedAt; }).length,
      active: S.view === 'trash'
    }));
  }

  /* ================= note list ================= */

  function snippet(n) {
    if (n.locked) return 'Locked — encrypted on this device';
    if (n.type === 'list') {
      var items = n.items || [];
      var done = items.filter(function (i) { return i.done; }).length;
      var head = items.slice(0, 4).map(function (i) { return i.text; }).filter(Boolean).join(' · ');
      return (items.length ? done + '/' + items.length + ' done' : 'Empty list') + (head ? ' — ' + head : '');
    }
    if (n.type === 'mindmap') {
      var nodes = (n.map && n.map.nodes) || [];
      var head2 = nodes.slice(0, 4).map(function (x) { return x.text; }).filter(Boolean).join(' · ');
      return plural(nodes.length, 'node') + (head2 ? ' — ' + head2 : '');
    }
    return (n.body || '').replace(/\s+/g, ' ').slice(0, 240);
  }

  function renderList() {
    if (S.layout === 'tabs') return renderTabsList();
    if (!S.note) setTimeout(renderFolderOverview, 0);
    var title = $('listTitle');
    var inFolder = !S.q && !!folderById(S.view);

    /* A trail rather than a line of text. The folder you are in is the bright
       name at the end; its parents are dimmer, and clicking one goes there. */
    if (inFolder) {
      title.innerHTML = folderChain(S.view).map(function (f, i, all) {
        return i === all.length - 1
          ? '<span class="crumb-here">' + esc(f.name) + '</span>'
          : '<span class="crumb-up" data-view="' + esc(f.id) + '">' +
            esc(f.name) + '</span>';
      }).join('<span class="crumb-sep">›</span>');
      title.classList.add('trail');
    } else {
      title.classList.remove('trail');
      title.textContent =
        S.q ? 'Results for "' + S.q + '"'
          : S.view === 'all' ? 'All notes'
          : S.view === 'pinned' ? 'Pinned'
          : S.view === 'trash' ? 'Trash · auto-clears after ' + TRASH_DAYS + ' days'
          : S.view === 'unfiled' ? 'Unfiled'
          : S.view.indexOf('tag:') === 0 ? 'Tagged “' + S.view.slice(4) + '”'
          : folderPath(S.view);
    }


    var wrap = $('noteList');
    var keepScroll = wrap.scrollTop;
    wrap.innerHTML = '';

    if (S.view === 'trash' && S.notes.some(function (n) { return n.deletedAt; })) {
      var bar = el('div', 'list-tools');
      var empty = el('button', 'ghost-btn', 'Empty trash now');
      empty.dataset.act = 'empty-trash';
      bar.appendChild(empty);
      wrap.appendChild(bar);
    }

    renderFolderRows(wrap);

    var notes = visibleNotes();
    if (!notes.length) {
      wrap.appendChild(el('div', 'list-empty', S.q ? 'Nothing matches that.' : 'No notes here yet.'));
      return;
    }
    renderCards(wrap, notes);
    wrap.scrollTop = keepScroll;
  }

  function renderCards(wrap, notes) {
    notes.forEach(function (n) {
      var picked = !!S.picked[n.id];
      var c = el('div', 'card' +
        (S.note && S.note.id === n.id ? ' active' : '') +
        (picked ? ' picked' : ''));
      c.dataset.noteId = n.id;
      c.tabIndex = 0;

      var top = el('div', 'card-top');
      var grip = el('span', 'card-grip', '⠿');
      grip.dataset.noteGrip = n.id;
      grip.title = 'Drag into a folder';
      top.appendChild(grip);

      // Always present, so picking several notes needs no hunting for a mode.
      var box = el('span', 'card-check' + (picked ? ' on' : ''), picked ? '✓' : '');
      box.dataset.pickNote = n.id;
      box.title = 'Select this note';
      top.appendChild(box);
      var kindEl = el('span', 'card-kind ' + (n.locked ? 'k-locked' : 'k-' + n.type),
                      n.locked ? '🔒' : (KIND[n.type] || KIND.text));
      kindEl.title = n.locked ? 'Locked note' :
        (n.type === 'list' ? 'List' : n.type === 'mindmap' ? 'Mindmap' : 'Note');
      top.appendChild(kindEl);
      top.appendChild(markText(el('span', 'card-title'), displayTitle(n), plainQuery()));
      if (n.pinned && S.view !== 'trash') top.appendChild(el('span', 'card-pin', '⚑'));
      c.appendChild(top);

      var sn = snippet(n);
      if (sn) c.appendChild(markText(el('div', 'card-snip'), sn, plainQuery()));

      var foot = el('div', 'card-foot');
      foot.appendChild(el('span', 'card-date', fmtDate(n.updatedAt)));
      tagsOf(n).slice(0, 3).forEach(function (t) {
        foot.appendChild(el('span', 'card-tag', '#' + t));
      });
      var mixedView = S.q || S.view === 'all' || S.view === 'pinned' || S.view === 'trash';
      if (n.folderId && mixedView) {
        var fp = folderPath(n.folderId);
        if (fp) {
          var chip = el('span', 'card-folder', fp);
          // the note inherits its folder's colour, so where it lives reads at
          // a glance without anyone having to look at the words
          var fc = folderColor(n.folderId);
          if (fc) chip.dataset.fcolor = fc;
          foot.appendChild(chip);
        }
      }
      if ((n.images || []).length) {
        var th = el('div', 'card-thumbs');
        n.images.slice(0, 3).forEach(function (id) {
          var img = el('img');
          img.alt = '';
          imgURL(id).then(function (u) { if (u) img.src = u; });
          th.appendChild(img);
        });
        foot.appendChild(th);
      }
      var bin = el('button', 'card-bin');
      // an emoji bin renders as a box in a lot of fonts, so draw one
      bin.innerHTML = n.deletedAt
        ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
          'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M4 12a8 8 0 1 1 2.3 5.7"/><path d="M4 7v5h5"/></svg>'
        : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 4h4a1 1 0 0 1 1 1v2H9V5a1 1 0 0 1 1-1z"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M10 11v6M14 11v6"/></svg>';
      bin.dataset.binNote = n.id;
      bin.title = n.deletedAt ? 'Restore this note' : 'Move to trash';
      foot.appendChild(bin);

      c.appendChild(foot);
      wrap.appendChild(c);
    });
  }

  /* ================= tabs: Notes / Lists / Mindmaps / More ================= */

  var TAB_ICON = {
    text: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/></svg>',
    list: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12.2l2.3 2.3 4.7-4.9"/></svg>',
    mindmap: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="5.5" r="2.2"/><circle cx="18" cy="12" r="2.2"/><circle cx="18" cy="18.5" r="2.2"/><path d="M8.5 12h7.3M8.2 10.8 15.8 6.3M8.2 13.2l7.6 4.5"/></svg>',
    more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/></svg>'
  };

  var TAB_VIEWS = ['tiles', 'list', 'outline'];
  var TAB_VIEW_NAME = { tiles: 'Tiles', list: 'List', outline: 'Outline' };

  function tabViewMode() {
    var m = S.tabView[S.tab];
    return TAB_VIEWS.indexOf(m) === -1 ? 'tiles' : m;
  }

  function setTabView(mode) {
    S.tabView[S.tab] = mode;
    try { localStorage.setItem('slate-tabview', JSON.stringify(S.tabView)); }
    catch (e) { /* private mode */ }
    renderList();
    $('noteList').scrollTop = 0;
  }

  function notesDirectlyIn(folderId, kind) {
    return liveNotes().filter(function (n) {
      return kindOf(n) === kind && (n.folderId || null) === (folderId || null);
    }).sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  }

  function countKindIn(folderId, kind) {
    var ids = subtreeIds(folderId);
    return liveNotes().filter(function (n) {
      return kindOf(n) === kind && ids.indexOf(n.folderId) !== -1;
    }).length;
  }

  // folders as plain rows, for the list view
  function renderFolderList(wrap) {
    if (S.q) return 0;
    var kind = S.tab, here = folderById(S.view) ? S.view : null;
    var kids = childFolders(here).filter(function (f) { return folderFits(f, kind); })
      .sort(function (a, b) {
        return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.name.localeCompare(b.name);
      });
    var strip = el('div', 'folder-strip');
    kids.forEach(function (f) {
      var row = el('button', 'folder-row' + (childFolders(f.id).length ? ' has-kids' : ''));
      row.dataset.view = f.id;
      row.appendChild(el('span', 'fr-ico', f.pinned ? '⚑' : '▢'));
      row.appendChild(el('span', 'fr-name', f.name));
      row.appendChild(el('span', 'fr-n', String(countKindIn(f.id, kind))));
      var dot = el('span', 'fr-dot', '⋮');
      dot.dataset.folderMenu = f.id;
      dot.title = 'Folder options';
      row.appendChild(dot);
      strip.appendChild(row);
    });
    var add = el('button', 'folder-row add');
    add.dataset.act = here ? 'new-subfolder-here' : 'new-folder';
    add.appendChild(el('span', 'fr-ico', '＋'));
    add.appendChild(el('span', 'fr-name', 'New folder'));
    strip.appendChild(add);
    wrap.appendChild(strip);
    return kids.length;
  }

  /* ---------- the outline ----------
     Every folder in the tab on one scrolling page, each one openable in place
     to show what is inside it. Best when you have many folders and want to
     jump about; the tiles are better when you want to see previews. */
  function outlineNoteRow(n, depth) {
    var row = el('button', 'ol-note');
    row.style.setProperty('--d', String(depth));
    row.dataset.noteId = n.id;
    row.appendChild(el('span', 'card-kind k-' + (n.locked ? 'locked' : n.type),
      n.locked ? '🔒' : (KIND[n.type] || KIND.text)));
    row.appendChild(markText(el('span', 'ol-title'), displayTitle(n), plainQuery()));
    row.appendChild(el('span', 'ol-date', fmtDate(n.updatedAt)));
    var bin = el('span', 'ol-bin', n.deletedAt ? '↺' : '✕');
    bin.dataset.binNote = n.id;
    bin.title = n.deletedAt ? 'Restore this note' : 'Move to trash';
    row.appendChild(bin);
    return row;
  }

  function renderOutline(wrap) {
    var kind = S.tab;
    var box = el('div', 'outline');
    var any = false;
    (function walk(parentId, depth) {
      childFolders(parentId).filter(function (f) { return folderFits(f, kind); })
        .sort(function (a, b) {
          return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.name.localeCompare(b.name);
        })
        .forEach(function (f) {
          any = true;
          var open = !!S.expanded[f.id];
          var row = el('button', 'ol-row' + (open ? ' open' : ''));
          row.style.setProperty('--d', String(depth));
          row.dataset.olFolder = f.id;
          row.dataset.view = f.id;          // so a dragged note can be dropped on it
          row.appendChild(el('span', 'ol-tw', '▸'));
          row.appendChild(el('span', 'ol-name', f.name));
          row.appendChild(el('span', 'ol-n', '(' + countKindIn(f.id, kind) + ')'));
          var dots = el('span', 'ol-dots', '⋮');
          dots.dataset.folderMenu = f.id;
          dots.title = 'Folder options';
          row.appendChild(dots);
          box.appendChild(row);
          if (open) {
            walk(f.id, depth + 1);
            notesDirectlyIn(f.id, kind).forEach(function (n) {
              box.appendChild(outlineNoteRow(n, depth + 1));
            });
          }
        });
    })(null, 0);

    notesDirectlyIn(null, kind).forEach(function (n) { box.appendChild(outlineNoteRow(n, 0)); });
    if (!box.childElementCount) {
      box.appendChild(el('div', 'list-empty', 'Nothing here yet.'));
    }
    var add = el('button', 'ol-add');
    add.dataset.act = 'new-folder';
    add.textContent = '＋ New folder';
    box.appendChild(add);
    wrap.appendChild(box);
  }

  function renderTabBar() {
    var bar = $('tabBar');
    if (!bar) return;
    if (!bar.childElementCount) {
      ['text', 'list', 'mindmap', 'more'].forEach(function (t) {
        var b = el('button', 'tab-btn');
        b.dataset.act = 'tab';
        b.dataset.tab = t;
        b.innerHTML = TAB_ICON[t] + '<span>' + (KIND_TAB[t] || 'More') + '</span>';
        bar.appendChild(b);
      });
    }
    Array.prototype.forEach.call(bar.children, function (b) {
      b.classList.toggle('on', b.dataset.tab === S.tab);
      b.setAttribute('aria-current', b.dataset.tab === S.tab ? 'page' : 'false');
    });
    var nh = $('newHere');
    if (nh) {
      nh.hidden = !isKindTab(S.tab);
      nh.lastChild.textContent = 'New ' + KIND_ONE[currentKind()];
      nh.title = 'New ' + KIND_ONE[currentKind()] + ' here';
    }
  }

  function saveTabState() {
    if (isKindTab(S.tab)) S.tabViews[S.tab] = S.view;
    try {
      localStorage.setItem('slate-tab', S.tab);
      localStorage.setItem('slate-tabviews', JSON.stringify(S.tabViews));
    } catch (e) { /* private mode */ }
  }

  /* Each tab reopens the folder you were last in there, as long as it still
     exists and still belongs to that tab. */
  function switchTab(tab) {
    saveTabState();
    S.tab = tab;
    if (tab === 'more') {
      S.view = 'more';
    } else {
      var v = S.tabViews[tab], f = v && folderById(v);
      S.view = (f && folderFits(f, tab)) ? v : 'all';
    }
    S.q = '';
    $('search').value = '';
    S.picked = {};
    S.selecting = false;
    if (S.note) { flush(); showEmpty(); }
    $('app').dataset.pane = 'list';
    saveTabState();
    renderTabBar();
    renderSelectBar();
    renderList();
    $('noteList').scrollTop = 0;
  }

  /* Coming from the classic layout, pick the tab that matches where you were. */
  function syncTabToView() {
    var f = folderById(S.view);
    if (f && f.kind) S.tab = f.kind;
    else if (S.view === 'pinned' || S.view === 'trash' || S.view.indexOf('tag:') === 0) S.tab = 'more';
    else if (!f) S.view = S.tab === 'more' ? 'more' : 'all';
  }

  function folderTile(f, kind) {
    var ids = subtreeIds(f.id);
    var inside = liveNotes().filter(function (n) {
      return ids.indexOf(n.folderId) !== -1 && kindOf(n) === kind;
    });
    var direct = inside.filter(function (n) { return n.folderId === f.id; }).length;
    var subs = childFolders(f.id).filter(function (x) { return folderFits(x, kind); }).length;
    var last = inside.reduce(function (m, n) { return Math.max(m, n.updatedAt || 0); }, f.createdAt || 0);

    var t = el('div', 'ftile' + (f.pinned ? ' pinned' : ''));
    t.dataset.view = f.id;
    t.tabIndex = 0;
    t.title = f.name;

    var pv = el('div', 'ft-pv');
    var pages = Math.min(3, (subs ? 1 : 0) + Math.min(2, direct));
    if (pages) {
      var peek = el('div', 'ft-peek');
      for (var i = 0; i < pages; i++) peek.appendChild(el('span', 'ft-page'));
      pv.appendChild(peek);
    }
    var fo = el('div', 'ft-folder');
    if (f.color) fo.dataset.fcolor = f.color;
    fo.appendChild(el('span', 'ft-count', String(inside.length)));
    pv.appendChild(fo);
    t.appendChild(pv);

    var nm = el('div', 'ft-name');
    if (f.pinned) nm.appendChild(el('span', 'ft-pin', '⚑'));
    nm.appendChild(document.createTextNode(f.name));
    t.appendChild(nm);

    var bits = [];
    if (subs) bits.push(plural(subs, 'folder'));
    if (direct) bits.push(plural(direct, KIND_SHORT[kind]));
    if (!bits.length) bits.push('Empty');
    bits.push(fmtDate(last));
    t.appendChild(el('div', 'ft-meta', bits.join(' · ')));

    var dot = el('button', 'ft-dots', '⋮');
    dot.dataset.folderMenu = f.id;
    dot.title = 'Open, pin, colour, move, copy, back up or delete';
    dot.setAttribute('aria-label', 'Folder options');
    t.appendChild(dot);
    return t;
  }

  function renderFolderTiles(wrap) {
    if (S.q) return;
    var kind = S.tab, here = folderById(S.view) ? S.view : null;
    var kids = childFolders(here).filter(function (f) { return folderFits(f, kind); })
      .sort(function (a, b) {
        return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.name.localeCompare(b.name);
      });
    var grid = el('div', 'ftiles');
    kids.forEach(function (f) { grid.appendChild(folderTile(f, kind)); });
    var add = el('button', 'ftile add');
    add.dataset.act = here ? 'new-subfolder-here' : 'new-folder';
    add.appendChild(el('span', 'ft-plus', '＋'));
    add.appendChild(el('span', 'ft-name', 'New folder'));
    grid.appendChild(add);
    wrap.appendChild(grid);
    return kids.length;
  }

  function renderMorePage(wrap) {
    var page = el('div', 'more-page');
    function row(label, count, attr, val) {
      var b = el('button', 'more-row');
      b.dataset[attr] = val;
      b.appendChild(el('span', 'mr-label', label));
      if (count !== null && count !== undefined) b.appendChild(el('span', 'mr-n', String(count)));
      page.appendChild(b);
    }
    page.appendChild(el('div', 'more-head', 'Your notes'));
    row('Pinned', liveNotes().filter(function (n) { return n.pinned; }).length, 'view', 'pinned');
    row('Trash', S.notes.filter(function (n) { return n.deletedAt; }).length, 'view', 'trash');
    var tags = allTags();
    if (tags.length) {
      page.appendChild(el('div', 'more-head', 'Tags'));
      tags.forEach(function (t) { row('#' + t.name, t.count, 'view', 'tag:' + t.name); });
    }
    page.appendChild(el('div', 'more-head', 'Settings'));
    row('Backup & transfer', null, 'act', 'open-transfer');
    row('Text & font', null, 'act', 'open-fonts');
    row('Theme', null, 'act', 'toggle-theme');
    var st = el('div', 'more-foot', $('storageLine').textContent || '');
    page.appendChild(st);
    var build = el('div', 'more-foot', 'Checking which build is running\u2026');
    page.appendChild(build);
    if (window.caches) {
      caches.keys().then(function (keys) {
        var mine = keys.filter(function (k) { return k.indexOf('sulat-') === 0; });
        build.textContent = mine.length
          ? 'Build ' + mine[0].replace('sulat-', '')
          : 'Running from the server, no offline copy stored';
      }).catch(function () { build.textContent = ''; });
    } else {
      build.textContent = '';
    }
    wrap.appendChild(page);
  }

  function renderTabsList() {
    renderTabBar();
    var title = $('listTitle');
    var wrap = $('noteList');
    var keepScroll = wrap.scrollTop;
    var here = folderById(S.view);
    if (here && !folderFits(here, S.tab)) { S.view = 'all'; here = null; }

    /* The path: the tab, then every folder down to this one. Each part except
       the last is a way back. */
    var parts = [];
    if (S.tab === 'more') {
      parts.push({ label: 'More', view: S.view === 'more' ? null : 'more' });
      if (S.view === 'pinned') parts.push({ label: 'Pinned' });
      else if (S.view === 'trash') parts.push({ label: 'Trash' });
      else if (S.view.indexOf('tag:') === 0) parts.push({ label: '#' + S.view.slice(4) });
    } else {
      parts.push({ label: KIND_TAB[S.tab], view: here ? 'all' : null });
      if (here) {
        folderChain(here.id).forEach(function (f, i, all) {
          parts.push({ label: f.name, view: i < all.length - 1 ? f.id : null });
        });
      }
    }
    title.innerHTML = parts.map(function (x) {
      return x.view
        ? '<span class="crumb-up" data-view="' + esc(x.view) + '">' + esc(x.label) + '</span>'
        : '<span class="crumb-here">' + esc(x.label) + '</span>';
    }).join('<span class="crumb-sep">›</span>');
    title.classList.add('trail');
    $('upBtn').hidden = parts.length < 2;

    $('search').placeholder = S.tab === 'more' ? 'Search everything'
      : here ? 'Search in ' + here.name : 'Search ' + KIND_TAB[S.tab].toLowerCase();

    wrap.innerHTML = '';
    if (S.tab === 'more' && S.view === 'more' && !S.q) {
      renderMorePage(wrap);
      saveTabState();
      return;
    }

    if (S.view === 'trash' && S.notes.some(function (n) { return n.deletedAt; })) {
      var bar = el('div', 'list-tools');
      var empty = el('button', 'ghost-btn', 'Empty trash now');
      empty.dataset.act = 'empty-trash';
      bar.appendChild(empty);
      wrap.appendChild(bar);
    }

    var mode = tabViewMode();
    $('app').dataset.tabview = mode;
    if (mode === 'outline' && isKindTab(S.tab) && !S.q) {
      renderOutline(wrap);
      wrap.scrollTop = keepScroll;
      saveTabState();
      return;
    }
    var folders = isKindTab(S.tab)
      ? (mode === 'list' ? renderFolderList(wrap) : renderFolderTiles(wrap))
      : 0;
    var notes = visibleNotes();
    if (!notes.length && !folders) {
      wrap.appendChild(el('div', 'list-empty',
        S.q ? 'Nothing matches that.'
            : isKindTab(S.tab) ? 'Empty. Use New ' + KIND_ONE[S.tab] + ' or New folder.'
            : 'Nothing here yet.'));
    }
    renderCards(wrap, notes);
    wrap.scrollTop = keepScroll;
    saveTabState();
  }

  /* Folders shown inside the note list itself. The sidebar is a drawer on a
     phone, so without these there is nowhere to drop a note on a small screen. */
  function renderFolderRows(wrap) {
    if (S.view === 'trash' || S.q) return;      // just noise in search and trash
    var here = folderById(S.view) ? S.view : null;
    var kids = childFolders(here).filter(function (f) { return folderFits(f, currentKind()); });

    var strip = el('div', 'folder-strip');

    if (here) {
      var f = folderById(here);
      var upTo = (f.parentId && folderById(f.parentId)) ? f.parentId : 'all';
      var up = el('button', 'folder-row up');
      up.dataset.view = upTo;
      up.appendChild(el('span', 'fr-ico', '⬑'));
      up.appendChild(el('span', 'fr-name',
        'Up to ' + (upTo === 'all' ? 'All notes' : folderById(upTo).name)));
      strip.appendChild(up);

      if (kids.length) {
        strip.appendChild(el('div', 'fr-head',
          plural(kids.length, 'folder') + ' inside ' + f.name));
      }
    }

    kids.forEach(function (f) {
      var grandkids = childFolders(f.id).length;
      var row = el('button', 'folder-row' + (here ? ' sub' : '') +
        (grandkids ? ' has-kids' : ''));
      row.dataset.view = f.id;
      row.title = f.name + ' — ' + countHint(f.id);
      row.appendChild(el('span', 'fr-ico', grandkids ? '▣' : '▢'));
      row.appendChild(el('span', 'fr-name', f.name));
      row.appendChild(el('span', 'fr-n', String(countIn(f.id))));
      var dot = el('span', 'fr-dot', '⋯');
      dot.dataset.folderMenu = f.id;
      dot.title = 'Rename, nest, export or delete';
      row.appendChild(dot);
      strip.appendChild(row);
    });

    /* The one control that says what this list is showing, put where the
       subfolders it is talking about are -- and offered only in a folder that
       has any, since everywhere else it would change nothing. */
    if (here && subtreeIds(here).length > 1) {
      var sc = el('button', 'folder-row scope' + (S.folderDeep ? ' on' : ''));
      sc.dataset.act = 'toggle-scope';
      sc.appendChild(el('span', 'fr-ico', S.folderDeep ? '⊖' : '⊕'));
      sc.appendChild(el('span', 'fr-name',
        S.folderDeep ? 'Subfolders included' : 'Include subfolders'));
      sc.title = S.folderDeep
        ? 'This list holds everything nested inside — switch it off to see only what is filed here'
        : 'This list holds only what is filed directly here — switch it on to include everything nested inside';
      strip.appendChild(sc);
    }

    var add = el('button', 'folder-row add');
    add.dataset.act = here ? 'new-subfolder-here' : 'new-folder';
    add.appendChild(el('span', 'fr-ico', '＋'));
    add.appendChild(el('span', 'fr-name',
      here ? 'New folder in ' + folderById(here).name : 'New folder'));
    strip.appendChild(add);

    wrap.appendChild(strip);
  }

  function pickedIds() { return Object.keys(S.picked); }

  // The bin on a card: trash it, or put it back if it is already in the trash.
  function binNote(id) {
    var n = byNoteId(id);
    if (!n) return;
    var restoring = !!n.deletedAt;
    act(restoring ? 'Restore note' : 'Trash note', noteRefs([id]), function () {
      n.deletedAt = restoring ? null : Date.now();
      n.updatedAt = Date.now();
    }).then(function () {
      if (!restoring && S.note && S.note.id === id) showEmpty();
      renderTree(); renderList(); renderMeta(); renderUndoButtons();
      toast(restoring ? 'Restored' : 'Moved to trash — Ctrl+Z to undo');
    });
  }

  /* ---------- dragging notes into folders (mouse and touch) ---------- */

  var noteDragState = null;
  var suppressClick = false;
  var pressDrag = { timer: null, x: 0, y: 0, id: 0 };

  function dropTargetAt(x, y) {
    var hit = document.elementFromPoint(x, y);
    if (!hit) return null;
    var t = hit.closest('[data-view]');
    if (!t) return null;
    var v = t.dataset.view;
    return (v === 'all' || v === 'unfiled' || v === 'pinned' || v === 'trash' || folderById(v))
      ? t : null;
  }

  function beginNoteDrag(e, ids, folderId) {
    noteDragState = {
      ids: ids, folderId: folderId || null, pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY,
      started: false, ghost: null, target: null
    };
  }

  function noteDragMove(e) {
    var d = noteDragState;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.started) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 8) return;
      d.started = true;
      var first = byNoteId(d.ids[0]);
      var moving = folderById(d.folderId);
      d.ghost = el('div', 'note-ghost', moving ? '▢ ' + moving.name
        : d.ids.length > 1 ? plural(d.ids.length, 'note')
        : ((first && first.title) || 'Untitled'));
      document.body.appendChild(d.ghost);
      document.body.classList.add('dragging-note');
    }
    e.preventDefault();
    d.ghost.style.transform = 'translate(' + (e.clientX + 14) + 'px,' + (e.clientY + 12) + 'px)';
    var t = dropTargetAt(e.clientX, e.clientY);
    if (d.target && d.target !== t) d.target.classList.remove('drop-target');
    d.target = t;
    if (t) t.classList.add('drop-target');
  }

  function endNoteDrag(e) {
    var d = noteDragState;
    if (!d || (e && e.pointerId !== d.pointerId)) return;
    noteDragState = null;
    if (d.ghost) d.ghost.remove();
    document.body.classList.remove('dragging-note');
    if (d.target) d.target.classList.remove('drop-target');
    if (!d.started) return;
    // the pointerup that ends a drag must not also open the note
    suppressClick = true;
    setTimeout(function () { suppressClick = false; }, 80);
    if (!d.target) return;
    if (d.folderId) dropFolderOn(d.target.dataset.view, d.folderId);
    else dropNotesOn(d.target.dataset.view, d.ids);
  }

  function dropFolderOn(target, folderId) {
    var f = folderById(folderId);
    if (!f) return;
    var dest = folderById(target) ? target : null;
    if (dest === (f.parentId || null)) return;              // already there
    if (dest && folderSubtree(folderId).indexOf(dest) !== -1) {
      toast('A folder cannot go inside itself');
      return;
    }
    var destF = dest ? folderById(dest) : null;
    if (destF && f.kind && destF.kind && destF.kind !== f.kind) {
      toast('That folder belongs to another tab');
      return;
    }
    act('Move folder', [{ store: 'folders', id: folderId }], function () {
      f.parentId = dest;
    }).then(function () {
      if (dest) S.expanded[dest] = true;
      renderTree(); renderList(); renderUndoButtons();
      toast('Moved into ' + (destF ? destF.name : 'the top level'));
    });
  }

  function dropNotesOn(target, ids) {
    ids = ids.filter(function (x) { return byNoteId(x); });
    if (!ids.length) return;

    if (target === 'trash') {
      act('Trash ' + plural(ids.length, 'note'), noteRefs(ids), function () {
        ids.forEach(function (id) {
          var n = byNoteId(id);
          n.deletedAt = Date.now();
          n.updatedAt = Date.now();   // so the delete wins when devices merge
        });
      }).then(function () {
        if (S.note && ids.indexOf(S.note.id) !== -1) showEmpty();
        S.picked = {};
        renderTree(); renderList(); renderSelectBar(); renderUndoButtons();
        toast('Moved to trash — Ctrl+Z to undo');
      });
      return;
    }
    if (target === 'pinned') {
      act('Pin ' + plural(ids.length, 'note'), noteRefs(ids), function () {
        ids.forEach(function (id) {
          var n = byNoteId(id); n.pinned = true; n.updatedAt = Date.now();
        });
      }).then(function () {
        renderTree(); renderList(); renderMeta(); renderUndoButtons();
        toast('Pinned');
      });
      return;
    }
    moveNotesTo(ids, (target === 'all' || target === 'unfiled') ? null : target);
  }

  function renderSelectBar() {
    var bar = $('selectBar');
    bar.hidden = !S.selecting;
    if (S.selecting) $('app').dataset.selecting = 'on';
    else delete $('app').dataset.selecting;
    $('selectBtn').classList.toggle('on', S.selecting);
    if (S.selecting) $('selCount').textContent = plural(pickedIds().length, 'note') + ' selected';
  }

  function setViewMode(mode) {
    S.viewMode = mode;
    $('app').dataset.viewMode = mode;
    localStorage.setItem('slate-viewmode', mode);
    $('viewBtn').title = 'View: ' + mode + ' (click to change)';
  }

  /* ================= images ================= */

  function imgURL(id) {
    if (S.imgURL[id]) return Promise.resolve(S.imgURL[id]);
    return DB.get('images', id).then(function (rec) {
      if (!rec || !rec.blob) return null;
      S.imgURL[id] = URL.createObjectURL(rec.blob);
      return S.imgURL[id];
    }).catch(function () { return null; });
  }

  function renderGallery() {
    var g = $('gallery');
    g.innerHTML = '';
    // a mindmap's images live on its nodes; a text note's live in its flow.
    // Anything left here is an attachment that is not placed yet.
    if (!S.note || S.note.type === 'mindmap') return;
    var placed = S.note.type === 'text' ? inlineImageIds() : [];
    (S.note.images || []).filter(function (id) {
      return placed.indexOf(id) === -1;
    }).forEach(function (id) {
      var t = el('div', 'thumb');
      var img = el('img');
      img.alt = '';
      img.dataset.lightbox = id;
      imgURL(id).then(function (u) { if (u) img.src = u; });
      var rm = el('button', 'rm', '✕');
      rm.dataset.removeImage = id;
      rm.title = 'Remove image';
      t.appendChild(img);
      t.appendChild(rm);
      g.appendChild(t);
    });
  }

  function attachFiles(files) {
    if (!S.note) { toast('Open a note first.'); return; }
    var imgs = Array.prototype.filter.call(files, function (f) {
      return f.type && f.type.indexOf('image/') === 0;
    });
    if (!imgs.length) { toast('No images in that drop.'); return; }
    var note = S.note;
    Promise.all(imgs.map(function (f) { return DB.addImage(f); }))
      .then(function (recs) {
        if (S.note !== note) return;

        // On a mindmap an image belongs to a node, not to a strip above the
        // canvas: the first goes on the selected node, the rest become nodes.
        if (note.type === 'mindmap' && S.map && S.mapNoteId === note.id) {
          recs.forEach(function (r, i) {
            S.map.attachImage(r.id, i === 0 ? S.map.selected : null);
          });
          renderMapTools(S.map.selected);
          renderList();
          renderUndoButtons();
          toast(plural(recs.length, 'image') + ' added to the map');
          return;
        }

        var ids = recs.map(function (r) { return r.id; });
        note.images = (note.images || []).concat(ids);
        if (note.type === 'text') {
          insertImagesInline(ids);
        } else {
          note.updatedAt = Date.now();
          touch();
        }
        renderGallery();
        renderList();
        renderUndoButtons();
        toast(plural(recs.length, 'image') + ' added');
      })
      .catch(function (e) { toast('Could not add image: ' + e.message); });
  }

  /* ================= editor ================= */

  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  /* An untitled mindmap is named after its central idea, so exports and the
     note list show something meaningful instead of "Untitled". */
  /* Words that carry no meaning at the front of a title. Dropping them stops
     every third note being called "The ..." or "A ...". */
  var TITLE_SKIP = { the: 1, a: 1, an: 1, to: 1, of: 1, and: 1, for: 1, in: 1, on: 1 };

  /* A stand-in title taken from the note itself. This is the first meaningful
     line trimmed to a sensible length -- not a summary; summarising would need
     a language model, and this app never reaches the network. */
  function autoTitle(n) {
    var src = '';
    if (n.type === 'list') {
      var first = (n.items || []).filter(function (i) { return (i.text || '').trim(); })[0];
      src = first ? first.text : '';
    } else if (n.type === 'mindmap') {
      var c = window.Mindmap && Mindmap.centralNode(n.map);
      src = c && c.text ? c.text : '';
    } else {
      src = n.body || '';
    }
    src = String(src).replace(/\s+/g, ' ').trim();
    if (!src) return '';

    // stop at the first sentence end, so a title is never half a paragraph
    var stop = src.search(/[.!?](\s|$)/);
    if (stop > 0 && stop < 60) src = src.slice(0, stop);

    var words = src.split(' ');
    while (words.length > 1 && TITLE_SKIP[words[0].toLowerCase().replace(/[^a-z]/g, '')]) {
      words.shift();
    }
    var out = words.slice(0, 8).join(' ');
    if (out.length > 52) out = out.slice(0, 52).replace(/\s\S*$/, '') + '…';
    else if (words.length > 8) out += '…';
    return out;
  }

  function displayTitle(n) {
    if (n.title) return n.title;
    var auto = autoTitle(n);
    if (auto) return auto;
    return 'Untitled';
  }

  function renderTagRow() {
    var row = $('tagRow');
    if (!row) return;
    row.innerHTML = '';
    if (!S.note) return;
    tagsOf(S.note).forEach(function (t) {
      var chip = el('span', 'tag-chip');
      var label = el('button', 'tag-name', '#' + t);
      label.dataset.view = 'tag:' + t;
      label.title = 'Show everything tagged “' + t + '”';
      var x = el('button', 'tag-x', '✕');
      x.dataset.untag = t;
      x.title = 'Remove this tag';
      chip.appendChild(label);
      chip.appendChild(x);
      row.appendChild(chip);
    });
    // Only offer the inline button once tags are actually in use. Otherwise it
    // is a control most people never want, sitting under every single title.
    // "Add a tag…" in the ⋮ menu is always there for the first one.
    if (tagsOf(S.note).length) {
      var add = el('button', 'tag-add', '＋ Tag');
      add.dataset.act = 'add-tag';
      row.appendChild(add);
    }
  }

  function renderMeta() {
    if (!S.note) return;
    var n = S.note;
    var bits = [n.type === 'mindmap' ? 'mindmap' : n.type,
                'edited ' + fmtDate(n.updatedAt, { full: true })];
    if (n.deletedAt) bits.unshift('in trash');
    if (n.pinned) bits.push('pinned');
    $('noteMeta').textContent = bits.join('  ·  ');
    var chip = $('pageChip');
    if (chip) {
      var ps = n.pages || [];
      chip.hidden = ps.length < 2 || !!n.locked;
      if (ps.length > 1) {
        var at = pageIndex(n);
        chip.textContent = (ps[at].name || 'Page ' + (at + 1)) + '  ·  ' + (at + 1) + ' of ' + ps.length + '  ▾';
        chip.title = 'Switch, add or rename pages';
      }
    }
    var chip = $('editorCrumb');
    chip.textContent = n.folderId ? '▢ ' + folderPath(n.folderId) : '◌ Unfiled';
    chip.classList.toggle('unfiled', !n.folderId);
  }

  function openNote(id) {
    var leaving = S.note && S.note.id !== id ? S.note : null;
    flush();
    if (S.draftId && S.draftId !== id) discardDraft();
    if (leaving) dropIfBlank(leaving);
    var n = byNoteId(id);
    S.note = n;
    if (!n) { showEmpty(); return; }
    localStorage.setItem('slate-last', n.id);

    $('emptyState').hidden = true;
    $('editorBody').hidden = false;
    if ($('app').dataset.pane !== 'editor') S.listScroll = $('noteList').scrollTop;
    $('app').dataset.pane = 'editor';

    $('noteTitle').value = n.title || '';
    autosize($('noteTitle'));       // a wrapped title needs its height set on open
    renderMeta();
    renderTagRow();
    renderGallery();

    var locked = !!n.locked;
    var isText = !locked && n.type === 'text';
    var isList = !locked && n.type === 'list';
    var isMap  = !locked && n.type === 'mindmap';
    $('lockedPanel').hidden = !locked;
    $('noteRich').hidden = !isText;
    $('listEditor').hidden = !isList;
    $('mapEditor').hidden = !isMap;

    /* The editor column is held to a reading width, which is right for prose
       and wrong for a canvas -- it left a mindmap boxed into the middle of a
       wide screen with dead margin either side. Mark the open note's kind so
       the stylesheet can let the map have the whole pane. */
    if (isMap) $('app').dataset.notetype = 'mindmap';
    else delete $('app').dataset.notetype;

    if (isText) {
      renderRich();
      renderGallery();      // again: it needs to know which images are now inline
    }
    if (isList) renderItems();
    if (isMap) mountMap(); else S.mapNoteId = null;
    /* The note page was hidden until this moment, so the canvas measured
       itself before it had a size. Measure again once it is on screen. */
    if (isMap) setTimeout(function () { if (S.map && S.note === n) S.map.resize(); }, 60);

    renderList();
    renderUndoButtons();
    setTimeout(function () { if (S.note && S.note.id === id) markHits(S.hitQuery); }, 30);
  }

  /* ---------- the searched word, inside the note ----------
     Marked without touching what is stored: a browser highlight over ranges
     for prose, a flash on the row for a list item, and the node itself for a
     mindmap. Where the browser has no highlight API nothing is marked, and
     the jump to the first match still works. */
  function clearHits() {
    S.hits = [];
    S.hitAt = 0;
    S.hitQuery = '';
    if (window.CSS && CSS.highlights) CSS.highlights.delete('sulat-hit');
    Array.prototype.forEach.call(document.querySelectorAll('.row.hit-row'), function (r) {
      r.classList.remove('hit-row');
    });
    var bar = $('hitBar');
    if (bar) bar.hidden = true;
  }

  function textRanges(root, q) {
    var out = [], needle = q.toLowerCase();
    var walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walk.nextNode())) {
      var low = (node.nodeValue || '').toLowerCase(), at = 0, i;
      while ((i = low.indexOf(needle, at)) !== -1) {
        var r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + needle.length);
        out.push(r);
        at = i + needle.length;
      }
    }
    return out;
  }

  function markHits(q) {
    clearHits();
    var n = S.note;
    if (!q || !n || n.locked) return;
    S.hitQuery = q;

    if (n.type === 'mindmap' && S.map) {
      var low = q.toLowerCase();
      S.hits = S.map.nodes.filter(function (nd) {
        return String(nd.text || '').toLowerCase().indexOf(low) !== -1;
      });
      if (!S.hits.length) return;
      showHit(0);
      return;
    }

    if (n.type === 'list') {
      var lowQ = q.toLowerCase();
      S.hits = Array.prototype.filter.call($('listItems').querySelectorAll('.row'), function (row) {
        var ta = row.querySelector('.txt');
        return ta && String(ta.value || '').toLowerCase().indexOf(lowQ) !== -1;
      });
      if (!S.hits.length) return;
      showHit(0);
      return;
    }

    var rich = $('noteRich');
    if (!rich) return;
    S.hits = textRanges(rich, q);
    if (!S.hits.length) return;
    if (window.CSS && CSS.highlights && window.Highlight) {
      try {
        var hl = new Highlight();
        S.hits.forEach(function (r) { hl.add(r); });
        CSS.highlights.set('sulat-hit', hl);
      } catch (e) { /* older browser: the jump still works */ }
    }
    showHit(0);
  }

  function showHit(i) {
    if (!S.hits.length) return;
    S.hitAt = (i + S.hits.length) % S.hits.length;
    var hit = S.hits[S.hitAt];
    if (S.note && S.note.type === 'mindmap' && S.map) {
      S.map.select(hit);
      S.map.reveal(hit);
    } else if (S.note && S.note.type === 'list') {
      Array.prototype.forEach.call(document.querySelectorAll('.row.hit-row'), function (r) {
        r.classList.remove('hit-row');
      });
      hit.classList.add('hit-row');
      hit.scrollIntoView({ block: 'center' });
    } else {
      var r = hit.getBoundingClientRect();
      var box = $('editorScroll');
      box.scrollTop += r.top - box.getBoundingClientRect().top - box.clientHeight / 3;
    }
    var bar = $('hitBar');
    if (bar) {
      bar.hidden = false;
      $('hitCount').textContent = (S.hitAt + 1) + ' of ' + S.hits.length +
        ' \u00b7 \u201c' + S.hitQuery + '\u201d';
    }
  }

  /* With no note open, the editor used to say only "Pick a note". When a
     folder is selected there is something better to show: what is in it. It is
     a summary, not an editor -- clicking a line opens the real note. */
  function renderFolderOverview() {
    var box = $('emptyState');
    if (!box) return;
    var f = folderById(S.view);
    if (!f) {
      box.innerHTML = '<div class="empty-mark">▢</div>' +
                      '<p>Pick a note, or start a new one.</p>';
      box.classList.remove('folder-view');
      return;
    }

    var inside = liveNotes().filter(function (n) { return n.folderId === f.id; })
      .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    var subs = S.folders.filter(function (x) { return x.parentId === f.id; });

    var chain = folderChain(f.id);
    var trail = chain.slice(0, -1);

    var html = '<div class="fv-head">' +
      (trail.length
        ? '<div class="fv-trail">' + trail.map(function (p) {
            return '<span data-view="' + esc(p.id) + '">' + esc(p.name) + '</span>';
          }).join(' › ') + ' ›</div>'
        : '') +
      '<h2>' + esc(f.name) + '</h2>' +
      '<p class="sub">' + plural(inside.length, 'note') + ' here' +
      (subs.length ? ' · ' + plural(subs.length, 'subfolder') +
        ' holding ' + (countDeep(f.id) - inside.length) + ' more' : '') +
      '</p></div>';

    if (subs.length) {
      html += '<div class="fv-section">Folders inside</div>' +
        '<div class="fv-subs">' + subs.map(function (x) {
        return '<button class="fv-sub" data-view="' + esc(x.id) + '"' +
          (x.color ? ' data-fcolor="' + esc(x.color) + '"' : '') + '>' +
          (childFolders(x.id).length ? '▣' : '▢') + ' ' + esc(x.name) +
          ' <span class="n">' + countDeep(x.id) + '</span></button>';
      }).join('') + '</div>';
    }

    if (subs.length && inside.length) html += '<div class="fv-section">Notes in ' + esc(f.name) + '</div>';

    html += inside.length
      ? '<ul class="fv-list">' + inside.map(function (n) {
          return '<li><button data-note-id="' + esc(n.id) + '">' +
            '<span class="card-kind k-' + esc(n.type) + '">' +
            (KIND[n.type] || KIND.text) + '</span>' +
            '<span class="fv-title">' + esc(displayTitle(n)) + '</span>' +
            '<span class="fv-when">' + esc(fmtDate(n.updatedAt)) + '</span></button></li>';
        }).join('') + '</ul>'
      : '<p class="sub">Nothing filed here yet.</p>';

    box.innerHTML = html;
    box.classList.add('folder-view');
  }

  function showEmpty() {
    clearHits();
    discardDraft();
    dropIfBlank(S.note);
    S.note = null;
    S.mapNoteId = null;
    // clear the fields too, so nothing stale is left behind the empty state
    $('noteTitle').value = '';
    $('noteRich').innerHTML = '';
    $('gallery').innerHTML = '';
    $('listItems').innerHTML = '';
    $('emptyState').hidden = false;
    $('editorBody').hidden = true;
    renderList();
    renderUndoButtons();
  }

  /* Nothing typed, nothing pasted, nothing ticked: the note you opened by
     mistake. A fresh mindmap's single "Start here" node counts as nothing,
     since the app put it there, not you. */
  function isBlankNote(n) {
    if (!n || n.locked) return false;
    if ((n.title || '').trim()) return false;
    if ((n.body || '').trim()) return false;
    if (String(n.bodyHtml || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim()) return false;
    if ((n.images || []).length) return false;
    if ((n.tags || []).length) return false;
    if ((n.items || []).some(function (i) { return (i.text || '').trim(); })) return false;
    if ((n.pages || []).length > 1) return false;
    var nodes = (n.map && n.map.nodes) || [];
    if (nodes.length > 1) return false;
    if (nodes.length === 1 && (nodes[0].text || '').trim() !== 'Start here') return false;
    return true;
  }

  // the first thing you put in it is what saves it
  /* Left with nothing in it -- everything typed then deleted again -- is the
     same as never having written anything, so it goes when you leave it.
     Through act(), so Ctrl+Z brings it straight back. */
  function dropIfBlank(n) {
    if (!n || n.deletedAt || n.locked) return false;
    if (S.draftId === n.id) return false;          // never saved: discardDraft handles it
    if (!byNoteId(n.id) || !isBlankNote(n)) return false;
    var id = n.id;
    act('Remove empty note', noteRefs([id]), function () {
      S.notes = S.notes.filter(function (x) { return x.id !== id; });
    });
    return true;
  }

  function commitDraft() {
    var id = S.draftId;
    if (!id) return Promise.resolve();
    var n = byNoteId(id);
    if (!n || isBlankNote(n)) return Promise.resolve();
    S.draftId = null;
    History.push('New ' + (n.type === 'mindmap' ? 'mindmap' : n.type),
      [History.rec('notes', id, null)], [History.rec('notes', id, n)]);
    renderUndoButtons();
    return DB.put('notes', n);
  }

  // left without a word in it: drop it, with nothing in Trash or undo to clear up
  function discardDraft() {
    var id = S.draftId;
    if (!id) return false;
    var n = byNoteId(id);
    if (!n || !isBlankNote(n)) return false;
    S.draftId = null;
    S.notes = S.notes.filter(function (x) { return x.id !== id; });
    if (S.note && S.note.id === id) { S.note = null; S.mapNoteId = null; }
    try {
      if (localStorage.getItem('slate-last') === id) localStorage.removeItem('slate-last');
    } catch (e) { /* private mode */ }
    DB.del('notes', id);
    return true;
  }

  function newNote(type) {
    flush();
    var folderId = (S.view === 'all' || S.view === 'pinned' || S.view === 'trash' ||
                    S.view === 'unfiled') ? null : S.view;
    if (folderId && !folderById(folderId)) folderId = null;     // a tag or More view
    var made = [];
    if (folderId) folderId = twinOf(folderId, type, made);
    var n = DB.blankNote(type, folderId);
    if (type === 'list') n.items = [{ id: DB.uid(), text: '', done: false, indent: 0 }];
    if (S.view === 'pinned') n.pinned = true;

    (made.length ? DB.putMany('folders', made) : Promise.resolve()).then(function () {
      discardDraft();                 // only ever one unsaved new note at a time
      S.notes.push(n);
      S.draftId = n.id;
      renderTree();
      renderUndoButtons();
      openNote(n.id);
      setTimeout(function () { $('noteTitle').focus(); }, 30);
    });
  }

  /* ---------- rich text notes: images sit in the flow, text wraps around ----------
     The body is stored twice: bodyHtml for the editor, and body as plain text
     so search, Markdown and .txt export keep working unchanged. Image elements
     carry only a data-img id; the blob URL is attached at render time and
     stripped again on save, so nothing stale is ever written to the database. */

  /* Folder colours. Deliberately a short list -- these are meant to be told
     apart instantly out of the corner of your eye, and a long palette stops
     being readable at a glance. `null` is the default, no colour at all. */
  var FOLDER_COLORS = [
    { id: null,      label: 'None' },
    { id: 'red',     label: 'Red' },
    { id: 'orange',  label: 'Orange' },
    { id: 'yellow',  label: 'Yellow' },
    { id: 'green',   label: 'Green' },
    { id: 'blue',    label: 'Blue' },
    { id: 'purple',  label: 'Purple' },
    { id: 'pink',    label: 'Pink' },
    { id: 'grey',    label: 'Grey' }
  ];

  function folderColor(id) {
    var f = id ? folderById(id) : null;
    return (f && f.color) || null;
  }

  var ALIGN_CLASS = { left: 'ni-left', right: 'ni-right', center: 'ni-center', full: 'ni-full' };

  /* Web addresses become clickable. Done on the stored HTML rather than while
     typing, so the caret is never moved out from under you mid-word. */
  var URL_RE = /(^|[\s(>])((?:https?:\/\/|www\.)[^\s<>"')]+[^\s<>"'),.;:!?])/gi;

  function linkifyHtml(html) {
    // never touch text that is already inside a tag or an existing link
    var parts = String(html || '').split(/(<[^>]+>)/);
    var inAnchor = false;
    for (var i = 0; i < parts.length; i++) {
      var chunk = parts[i];
      if (chunk.charAt(0) === '<') {
        if (/^<a\b/i.test(chunk)) inAnchor = true;
        else if (/^<\/a>/i.test(chunk)) inAnchor = false;
        continue;
      }
      if (inAnchor || chunk.indexOf('http') === -1 && chunk.indexOf('www.') === -1) continue;
      parts[i] = chunk.replace(URL_RE, function (all, lead, url) {
        var href = /^www\./i.test(url) ? 'https://' + url : url;
        return lead + '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' +
               url + '</a>';
      });
    }
    return parts.join('');
  }

  /* ---------- keeping pasted content local and inert ----------

     Anything pasted from a web page arrives as its markup: remote <img> tags
     that would call that server every time the note is opened, and event
     handlers that would run when it is rendered. Both are stripped here, so a
     note can never reach the network on its own and pasted markup cannot
     execute. Only the app's own images -- the ones carrying data-img, which
     resolve to blobs held on this device -- are kept. */

  var OK_TAGS = {
    P: 1, BR: 1, DIV: 1, SPAN: 1, B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1,
    UL: 1, OL: 1, LI: 1, A: 1, IMG: 1, BLOCKQUOTE: 1, CODE: 1, PRE: 1,
    H1: 1, H2: 1, H3: 1, H4: 1
  };

  function sanitizeInto(root) {
    var strippedRemote = 0;
    var drop = [];
    var els = root.querySelectorAll('*');
    Array.prototype.forEach.call(els, function (node) {
      if (!OK_TAGS[node.tagName]) { drop.push(node); return; }

      Array.prototype.slice.call(node.attributes).forEach(function (attr) {
        var n = attr.name.toLowerCase();
        var keep =
          (node.tagName === 'A' && n === 'href') ||
          (node.tagName === 'IMG' && (n === 'data-img' || n === 'class')) ||
          // where a freely placed picture sits. Numbers only, and the position
          // is re-applied as a transform at render time -- nothing from a
          // pasted document is ever written into a style attribute.
          (node.tagName === 'IMG' && (n === 'data-fx' || n === 'data-fy') &&
            /^-?\d{1,5}$/.test(attr.value)) ||
          (node.tagName === 'IMG' && n === 'style' &&
            /^width:\s*[\d.]+%;?$/.test(attr.value));
        if (!keep) node.removeAttribute(attr.name);   // takes every on* handler with it
      });

      if (node.tagName === 'IMG' && !node.hasAttribute('data-img')) {
        drop.push(node);
        strippedRemote++;
        return;
      }
      if (node.tagName === 'A') {
        var href = node.getAttribute('href') || '';
        if (!/^https?:\/\//i.test(href)) node.removeAttribute('href');
        else {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        }
      }
    });

    drop.forEach(function (node) {
      if (!node.parentNode) return;
      // pictures and scripts go; an unknown wrapper just loses its wrapping
      if (node.tagName === 'IMG' || node.tagName === 'SCRIPT' ||
          node.tagName === 'IFRAME' || node.tagName === 'OBJECT' ||
          node.tagName === 'EMBED' || node.tagName === 'STYLE' ||
          node.tagName === 'LINK') {
        node.remove();
        return;
      }
      while (node.firstChild) node.parentNode.insertBefore(node.firstChild, node);
      node.remove();
    });
    return strippedRemote;
  }

  function sanitizeHtml(html) {
    var box = document.createElement('div');
    box.innerHTML = String(html || '');
    sanitizeInto(box);
    return box.innerHTML;
  }

  function htmlFromPlain(text) {
    return String(text || '').split(/\n{2,}/).map(function (p) {
      if (!p.trim()) return '';
      return '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>';
    }).filter(Boolean).join('') || '<p><br></p>';
  }

  function bodyHtmlOf(note) {
    if (note.bodyHtml) return note.bodyHtml;
    var html = htmlFromPlain(note.body);
    // a note that had images before inline editing existed: keep them visible
    (note.images || []).forEach(function (id) {
      html += '<p><img data-img="' + esc(id) + '" class="ni ni-center" style="width:60%"></p>';
    });
    return html;
  }

  function renderRichSrcs() {
    Array.prototype.forEach.call($('noteRich').querySelectorAll('img[data-img]'), function (im) {
      im.draggable = false;
      if (!im.getAttribute('src')) imgURL(im.dataset.img).then(function (u) { if (u) im.src = u; });
    });
  }

  function renderRich() {
    var box = $('noteRich');
    box.innerHTML = linkifyHtml(sanitizeHtml(bodyHtmlOf(S.note)));
    Array.prototype.forEach.call(box.querySelectorAll('img[data-img]'), function (im) {
      im.draggable = false;          // the pointer handler owns this gesture
      imgURL(im.dataset.img).then(function (u) { if (u) im.src = u; });
      if (im.classList.contains('ni-free')) {
        setFreeXY(im, parseFloat(im.dataset.fx) || 0, parseFloat(im.dataset.fy) || 0);
      }
    });
    hideImgBar();
  }

  // Serialise without blob URLs, which are only valid for this page load.
  function readRich() {
    var clone = $('noteRich').cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll('img[data-img]'), function (im) {
      im.removeAttribute('src');
      im.removeAttribute('draggable');
    });
    Array.prototype.forEach.call(clone.querySelectorAll('.ni-sel'), function (im) {
      im.classList.remove('ni-sel');
    });
    return { html: clone.innerHTML, text: (clone.textContent || '').replace(/ /g, ' ') };
  }

  function inlineImageIds() {
    return Array.prototype.map.call(
      $('noteRich').querySelectorAll('img[data-img]'),
      function (im) { return im.dataset.img; });
  }

  var selectedImg = null;


/* ================= moving an image in a note =================

   The old version used HTML5 drag-and-drop, which is why it stuck: the
   browser owns the timing, the real element never moves, and it does nothing
   at all on touch.

   This is the model CJBoard uses -- remember where the grab started, add the
   delta, paint. The difference from a canvas is that the picture sits in
   text, so two things run at once while you drag:

     1. the image follows the pointer through `transform`, which the compositor
        handles without any layout work, so it tracks 1:1;
     2. an anchor walks through the text, throttled to one update per frame,
        and the paragraphs rewrap around wherever it now sits.

   That second part is what makes it feel like PageMaker rather than like
   dropping a file into a text box. */

var imgDrag = null;

function noteSurface() { return $('noteRich'); }

function freeXY(img) {
  return {
    x: parseFloat(img.dataset.fx || '0') || 0,
    y: parseFloat(img.dataset.fy || '0') || 0
  };
}

function setFreeXY(img, x, y) {
  img.dataset.fx = Math.round(x);
  img.dataset.fy = Math.round(y);
  img.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)';
}

function isFree(img) { return img.classList.contains('ni-free'); }

function caretFromPoint(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  if (document.caretPositionFromPoint) {
    var pos = document.caretPositionFromPoint(x, y);
    if (!pos) return null;
    var r = document.createRange();
    r.setStart(pos.offsetNode, pos.offset);
    r.collapse(true);
    return r;
  }
  return null;
}

/* Which side the text should wrap on, from where the pointer is across the
   writing column. Matches what a person expects: put the picture on the left
   and the words run down its right. */
function wrapSideFor(clientX) {
  var box = noteSurface().getBoundingClientRect();
  var t = (clientX - box.left) / Math.max(1, box.width);
  if (t < 0.34) return 'left';
  if (t > 0.66) return 'right';
  return 'center';
}

function applyAlignClass(img, align) {
  Object.keys(ALIGN_CLASS).forEach(function (k) { img.classList.remove(ALIGN_CLASS[k]); });
  img.classList.add(ALIGN_CLASS[align] || ALIGN_CLASS.center);
}

function startImgDrag(e, img) {
  var r = img.getBoundingClientRect();
  var free = isFree(img);
  var xy = free ? freeXY(img) : { x: 0, y: 0 };

  imgDrag = {
    img: img,
    free: free,
    grabX: e.clientX - r.left,        // where inside the picture you took hold
    grabY: e.clientY - r.top,
    baseX: xy.x, baseY: xy.y,
    startClientX: e.clientX, startClientY: e.clientY,
    lastX: e.clientX, lastY: e.clientY,
    side: null,
    frame: 0,
    moved: false,
    w: r.width, h: r.height
  };
  // capture keeps the gesture if the pointer leaves the picture; not fatal
  try { img.setPointerCapture(e.pointerId); } catch (err) { /* no active pointer */ }
}

function imgDragMove(e) {
  var d = imgDrag;
  if (!d) return;
  d.lastX = e.clientX; d.lastY = e.clientY;

  if (!d.moved) {
    // a few pixels of slack, so a click to select is never a drag
    if (Math.abs(e.clientX - d.startClientX) < 4 &&
        Math.abs(e.clientY - d.startClientY) < 4) return;
    d.moved = true;
    beginBurst('Move image');
    d.img.classList.add('ni-drag');
    document.body.classList.add('img-dragging');
    if ($('imgGrip')) $('imgGrip').hidden = true;
  }

  /* Painted straight from the event, the way CJBoard paints from mousemove.
     Pointer moves already arrive at roughly one per frame, and this writes a
     transform and nothing else -- no layout. Deferring to requestAnimationFrame
     would be tidier, but it is throttled in a background view and paused in a
     hidden one, which would leave the picture stuck exactly when you are
     dragging it. */
  paintImgDrag();
}

function paintImgDrag() {
  var d = imgDrag, img = d.img;
  var surface = noteSurface();
  var box = surface.getBoundingClientRect();

  if (d.free) {
    // straight coordinates, exactly like a board
    setFreeXY(img,
      d.baseX + (d.lastX - d.startClientX),
      d.baseY + (d.lastY - d.startClientY));
    return;
  }

  /* Anchored: the picture follows the pointer for the eye, while the anchor
     moves through the text so the paragraphs reflow around its new home. */
  var here = img.getBoundingClientRect();
  var wantX = d.lastX - d.grabX, wantY = d.lastY - d.grabY;
  img.style.transform =
    'translate3d(' + (wantX - here.left + (parseFloat(img.dataset.tx || 0))) + 'px,' +
    (wantY - here.top + (parseFloat(img.dataset.ty || 0))) + 'px,0)';
  img.dataset.tx = wantX - here.left + (parseFloat(img.dataset.tx || 0));
  img.dataset.ty = wantY - here.top + (parseFloat(img.dataset.ty || 0));

  var side = wrapSideFor(d.lastX);
  var r = caretFromPoint(d.lastX, d.lastY);
  if (r && !img.contains(r.startContainer) && r.startContainer !== img) {
    var moved = false;
    try {
      // only touch the DOM when the anchor really changed, or every frame
      // would reflow the note for nothing
      var probe = document.createRange();
      probe.selectNode(img);
      if (r.compareBoundaryPoints(Range.START_TO_START, probe) !== 0) {
        r.insertNode(img);
        moved = true;
      }
    } catch (err) { /* the caret landed somewhere we cannot use */ }
    if (moved || side !== d.side) {
      d.side = side;
      applyAlignClass(img, side);
      // re-measure: the reflow moved the picture, so the offset must follow
      var after = img.getBoundingClientRect();
      img.dataset.tx = (d.lastX - d.grabX) - (after.left - (parseFloat(img.dataset.tx || 0)));
      img.dataset.ty = (d.lastY - d.grabY) - (after.top - (parseFloat(img.dataset.ty || 0)));
      img.style.transform = 'translate3d(' + Math.round(img.dataset.tx) + 'px,' +
                            Math.round(img.dataset.ty) + 'px,0)';
    }
  }
}

/* Abandon a drag without committing it -- used when a second finger lands and
   the gesture turns out to be a pinch, which belongs to the browser. */
function cancelImgDrag() {
  var d = imgDrag;
  if (!d) return;
  imgDrag = null;
  if (d.frame) cancelAnimationFrame(d.frame);
  document.body.classList.remove('img-dragging');
  d.img.classList.remove('ni-drag');
  d.img.style.transform = d.free
    ? 'translate3d(' + d.baseX + 'px,' + d.baseY + 'px,0)' : '';
  if (!d.free) { delete d.img.dataset.tx; delete d.img.dataset.ty; }
}

function endImgDrag() {
  var d = imgDrag;
  imgDrag = null;
  if (!d) return;
  if (d.frame) cancelAnimationFrame(d.frame);
  document.body.classList.remove('img-dragging');
  d.img.classList.remove('ni-drag');

  if (!d.moved) { showImgBar(d.img); return; }

  if (d.free) {
    setFreeXY(d.img, freeXY(d.img).x, freeXY(d.img).y);
  } else {
    // settle into the flow: the anchor is already right, so drop the offset
    d.img.style.transform = '';
    delete d.img.dataset.tx;
    delete d.img.dataset.ty;
  }
  showImgBar(d.img);
  saveRich('Move image');
}

function bindImgDrag() {
  var rich = $('noteRich');

  /* How many fingers are on the editor. Two is a pinch, and a pinch belongs to
     the browser -- claiming it is why zooming on the phone dragged the picture
     about instead of zooming the page. */
  var livePointers = 0;

  rich.addEventListener('pointerdown', function (e) {
    livePointers++;
    if (livePointers > 1) { cancelImgDrag(); return; }    // a pinch is starting
    var img = e.target && e.target.closest ? e.target.closest('img.ni') : null;
    if (!img || e.button !== 0) return;
    /* Locked is the resting state. A picture that can be dragged is a picture
       that competes with scrolling and pinching for the same finger, and on a
       phone the gesture nearly always meant zoom rather than move. Tap the
       padlock in the image bar when you actually want to rearrange. */
    if (!S.imgMovable) { showImgBar(img); return; }
    e.preventDefault();          // no native drag, no text selection
    showImgBar(img);
    startImgDrag(e, img);
  });

  rich.addEventListener('pointermove', function (e) {
    if (livePointers > 1) { cancelImgDrag(); return; }
    if (imgDrag) { e.preventDefault(); imgDragMove(e); }
  });

  function releasePointer() { livePointers = Math.max(0, livePointers - 1); }

  rich.addEventListener('pointerup', function (e) { releasePointer(); endImgDrag(e); });
  rich.addEventListener('pointercancel', function (e) { releasePointer(); endImgDrag(e); });

  // the browser's own drag would still fire on an image; refuse it outright
  rich.addEventListener('dragstart', function (e) {
    if (e.target && e.target.closest && e.target.closest('img.ni')) e.preventDefault();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && imgDrag) {
      var d = imgDrag;
      imgDrag = null;
      d.img.classList.remove('ni-drag');
      document.body.classList.remove('img-dragging');
      d.img.style.transform = d.free
        ? 'translate3d(' + d.baseX + 'px,' + d.baseY + 'px,0)' : '';
      renderRich();
    }
  });
}

/* Free placement is InDesign's "text wrap off": the picture leaves the flow
   and the words carry on underneath it. */
function toggleImgFree() {
  if (!selectedImg) return;
  var img = selectedImg;
  var surface = noteSurface();
  if (isFree(img)) {
    img.classList.remove('ni-free');
    img.style.transform = '';
    delete img.dataset.fx; delete img.dataset.fy;
    applyAlignClass(img, 'center');
  } else {
    var r = img.getBoundingClientRect(), box = surface.getBoundingClientRect();
    img.classList.add('ni-free');
    setFreeXY(img, r.left - box.left, r.top - box.top + surface.scrollTop);
  }
  showImgBar(img);
  saveRich('Image placement');
}

  function hideImgBar() {
    if (selectedImg) selectedImg.classList.remove('ni-sel');
    selectedImg = null;
    $('imgBar').hidden = true;
    if ($('imgGrip')) $('imgGrip').hidden = true;
  }

  function showImgBar(img) {
    if (selectedImg && selectedImg !== img) selectedImg.classList.remove('ni-sel');
    selectedImg = img;
    img.classList.add('ni-sel');
    var bar = $('imgBar');
    bar.hidden = false;
    var r = img.getBoundingClientRect();
    var host = $('editorScroll').getBoundingClientRect();
    bar.style.left = Math.max(8, Math.min(r.left - host.left, host.width - 250)) + 'px';
    bar.style.top = Math.max(4, r.top - host.top - 42) + 'px';
    $('imgSize').textContent = Math.round(parseFloat(img.style.width) || 100) + '%';
    var freeBtn = $('imgFreeBtn');
    if (freeBtn) freeBtn.classList.toggle('on', isFree(img));
    var lockBtn = $('imgLockBtn');
    if (lockBtn) {
      lockBtn.classList.toggle('on', S.imgMovable);
      lockBtn.title = S.imgMovable
        ? 'Images can be moved — tap to lock them again'
        : 'Unlock to move this image';
      var shut = lockBtn.querySelector('.lock-shut'), open = lockBtn.querySelector('.lock-open');
      if (shut && open) {
        shut.style.display = S.imgMovable ? 'none' : '';
        open.style.display = S.imgMovable ? '' : 'none';
      }
    }
    document.body.classList.toggle('img-movable', S.imgMovable);
    placeImgGrip(img);
  }

  function placeImgGrip(img) {
    var grip = $('imgGrip');
    if (!grip) return;
    var r = img.getBoundingClientRect();
    var host = $('editorScroll').getBoundingClientRect();
    grip.hidden = false;
    grip.style.left = (r.right - host.left - 8) + 'px';
    grip.style.top = (r.bottom - host.top - 8 + $('editorScroll').scrollTop) + 'px';
  }

  function setImgAlign(align) {
    if (!selectedImg) return;
    Object.keys(ALIGN_CLASS).forEach(function (k) { selectedImg.classList.remove(ALIGN_CLASS[k]); });
    selectedImg.classList.add(ALIGN_CLASS[align] || ALIGN_CLASS.center);
    if (align === 'full') selectedImg.style.width = '100%';
    showImgBar(selectedImg);
    saveRich('Image layout');
  }

  /* Dragging the corner sets the width as a percentage of the writing column,
     so the picture keeps its place when the window or the interface size
     changes. Height stays auto, so the proportions look after themselves. */
  function bindImgResize() {
    var grip = $('imgGrip');
    if (!grip) return;
    var startX = 0, startW = 0, hostW = 1, live = false;

    grip.addEventListener('pointerdown', function (e) {
      if (!selectedImg) return;
      live = true;
      startX = e.clientX;
      startW = selectedImg.getBoundingClientRect().width;
      hostW = $('noteRich').clientWidth || 1;
      grip.classList.add('on');
      document.body.classList.add('img-resizing');
      try { grip.setPointerCapture(e.pointerId); } catch (err) { /* no active pointer */ }
      e.preventDefault();
      e.stopPropagation();
    });

    grip.addEventListener('pointermove', function (e) {
      if (!live || !selectedImg) return;
      var w = startW + (e.clientX - startX);
      var pct = Math.max(10, Math.min(100, Math.round(w / hostW * 100)));
      selectedImg.style.width = pct + '%';
      $('imgSize').textContent = pct + '%';
      placeImgGrip(selectedImg);
    });

    function stop() {
      if (!live) return;
      live = false;
      grip.classList.remove('on');
      document.body.classList.remove('img-resizing');
      if (selectedImg) { showImgBar(selectedImg); saveRich('Resize image'); }
    }
    grip.addEventListener('pointerup', stop);
    grip.addEventListener('pointercancel', stop);
  }

  function nudgeImgSize(delta) {
    if (!selectedImg) return;
    var w = parseFloat(selectedImg.style.width) || 60;
    selectedImg.style.width = Math.max(10, Math.min(100, w + delta)) + '%';
    showImgBar(selectedImg);
    saveRich('Resize image');
  }

  function removeSelectedImg() {
    if (!selectedImg) return;
    var id = selectedImg.dataset.img;
    selectedImg.remove();
    hideImgBar();
    saveRich('Remove image');
    // drop it from the note's list too, so storage can be reclaimed
    if (S.note && (S.note.images || []).indexOf(id) !== -1 && inlineImageIds().indexOf(id) === -1) {
      S.note.images = S.note.images.filter(function (x) { return x !== id; });
      touch();
    }
  }

  /* Capitalise the letter that starts a sentence.

     Deliberately conservative. It only fires on a letter typed directly after
     a sentence ending plus a space, or at the very start, so it cannot reach
     back and rewrite text you already have. Common abbreviations are left
     alone, because "e.g. this" must not become "e.g. This". The change goes in
     through the normal edit path, so Ctrl+Z undoes it like anything else. */
  var ABBREV = /(^|\s)(e\.g|i\.e|etc|vs|mr|mrs|ms|dr|prof|st|no|fig|approx|cf|al)\.$/i;

  function capitaliseSentence(el) {
    if (!S.autoCaps) return false;
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return false;
    var r = sel.getRangeAt(0);
    if (!r.collapsed) return false;
    var node = r.startContainer;
    if (node.nodeType !== 3) return false;          // text nodes only
    var at = r.startOffset;
    if (at < 1) return false;

    var ch = node.data.charAt(at - 1);
    if (!/[a-z]/.test(ch)) return false;            // only a lowercase letter
    var before = node.data.slice(0, at - 1);

    // start of the note, or a sentence ending followed by a space
    var atStart = !before.trim() && !hasTextBefore(el, node);
    var afterStop = /[.!?]["'’”)\]]*\s+$/.test(before);
    if (!atStart && !afterStop) return false;
    if (afterStop && ABBREV.test(before.replace(/\s+$/, ''))) return false;

    node.replaceData(at - 1, 1, ch.toUpperCase());
    // put the caret back where the typist left it
    r.setStart(node, at); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    return true;
  }

  // is there any text in the editor before this node?
  function hasTextBefore(root, node) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var t;
    while ((t = walker.nextNode())) {
      if (t === node) return false;
      if (t.data.trim()) return true;
    }
    return false;
  }

  /* The textarea version: same rule, applied to a plain value + caret pair. */
  function capitaliseField(ta) {
    if (!S.autoCaps) return false;
    var at = ta.selectionStart;
    if (at !== ta.selectionEnd || at < 1) return false;
    var ch = ta.value.charAt(at - 1);
    if (!/[a-z]/.test(ch)) return false;
    var before = ta.value.slice(0, at - 1);
    var atStart = !before.trim();
    var afterStop = /[.!?]["'’”)\]]*\s+$/.test(before);
    if (!atStart && !afterStop) return false;
    if (afterStop && ABBREV.test(before.replace(/\s+$/, ''))) return false;
    ta.value = before + ch.toUpperCase() + ta.value.slice(at);
    ta.selectionStart = ta.selectionEnd = at;
    return true;
  }

  function saveRich(label) {
    if (!S.note || S.note.type !== 'text') return;
    beginBurst(label || 'Edit text');
    var r = readRich();
    S.note.bodyHtml = linkifyHtml(sanitizeHtml(r.html));
    S.note.body = r.text;
    touch();
  }

  function insertImagesInline(ids) {
    var box = $('noteRich');
    box.focus();
    var sel = window.getSelection();
    var range = null;
    if (sel && sel.rangeCount && box.contains(sel.anchorNode)) range = sel.getRangeAt(0);

    ids.forEach(function (id) {
      var img = document.createElement('img');
      img.dataset.img = id;
      img.className = 'ni ni-center';
      img.style.width = '60%';
      img.draggable = true;
      imgURL(id).then(function (u) { if (u) img.src = u; });

      if (range) {
        range.collapse(false);
        range.insertNode(img);
        range.setStartAfter(img);
      } else {
        box.appendChild(img);
      }
    });
    if (range && sel) { sel.removeAllRanges(); sel.addRange(range); }
    saveRich('Add image');
  }

  /* ---------- list editor ---------- */

  function renderItems() {
    var wrap = $('listItems');
    wrap.innerHTML = '';
    (S.note.items || []).forEach(function (it) {
      var row = el('div', 'row' + (it.done ? ' done' : ''));
      row.dataset.id = it.id;
      row.dataset.indent = String(it.indent || 0);

      var grip = el('span', 'grip', '☰');
      grip.dataset.grip = it.id;
      grip.title = 'Drag to reorder';
      row.appendChild(grip);

      var chk = el('button', 'chk', '✓');
      chk.dataset.toggle = it.id;
      chk.setAttribute('aria-label', it.done ? 'Mark not done' : 'Mark done');
      row.appendChild(chk);

      var ta = el('textarea', 'txt');
      ta.rows = 1;
      ta.value = it.text || '';
      ta.dataset.item = it.id;
      ta.placeholder = 'Item';
      row.appendChild(ta);

      // + and x sit immediately after the text, always visible, so they are
      // easy to hit instead of stranded at the far right of the pane.
      var acts = el('span', 'row-acts');
      var sub = el('button', 'act-btn sub', '＋');
      sub.dataset.subItem = it.id;
      sub.title = 'Add a sub-item under this one';
      acts.appendChild(sub);

      var kill = el('button', 'act-btn kill', '✕');
      kill.dataset.killItem = it.id;
      kill.title = 'Delete item';
      acts.appendChild(kill);

      var up = el('button', 'act-btn nudge', '↑');
      up.dataset.moveItem = it.id; up.dataset.dir = '-1'; up.title = 'Move up (Alt+↑)';
      acts.appendChild(up);
      var down = el('button', 'act-btn nudge', '↓');
      down.dataset.moveItem = it.id; down.dataset.dir = '1'; down.title = 'Move down (Alt+↓)';
      acts.appendChild(down);

      row.appendChild(acts);
      wrap.appendChild(row);
      autosizeItem(ta);
    });
    updateCount();
    renderItemSelection();
  }

  /* Item text boxes size to their content (up to a readable maximum) so the
     buttons after them stay close to the words. */
  var itemMirror = null;
  function autosizeItem(ta) {
    if (!itemMirror) {
      itemMirror = el('span');
      itemMirror.style.cssText =
        'position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0';
      document.body.appendChild(itemMirror);
    }
    var cs = getComputedStyle(ta);
    itemMirror.style.font = cs.font;
    itemMirror.style.letterSpacing = cs.letterSpacing;
    itemMirror.textContent = ta.value || ta.placeholder || '';

    // Measure the real chrome around the text — grip, checkbox, the button
    // group and the indent margin — so a row never overflows its container.
    var row = ta.closest('.row');
    var acts = row ? row.querySelector('.row-acts') : null;
    var grip = row ? row.querySelector('.grip') : null;
    var chk = row ? row.querySelector('.chk') : null;
    var chrome = (acts ? acts.offsetWidth : 120) +
                 (grip ? grip.offsetWidth : 24) +
                 (chk ? chk.offsetWidth : 20) +
                 (row ? parseFloat(getComputedStyle(row).marginLeft) || 0 : 0) + 34;
    var room = ($('listItems').clientWidth || 600) - chrome;
    var wanted = Math.min(Math.max(itemMirror.offsetWidth + 14, 80), Math.max(90, room));
    ta.style.width = wanted + 'px';
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  function updateCount() {
    var items = (S.note && S.note.items) || [];
    var done = items.filter(function (i) { return i.done; }).length;
    $('listCount').textContent = items.length ? done + ' of ' + items.length + ' done' : '';
  }

  function itemIndex(id) {
    var items = (S.note && S.note.items) || [];
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return i;
    return -1;
  }

  /* Sub-items are expressed by indent alone, so an item's children are the
     following items indented deeper, up to the next item at its own level or
     shallower. A parent is crossed out exactly when it has children and every
     one of them is crossed out -- so unticking a child brings the parent back
     on its own. Childless items keep working by hand. */
  function childRange(items, i) {
    var depth = items[i].indent || 0, j = i + 1;
    while (j < items.length && (items[j].indent || 0) > depth) j++;
    return j;                                  // exclusive end
  }

  function syncParents() {
    var items = S.note && S.note.items;
    if (!items) return;
    // deepest first, so a parent sees children that are already settled
    for (var i = items.length - 1; i >= 0; i--) {
      var end = childRange(items, i);
      if (end === i + 1) continue;             // no children: leave it alone
      var kids = items.slice(i + 1, end);
      items[i].done = kids.every(function (k) { return k.done; });
    }
  }

  function addItem(afterId, indent, atTop) {
    var it = { id: DB.uid(), text: '', done: false, indent: indent || 0 };
    editNote('Add item', function () {
      var items = S.note.items = S.note.items || [];
      var at = atTop ? 0 : (afterId ? itemIndex(afterId) + 1 : items.length);
      items.splice(at, 0, it);
      S.note.updatedAt = Date.now();
    }).then(function () {
      renderItems();
      renderUndoButtons();
      var ta = document.querySelector('[data-item="' + it.id + '"]');
      if (ta) ta.focus();
    });
    return it;
  }

  function removeItem(id) {
    var items = itemsOf();
    var i = itemIndex(id);
    if (i < 0) return;
    var kids = hasChildren(id);
    // Promote the children rather than deleting them with the parent -- losing
    // several rows to one click on "x" would be a nasty surprise.
    editNote(kids ? 'Delete item, keep sub-items' : 'Delete item', function () {
      var end = blockEnd(items, i);
      for (var k = i + 1; k < end; k++) {
        items[k].indent = Math.max(0, (items[k].indent || 0) - 1);
      }
      items.splice(i, 1);
      normalizeIndents(items);
      S.note.updatedAt = Date.now();
    }).then(function () {
      renderItems();
      renderUndoButtons();
      var prev = S.note.items[Math.max(0, i - 1)];
      if (prev) {
        var ta = document.querySelector('[data-item="' + prev.id + '"]');
        if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; }
      }
    });
  }

  /* Sub-items are expressed purely by indent, so an item's "block" is itself
     plus every following item indented deeper. Moves operate on whole blocks,
     which is what keeps a sub-list attached to its parent. */

  function itemsOf() { return (S.note && S.note.items) || []; }

  function blockEnd(items, i) {
    var lvl = items[i].indent || 0;
    var end = i + 1;
    while (end < items.length && (items[end].indent || 0) > lvl) end++;
    return end;
  }

  function hasChildren(id) {
    var items = itemsOf(), i = itemIndex(id);
    return i >= 0 && blockEnd(items, i) > i + 1;
  }

  // No item may sit more than one level deeper than the one above it. Applied
  // left to right, this preserves the relative shape of a moved block.
  function normalizeIndents(items) {
    for (var i = 0; i < items.length; i++) {
      var max = i === 0 ? 0 : (items[i - 1].indent || 0) + 1;
      items[i].indent = Math.max(0, Math.min(items[i].indent || 0, max, 3));
    }
  }

  // Swap a block with its previous/next sibling. Refuses to move past the
  // parent, so an item never silently escapes the list it belongs to.
  function moveItem(id, dir) {
    var items = itemsOf();
    var i = itemIndex(id);
    if (i < 0) return;
    var lvl = items[i].indent || 0;
    var end = blockEnd(items, i);
    var at;

    if (dir < 0) {
      if (i === 0) return;
      var prev = i - 1;
      while (prev > 0 && (items[prev].indent || 0) > lvl) prev--;
      if ((items[prev].indent || 0) !== lvl) return;   // that is the parent
      at = prev;
    } else {
      if (end >= items.length) return;
      if ((items[end].indent || 0) !== lvl) return;    // end of this sub-list
      at = blockEnd(items, end) - (end - i);
    }

    editNote(hasChildren(id) ? 'Move item and sub-items' : 'Move item', function () {
      var block = items.splice(i, end - i);
      items.splice.apply(items, [at, 0].concat(block));
      normalizeIndents(items);
      S.note.updatedAt = Date.now();
    }).then(function () {
      renderItems();
      renderUndoButtons();
      var ta = document.querySelector('[data-item="' + id + '"]');
      if (ta) ta.focus();
    });
  }

  // Indenting carries the sub-items with it, so nesting shape is preserved.
  function indentItem(id, delta) {
    var items = itemsOf();
    var i = itemIndex(id);
    if (i < 0) return;
    var lvl = items[i].indent || 0;
    if (delta > 0) {
      if (i === 0 || lvl >= 3) return;
      if ((items[i - 1].indent || 0) < lvl) return;   // nothing to nest under
    } else if (lvl === 0) {
      return;
    }
    var end = blockEnd(items, i);
    editNote(delta > 0 ? 'Indent item' : 'Outdent item', function () {
      for (var k = i; k < end; k++) {
        items[k].indent = Math.max(0, Math.min(3, (items[k].indent || 0) + delta));
      }
      normalizeIndents(items);
      S.note.updatedAt = Date.now();
    }).then(function () {
      renderItems();
      renderUndoButtons();
      var ta = document.querySelector('[data-item="' + id + '"]');
      if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; }
    });
  }

  // The "+" on a row: a new item nested under it, after any existing children.
  function addSubItem(id) {
    var items = itemsOf();
    var i = itemIndex(id);
    if (i < 0) return;
    var it = { id: DB.uid(), text: '', done: false, indent: Math.min(3, (items[i].indent || 0) + 1) };
    editNote('Add sub-item', function () {
      items.splice(blockEnd(items, i), 0, it);
      normalizeIndents(items);
      S.note.updatedAt = Date.now();
    }).then(function () {
      renderItems();
      renderUndoButtons();
      var ta = document.querySelector('[data-item="' + it.id + '"]');
      if (ta) ta.focus();
    });
  }

  // Pointer-driven reorder so the grip behaves the same with mouse and touch.
  function pickedItemIds() {
    return itemsOf().filter(function (i) { return S.pickedItems[i.id]; })
      .map(function (i) { return i.id; });
  }

  function renderItemSelection() {
    var picked = pickedItemIds();
    Array.prototype.forEach.call($('listItems').children, function (row) {
      row.classList.toggle('picked', !!S.pickedItems[row.dataset.id]);
    });
    var tag = $('itemSelCount');
    if (tag) {
      tag.textContent = picked.length ? plural(picked.length, 'item') + ' selected — drag to move' : '';
      tag.hidden = !picked.length;
    }
  }

  function clearItemSelection() {
    if (!Object.keys(S.pickedItems).length) return;
    S.pickedItems = {};
    renderItemSelection();
  }

  // The rows to move: every selected item's block if the dragged row is part
  // of the selection, otherwise just the dragged row's own block.
  function dragSet(id) {
    var items = itemsOf();
    var roots = S.pickedItems[id] ? pickedItemIds() : [id];
    var ids = [];
    roots.forEach(function (rid) {
      var i = itemIndex(rid);
      if (i < 0) return;
      items.slice(i, blockEnd(items, i)).forEach(function (x) {
        if (ids.indexOf(x.id) === -1) ids.push(x.id);
      });
    });
    return ids;
  }

  var reorder = null;
  function startReorder(e, id) {
    var row = document.querySelector('.row[data-id="' + id + '"]');
    if (!row || itemIndex(id) < 0) return;
    var ids = dragSet(id);
    reorder = {
      id: id, row: row, ids: ids, target: null, before: true,
      moved: false, sx: e.clientX, sy: e.clientY
    };
    try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
    e.preventDefault();
  }

  function moveReorder(e) {
    if (!reorder) return;
    if (!reorder.moved) {
      if (Math.hypot(e.clientX - reorder.sx, e.clientY - reorder.sy) < 5) return;
      reorder.moved = true;
      reorder.ids.forEach(function (x) {
        var r = document.querySelector('.row[data-id="' + x + '"]');
        if (r) r.classList.add('dragging');
      });
    }
    var rows = Array.prototype.slice.call($('listItems').children);
    var target = null, before = true;
    for (var i = 0; i < rows.length; i++) {
      // never offer a drop slot inside the rows being dragged
      if (reorder.ids.indexOf(rows[i].dataset.id) !== -1) continue;
      var r = rows[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { target = rows[i]; before = true; break; }
      target = rows[i]; before = false;
    }
    rows.forEach(function (r) { r.classList.remove('drop-above', 'drop-below'); });
    if (target) target.classList.add(before ? 'drop-above' : 'drop-below');
    reorder.target = target;
    reorder.before = before;
  }

  function endReorder() {
    if (!reorder) return;
    var r = reorder;
    reorder = null;

    // a press that never moved is a selection tap, not a drag
    if (!r.moved) {
      if (S.pickedItems[r.id]) delete S.pickedItems[r.id];
      else S.pickedItems[r.id] = true;
      renderItemSelection();
      return;
    }

    var items = itemsOf();
    var tgtId = r.target ? r.target.dataset.id : null;
    if (!tgtId || r.ids.indexOf(tgtId) !== -1) { renderItems(); return; }

    var moving = r.ids.slice();
    var label = moving.length > 1 ? 'Move ' + plural(moving.length, 'item') : 'Reorder items';

    editNote(label, function () {
      // pull the rows out in list order, then re-insert them at the drop slot
      var taken = [];
      for (var i = items.length - 1; i >= 0; i--) {
        if (moving.indexOf(items[i].id) !== -1) taken.unshift(items.splice(i, 1)[0]);
      }
      var t = itemIndex(tgtId);
      if (t < 0) t = items.length - 1;
      var insertAt = r.before ? t : blockEnd(items, t);
      items.splice.apply(items, [insertAt, 0].concat(taken));
      normalizeIndents(items);
      S.note.updatedAt = Date.now();
    }).then(function () {
      S.pickedItems = {};
      renderItems();
      renderUndoButtons();
    });
  }

  /* ---------- mindmap ---------- */

  /* ---------- editing a node's text in place on the canvas ---------- */

  function nodeScreenBox(node) {
    var cam = S.map.cam;
    var w = Math.max(70, node.w * cam.s);
    var h = Math.max(26, node.h * cam.s);
    return {
      left: node.x * cam.s + cam.x - w / 2,
      top: node.y * cam.s + cam.y - h / 2,
      w: w, h: h
    };
  }

  /* Typing into a node grows the node itself, so the words are never
     hidden behind a box that stayed the size it was when you started. The
     text is put into the node as you type and the map re-measured; the
     original is kept so cancelling puts it back, and so the rename is still
     one undo step rather than one per letter. */
  function sizeNodeEdit() {
    var node = S.editingNode;
    if (!node || !S.map) return;
    var ta = $('mapInlineEdit');
    node.text = ta.value;
    S.map._layout();
    S.map.draw();
    var box = nodeScreenBox(node);
    ta.style.left = box.left + 'px';
    ta.style.top = box.top + 'px';
    ta.style.width = box.w + 'px';
    ta.style.height = box.h + 'px';
  }

  function startNodeEdit(node) {
    if (!node || !S.map) return;
    var ta = $('mapInlineEdit');
    var box = nodeScreenBox(node);
    ta.style.left = box.left + 'px';
    ta.style.top = box.top + 'px';
    ta.style.width = box.w + 'px';
    ta.style.height = box.h + 'px';
    ta.style.fontSize = Math.max(9, S.font.size * S.map.cam.s) + 'px';
    ta.style.fontFamily = FONTS[S.font.family].stack;
    ta.value = node.text || '';
    ta.hidden = false;
    S.editingNode = node;
    S.editingWas = node.text || '';
    S.map.select(node);
    ta.focus();
    ta.select();
  }

  function commitNodeEdit(then) {
    var ta = $('mapInlineEdit');
    if (ta.hidden || !S.editingNode) { if (then) then(); return; }
    var node = S.editingNode;
    S.editingNode = null;
    ta.hidden = true;
    var was = S.editingWas || '';
    node.text = was;                        // undo the live typing...
    var v = ta.value.replace(/\s+/g, ' ').trim();
    if (v !== was) {
      S.map.select(node);
      S.map.renameSelected(v);              // ...and do it once, properly
    } else {
      S.map._layout();
      S.map.draw();
    }
    if (then) then(); else focusMap();
  }

  function cancelNodeEdit() {
    var ta = $('mapInlineEdit');
    if (ta.hidden) return;
    if (S.editingNode) {
      S.editingNode.text = S.editingWas || '';
      S.map._layout();
      S.map.draw();
    }
    S.editingNode = null;
    ta.hidden = true;
    focusMap();
  }

  // A tiny glyph per shape, drawn with CSS in the swatch itself.
  var SHAPE_GLYPH = {
    round: '\u25A2', rect: '\u25AD', square: '\u25A1',
    circle: '\u25CB', ellipse: '\u2B2D', diamond: '\u25C7'
  };

  function renderShapeSwatches() {
    var box = $('mapShapes');
    if (!box || box.childElementCount) return;
    Mindmap.SHAPE_KEYS.forEach(function (key) {
      var b = el('button', 'shape-btn', SHAPE_GLYPH[key] || '\u25A2');
      b.dataset.act = 'map-shape';
      b.dataset.shape = key;
      b.title = Mindmap.SHAPES[key].label;
      b.setAttribute('aria-label', Mindmap.SHAPES[key].label);
      box.appendChild(b);
    });
  }

  function renderLayouts() {
    var sel = $('mapLayout');
    if (!sel) return;
    if (!sel.childElementCount) {
      Object.keys(Mindmap.LAYOUTS).forEach(function (k) {
        var o = document.createElement('option');
        o.value = k;
        o.textContent = Mindmap.LAYOUTS[k];
        sel.appendChild(o);
      });
      sel.onchange = function () {
        commitNodeEdit();            // the edit box cannot follow a node that moves
        S.map.setLayout(sel.value);
        $('autoBtn').classList.toggle('on', !!S.map.auto);
        S.map.fit();
        focusMap();
      };
    }
    sel.value = S.map.layout || 'right';
  }

  function renderEdgeTypes() {
    var sel = $('mapEdgeType');
    if (!sel || sel.childElementCount) return;
    Mindmap.EDGE_KEYS.forEach(function (key) {
      var opt = document.createElement('option');
      opt.value = key;
      opt.textContent = Mindmap.EDGE_TYPES[key];
      sel.appendChild(opt);
    });
    sel.onchange = function () {
      var where = S.map.setEdgeType(sel.value);
      toast(where === 'edge' ? 'This link restyled' : 'All links restyled');
      focusMap();
    };
  }

  // Colour swatches, built once per map open from the palette the canvas owns.
  function renderSwatches() {
    var box = $('mapColors');
    if (!box || box.childElementCount) return;
    Mindmap.COLOR_KEYS.forEach(function (key) {
      var p = Mindmap.PALETTE[key];
      var b = el('button', 'swatch' + (key === 'plain' ? ' plain' : ''));
      b.dataset.act = 'map-color';
      b.dataset.color = key;
      b.title = p.label;
      b.setAttribute('aria-label', p.label);
      if (p.line) {
        b.style.background = p.light;
        b.style.borderColor = p.line;
      }
      box.appendChild(b);
    });
  }

  // Enable/disable the controls that only make sense with a node selected.
  function renderMapTools(node) {
    var count = S.map ? S.map.selection.length : 0;
    var one = count === 1;
    var any = count > 0;

    // colour and delete work on any number; rename, child and image need one
    ['map-rename', 'map-image'].forEach(function (a) {
      Array.prototype.forEach.call(document.querySelectorAll('[data-act="' + a + '"]'), function (elx) {
        elx.classList.toggle('dimmed', !one);
      });
    });
    $('mapColors').classList.toggle('dimmed', !any);

    var rm = document.querySelector('[data-act="map-image-remove"]');
    if (rm) rm.hidden = !(one && node && node.image);

    Array.prototype.forEach.call($('mapColors').children, function (b) {
      b.classList.toggle('on', one && (node.color || 'plain') === b.dataset.color);
    });

    var tag = $('mapSelCount');
    if (tag) {
      tag.textContent = count > 1 ? plural(count, 'node') + ' selected' : '';
      tag.hidden = count < 2;
    }

    // shape and text size follow the same rule as colour: any selection will do
    $('mapShapes').classList.toggle('dimmed', !any);
    Array.prototype.forEach.call($('mapShapes').children, function (b) {
      b.classList.toggle('on', one && (node.shape || 'round') === b.dataset.shape);
    });

    var fv = $('mapFontVal');
    if (fv) {
      fv.textContent = one ? Math.round(S.map.fontSizeOf(node)) + (node.fs ? '' : '*') : '–';
      fv.title = one && !node.fs ? 'following the app text size' : 'set for this node';
    }
    ['map-font-smaller', 'map-font-bigger', 'map-font-reset'].forEach(function (a) {
      var b = document.querySelector('[data-act="' + a + '"]');
      if (b) b.classList.toggle('dimmed', !any);
    });

    // line controls act on the selected link, or on the whole map
    var st = S.map ? (S.map.selectedEdge ? S.map.edgeStyleOf(S.map.selectedEdge) : S.map.style) : null;
    if (st) {
      $('mapEdgeType').value = st.type;
      $('mapLineVal').textContent = st.width;
    }
  }

  function mapHintText() {
    if (window.innerWidth <= 900) {
      return 'Tap a node to select · double-tap to rename · drag the corner to resize · ' +
        'pinch to zoom';
    }
    return 'Tab adds a child · Enter renames · Del removes · Ctrl+L links · ' +
      'Shift+drag empty space to select several · Shift+click adds to the selection · ' +
      'Shift+drag a node moves its children too · scroll or pinch to zoom';
  }

  function applyMapSpacing() {
    if (!S.map) return;
    var y = parseInt(localStorage.getItem('sulat-mapspacing'), 10);
    if (y > 0) S.map.setSpacing(0, y);
    var out = $('mapSpaceVal');
    if (out) out.textContent = S.map.gapY;
  }

  /* The mindmap tools as icons. The words stay beside them on a wide screen,
     where there is room; on a phone the icons alone make one short row, and
     every button keeps its name as a tooltip and for screen readers. */
  var MAP_ICONS = {
    'map-sibling': '<rect x="2.5" y="4" width="19" height="6.5" rx="2"/><rect x="2.5" y="13.5" width="19" height="6.5" rx="2"/><path d="M12 15.2v3M10.5 16.7h3"/>',
    'map-child': '<rect x="2.5" y="9" width="7" height="6" rx="2"/><rect x="15.5" y="3.5" width="6" height="5" rx="1.5"/><rect x="15.5" y="15.5" width="6" height="5" rx="1.5"/><path d="M9.5 12h3M12.5 6v12M12.5 6h3M12.5 18h3"/>',
    'map-rename': '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    'map-select-mode': '<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3 2.6"/>',
    'map-link': '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.4 1.4"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.4-1.4"/>',
    'map-image': '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 16l-5-5-8 8"/>',
    'map-image-remove': '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M9 9l6 6M15 9l-6 6"/>',
    'map-copy': '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
    'map-paste': '<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 5V3.5h6V5M9 11h6M9 15h4"/>',
    'map-duplicate': '<rect x="3" y="3" width="12" height="12" rx="2"/><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M15 12.5v5M12.5 15h5"/>',
    'map-unlink': '<path d="M9.5 14.5l-2 2a3.2 3.2 0 0 1-4.5-4.5l2-2"/><path d="M14.5 9.5l2-2a3.2 3.2 0 0 1 4.5 4.5l-2 2"/><path d="M8 3.5v2.5M3.5 8H6M16 20.5V18M20.5 16H18"/>',
    'map-del': '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
    'map-zoom-out': '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5M8 11h6"/>',
    'map-zoom-in': '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5M8 11h6M11 8v6"/>',
    'map-fit': '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
    'map-auto': '<rect x="2.5" y="10" width="6" height="4" rx="1"/><rect x="15.5" y="3.5" width="6" height="4" rx="1"/><rect x="15.5" y="10" width="6" height="4" rx="1"/><rect x="15.5" y="16.5" width="6" height="4" rx="1"/><path d="M8.5 12h7M12 5.5v13M12 5.5h3.5M12 18.5h3.5"/>',
    'map-style-toggle': '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.8 0-1.2-1-1.6-1-2.7 0-1 .8-1.7 1.8-1.7H17a4 4 0 0 0 4-4c0-4.2-4-7.8-9-7.8z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="14.5" cy="7" r="1"/>'
  };

  function decorateMapTools() {
    Array.prototype.forEach.call(document.querySelectorAll('.map-tools .ghost-btn'), function (b) {
      var path = MAP_ICONS[b.dataset.act];
      if (!path || b.querySelector('.mt-ico')) return;
      var name = (b.childNodes[0] && b.childNodes[0].textContent || b.textContent).trim()
        .replace(/^[\u002b\uff0b\u2212]\s*/, '');
      var key = b.querySelector('kbd');
      var label = el('span', 'mt-label');
      while (b.firstChild) label.appendChild(b.firstChild);
      var ico = el('span', 'mt-ico');
      ico.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + path + '</svg>';
      b.appendChild(ico);
      b.appendChild(label);
      var tip = { 'map-zoom-out': 'Zoom out', 'map-zoom-in': 'Zoom in',
        'map-sibling': 'New node beside this one', 'map-child': 'New node under this one',
        'map-image': 'Add image', 'map-image-remove': 'Remove image' }[b.dataset.act] || name;
      b.title = tip + (key ? ' (' + key.textContent + ')' : '');
      b.setAttribute('aria-label', tip);
    });
  }

  /* The menu for one node: the right button on a desktop, a long press on a
     phone. It opens where you pressed, and closes as soon as you pick
     something or tap elsewhere. */
  function showNodeMenu(x, y) {
    var m = $('nodeMenu');
    if (!m) return;
    closeMenus();
    m.hidden = false;
    var r = m.getBoundingClientRect();
    var maxX = window.innerWidth - r.width - 8;
    var maxY = window.innerHeight - r.height - 8;
    m.style.left = Math.max(8, Math.min(x, maxX)) + 'px';
    m.style.top = Math.max(8, Math.min(y, maxY)) + 'px';
    if (!m.dataset.wired) {
      m.dataset.wired = '1';
      m.addEventListener('click', function () { m.hidden = true; });
    }
  }

  function mountMap() {
    var canvas = $('mapCanvas');
    if (!S.map) {
      S.map = new Mindmap(canvas, {
        onChange: function () {
          // S.note.map still holds the pre-change state here, which is exactly
          // what the undo snapshot needs.
          if (!S.note || S.note.type !== 'mindmap' || S.mapNoteId !== S.note.id) return;
          var before = [History.rec('notes', S.note.id, S.note)];
          S.note.map = S.map.getData();
          // On a mindmap the note's image list is exactly what the nodes use,
          // so images drop out of the backup and get reclaimed when a node goes.
          S.note.images = S.map.imageIds().concat(otherPageImages(S.note))
            .filter(function (x, i, all) { return all.indexOf(x) === i; });
          S.note.updatedAt = Date.now();
          var after = [History.rec('notes', S.note.id, S.note)];
          History.push('Edit mindmap', before, after);
          renderUndoButtons();
          clearTimeout(S.saveTimer);
          S.saveTimer = setTimeout(flush, SAVE_DELAY);
        },
        // Edited in place on the canvas -- a modal popping up on every Tab was
        // the single most intrusive thing about building a map.
        onRename: function (node) { startNodeEdit(node); },
        onLinkModeChange: function (on) {
          $('linkBtn').classList.toggle('on', on);
          $('mapHint').textContent = on
            ? 'Link mode: tap one node, then another. Tap a link to remove it. Esc to exit.'
            : mapHintText();
        },
        onLinkStep: function (result) {
          if (result === 'started') toast('Now tap the node to link to');
          else if (result === 'linked') toast('Linked');
          else if (result === 'unlinked') toast('Link removed');
          else if (result === 'cancelled') toast('Link cancelled');
        },
        onSelect: function (node) { renderMapTools(node); },
        onNodeMenu: function (node, x, y) { showNodeMenu(x, y); },
        onCam: function (scale) {
          var z = $('mapZoom');
          if (!z) return;
          var pct = Math.round(scale * 100) + '%';
          if (z.textContent !== pct) z.textContent = pct;
        },
        onEdgeSelect: function () { renderMapTools(S.map.selected); },
        onSelectModeChange: function (on) {
          $('selModeBtn').classList.toggle('on', on);
          $('mapHint').textContent = on
            ? 'Select mode: drag across the map to pick nodes. Shift+drag does the same any time. Esc to exit.'
            : mapHintText();
        },
        resolveImage: imgURL
      });
      if (window.ResizeObserver) {
        var ro = new ResizeObserver(function () { S.map.resize(); });
        ro.observe($('mapEditor').querySelector('.map-canvas-wrap'));
      }
    }
    // Load synchronously: a hidden or non-compositing tab never runs rAF, and
    // an unloaded canvas that then fires onChange would erase the note.
    S.mapNoteId = S.note.id;
    // applyFont() runs at boot, before any canvas exists, so a map mounted
    // later has to pick the setting up here.
    S.map.setFont(fontStack(), S.font.size);
    S.map.setLinkMode(false);
    S.map.setSelectMode(false);
    S.map.setData(S.note.map || { nodes: [], edges: [] });
    $('autoBtn').classList.toggle('on', !!S.map.auto);
    S.map.resize();
    applyMapSpacing();
    $('mapHint').textContent = mapHintText();
    renderSwatches();
    renderShapeSwatches();
    renderEdgeTypes();
    renderLayouts();
    var cc = $('customColor');
    if (cc && !cc.dataset.wired) {
      cc.dataset.wired = '1';
      cc.oninput = function () {
        if (!S.map.setColor(cc.value)) toast('Select a node first.');
        renderMapTools(S.map.selected);
      };
    }
    // the style bar is a whole row of screen: closed until the Style button asks for it
    $('mapEditor').classList.add('style-off');
    $('styleBtn').classList.remove('on');
    renderMapTools(null);
    requestAnimationFrame(function () {
      if (S.mapNoteId !== (S.note && S.note.id)) return;
      S.map.resize();
      S.map.fit();
    });
  }

  /* ================= dialogs ================= */

  function closeDlg() { var d = $('dlg'); if (d.open) d.close(); }

  function showDlg(html, wire) {
    var d = $('dlg');
    $('dlgInner').innerHTML = html;
    if (!d.open) d.showModal();
    if (wire) wire($('dlgInner'));
    var first = $('dlgInner').querySelector('input, select, button');
    if (first) setTimeout(function () { first.focus(); }, 20);
  }

  function promptDialog(title, value, onOk, sub) {
    showDlg(
      '<h3>' + esc(title) + '</h3>' +
      (sub ? '<p class="sub">' + esc(sub) + '</p>' : '') +
      '<input type="text" id="pv" value="' + esc(value || '') + '">' +
      '<div class="dlg-actions"><button class="btn" data-x="c">Cancel</button>' +
      '<button class="btn solid" data-x="k">Save</button></div>',
      function (root) {
        var input = root.querySelector('#pv');
        function ok() { closeDlg(); onOk(input.value.trim()); }
        root.querySelector('[data-x="k"]').onclick = ok;
        root.querySelector('[data-x="c"]').onclick = closeDlg;
        input.onkeydown = function (e) {
          if (e.key === 'Enter') { e.preventDefault(); ok(); }
        };
        setTimeout(function () { input.select(); }, 20);
      }
    );
  }

  function confirmDialog(title, sub, okLabel, onOk, danger) {
    showDlg(
      '<h3>' + esc(title) + '</h3><p class="sub">' + esc(sub) + '</p>' +
      '<div class="dlg-actions"><button class="btn" data-x="c">Cancel</button>' +
      '<button class="btn ' + (danger ? 'solid danger' : 'solid') + '" data-x="k">' +
      esc(okLabel) + '</button></div>',
      function (root) {
        root.querySelector('[data-x="k"]').onclick = function () { closeDlg(); onOk(); };
        root.querySelector('[data-x="c"]').onclick = closeDlg;
      }
    );
  }

  var MAP_FORMATS = [
    ['png', 'PNG image', 'High-resolution picture of the map'],
    ['jpeg', 'JPEG image', 'Smaller file, no transparency']
  ];

  var FORMATS = [
    ['pdf', 'PDF', 'Opens your print dialog — choose "Save as PDF"'],
    ['md', 'Markdown', 'Plain .md, good for other apps'],
    ['txt', 'Plain text', 'No formatting at all'],
    ['html', 'Web page', 'Single .html file, images embedded'],
    ['json', 'Sulat backup', 'Everything, restorable on your other device']
  ];

  function exportDialog(title, sub, getNotes, baseName, mapOnly) {
    var formats = mapOnly ? FORMATS.concat(MAP_FORMATS) : FORMATS;
    showDlg(
      '<h3>' + esc(title) + '</h3><p class="sub">' + esc(sub) + '</p>' +
      (mapOnly
        ? '<label class="fld">Background</label>' +
          '<div class="seg" id="bgSeg">' +
          '<button class="seg-btn on" data-bg="light">Light</button>' +
          '<button class="seg-btn" data-bg="dark">Dark</button></div>'
        : '') +
      '<label class="check"><input type="checkbox" id="xmeta"' +
      (S.exportDates ? ' checked' : '') + '> Include the folder and date line</label>' +
      '<div class="opt-grid">' + formats.map(function (f) {
        return '<button class="opt" data-fmt="' + f[0] + '"><b>' + esc(f[1]) + '</b><span>' +
          esc(f[2]) + '</span></button>';
      }).join('') + '</div>' +
      '<div class="dlg-actions"><button class="btn" data-x="c">Cancel</button></div>',
      function (root) {
        root.querySelector('[data-x="c"]').onclick = closeDlg;
        var xmeta = root.querySelector('#xmeta');
        if (xmeta) {
          xmeta.onchange = function () {
            S.exportDates = xmeta.checked;
            applyFont();                    // persists the display preferences
          };
        }
        var mapDark = false;
        var seg = root.querySelector('#bgSeg');
        if (seg) {
          Array.prototype.forEach.call(seg.children, function (b) {
            b.onclick = function () {
              mapDark = b.dataset.bg === 'dark';
              Array.prototype.forEach.call(seg.children, function (x) {
                x.classList.toggle('on', x === b);
              });
            };
          });
        }
        Array.prototype.forEach.call(root.querySelectorAll('[data-fmt]'), function (b) {
          b.onclick = function () {
            var fmt = b.dataset.fmt;
            closeDlg();
            Promise.resolve(getNotes()).then(expandPages).then(function (notes) {
              if (!notes.length) { toast('Nothing to export.'); return; }
              var names = {};
              notes.forEach(function (n) {
                if (n.folderId) names[n.id] = folderPath(n.folderId);
              });
              return Exporter.exportNotes(notes, fmt, {
                name: baseName, folderName: S.exportDates ? names : null,
                docTitle: notes.length === 1 ? displayTitle(notes[0]) : 'Sulat export',
                dates: S.exportDates,
                mapDark: mapDark,
                fmtDate: function (ts) { return fmtDate(ts, { time: true }); }
              })
                .then(function () {
                  if (fmt !== 'pdf') toast('Exported ' + plural(notes.length, 'note'));
                });
            }).catch(function (e) { toast('Export failed: ' + e.message); });
          };
        });
      }
    );
  }

  function folderOptions(selectedId, kind) {
    return ['<option value="">' + (kind ? 'Top of ' + KIND_TAB[kind] : 'Unfiled') + '</option>'].concat(
      S.folders.filter(function (f) { return !kind || folderFits(f, kind); }).sort(function (a, b) {
        return folderPath(a.id).localeCompare(folderPath(b.id));
      }).map(function (f) {
        return '<option value="' + esc(f.id) + '"' +
          (selectedId === f.id ? ' selected' : '') + '>' + esc(folderPath(f.id)) + '</option>';
      })
    ).join('');
  }

  /* Every folder inside this one, however deep. A folder cannot be moved into
     its own descendant -- that would cut the branch off the tree and leave the
     notes in it unreachable -- so those are the options to leave out. */
  function folderSubtree(id) {
    var out = [id], added = true;
    while (added) {
      added = false;
      S.folders.forEach(function (f) {
        if (f.parentId && out.indexOf(f.parentId) > -1 && out.indexOf(f.id) === -1) {
          out.push(f.id);
          added = true;
        }
      });
    }
    return out;
  }

  function moveFolderDialog(id) {
    var f = folderById(id);
    if (!f) return;
    var banned = folderSubtree(id);
    // a folder can only move within its own tab
    var choices = S.folders.filter(function (x) {
      return banned.indexOf(x.id) === -1 && (!f.kind || folderFits(x, f.kind));
    });

    showDlg(
      '<h3>Move “' + esc(f.name) + '”</h3>' +
      '<p class="sub">Pick the folder it should sit inside. Everything in it moves too.</p>' +
      '<select id="mvf"><option value="">Top level</option>' +
      choices.map(function (x) {
        return '<option value="' + x.id + '"' + (x.id === f.parentId ? ' selected' : '') +
          '>' + esc(folderPath(x.id)) + '</option>';
      }).join('') + '</select>' +
      '<div class="dlg-actions"><button class="btn" data-x="c">Cancel</button>' +
      '<button class="btn solid" data-x="k">Move</button></div>',
      function (root) {
        root.querySelector('[data-x="c"]').onclick = closeDlg;
        root.querySelector('[data-x="k"]').onclick = function () {
          var dest = root.querySelector('#mvf').value || null;
          closeDlg();
          if (dest === f.parentId) return;
          act('Move folder', [{ store: 'folders', id: id }], function () {
            f.parentId = dest;
          }).then(function () {
            renderTree(); renderList(); renderUndoButtons();
            toast('Moved to ' + (dest ? folderPath(dest) : 'the top level'));
          });
        };
      }
    );
  }

  function moveDialog(ids, label) {
    var targets = ids || (S.note ? [S.note.id] : []);
    if (!targets.length) return;
    var firstNote = byNoteId(targets[0]);
    // one kind selected: offer only that tab's folders
    var oneKind = targets.every(function (x) { return kindOf(byNoteId(x)) === kindOf(firstNote); })
      ? kindOf(firstNote) : null;
    showDlg(
      '<h3>' + esc(label || 'Move note') + '</h3>' +
      '<p class="sub">Choose the folder ' + (targets.length > 1 ? 'these notes' : 'this note') +
      ' should live in.</p>' +
      '<select id="mv">' + folderOptions(targets.length === 1 && firstNote ? firstNote.folderId : null, oneKind) + '</select>' +
      '<div class="dlg-actions">' +
      '<button class="btn" data-x="new">New folder…</button>' +
      '<button class="btn" data-x="c">Cancel</button>' +
      '<button class="btn solid" data-x="k">Move</button></div>',
      function (root) {
        root.querySelector('[data-x="c"]').onclick = closeDlg;
        root.querySelector('[data-x="new"]').onclick = function () {
          closeDlg();
          promptDialog('New folder', '', function (v) {
            if (!v) return;
            var f = DB.blankFolder(v, null);
            f.kind = firstNote ? kindOf(firstNote) : currentKind();
            act('New folder', [{ store: 'folders', id: f.id }], function () {
              S.folders.push(f);
            }).then(function () {
              renderTree();
              renderUndoButtons();
              moveNotesTo(targets, f.id);
            });
          });
        };
        root.querySelector('[data-x="k"]').onclick = function () {
          var dest = root.querySelector('#mv').value || null;
          closeDlg();
          moveNotesTo(targets, dest);
        };
      }
    );
  }

  function moveNotesTo(ids, folderId) {
    /* Each note lands in the folder of its own kind in that place: a mindmap
       dropped on a Notes "Work" goes to Mindmaps "Work", made if need be. */
    var made = [], dest = {};
    ids.forEach(function (id) {
      var n = byNoteId(id);
      if (n) dest[id] = folderId ? twinOf(folderId, kindOf(n), made) : null;
    });
    (made.length ? DB.putMany('folders', made) : Promise.resolve()).then(function () {
      return act('Move ' + plural(ids.length, 'note'), noteRefs(ids), function () {
        ids.forEach(function (id) {
          var n = byNoteId(id);
          if (!n) return;
          n.folderId = dest[id];
          n.deletedAt = null;
          n.updatedAt = Date.now();
        });
      });
    }).then(function () {
      renderTree(); renderList(); renderMeta(); renderUndoButtons();
      toast('Moved to ' + (folderId ? folderPath(folderId) : 'Unfiled'));
    });
  }

  function folderMenuDialog(id) {
    var f = folderById(id);
    if (!f) return;
    showDlg(
      '<h3>' + esc(f.name) + '</h3><p class="sub">' +
      plural(countDirect(id), 'note') + ' filed here' +
      (countDeep(id) !== countDirect(id)
        ? ' · ' + countDeep(id) + ' including subfolders' : '') + '.</p>' +
      '<div class="opt-grid">' +
      '<button class="opt" data-x="rename"><b>Rename</b><span>Change the folder name</span></button>' +
      '<button class="opt" data-x="sub"><b>New subfolder</b><span>Nest one inside</span></button>' +
      '<button class="opt" data-x="move"><b>Move to folder…</b>' +
      '<span>Nest this folder inside another</span></button>' +
      '<button class="opt" data-x="export"><b>Export folder</b><span>All notes inside, any format</span></button>' +
      '<button class="opt" data-x="pin"><b>' + (f.pinned ? 'Unpin' : 'Pin to top') + '</b>' +
      '<span>' + (f.pinned ? 'Back in name order' : 'Always first in its folder') + '</span></button>' +
      '<button class="opt" data-x="copy"><b>Copy folder</b><span>With everything inside</span></button>' +
      '<button class="opt" data-x="del"><b>Delete folder</b><span>Contents go to Trash</span></button>' +
      '</div>' +
      '<label class="fld">Colour</label>' +
      '<div class="fcolors">' + FOLDER_COLORS.map(function (c) {
        return '<button class="fswatch' + ((f.color || null) === c.id ? ' on' : '') +
          '" data-fc="' + (c.id || '') + '" title="' + esc(c.label) + '"' +
          (c.id ? ' data-fcolor="' + c.id + '"' : '') + '></button>';
      }).join('') + '</div>' +
      '<div class="dlg-actions"><button class="btn" data-x="c">Close</button></div>',
      function (root) {
        root.querySelector('[data-x="c"]').onclick = closeDlg;
        Array.prototype.forEach.call(root.querySelectorAll('[data-fc]'), function (b) {
          b.onclick = function () {
            var val = b.dataset.fc || null;
            act('Folder colour', [{ store: 'folders', id: id }], function () {
              if (val) f.color = val; else delete f.color;
            }).then(function () {
              Array.prototype.forEach.call(root.querySelectorAll('[data-fc]'), function (x) {
                x.classList.toggle('on', x === b);
              });
              renderTree(); renderList(); renderUndoButtons();
            });
          };
        });
        root.querySelector('[data-x="move"]').onclick = function () {
          closeDlg();
          moveFolderDialog(id);
        };
        root.querySelector('[data-x="pin"]').onclick = function () {
          closeDlg();
          act(f.pinned ? 'Unpin folder' : 'Pin folder', [{ store: 'folders', id: id }], function () {
            if (f.pinned) delete f.pinned; else f.pinned = true;
          }).then(function () {
            renderTree(); renderList(); renderUndoButtons();
            toast(f.pinned ? 'Pinned to the top' : 'Unpinned');
          });
        };
        root.querySelector('[data-x="copy"]').onclick = function () {
          closeDlg();
          copyFolder(id);
        };
        root.querySelector('[data-x="rename"]').onclick = function () {
          closeDlg();
          promptDialog('Rename folder', f.name, function (v) {
            if (!v) return;
            act('Rename folder', [{ store: 'folders', id: id }], function () {
              f.name = v;
            }).then(function () {
              renderTree(); renderList(); renderMeta(); renderUndoButtons();
            });
          });
        };
        root.querySelector('[data-x="sub"]').onclick = function () {
          closeDlg();
          promptDialog('New subfolder', '', function (v) {
            if (!v) return;
            var nf = DB.blankFolder(v, id);
            nf.kind = f.kind || currentKind();
            act('New subfolder', [{ store: 'folders', id: nf.id }], function () {
              S.folders.push(nf);
              S.expanded[id] = true;
            }).then(function () { renderTree(); renderUndoButtons(); });
          });
        };
        root.querySelector('[data-x="export"]').onclick = function () {
          closeDlg();
          var ids = subtreeIds(id);
          exportDialog('Export "' + f.name + '"', plural(countDeep(id), 'note') + ' including subfolders.',
            function () {
              return liveNotes().filter(function (n) { return ids.indexOf(n.folderId) !== -1; })
                .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
            },
            Exporter.slug(f.name, 'folder'));
        };
        root.querySelector('[data-x="del"]').onclick = function () {
          closeDlg();
          confirmDialog('Delete "' + f.name + '"?',
            'Its subfolders go too, and everything inside moves to Trash, where it ' +
            'stays for ' + TRASH_DAYS + ' days. Ctrl+Z brings the whole folder back.',
            'Delete folder', function () {
              var fids = subtreeIds(id);
              var orphans = S.notes.filter(function (n) { return fids.indexOf(n.folderId) !== -1; });
              var refs = fids.map(function (x) { return { store: 'folders', id: x }; })
                .concat(noteRefs(orphans.map(function (n) { return n.id; })));
              act('Delete folder', refs, function () {
                orphans.forEach(function (n) {
                  n.folderId = null;
                  if (!n.deletedAt) { n.deletedAt = Date.now(); n.updatedAt = Date.now(); }
                });
                S.folders = S.folders.filter(function (x) { return fids.indexOf(x.id) === -1; });
                if (fids.indexOf(S.view) !== -1) S.view = 'all';
              }).then(function () {
                renderTree(); renderList(); renderMeta(); renderUndoButtons();
                toast('Folder deleted — Ctrl+Z to undo');
              });
            }, true);
        };
      }
    );
  }

  /* Copy a folder and everything in it. The notes are real copies with new
     ids; pictures are shared by id, which is safe because an image is only
     cleared away once no note anywhere refers to it. */
  function copyFolder(id) {
    var src = folderById(id);
    if (!src) return;
    var ids = subtreeIds(id), map = {}, newFolders = [], newNotes = [];
    ids.forEach(function (fid) { map[fid] = DB.uid(); });
    ids.forEach(function (fid) {
      var f = folderById(fid);
      var c = History.clone(f);
      c.id = map[fid];
      c.parentId = fid === id ? f.parentId : map[f.parentId];
      if (fid === id) { c.name = f.name + ' copy'; delete c.pinned; }
      c.createdAt = Date.now();
      newFolders.push(c);
    });
    liveNotes().forEach(function (n) {
      if (ids.indexOf(n.folderId) === -1) return;
      var c = History.clone(n);
      c.id = DB.uid();
      c.folderId = map[n.folderId];
      c.createdAt = c.updatedAt = Date.now();
      newNotes.push(c);
    });
    var refs = newFolders.map(function (f) { return { store: 'folders', id: f.id }; })
      .concat(noteRefs(newNotes.map(function (n) { return n.id; })));
    act('Copy folder', refs, function () {
      newFolders.forEach(function (f) { S.folders.push(f); });
      newNotes.forEach(function (n) { S.notes.push(n); });
    }).then(function () {
      renderTree(); renderList(); renderUndoButtons();
      toast('Copied "' + src.name + '" with ' + plural(newNotes.length, KIND_ONE[src.kind || 'text']));
    });
  }

  /* ================= pages ================= */

  function blankPageContent(type) {
    if (type === 'list') return { items: [{ id: DB.uid(), text: '', done: false, indent: 0 }] };
    if (type === 'mindmap') {
      return { map: { nodes: [{ id: DB.uid(), text: 'Start here', x: 0, y: 0, noteId: null }], edges: [] } };
    }
    return { body: '', bodyHtml: '' };
  }

  // a note that has never had pages is one page; give it the list to hang more on
  function ensurePages(n) {
    if (!Array.isArray(n.pages) || !n.pages.length) {
      n.pages = [{ id: DB.uid(), name: 'Page 1', content: null }];
      n.page = n.pages[0].id;
    }
    if (!n.pages.some(function (p) { return p.id === n.page; })) n.page = n.pages[0].id;
    return n.pages;
  }

  function pageIndex(n) {
    var ps = n.pages || [];
    for (var i = 0; i < ps.length; i++) if (ps[i].id === n.page) return i;
    return 0;
  }

  // the pictures used on the page you are on, so they can travel with it
  function currentPageImages(n) {
    var ids = [];
    ((n.map && n.map.nodes) || []).forEach(function (x) { if (x.image) ids.push(x.image); });
    String(n.bodyHtml || '').replace(/data-img="([^"]+)"/g, function (m, id) { ids.push(id); return m; });
    return ids;
  }

  function otherPageImages(n) {
    var ids = [];
    (n.pages || []).forEach(function (p) {
      var c = p.content;
      if (!c) return;
      (c.imgs || []).forEach(function (id) { ids.push(id); });
      ((c.map && c.map.nodes) || []).forEach(function (x) { if (x.image) ids.push(x.image); });
    });
    return ids;
  }

  // put the page you are on away and bring another one out
  function swapPage(n, toId) {
    ensurePages(n);
    var from = n.pages[pageIndex(n)];
    var to = n.pages.filter(function (p) { return p.id === toId; })[0];
    if (!to || to === from) return;
    from.content = History.clone({
      body: n.body || '', bodyHtml: n.bodyHtml || '',
      items: n.items || [], map: n.map || { nodes: [], edges: [] },
      imgs: currentPageImages(n)
    });
    var c = to.content || blankPageContent(n.type);
    n.body = c.body || '';
    n.bodyHtml = c.bodyHtml || '';
    n.items = c.items || (n.type === 'list' ? blankPageContent('list').items : []);
    n.map = c.map || (n.type === 'mindmap' ? blankPageContent('mindmap').map : { nodes: [], edges: [] });
    to.content = null;
    n.page = to.id;
  }

  // For export: a note with several pages goes out as one part per page.
  function expandPages(notes) {
    var out = [];
    (notes || []).forEach(function (n) {
      if (!n.pages || n.pages.length < 2 || n.locked) { out.push(n); return; }
      var here = pageIndex(n);
      n.pages.forEach(function (p, i) {
        var c = i === here ? n : (p.content || {});
        var copy = {};
        for (var k in n) if (Object.prototype.hasOwnProperty.call(n, k)) copy[k] = n[k];
        copy.title = (displayTitle(n) || 'Untitled') + ' — ' + (p.name || 'Page ' + (i + 1));
        copy.body = c.body || '';
        copy.bodyHtml = c.bodyHtml || '';
        copy.items = c.items || [];
        copy.map = c.map || { nodes: [], edges: [] };
        delete copy.pages;
        out.push(copy);
      });
    });
    return out;
  }

  function pagesDialog() {
    var n = S.note;
    if (!n) return;
    if (n.locked) { toast('Unlock the note first'); return; }
    flush();
    var ps = n.pages && n.pages.length ? n.pages : [{ id: '_one', name: 'Page 1' }];
    var here = n.pages && n.pages.length ? pageIndex(n) : 0;
    showDlg(
      '<h3>Pages</h3>' +
      '<p class="sub">Each page is its own sheet in this ' + KIND_ONE[kindOf(n)] +
      '. Tap one to open it.</p>' +
      '<div class="page-list">' + ps.map(function (p, i) {
        return '<div class="page-row' + (i === here ? ' on' : '') + '">' +
          '<button class="page-open" data-pg="' + esc(p.id) + '">' +
          '<span class="pg-n">' + (i + 1) + '</span>' + esc(p.name || 'Page ' + (i + 1)) + '</button>' +
          '<button class="icon-btn" data-pg-up="' + esc(p.id) + '" title="Move up"' +
          (i === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button class="icon-btn" data-pg-ren="' + esc(p.id) + '" title="Rename">✎</button>' +
          '<button class="icon-btn" data-pg-del="' + esc(p.id) + '" title="Delete"' +
          (ps.length < 2 ? ' disabled' : '') + '>✕</button></div>';
      }).join('') + '</div>' +
      '<div class="dlg-actions"><button class="btn" data-x="c">Close</button>' +
      '<button class="btn solid" data-x="add">＋ New page</button></div>',
      function (root) {
        root.querySelector('[data-x="c"]').onclick = closeDlg;
        function redo(label, fn) {
          editNote(label, function () { fn(); n.updatedAt = Date.now(); });
          closeDlg();
          openNote(n.id);
        }
        root.querySelector('[data-x="add"]').onclick = function () {
          redo('New page', function () {
            ensurePages(n);
            var at = pageIndex(n);
            var pg = { id: DB.uid(), name: 'Page ' + (n.pages.length + 1), content: blankPageContent(n.type) };
            n.pages.splice(at + 1, 0, pg);
            swapPage(n, pg.id);
          });
          toast('New page');
        };
        Array.prototype.forEach.call(root.querySelectorAll('[data-pg]'), function (b) {
          b.onclick = function () {
            if (b.dataset.pg === n.page || b.dataset.pg === '_one') { closeDlg(); return; }
            redo('Switch page', function () { swapPage(n, b.dataset.pg); });
          };
        });
        Array.prototype.forEach.call(root.querySelectorAll('[data-pg-up]'), function (b) {
          b.onclick = function () {
            if (b.dataset.pgUp === '_one') return;
            editNote('Move page', function () {
              var i = n.pages.map(function (p) { return p.id; }).indexOf(b.dataset.pgUp);
              if (i > 0) n.pages.splice(i - 1, 0, n.pages.splice(i, 1)[0]);
              n.updatedAt = Date.now();
            });
            closeDlg();
            renderMeta();
            pagesDialog();
          };
        });
        Array.prototype.forEach.call(root.querySelectorAll('[data-pg-ren]'), function (b) {
          b.onclick = function () {
            var id = b.dataset.pgRen;
            closeDlg();
            var cur = (n.pages || []).filter(function (p) { return p.id === id; })[0];
            promptDialog('Rename page', cur ? cur.name : 'Page 1', function (v) {
              if (!v) return;
              editNote('Rename page', function () {
                ensurePages(n);
                var p = id === '_one' ? n.pages[0] : n.pages.filter(function (x) { return x.id === id; })[0];
                if (p) p.name = v;
                n.updatedAt = Date.now();
              });
              renderMeta();
              pagesDialog();
            });
          };
        });
        Array.prototype.forEach.call(root.querySelectorAll('[data-pg-del]'), function (b) {
          b.onclick = function () {
            var id = b.dataset.pgDel;
            if (!n.pages || n.pages.length < 2) return;
            closeDlg();
            var p = n.pages.filter(function (x) { return x.id === id; })[0];
            confirmDialog('Delete "' + (p.name || 'this page') + '"?',
              'Everything on this page goes. Ctrl+Z brings it back.', 'Delete page', function () {
                redo('Delete page', function () {
                  if (id === n.page) {
                    var i = pageIndex(n);
                    swapPage(n, n.pages[i === 0 ? 1 : i - 1].id);
                  }
                  n.pages = n.pages.filter(function (x) { return x.id !== id; });
                  if (n.pages.length === 1) { delete n.pages; delete n.page; }
                });
              }, true);
          };
        });
      }
    );
  }

  function fontDialog() {
    showDlg(
      '<h3>Text &amp; font</h3>' +
      '<p class="sub">Applies to note text, list items and mindmap nodes — and to ' +
      'what you export. Changes preview live.</p>' +
      '<label class="fld" for="ff">Typeface</label>' +
      '<select id="ff">' + FONT_KEYS.map(function (k) {
        return '<option value="' + k + '"' + (k === S.font.family ? ' selected' : '') + '>' +
          esc(FONTS[k].label) + '</option>';
      }).join('') + '</select>' +
      '<label class="fld" for="fs">Size — <b id="fsv">' + S.font.size + '</b> px</label>' +
      '<input type="range" id="fs" min="' + SIZE_MIN + '" max="' + SIZE_MAX +
      '" step="1" value="' + S.font.size + '">' +
      '<div class="font-preview" id="fp">Sphinx of black quartz, judge my vow — 0123456789</div>' +

      '<label class="fld" for="pw">Page width</label>' +
      '<select id="pw" class="sort-select wide">' +
      [['full', 'Full - use the whole pane'],
       ['wide', 'Wide'],
       ['reading', 'Reading measure - easiest on the eye']].map(function (o) {
        return '<option value="' + o[0] + '"' + (o[0] === S.pageWidth ? ' selected' : '') +
          '>' + o[1] + '</option>';
      }).join('') + '</select>' +

      '<label class="fld" for="ls">Line spacing \u2014 <b id="lsv">' +
      S.leading.toFixed(2) + '</b></label>' +
      '<input type="range" id="ls" min="1.1" max="2.6" step="0.05" value="' +
      S.leading + '">' +
      '<p class="sub tight">How far apart the lines sit in notes, lists and ' +
      'mindmap text.</p>' +

      '<label class="check"><input type="checkbox" id="pf"' +
      (S.keepPasteFormat ? ' checked' : '') +
      '> Keep formatting when pasting</label>' +
      '<p class="sub tight">Off means pasted text arrives plain \u2014 no ' +
      'inherited headings or numbered lists that then carry on into whatever ' +
      'you type next.</p>' +

      '<label class="check"><input type="checkbox" id="lay"' +
      (S.layout === 'tabs' ? ' checked' : '') +
      '> New layout: Notes, Lists and Mindmaps tabs</label>' +
      '<p class="sub tight">Folder tiles you tap into, one kind per tab. Off brings ' +
      'back the sidebar. Your notes are the same either way.</p>' +

      '<label class="fld" for="nb">New note buttons</label>' +
      '<select id="nb" class="sort-select wide">' +
      [['row', 'A row of three — Note, List, Mindmap'],
       ['menu', 'One + button with a menu behind it']].map(function (o) {
        return '<option value="' + o[0] + '"' + (o[0] === S.newStyle ? ' selected' : '') +
          '>' + o[1] + '</option>';
      }).join('') + '</select>' +

      '<label class="check"><input type="checkbox" id="fdp"' +
      (S.folderDeep ? ' checked' : '') +
      '> A folder also lists its subfolders’ notes</label>' +
      '<p class="sub tight">Off, a folder shows only what is filed directly in ' +
      'it and you open a subfolder to see what is inside. The count beside each ' +
      'folder follows the same rule, so the numbers add up.</p>' +

      '<label class="fld" for="uf">Interface typeface</label>' +
      '<select id="uf">' + FONT_KEYS.map(function (k) {
        return '<option value="' + k + '"' + (k === S.uiFont ? ' selected' : '') + '>' +
          esc(FONTS[k].label) + '</option>';
      }).join('') + '</select>' +

      '<label class="fld" for="us">Interface size — <b id="usv">' + S.uiScale +
      '</b>%</label>' +
      '<input type="range" id="us" min="' + SCALE_MIN + '" max="' + SCALE_MAX +
      '" step="5" value="' + S.uiScale + '">' +
      '<p class="sub tight">Menus, lists and buttons. Affects Sulat only — not ' +
      'your other apps.</p>' +

      '<label class="fld" for="dfmt">Date format</label>' +
      '<select id="dfmt">' + DATE_KEYS.map(function (k) {
        return '<option value="' + k + '"' + (k === S.dateFormat ? ' selected' : '') + '>' +
          esc(DATE_FORMATS[k].label) + '</option>';
      }).join('') + '</select>' +
      '<div class="font-preview" id="dp"></div>' +

      '<label class="check"><input type="checkbox" id="ac"' + (S.autoCaps ? ' checked' : '') +
      '> Capitalise the start of a sentence</label>' +

      '<label class="check"><input type="checkbox" id="xd"' + (S.exportDates ? ' checked' : '') +
      '> Folder and date line in exports</label>' +

      '<div class="dlg-actions">' +
      '<button class="btn" data-x="reset">Reset</button>' +
      '<button class="btn solid" data-x="c">Done</button></div>',
      function (root) {
        var ff = root.querySelector('#ff'), fs = root.querySelector('#fs');
        var fsv = root.querySelector('#fsv'), fp = root.querySelector('#fp');
        var dfmt = root.querySelector('#dfmt'), dp = root.querySelector('#dp');
        var xd = root.querySelector('#xd');
        var ac = root.querySelector('#ac');
        var ls = root.querySelector('#ls'), lsv = root.querySelector('#lsv');
        var pf = root.querySelector('#pf');
        var pw = root.querySelector('#pw');
        var nb = root.querySelector('#nb'), fdp = root.querySelector('#fdp');
        var lay = root.querySelector('#lay');
        var us = root.querySelector('#us'), usv = root.querySelector('#usv');
        var uf = root.querySelector('#uf');
        function live() {
          S.font = { family: ff.value, size: parseInt(fs.value, 10) };
          S.dateFormat = dfmt.value;
          S.exportDates = xd.checked;
          S.autoCaps = ac.checked;
          S.leading = parseFloat(ls.value) || 1.65;
          S.keepPasteFormat = pf.checked;
          S.pageWidth = pw.value;
          S.newStyle = nb.value;
          var wasLayout = S.layout;
          S.layout = lay.checked ? 'tabs' : 'classic';
          if (S.layout !== wasLayout) {
            if (S.layout === 'tabs') { syncTabToView(); $('app').dataset.pane = 'list'; }
            else if (S.view === 'more') S.view = 'all';
          }
          S.folderDeep = fdp.checked;
          lsv.textContent = S.leading.toFixed(2);
          S.uiScale = parseInt(us.value, 10);
          S.uiFont = uf.value;
          usv.textContent = S.uiScale;
          applyUiFont();
          applyUiScale();
          fsv.textContent = S.font.size;
          fp.style.fontFamily = fontStack();
          fp.style.fontSize = S.font.size + 'px';
          dp.textContent = 'Now: ' + fmtDate(Date.now(), { time: true }) +
            '   ·   Older: ' + fmtDate(Date.now() - 86400000 * 400, { time: true });
          applyFont();
          renderTree();
          renderList();
          renderMeta();
        }
        ff.onchange = live;
        fs.oninput = live;
        dfmt.onchange = live;
        xd.onchange = live;
        ac.onchange = live;
        ls.oninput = live;
        pf.onchange = live;
        pw.onchange = live;
        nb.onchange = live;
        lay.onchange = live;
        fdp.onchange = live;
        us.oninput = live;
        uf.onchange = live;
        root.querySelector('[data-x="reset"]').onclick = function () {
          ff.value = 'system';
          fs.value = SIZE_DEFAULT;
          dfmt.value = 'relative';
          xd.checked = false;
          ac.checked = true;
          ls.value = 1.65;
          pf.checked = false;
          pw.value = 'full';
          nb.value = 'row';
          lay.checked = true;
          fdp.checked = false;
          us.value = 100;
          uf.value = 'system';
          live();
        };
        root.querySelector('[data-x="c"]').onclick = closeDlg;
        live();
      }
    );
  }

  function tagMenuDialog(tag) {
    var n = liveNotes().filter(function (x) { return noteHasTag(x, tag); }).length;
    showDlg(
      '<h3>#' + esc(tag) + '</h3><p class="sub">On ' + plural(n, 'note') + '.</p>' +
      '<div class="opt-grid">' +
      '<button class="opt" data-x="rename"><b>Rename</b><span>Changes it everywhere</span></button>' +
      '<button class="opt" data-x="del"><b>Remove tag</b><span>Notes are kept</span></button>' +
      '</div><div class="dlg-actions"><button class="btn" data-x="c">Close</button></div>',
      function (root) {
        root.querySelector('[data-x="c"]').onclick = closeDlg;
        root.querySelector('[data-x="rename"]').onclick = function () {
          closeDlg();
          promptDialog('Rename tag', tag, function (v) { renameTag(tag, v); });
        };
        root.querySelector('[data-x="del"]').onclick = function () {
          closeDlg();
          confirmDialog('Remove #' + tag + '?',
            'It comes off ' + plural(n, 'note') + '. The notes stay, and you can undo.',
            'Remove tag', function () { deleteTag(tag); }, true);
        };
      }
    );
  }

  /* ---------- cleaning up duplicates already in the library ----------
     The fixes above stop new duplicates on import; these two put right what
     an earlier import already did -- a folder merge is fully automatic
     (folders hold no content of their own, so consolidating them loses
     nothing), while notes need a human choice, since two notes that share a
     title may hold genuinely different content one of them still cares about. */

  function folderGroups() {
    var byKey = {};
    S.folders.forEach(function (f) {
      // a Notes "Work" and a Mindmaps "Work" are two folders on purpose
      var key = (f.parentId || '') + ' ' + (f.kind || '') + ' ' + f.name.trim().toLowerCase();
      (byKey[key] = byKey[key] || []).push(f);
    });
    return Object.keys(byKey).map(function (k) { return byKey[k]; })
      .filter(function (g) { return g.length > 1; });
  }

  function mergeDuplicateFolders(opts) {
    opts = opts || {};
    if (!folderGroups().length) {
      if (!opts.silent) toast('No duplicate folders found.');
      return Promise.resolve(0);
    }

    /* Merging two parents makes their children siblings, which can put two
       identically named subfolders side by side that were not side by side
       before. So this keeps going until a pass finds nothing left to merge,
       working on a copy first and touching the real data only once at the end. */
    var survivorOf = {}, doomedIds = [];
    function resolve(id) {
      var guard = 0;
      while (survivorOf[id] && guard++ < 32) id = survivorOf[id];
      return id;
    }

    var working = S.folders.map(function (f) {
      return { id: f.id, name: f.name, parentId: f.parentId, createdAt: f.createdAt, kind: f.kind };
    });
    var pass = 0;
    while (pass++ < 32) {
      working.forEach(function (f) { f.parentId = f.parentId ? resolve(f.parentId) : null; });

      var byKey = {};
      working.forEach(function (f) {
        var key = (f.parentId || '') + ' ' + (f.kind || '') + ' ' +
          String(f.name || '').trim().toLowerCase();
        (byKey[key] = byKey[key] || []).push(f);
      });
      var dupes = Object.keys(byKey).map(function (k) { return byKey[k]; })
        .filter(function (g) { return g.length > 1; });
      if (!dupes.length) break;

      dupes.forEach(function (g) {
        // the oldest copy in each group survives; the rest fold into it
        var sorted = g.slice().sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
        sorted.slice(1).forEach(function (f) {
          survivorOf[f.id] = sorted[0].id;
          doomedIds.push(f.id);
        });
      });
      working = working.filter(function (f) { return !survivorOf[f.id]; });
    }
    if (!doomedIds.length) {
      if (!opts.silent) toast('No duplicate folders found.');
      return Promise.resolve(0);
    }

    var affectedNotes = S.notes.filter(function (n) { return n.folderId && survivorOf[n.folderId]; });
    var affectedFolders = S.folders.filter(function (f) { return f.parentId && survivorOf[f.parentId]; });
    var refs = doomedIds.map(function (id) { return { store: 'folders', id: id }; })
      .concat(affectedFolders.map(function (f) { return { store: 'folders', id: f.id }; }))
      .concat(noteRefs(affectedNotes.map(function (n) { return n.id; })));

    return act('Merge duplicate folders', refs, function () {
      affectedNotes.forEach(function (n) { n.folderId = resolve(n.folderId); n.updatedAt = Date.now(); });
      affectedFolders.forEach(function (f) { f.parentId = resolve(f.parentId); });
      S.folders = S.folders.filter(function (f) { return doomedIds.indexOf(f.id) === -1; });
      if (doomedIds.indexOf(S.view) !== -1) S.view = 'all';
    }).then(function () {
      renderTree(); renderList(); renderMeta(); renderUndoButtons();
      toast('Merged ' + plural(doomedIds.length, 'duplicate folder') + ' — Ctrl+Z to undo');
      return doomedIds.length;
    });
  }

  function noteGroups() {
    var byKey = {};
    liveNotes().forEach(function (n) {
      var key = (n.title || '').trim().toLowerCase();
      if (!key) return;                      // untitled notes aren't "duplicates" by name
      (byKey[key] = byKey[key] || []).push(n);
    });
    return Object.keys(byKey).map(function (k) { return byKey[k]; })
      .filter(function (g) { return g.length > 1; })
      .sort(function (a, b) { return b.length - a.length; });
  }

  function duplicatesDialog() {
    var groups = noteGroups();
    if (!groups.length) { toast('No notes share a title.'); return; }

    var html = '<h3>Possible duplicates</h3><p class="sub">' + plural(groups.length, 'title') +
      ' show up more than once. Pick which copy to keep in each — the rest go to ' +
      'the trash, so nothing is lost for good.</p>';
    groups.forEach(function (g, gi) {
      var sorted = g.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; });
      html += '<div class="dupe-group"><div class="dupe-title">' +
        esc(sorted[0].title || 'Untitled') + '</div>';
      sorted.forEach(function (n, i) {
        html += '<label class="dupe-row"><input type="radio" name="dg' + gi + '" value="' +
          esc(n.id) + '"' + (i === 0 ? ' checked' : '') + '>' +
          '<span class="dupe-meta">' + esc(KIND[n.type] || '') + ' · ' +
          esc(fmtDate(n.updatedAt, { time: true })) + '</span>' +
          '<span class="dupe-snip">' + esc(snippet(n).slice(0, 90)) + '</span></label>';
      });
      html += '</div>';
    });
    html += '<div class="dlg-actions"><button class="btn" data-x="c">Cancel</button>' +
      '<button class="btn solid" data-x="k">Trash the rest</button></div>';

    showDlg(html, function (root) {
      root.querySelector('[data-x="c"]').onclick = closeDlg;
      root.querySelector('[data-x="k"]').onclick = function () {
        var toTrash = [];
        groups.forEach(function (g, gi) {
          var picked = root.querySelector('input[name="dg' + gi + '"]:checked');
          var keepId = picked ? picked.value : g[0].id;
          g.forEach(function (n) { if (n.id !== keepId) toTrash.push(n.id); });
        });
        closeDlg();
        if (!toTrash.length) return;
        act('Merge ' + plural(toTrash.length, 'duplicate note'), noteRefs(toTrash), function () {
          toTrash.forEach(function (id) {
            var n = byNoteId(id);
            if (n) { n.deletedAt = Date.now(); n.updatedAt = Date.now(); }
          });
        }).then(function () {
          renderTree(); renderList(); renderUndoButtons();
          toast(plural(toTrash.length, 'note') + ' moved to trash — Ctrl+Z to undo');
        });
      };
    });
  }

  /* Encryption is offered, not imposed. A backup you cannot open is worse
     than no backup, and forgetting this password costs only this one file --
     your notes are still on the device in the clear. */
  /* Asked for after a reload, when automatic backups are protected but the
     password is only ever held in memory. Nothing is exported here -- it just
     puts the key back so the next scheduled backup can run. */
  function askBackupPassword() {
    showDlg(
      '<h3>Unlock automatic backups</h3>' +
      '<p class="sub">Your backups are protected. The password is never stored, ' +
      'so it is needed again each time the app starts.</p>' +
      '<label class="fld" for="ap">Backup password</label>' +
      '<input type="password" id="ap" autocomplete="current-password">' +
      '<div class="dlg-actions">' +
      '<button class="btn" data-x="off">Stop protecting them</button>' +
      '<button class="btn solid" data-x="k">Unlock</button></div>',
      function (root) {
        var ap = root.querySelector('#ap');
        root.querySelector('[data-x="k"]').onclick = function () {
          if (!ap.value) return;
          S.backupPassword = ap.value;
          closeDlg();
          toast('Automatic backups unlocked');
          scheduleAutoBackup();
        };
        root.querySelector('[data-x="off"]').onclick = function () {
          S.autoEncrypt = false;
          S.backupPassword = '';
          try { localStorage.setItem('sulat-autoencrypt', '0'); } catch (e) { /* ignore */ }
          closeDlg();
          toast('Automatic backups will no longer be protected');
          scheduleAutoBackup();
        };
        ap.onkeydown = function (e) {
          if (e.key === 'Enter') { e.preventDefault(); root.querySelector('[data-x="k"]').click(); }
        };
        setTimeout(function () { ap.focus(); }, 30);
      }
    );
  }

  function backupDialog() {
    var linked = Exporter.linkedName();
    showDlg(
      '<h3>Export backup</h3>' +
      '<p class="sub">One file with every note, folder, list, mindmap and image.' +
      (linked ? ' It will overwrite <b>' + esc(linked) + '</b>.' : '') + '</p>' +
      '<label class="check"><input type="checkbox" id="be"> Protect it with a password</label>' +
      '<div id="beWrap" hidden>' +
      '<label class="fld" for="bp">Password</label>' +
      '<input type="password" id="bp" autocomplete="new-password">' +
      '<label class="fld" for="bp2">Repeat it</label>' +
      '<input type="password" id="bp2" autocomplete="new-password">' +
      '<p class="sub tight">Needed to import this file anywhere. Forgetting it ' +
      'costs you this file only — your notes stay on this device, so you can ' +
      'always export a fresh one.</p></div>' +
      '<div class="dlg-err" id="berr" hidden></div>' +
      '<div class="dlg-actions"><button class="btn" data-x="c">Cancel</button>' +
      '<button class="btn solid" data-x="k">Export</button></div>',
      function (root) {
        var be = root.querySelector('#be'), wrap = root.querySelector('#beWrap');
        var bp = root.querySelector('#bp'), bp2 = root.querySelector('#bp2');
        var err = root.querySelector('#berr');
        be.onchange = function () {
          wrap.hidden = !be.checked;
          if (be.checked) bp.focus();
        };
        if (!Lock.available()) {
          be.disabled = true;
          be.parentNode.title = 'Encryption needs a secure connection (https or localhost).';
        }
        root.querySelector('[data-x="c"]').onclick = closeDlg;
        root.querySelector('[data-x="k"]').onclick = function () {
          var pass = be.checked ? bp.value : '';
          if (be.checked) {
            if (pass.length < 4) { err.textContent = 'Use at least 4 characters.'; err.hidden = false; return; }
            if (pass !== bp2.value) { err.textContent = 'Those two do not match.'; err.hidden = false; return; }
          }
          closeDlg();
          /* Hold it for this session so automatic backups stay protected too.
             Deliberately not stored: a password in localStorage would sit in
             plain text beside the very notes it exists to protect. */
          S.backupPassword = pass;
          S.autoEncrypt = !!pass;
          try { localStorage.setItem('sulat-autoencrypt', S.autoEncrypt ? '1' : '0'); }
          catch (e) { /* private mode */ }
          Exporter.exportBundle(null, null, { password: pass, toLinked: true })
            .then(function (c) {
              var size = c.bytes ? ' · ' + (c.bytes / 1048576).toFixed(1) + ' MB' : '';
              toast('Backed up ' + plural(c.notes, 'note') + ' and ' +
                    plural(c.images, 'image') + (c.encrypted ? ', encrypted' : '') + size);
            })
            .catch(function (e) { toast('Backup failed: ' + e.message); });
        };
      }
    );
  }

  /* An encrypted backup asks for its password rather than failing. The prompt
     only appears once the file has said it is encrypted, so a plain import is
     never interrupted by one. */
  function runImport(file, password) {
    /* Snapshot first. Import cannot be undone -- the undo history is cleared
       afterwards -- so this is the only way back if the merge resolves a note
       in a direction you did not want. */
    Exporter.snapshotNow('before-import').catch(function () {
      return null;                 // a failed snapshot must not block the import
    }).then(function () {
      return Exporter.importBundle(file, { password: password });
    }).then(function (c) {
      return load().then(function () {
        return sortFoldersByType(true);
      }).then(function () {
        History.clear();
        S.note = null;
        renderTree(); renderList(); showEmpty(); renderStorage();
        var bits = [];
        if (c.added) bits.push(c.added + ' new');
        if (c.updated) bits.push(c.updated + ' updated');
        if (c.kept) bits.push(c.kept + ' already newer here');
        toast((bits.length ? 'Merged: ' + bits.join(', ')
                           : 'Nothing to merge — already up to date') +
              ' · restore point saved');
      });
    }).catch(function (e) {
      if (e && (e.needsPassword || /wrong password/i.test(e.message))) {
        askImportPassword(file, !!password);
        return;
      }
      toast('Import failed: ' + e.message);
    });
  }

  function askImportPassword(file, retry) {
    showDlg(
      '<h3>This backup is locked</h3>' +
      '<p class="sub">Enter the password it was exported with.</p>' +
      '<label class="fld" for="ip">Password</label>' +
      '<input type="password" id="ip" autocomplete="current-password">' +
      (retry ? '<div class="dlg-err">That password did not open it.</div>' : '') +
      '<div class="dlg-actions"><button class="btn" data-x="c">Cancel</button>' +
      '<button class="btn solid" data-x="k">Import</button></div>',
      function (root) {
        var ip = root.querySelector('#ip');
        root.querySelector('[data-x="c"]').onclick = closeDlg;
        root.querySelector('[data-x="k"]').onclick = function () {
          var v = ip.value;
          closeDlg();
          runImport(file, v);
        };
        ip.onkeydown = function (e) {
          if (e.key === 'Enter') { e.preventDefault(); root.querySelector('[data-x="k"]').click(); }
        };
        setTimeout(function () { ip.focus(); }, 30);
      }
    );
  }

  /* Shown once, immediately after locking. We cannot show it again: the code
     is not stored anywhere in readable form -- only the note encrypted under
     it is -- which is exactly what stops it being a back door. */
  function showRecoveryCode(code) {
    showDlg(
      '<h3>Your recovery code</h3>' +
      '<p class="sub">This opens the note if you forget the password. It is shown ' +
      '<b>once</b> and cannot be looked up later. Write it down or put it in a ' +
      'password manager now.</p>' +
      '<div class="reccode" id="rcVal">' + esc(code) + '</div>' +
      '<div class="dlg-actions">' +
      '<button class="btn" data-x="copy">Copy</button>' +
      '<button class="btn solid" data-x="c">I have saved it</button></div>',
      function (root) {
        root.querySelector('[data-x="c"]').onclick = function () {
          closeDlg();
          toast('Locked. Undo history was cleared.');
        };
        root.querySelector('[data-x="copy"]').onclick = function () {
          if (navigator.clipboard) {
            navigator.clipboard.writeText(code).then(function () { toast('Copied'); },
              function () { toast('Could not copy — write it down instead.'); });
          } else {
            toast('Could not copy — write it down instead.');
          }
        };
      }
    );
  }

  /* ---------- backing up on its own ----------
     A backup you have to remember is a backup you will not have. This writes
     one a short while after you stop editing, and at most once an hour, so a
     long working session costs a single file rather than one per keystroke.

     It writes to the file you linked when there is one, and falls back to a
     normal download otherwise -- which is noisier, hence off until asked for. */
  var AUTO_QUIET_MS = 60 * 1000;          // wait for the typing to stop
  /* How long to leave between automatic backups. Hourly was the only setting
     and it was not written down anywhere, so a backup could be an hour behind
     with nothing on screen to say so. */
  var AUTO_GAPS = [
    { id: '1m',  label: 'Every minute',    ms: 60 * 1000 },
    { id: '5m',  label: 'Every 5 minutes', ms: 5 * 60 * 1000 },
    { id: '15m', label: 'Every 15 minutes', ms: 15 * 60 * 1000 },
    { id: '1h',  label: 'Hourly',          ms: 60 * 60 * 1000 },
    { id: '1d',  label: 'Once a day',      ms: 24 * 60 * 60 * 1000 }
  ];
  function autoGapMs() {
    var g = AUTO_GAPS.filter(function (x) { return x.id === S.autoGap; })[0];
    return (g || AUTO_GAPS[3]).ms;
  }
  var autoTimer = null;

  function scheduleAutoBackup() {
    if (!S.autoBackup) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(runAutoBackup, AUTO_QUIET_MS);
  }

  var autoNagged = false;

  function runAutoBackup() {
    if (!S.autoBackup) return;
    var now = Date.now();
    var gap = autoGapMs();
    if (S.lastAutoBackup && now - S.lastAutoBackup < gap) {
      // too soon: come back when the gap has passed
      autoTimer = setTimeout(runAutoBackup, gap - (now - S.lastAutoBackup));
      return;
    }

    /* Never quietly downgrade. If the last backup you made by hand was
       protected, an automatic one has to be protected too -- otherwise it
       overwrites your encrypted file with a plain one a minute later, which is
       worse than not backing up at all. The password is held for this session
       only and never written to disk, so after a reload it has to be given
       again before automatic backups resume. */
    if (S.autoEncrypt && !S.backupPassword) {
      console.warn('Sulat: automatic backup held - encrypted backups need the ' +
                   'password again after a reload.');
      if (!autoNagged) {
        autoNagged = true;
        toast('Automatic backup paused: open Backup & transfer to unlock it.');
      }
      return;
    }

    Exporter.exportBundle(null, null, {
      toLinked: true, quiet: true,
      password: S.autoEncrypt ? S.backupPassword : ''
    })
      .then(function (c) {
        S.lastAutoBackup = Date.now();
        try { localStorage.setItem('sulat-lastautobackup', String(S.lastAutoBackup)); }
        catch (e) { /* private mode */ }
        console.info('Sulat: automatic backup', c.notes + ' notes',
                     Math.round((c.bytes || 0) / 1024) + ' KB');
      })
      .catch(function (e) { console.warn('Sulat: automatic backup skipped -', e.message); });
  }

  function transferDialog() {
    DB.estimate().then(function (est) {
      var used = est && est.usage ? (est.usage / 1048576).toFixed(1) + ' MB used' : 'size unknown';
      var persisted = navigator.storage && navigator.storage.persisted
        ? navigator.storage.persisted() : Promise.resolve(false);
      persisted.then(function (isP) {
        showDlg(
          '<h3>Backup &amp; transfer</h3>' +
          '<p class="sub">' + plural(S.notes.length, 'note') + ', ' +
          plural(S.folders.length, 'folder') + ' · ' + esc(used) +
          '.<br>Your notes are inside this browser, not in loose files. The backup below is ' +
          'the one file that holds all of them — export it here, import it on your phone.</p>' +
          (DB.isFallback()
            ? '<p class="sub tight"><b>Limited storage.</b> This page was opened ' +
              'straight from a file, so the browser will not give it the normal ' +
              'database and Sulat is using a smaller one — about 5 MB, enough for ' +
              'a lot of writing but only a handful of images. Export a backup often. ' +
              'Opening the app from a web address instead removes the limit.</p>'
            : '') +
          /* Two things people actually come here for, then the automatic
             backup, then everything else folded away. The old grid put nine
             equal-looking buttons on screen at once, so the two that matter
             were no easier to find than "Merge duplicate folders". */
          '<div class="opt-grid">' +
          '<button class="opt" data-x="out"><b>Export backup</b>' +
          '<span>One file with everything, to keep or move to your phone</span></button>' +
          '<button class="opt" data-x="in"><b>Import backup</b>' +
          '<span>Merges into what is here</span></button>' +
          '</div>' +

          '<div class="auto-box">' +
          '<label class="check"><input type="checkbox" id="autoBk"' +
          (S.autoBackup ? ' checked' : '') + '> Back up automatically</label>' +
          '<p class="auto-note" id="autoLine"></p>' +
          '<label class="fld tight" for="autoKeep">How many to keep</label>' +
          '<select id="autoKeep" class="sort-select wide">' +
          [7, 14, 30, 60, 120].map(function (n) {
            return '<option value="' + n + '"' + (n === S.autoKeep ? ' selected' : '') +
              '>' + n + ' most recent</option>';
          }).join('') + '</select>' +

          '<label class="fld tight" for="autoGap">How often</label>' +
          '<select id="autoGap" class="sort-select wide">' + AUTO_GAPS.map(function (g) {
            return '<option value="' + g.id + '"' + (g.id === S.autoGap ? ' selected' : '') +
              '>' + esc(g.label) + '</option>';
          }).join('') + '</select>' +
          (S.autoEncrypt && !S.backupPassword
            ? '<p class="auto-note warn-note">Paused — these backups are protected and ' +
              'the password is needed again after a reload.</p>' +
              '<button class="ghost-btn" data-x="unlock-auto">Enter the backup password</button>'
            : '') +
          (Exporter.hasFilePicker()
            ? (Exporter.linkedName()
                ? '<div class="auto-actions">' +
                  '<button class="ghost-btn" data-x="relink">Choose a different file</button>' +
                  '<button class="ghost-btn" data-x="link">Use Downloads instead</button>' +
                  '</div>'
                : '<button class="ghost-btn" data-x="link">Choose a file to keep updated</button>')
            : '<p class="auto-note">This browser cannot write to a file you choose, ' +
              'so automatic backups land in your Downloads folder.</p>') +
          '</div>' +

          '<details class="more-box"><summary>Other tools</summary>' +
          '<div class="opt-grid">' +
          '<button class="opt" data-x="all"><b>Export all notes</b>' +
          '<span>PDF, Markdown, text or web page</span></button>' +
          '<button class="opt" data-x="snaps"><b>Daily snapshots</b>' +
          '<span id="snapLine">kept automatically on this device</span></button>' +
          '<button class="opt" data-x="dupfolders"><b>Merge duplicate folders</b>' +
          '<span>Fixes “Ideas” or “Work” showing up twice</span></button>' +
          '<button class="opt" data-x="dupnotes"><b>Find duplicate notes</b>' +
          '<span>For when the same note landed twice</span></button>' +
          '<button class="opt" data-x="refresh"><b>Reload the app files</b>' +
          '<span id="buildLine">If the app looks out of date after an update</span></button>' +
          '<button class="opt" data-x="persist"><b>' +
          (isP ? 'Storage is persistent' : 'Make storage persistent') + '</b><span>' +
          (isP ? 'The browser will not evict your notes' : 'Ask the browser not to evict your notes') +
          '</span></button>' +
          '</div></details>' +
          '<div class="dlg-actions"><button class="btn" data-x="c">Close</button></div>',
          function (root) {
            root.querySelector('[data-x="c"]').onclick = closeDlg;

            var keepSel = root.querySelector('#autoKeep');
            if (keepSel) {
              keepSel.onchange = function () {
                S.autoKeep = parseInt(keepSel.value, 10) || 30;
                try { localStorage.setItem('sulat-autokeep', String(S.autoKeep)); }
                catch (err) { /* private mode */ }
                Exporter.setSnapshotLimit(S.autoKeep);
                Exporter.pruneSnapshots().then(function () { describeAuto(); });
              };
            }
            var gapSel = root.querySelector('#autoGap');
            if (gapSel) {
              gapSel.onchange = function () {
                S.autoGap = gapSel.value;
                try { localStorage.setItem('sulat-autogap', S.autoGap); }
                catch (err) { /* private mode */ }
                describeAuto();
                if (S.autoBackup) scheduleAutoBackup();
              };
            }

            var unlockBtn = root.querySelector('[data-x="unlock-auto"]');
            if (unlockBtn) {
              unlockBtn.onclick = function () { closeDlg(); askBackupPassword(); };
            }

            var autoBox = root.querySelector('#autoBk');
            var autoLine = root.querySelector('#autoLine');
            function describeAuto() {
              if (!autoLine) return;
              var where = Exporter.linkedName();
              autoLine.textContent = !S.autoBackup
                ? 'Off. Nothing is written unless you export by hand.'
                : (where
                    ? 'Keeps ' + where + ' up to date'
                    : 'Saves to your Downloads folder') +
                  ', at most ' + ((AUTO_GAPS.filter(function (g) {
                    return g.id === S.autoGap;
                  })[0] || AUTO_GAPS[3]).label.toLowerCase()) + '.' +
                  (S.autoEncrypt ? ' Protected with your backup password.' : '') +
                  // the full date, not just a time: a linked file keeps whatever
                  // name it was given, so the name cannot be trusted to say when
                  (S.lastAutoBackup
                    ? ' Last written ' + fmtDate(S.lastAutoBackup, { full: true }) + '.'
                    : '');
            }
            describeAuto();
            if (autoBox) {
              autoBox.onchange = function () {
                S.autoBackup = autoBox.checked;
                try {
                  localStorage.setItem('sulat-autobackup', S.autoBackup ? '1' : '0');
                  localStorage.setItem('sulat-autogap', S.autoGap);
                  localStorage.setItem('sulat-autoencrypt', S.autoEncrypt ? '1' : '0');
                }
                catch (err) { /* private mode */ }
                describeAuto();
                if (S.autoBackup) scheduleAutoBackup();
              };
            }

            root.querySelector('[data-x="out"]').onclick = function () {
              closeDlg();
              backupDialog();
            };
            var relinkBtn = root.querySelector('[data-x="relink"]');
            if (relinkBtn) {
              relinkBtn.onclick = function () {
                Exporter.linkBackupFile().then(function (name) {
                  closeDlg();
                  toast('Now keeping ' + name + ' up to date');
                }).catch(function (e) {
                  if (e && e.name === 'AbortError') return;   // they changed their mind
                  toast('Could not link a file: ' + e.message);
                });
              };
            }
            var linkBtn = root.querySelector('[data-x="link"]');
            if (linkBtn) {
              linkBtn.onclick = function () {
                if (Exporter.linkedName()) {
                  Exporter.unlinkBackupFile();
                  closeDlg();
                  toast('Backups go to your Downloads folder again.');
                  return;
                }
                Exporter.linkBackupFile().then(function (name) {
                  closeDlg();
                  toast('Backups now keep ' + name + ' up to date');
                }).catch(function (e) {
                  if (e && e.name === 'AbortError') return;      // they changed their mind
                  toast('Could not link a file: ' + e.message);
                });
              };
            }
            root.querySelector('[data-x="in"]').onclick = function () {
              closeDlg();
              $('bundlePick').click();
            };
            root.querySelector('[data-x="all"]').onclick = function () {
              closeDlg();
              exportDialog('Export all notes', plural(liveNotes().length, 'note') + '.',
                function () {
                  return liveNotes().sort(function (a, b) { return b.updatedAt - a.updatedAt; });
                }, 'sulat-' + Exporter.stamp());
            };
            Exporter.listSnapshots().then(function (rows) {
              var line = root.querySelector('#snapLine');
              if (!line) return;
              if (!rows.length) { line.textContent = 'none yet — one is kept each day you open Sulat'; return; }
              var mb = rows.reduce(function (t, r) { return t + (r.bytes || 0); }, 0) / 1048576;
              line.textContent = rows.length + ' kept, newest ' + rows[0].id +
                ', ' + mb.toFixed(1) + ' MB total';
            });
            root.querySelector('[data-x="snaps"]').onclick = function () {
              Exporter.listSnapshots().then(function (rows) {
                if (!rows.length) { toast('No snapshots yet.'); return; }
                closeDlg();
                showDlg(
                  '<h3>Daily snapshots</h3><p class="sub">Kept on this device, images included. ' +
                  'The newest seven are held; older ones drop off.</p>' +
                  '<div class="opt-grid">' + rows.map(function (r) {
                    return '<button class="opt" data-snap="' + esc(r.id) + '"><b>' + esc(r.id) +
                      '</b><span>' + plural(r.counts.notes, 'note') + ' · ' +
                      (r.bytes / 1048576).toFixed(1) + ' MB — save a copy</span></button>';
                  }).join('') + '</div>' +
                  '<div class="dlg-actions"><button class="btn" data-x="c">Close</button></div>',
                  function (r2) {
                    r2.querySelector('[data-x="c"]').onclick = closeDlg;
                    Array.prototype.forEach.call(r2.querySelectorAll('[data-snap]'), function (b) {
                      b.onclick = function () {
                        var row = rows.filter(function (x) { return x.id === b.dataset.snap; })[0];
                        closeDlg();
                        toast('Preparing ' + row.id + '…');
                        Exporter.snapshotBlob(row).then(function (blob) {
                          Exporter.download('sulat-backup-' + row.id + '.json', blob);
                          toast('Saved ' + row.id);
                        }).catch(function (e) { toast('Could not save: ' + e.message); });
                      };
                    });
                  }
                );
              });
            };
            root.querySelector('[data-x="dupfolders"]').onclick = function () {
              closeDlg();
              mergeDuplicateFolders();
            };
            root.querySelector('[data-x="dupnotes"]').onclick = function () {
              closeDlg();
              duplicatesDialog();
            };
            /* The service worker serves the app from a cache so it opens offline.
               If that cache ever gets stuck on an old build, this clears it and
               reloads. It only touches the cached copies of the app's own files --
               the notes live in IndexedDB and are not involved. */
            /* Which build is in front of you. The service worker's cache name is
               the build hash the packager stamped in, so it answers the question
               exactly -- and answers it differently from what the page *thinks*
               it is, which is the whole point when an update has not landed. */
            (function () {
              var line = root.querySelector('#buildLine');
              if (!line || !window.caches) return;
              caches.keys().then(function (keys) {
                var mine = keys.filter(function (k) { return k.indexOf('sulat-') === 0; });
                line.textContent = mine.length
                  ? 'Running build ' + mine[0].replace('sulat-', '')
                  : 'Running from the server, with no offline copy stored';
              }).catch(function () { /* leave the default wording */ });
            })();

            root.querySelector('[data-x="refresh"]').onclick = function () {
              confirmDialog('Reload the app files?',
                'This clears the offline copy of the app and fetches it again. ' +
                'Your notes are stored separately and are not affected.',
                'Reload', function () {
                  var jobs = [];
                  if ('serviceWorker' in navigator) {
                    jobs.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
                      return Promise.all(regs.map(function (r) { return r.unregister(); }));
                    }));
                  }
                  if (window.caches) {
                    jobs.push(caches.keys().then(function (keys) {
                      return Promise.all(keys.map(function (k) { return caches.delete(k); }));
                    }));
                  }
                  Promise.all(jobs)
                    .catch(function (e) { console.warn('Sulat: cache clear —', e.message); })
                    .then(function () { location.reload(); });
                });
            };
            root.querySelector('[data-x="persist"]').onclick = function () {
              if (!navigator.storage || !navigator.storage.persist) {
                toast('This browser does not offer persistent storage.');
                return;
              }
              navigator.storage.persist().then(function (g) {
                toast(g ? 'Storage is now persistent.' : 'The browser declined for now.');
                closeDlg();
              });
            };
          }
        );
      });
    });
  }

  /* ================= actions ================= */

  function makeFolder(parentId, sub) {
    promptDialog('New folder', '', function (v) {
      if (!v) return;
      var f = DB.blankFolder(v, parentId);
      var par = parentId ? folderById(parentId) : null;
      f.kind = (par && par.kind) || currentKind();
      act('New folder', [{ store: 'folders', id: f.id }], function () {
        S.folders.push(f);
        if (parentId) S.expanded[parentId] = true;
      }).then(function () {
        renderTree();
        renderList();
        renderUndoButtons();
        toast('Folder created');
      });
    }, sub);
  }

  var ACTIONS = {
    'nav-open': function () { $('app').dataset.nav = 'open'; },
    'nav-close': function () { delete $('app').dataset.nav; },
    'editor-back': function () {
      flush();
      if (discardDraft()) renderTree();
      else if (dropIfBlank(S.note)) { S.note = null; renderTree(); }
      $('app').dataset.pane = 'list';
      // back to the folder you came from, scrolled to where you were
      if (S.layout === 'tabs') {
        renderList();
        $('noteList').scrollTop = S.listScroll || 0;
      }
    },
    /* Another tab: reopen the folder you were last in there. The tab you are
       already on: back to its top, where all of its folders are. */
    'tab': function (e, t) {
      var tab = t.dataset.tab;
      if (tab !== S.tab) { switchTab(tab); return; }
      if (S.note) { flush(); showEmpty(); }
      S.view = tab === 'more' ? 'more' : 'all';
      S.q = '';
      $('search').value = '';
      S.picked = {};
      S.selecting = false;
      $('app').dataset.pane = 'list';
      renderSelectBar();
      renderList();
      $('noteList').scrollTop = 0;
    },
    'tab-up': function () {
      if (S.tab === 'more') S.view = 'more';
      else {
        var f = folderById(S.view);
        S.view = (f && f.parentId && folderById(f.parentId)) ? f.parentId : 'all';
      }
      S.q = '';
      $('search').value = '';
      renderList();
      $('noteList').scrollTop = 0;
    },
    'new-here': function () { newNote(currentKind()); },
    'hit-next': function () { showHit(S.hitAt + 1); },
    'hit-prev': function () { showHit(S.hitAt - 1); },
    'hit-clear': function () { clearHits(); },
    'tree-kind': function (e, t) {
      S.tab = t.dataset.kind;
      var f = folderById(S.view);
      if (f && !folderFits(f, S.tab)) S.view = 'all';
      saveTabState();
      renderTree(); renderList();
    },

    'new-folder': function (e) {
      if (e) e.stopPropagation();
      makeFolder(null, 'Top-level folder. To nest one, open a folder first, or use the ⋯ beside it.');
    },
    'new-subfolder-here': function (e) {
      if (e) e.stopPropagation();
      var parent = folderById(S.view) ? S.view : null;
      makeFolder(parent, parent ? 'Nested inside ' + folderPath(parent) : null);
    },

    'new-menu': function (e) { toggleMenu($('newMenu'), e); },
    'note-menu': function (e) {
      if (!S.note) { toast('Open a note first.'); return; }
      $('noteMenu').classList.toggle('show-trash', !!S.note.deletedAt);
      $('noteMenu').classList.toggle('show-locked', !!S.note.locked);
      toggleMenu($('noteMenu'), e);
    },
    'new': function (e, t) { closeMenus(); newNote(t.dataset.type); },

    'toggle-scope': function () {
      S.folderDeep = !S.folderDeep;
      try { localStorage.setItem('slate-folderdeep', S.folderDeep ? '1' : '0'); }
      catch (err) { /* private mode */ }
      renderTree(); renderList(); renderFolderOverview();
      toast(S.folderDeep ? 'Showing subfolders too' : 'Showing this folder only');
    },

    'cycle-view': function () {
      if (S.layout === 'tabs') {
        var at = TAB_VIEWS.indexOf(tabViewMode());
        var next = TAB_VIEWS[(at + 1) % TAB_VIEWS.length];
        setTabView(next);
        toast(TAB_VIEW_NAME[next]);
        return;
      }
      var i = VIEW_MODES.indexOf(S.viewMode);
      setViewMode(VIEW_MODES[(i + 1) % VIEW_MODES.length]);
      toast('View: ' + S.viewMode);
    },

    'toggle-select': function () {
      S.selecting = !S.selecting;
      S.picked = {};
      renderSelectBar();
      renderList();
    },
    'sel-all': function () {
      visibleNotes().forEach(function (n) { S.picked[n.id] = true; });
      renderSelectBar(); renderList();
    },
    'sel-none': function () { S.picked = {}; renderSelectBar(); renderList(); },
    'sel-move': function () {
      var ids = pickedIds();
      if (!ids.length) { toast('Select some notes first.'); return; }
      moveDialog(ids, 'Move ' + plural(ids.length, 'note'));
    },
    'sel-pin': function () {
      var ids = pickedIds();
      if (!ids.length) { toast('Select some notes first.'); return; }
      var allPinned = ids.every(function (id) { var n = byNoteId(id); return n && n.pinned; });
      act((allPinned ? 'Unpin ' : 'Pin ') + plural(ids.length, 'note'), noteRefs(ids), function () {
        ids.forEach(function (id) {
          var n = byNoteId(id);
          if (n) { n.pinned = !allPinned; n.updatedAt = Date.now(); }
        });
      }).then(function () {
        renderTree(); renderList(); renderMeta(); renderUndoButtons();
        toast(allPinned ? 'Unpinned' : 'Pinned');
      });
    },
    'sel-export': function () {
      var ids = pickedIds();
      if (!ids.length) { toast('Select some notes first.'); return; }
      exportDialog('Export ' + plural(ids.length, 'note'), 'Pick a format.', function () {
        return ids.map(byNoteId).filter(Boolean);
      }, 'sulat-' + Exporter.stamp());
    },
    'sel-trash': function () {
      var ids = pickedIds();
      if (!ids.length) { toast('Select some notes first.'); return; }
      act('Trash ' + plural(ids.length, 'note'), noteRefs(ids), function () {
        ids.forEach(function (id) {
          var n = byNoteId(id);
          if (n) { n.deletedAt = Date.now(); n.updatedAt = Date.now(); }
        });
      }).then(function () {
        S.picked = {};
        if (S.note && ids.indexOf(S.note.id) !== -1) showEmpty();
        renderTree(); renderList(); renderSelectBar(); renderUndoButtons();
        toast('Moved to trash — Ctrl+Z to undo');
      });
    },

    'add-image': function () {
      if (!S.note) { toast('Open a note first.'); return; }
      $('filePick').click();
    },

    'undo': function () {
      History.undo().then(function (label) {
        renderUndoButtons();
        if (label) toast('Undid: ' + label);
      });
    },
    'redo': function () {
      History.redo().then(function (label) {
        renderUndoButtons();
        if (label) toast('Redid: ' + label);
      });
    },

    'pin': function () {
      closeMenus();
      var was = S.note.pinned;
      editNote(was ? 'Unpin note' : 'Pin note', function () {
        S.note.pinned = !was;
        S.note.updatedAt = Date.now();
      }).then(function () {
        renderTree(); renderList(); renderMeta(); renderUndoButtons();
        toast(!was ? 'Pinned' : 'Unpinned');
      });
    },
    'move': function () { closeMenus(); moveDialog(); },

    'add-tag': function () {
      var target = S.selecting && pickedIds().length ? pickedIds()
                 : (S.note ? [S.note.id] : []);
      if (!target.length) { toast('Open or select a note first.'); return; }
      var existing = allTags();
      showDlg(
        '<h3>Add a tag</h3><p class="sub">' +
        (target.length > 1 ? plural(target.length, 'note') + ' will get it.'
                           : 'Tags cut across folders — a note can carry several.') +
        '</p>' +
        '<input type="text" id="tg" placeholder="e.g. work" autocomplete="off">' +
        (existing.length
          ? '<label class="fld">Already in use</label><div class="tag-cloud">' +
            existing.map(function (t) {
              return '<button class="tag-chip pick" data-pick="' + esc(t.name) + '">#' +
                esc(t.name) + ' <span>' + t.count + '</span></button>';
            }).join('') + '</div>'
          : '') +
        '<div class="dlg-actions"><button class="btn" data-x="c">Cancel</button>' +
        '<button class="btn solid" data-x="k">Add</button></div>',
        function (root) {
          var input = root.querySelector('#tg');
          function go(v) { closeDlg(); addTagTo(target, v); }
          root.querySelector('[data-x="c"]').onclick = closeDlg;
          root.querySelector('[data-x="k"]').onclick = function () { go(input.value); };
          input.onkeydown = function (e) {
            if (e.key === 'Enter') { e.preventDefault(); go(input.value); }
          };
          Array.prototype.forEach.call(root.querySelectorAll('[data-pick]'), function (b) {
            b.onclick = function () { go(b.dataset.pick); };
          });
        }
      );
    },

    'sel-tag': function () {
      if (!pickedIds().length) { toast('Select some notes first.'); return; }
      ACTIONS['add-tag']();
    },

    'lock': function () {
      closeMenus();
      if (!Lock.available()) {
        // Web Crypto only exists in a secure context, so over a plain-http LAN
        // address it is missing. Say which of the two it actually is.
        toast(window.isSecureContext
          ? 'This browser has no encryption support, so notes cannot be locked.'
          : 'Locking needs a secure connection. Open Sulat over https (or on ' +
            'localhost) rather than this http address.');
        return;
      }
      var n = S.note;
      if (n.locked) { toast('That note is already locked.'); return; }
      showDlg(
        '<h3>Lock “' + esc(n.title || 'Untitled') + '”</h3>' +
        '<p class="sub">The text, list, mindmap and any images are encrypted with this ' +
        'password and removed from the database — including from backup files. ' +
        'The title stays visible so you can still find the note.</p>' +
        '<label class="check"><input type="checkbox" id="rc" checked> ' +
        'Also give me a recovery code</label>' +
        '<p class="sub tight" id="rcNote">A second key to this note, shown once after ' +
        'locking. Keep it somewhere safe. Without it there is no way back if you ' +
        'forget the password.</p>' +
        '<label class="fld" for="p1">Password</label>' +
        '<input type="password" id="p1" autocomplete="new-password">' +
        '<label class="fld" for="p2">Repeat it</label>' +
        '<input type="password" id="p2" autocomplete="new-password">' +
        '<div class="dlg-err" id="perr" hidden></div>' +
        '<div class="dlg-actions"><button class="btn" data-x="c">Cancel</button>' +
        '<button class="btn solid" data-x="k">Lock note</button></div>',
        function (root) {
          var p1 = root.querySelector('#p1'), p2 = root.querySelector('#p2');
          var err = root.querySelector('#perr');
          function fail(m) { err.textContent = m; err.hidden = false; }
          root.querySelector('[data-x="c"]').onclick = closeDlg;
          root.querySelector('[data-x="k"]').onclick = function () {
            if (p1.value.length < 4) return fail('Use at least 4 characters.');
            if (p1.value !== p2.value) return fail('Those two do not match.');
            var pass = p1.value;
            var wantCode = root.querySelector('#rc').checked;
            var code = wantCode ? Lock.makeRecoveryCode() : null;
            closeDlg();
            flush().then(function () {
              return Lock.lock(n, pass, code);
            }).then(function () {
              History.clear();          // the old plaintext must not sit in undo
              renderUndoButtons();
              openNote(n.id);
              renderList();
              if (code) showRecoveryCode(code);
              else toast('Locked. Undo history was cleared.');
            }).catch(function (e) { toast('Could not lock: ' + e.message); });
          };
          p2.onkeydown = function (e) {
            if (e.key === 'Enter') { e.preventDefault(); root.querySelector('[data-x="k"]').click(); }
          };
        }
      );
    },

    'unlock': function () {
      closeMenus();
      var n = S.note;
      if (!n || !n.locked) { toast('That note is not locked.'); return; }
      showDlg(
        '<h3>Unlock “' + esc(n.title || 'Untitled') + '”</h3>' +
        '<p class="sub">The note is decrypted and stays unlocked until you lock it again. ' +
        'Your recovery code works here too.</p>' +
        '<label class="fld" for="pu">Password or recovery code</label>' +
        '<input type="password" id="pu" autocomplete="current-password">' +
        '<div class="dlg-err" id="uerr" hidden></div>' +
        '<div class="dlg-actions"><button class="btn" data-x="c">Cancel</button>' +
        '<button class="btn solid" data-x="k">Unlock</button></div>',
        function (root) {
          var pu = root.querySelector('#pu'), err = root.querySelector('#uerr');
          var btn = root.querySelector('[data-x="k"]');
          root.querySelector('[data-x="c"]').onclick = closeDlg;
          btn.onclick = function () {
            btn.disabled = true;
            err.hidden = true;
            Lock.unlock(n, pu.value).then(function () {
              closeDlg();
              History.clear();
              renderUndoButtons();
              openNote(n.id);
              renderList();
              toast('Unlocked');
            }).catch(function (e) {
              btn.disabled = false;
              err.textContent = e.message;
              err.hidden = false;
              pu.select();
            });
          };
          pu.onkeydown = function (e) {
            if (e.key === 'Enter') { e.preventDefault(); btn.click(); }
          };
        }
      );
    },
    'pages': function () { closeMenus(); pagesDialog(); },
    'duplicate': function () {
      closeMenus();
      var copy = History.clone(S.note);
      copy.id = DB.uid();
      copy.title = (S.note.title || 'Untitled') + ' copy';
      copy.createdAt = copy.updatedAt = Date.now();
      act('Duplicate note', noteRefs([copy.id]), function () {
        S.notes.push(copy);
      }).then(function () {
        renderTree(); renderUndoButtons();
        openNote(copy.id);
        toast('Duplicated');
      });
    },
    'export-note': function () {
      closeMenus();
      var n = S.note;
      var shown = displayTitle(n);
      exportDialog('Export "' + shown + '"', 'Pick a format.',
        function () { return [n]; }, Exporter.slug(shown, 'note'),
        n.type === 'mindmap');
    },
    'trash': function () {
      closeMenus();
      editNote('Trash note', function () {
        S.note.deletedAt = Date.now();
        S.note.updatedAt = Date.now();   // so the delete wins when devices merge
      })
        .then(function () {
          renderTree(); showEmpty(); renderUndoButtons();
          toast('Moved to trash — Ctrl+Z to undo');
        });
    },
    'restore': function () {
      closeMenus();
      editNote('Restore note', function () {
        S.note.deletedAt = null;
        S.note.updatedAt = Date.now();
      }).then(function () {
        renderTree(); renderMeta(); renderList(); renderUndoButtons();
        toast('Restored');
      });
    },
    'purge': function () {
      closeMenus();
      var n = S.note;
      confirmDialog('Delete forever?',
        'Removes the note from this device. Undo can still bring it back until you close Sulat.',
        'Delete forever', function () {
          act('Delete note', noteRefs([n.id]), function () {
            S.notes = S.notes.filter(function (x) { return x.id !== n.id; });
          }).then(function () {
            renderTree(); showEmpty(); renderUndoButtons();
            toast('Deleted');
          });
        }, true);
    },
    'empty-trash': function () {
      var doomed = S.notes.filter(function (n) { return n.deletedAt; });
      if (!doomed.length) return;
      confirmDialog('Empty the trash?',
        plural(doomed.length, 'note') + ' removed. Undo still works until you close Sulat.',
        'Empty trash', function () {
          var ids = doomed.map(function (n) { return n.id; });
          act('Empty trash', noteRefs(ids), function () {
            S.notes = S.notes.filter(function (n) { return !n.deletedAt; });
          }).then(function () {
            if (S.note && ids.indexOf(S.note.id) !== -1) showEmpty();
            renderTree(); renderList(); renderUndoButtons();
            toast('Trash emptied');
          });
        }, true);
    },

    'add-item': function () { addItem(null, 0, false); },
    'add-item-top': function () { addItem(null, 0, true); },
    'sweep-done': function () {
      editNote('Move done to bottom', function () {
        var items = S.note.items || [];
        S.note.items = items.filter(function (i) { return !i.done; })
          .concat(items.filter(function (i) { return i.done; }));
        S.note.updatedAt = Date.now();
      }).then(function () { renderItems(); renderUndoButtons(); });
    },
    'clear-done': function () {
      var items = (S.note.items || []);
      var gone = items.filter(function (i) { return i.done; }).length;
      if (!gone) { toast('Nothing checked off.'); return; }
      editNote('Clear done items', function () {
        S.note.items = S.note.items.filter(function (i) { return !i.done; });
        S.note.updatedAt = Date.now();
      }).then(function () {
        renderItems(); renderUndoButtons();
        toast(plural(gone, 'item') + ' cleared — Ctrl+Z to undo');
      });
    },

    /* Two buttons, two jobs, the same as Tab and Enter on a keyboard:
       Child hangs the new node under the selected one, Sibling puts it
       beside it. Both always join the map -- with nothing selected they
       work from the middle of it, and an empty map gets its first node. */
    'map-sibling': function () {
      var sel = S.map.selected;
      var made;
      if (!sel) {
        var mid = S.map.centralNode();
        made = mid ? S.map.addChild(mid) : S.map.addNode();
      } else {
        made = S.map.addSibling();
      }
      S.map.reveal(made);
      if (made && S.map.opts.onRename) S.map.opts.onRename(made, true);
      focusMap();
    },
    'map-child': function () {
      var parent = S.map.selected || S.map.centralNode();
      var n = parent ? S.map.addChild(parent) : S.map.addNode();
      S.map.reveal(n);
      if (n && S.map.opts.onRename) S.map.opts.onRename(n, true);
      focusMap();
    },
    'map-rename': function () {
      if (!S.map.selected) { toast('Select a node first.'); return; }
      S.map.opts.onRename(S.map.selected);
    },
    'map-link': function () { toggleLinkMode(); },
    'map-del': function () {
      var what = S.map.deleteSelected();
      if (!what) toast('Select a node or a link first.');
      else if (what === 'link') toast('Link removed');
      else toast(plural(what, 'node') + ' removed — Ctrl+Z to undo');
      focusMap();
    },
    'map-color': function (e, t) {
      var n = S.map.setColor(t.dataset.color);
      if (!n) { toast('Select a node first.'); return; }
      if (n > 1) toast('Coloured ' + plural(n, 'node'));
      renderMapTools(S.map.selected);
      focusMap();
    },
    'map-shape': function (e, t) {
      var n = S.map.setShape(t.dataset.shape);
      if (!n) { toast('Select a node first.'); return; }
      if (n > 1) toast('Reshaped ' + plural(n, 'node'));
      renderMapTools(S.map.selected);
      focusMap();
    },
    'map-font-smaller': function () {
      if (!S.map.nudgeFontSize(-2)) toast('Select a node first.');
      renderMapTools(S.map.selected);
      focusMap();
    },
    'map-font-bigger': function () {
      if (!S.map.nudgeFontSize(2)) toast('Select a node first.');
      renderMapTools(S.map.selected);
      focusMap();
    },
    'map-font-reset': function () {
      if (!S.map.nudgeFontSize(0)) toast('Select a node first.');
      renderMapTools(S.map.selected);
      focusMap();
    },
    'map-line-thinner': function () {
      $('mapLineVal').textContent = S.map.nudgeEdgeWidth(-0.4);
      focusMap();
    },
    'map-line-thicker': function () {
      $('mapLineVal').textContent = S.map.nudgeEdgeWidth(0.4);
      focusMap();
    },
    'toggle-full': function () { toggleFullScreen(); },
    'map-style-toggle': function () {
      var hidden = $('mapEditor').classList.toggle('style-off');
      $('styleBtn').classList.toggle('on', !hidden);
      focusMap();
    },
    'map-copy': function () {
      if (!S.map) return;
      var n = S.map.copySelection();
      toast(n ? 'Copied ' + plural(n, 'node') : 'Select some nodes first.');
    },
    /* Copy and paste in one move. Duplicating is what people actually reach
       for on a selected branch, and making them do it in two steps -- with a
       clipboard they cannot see -- is friction for no gain. */
    'map-duplicate': function () {
      if (!S.map) return;
      var n = S.map.copySelection();
      if (!n) { toast('Select some nodes first.'); return; }
      editNote('Duplicate nodes', function () {
        S.map.pasteClipboard();
      }).then(function () {
        toast('Duplicated ' + plural(n, 'node'));
      });
    },
    'map-paste': function () {
      if (!S.map) return;
      editNote('Paste nodes', function () {
        var n = S.map.pasteClipboard();
        if (!n) toast('Nothing copied yet.');
        else toast('Pasted ' + plural(n, 'node'));
      });
    },
    'map-space-less': function () { nudgeMapSpacing(-8); },
    'map-space-more': function () { nudgeMapSpacing(8); },
    'map-unlink': function () {
      var n = S.map.unlinkSelected();
      if (!n) toast('Pick a link, or two or more nodes, first.');
      else toast(n === 1 ? 'Link removed' : n + ' links removed');
      renderMapTools(S.map.selected);
      focusMap();
    },
    'map-tone-down': function () {
      if (!S.map.adjustSaturation(-0.08)) toast('Select a node first.');
      renderMapTools(S.map.selected);
    },
    'map-tone-up': function () {
      if (!S.map.adjustSaturation(0.08)) toast('Select a node first.');
      renderMapTools(S.map.selected);
    },
    'map-select-mode': function () {
      S.map.setSelectMode(!S.map.selectMode);
      if (S.map.selectMode) toast('Drag across the map to select nodes');
      focusMap();
    },
    'map-image': function () {
      if (!S.note || S.note.type !== 'mindmap') return;
      if (!S.map.selected) toast('Adding the image as a new node');
      $('filePick').click();
    },
    'map-image-remove': function () {
      if (S.map.detachImage()) {
        renderMapTools(S.map.selected);
        toast('Image removed — Ctrl+Z to undo');
      }
      focusMap();
    },
    'map-fit': function () { S.map.fit(); focusMap(); },
    'map-auto': function () {
      S.map.setAuto(!S.map.auto);
      $('autoBtn').classList.toggle('on', S.map.auto);
      S.map.fit();
      toast(S.map.auto ? 'Auto-arrange on' : 'Auto-arrange off');
      focusMap();
    },
    'map-zoom-in': function () { S.map.zoomBy(1.2); },
    'map-zoom-out': function () { S.map.zoomBy(1 / 1.2); },

    'img-align': function (e, t) { setImgAlign(t.dataset.align); },
    'img-lock': function () {
      S.imgMovable = !S.imgMovable;
      try { localStorage.setItem('slate-imgmove', S.imgMovable ? '1' : '0'); }
      catch (e) { /* private mode */ }
      if (selectedImg) showImgBar(selectedImg);
      toast(S.imgMovable ? 'Images can be moved' : 'Images locked in place');
    },
    'zoom-in': function () { zoomText(1); },
    'zoom-out': function () { zoomText(-1); },
    'img-free': function () { toggleImgFree(); },
    'img-smaller': function () { nudgeImgSize(-10); },
    'img-bigger': function () { nudgeImgSize(10); },
    'img-remove': function () { removeSelectedImg(); },

    'open-transfer': function () { transferDialog(); },
    'open-fonts': function () { fontDialog(); },
    'toggle-theme': function () {
      var cur = document.documentElement.dataset.theme;
      var next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('slate-theme', next);
      if (S.map) S.map.draw();
    },
    'install': function () {
      if (!S.installPrompt) return;
      S.installPrompt.prompt();
      S.installPrompt = null;
    }
  };

  function focusMap() {
    var c = $('mapCanvas');
    if (c) c.focus({ preventScroll: true });
  }

  /* Spacing is remembered for the app, not per map: it is a preference about
     how you like maps laid out, the same way the font size is. */
  function nudgeMapSpacing(delta) {
    if (!S.map) return;
    var y = Math.max(24, Math.min(200, (S.map.gapY || 52) + delta));
    S.map.setSpacing(0, y);
    try { localStorage.setItem('sulat-mapspacing', String(y)); } catch (e) { /* ignore */ }
    var out = $('mapSpaceVal');
    if (out) out.textContent = y;
    toast('New nodes sit ' + y + 'px apart');
  }

  function toggleLinkMode() {
    if (!S.map || $('mapEditor').hidden) return;
    S.map.setLinkMode(!S.map.linkMode);
    if (S.map.linkMode) toast('Link mode on — tap two nodes');
    focusMap();
  }

  /* Buttons that step a value should keep stepping while held down. */
  var REPEATABLE = {
    'map-font-smaller': 1, 'map-font-bigger': 1,
    'map-line-thinner': 1, 'map-line-thicker': 1,
    'map-tone-down': 1, 'map-tone-up': 1,
    'img-smaller': 1, 'img-bigger': 1, 'img-free': 1, 'img-lock': 1,
    'zoom-in': 1, 'zoom-out': 1,
    'map-zoom-in': 1, 'map-zoom-out': 1
  };

  var holdTimer = null, holdRepeat = null;
  function stopHold() {
    clearTimeout(holdTimer);
    clearInterval(holdRepeat);
    holdTimer = holdRepeat = null;
  }

  function startHold(target) {
    stopHold();
    var act = target.dataset.act;
    // first press is the click itself; hold for a beat, then repeat
    holdTimer = setTimeout(function () {
      holdRepeat = setInterval(function () {
        if (!document.body.contains(target) || target.disabled) { stopHold(); return; }
        ACTIONS[act](null, target);
      }, 110);
    }, 420);
  }

  /* Swipe the folder drawer, phone only. Opening is an edge swipe so it never
     competes with anything inside the list; closing works from anywhere on the
     drawer. A gesture is claimed only once it is clearly sideways, so ordinary
     up-and-down scrolling is untouched. */
  function bindDrawerSwipe() {
    var startX = 0, startY = 0, tracking = false, decided = false, sideways = false;
    var EDGE = 30, THRESHOLD = 55;

    function narrow() { return window.innerWidth <= 900; }
    function isOpen() { return $('app').dataset.nav === 'open'; }

    document.addEventListener('touchstart', function (e) {
      tracking = false;
      if (!narrow() || e.touches.length !== 1) return;
      var el = e.target;
      // leave the map canvas, drag handles and dialogs to their own gestures
      if (el.closest && (el.closest('.map-canvas-wrap') || el.closest('[data-note-grip]') ||
          el.closest('[data-grip]') || el.closest('dialog') || el.closest('input[type="range"]'))) return;
      var t = e.touches[0];
      if (!isOpen() && t.clientX > EDGE) return;   // opening starts at the edge only
      startX = t.clientX; startY = t.clientY;
      tracking = true; decided = false; sideways = false;
    }, { passive: true });

    document.addEventListener('touchmove', function (e) {
      if (!tracking || decided || e.touches.length !== 1) return;
      var t = e.touches[0];
      var dx = t.clientX - startX, dy = t.clientY - startY;
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      decided = true;
      sideways = Math.abs(dx) > Math.abs(dy) * 1.4;
      if (!sideways) tracking = false;            // it is a scroll; hands off
    }, { passive: true });

    document.addEventListener('touchend', function (e) {
      if (!tracking || !sideways) { tracking = false; return; }
      tracking = false;
      var dx = e.changedTouches[0].clientX - startX;
      if (!isOpen() && dx > THRESHOLD) $('app').dataset.nav = 'open';
      else if (isOpen() && dx < -THRESHOLD) delete $('app').dataset.nav;
    }, { passive: true });
  }

  /* ---------- dragging the pane edges ----------
     The three-pane grid is driven by --nav-w and --list-w, so resizing is just
     writing those two. The widths are only applied once you have actually
     dragged; until then the view modes keep choosing the list width for you.
     Double-click a handle to hand that choice back. */
  var PANE_MIN = { nav: 150, list: 220 }, PANE_MAX = { nav: 460, list: 720 };

  function applyPaneWidths() {
    var app = $('app');
    if (S.paneW.nav)  app.style.setProperty('--nav-w', S.paneW.nav + 'px');
    else app.style.removeProperty('--nav-w');
    if (S.paneW.list) app.style.setProperty('--list-w', S.paneW.list + 'px');
    else app.style.removeProperty('--list-w');
    try { localStorage.setItem('slate-panew', JSON.stringify(S.paneW)); }
    catch (e) { /* private mode */ }
  }

  function bindPaneResize() {
    var dragging = null, startX = 0, startW = 0;

    document.addEventListener('pointerdown', function (e) {
      var h = e.target.closest && e.target.closest('.resizer');
      if (!h || window.innerWidth <= 900) return;
      dragging = h.dataset.resize;
      startX = e.clientX;
      var app = $('app');
      startW = parseFloat(getComputedStyle(app)
        .getPropertyValue(dragging === 'nav' ? '--nav-w' : '--list-w')) || 0;
      h.classList.add('on');
      document.body.classList.add('resizing');
      h.setPointerCapture && h.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    document.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var w = startW + (e.clientX - startX);
      S.paneW[dragging] = Math.max(PANE_MIN[dragging], Math.min(PANE_MAX[dragging], Math.round(w)));
      applyPaneWidths();
    });

    document.addEventListener('pointerup', function () {
      if (!dragging) return;
      dragging = null;
      document.body.classList.remove('resizing');
      Array.prototype.forEach.call(document.querySelectorAll('.resizer'), function (r) {
        r.classList.remove('on');
      });
      if (S.map) S.map.resize();
    });

    document.addEventListener('dblclick', function (e) {
      var h = e.target.closest && e.target.closest('.resizer');
      if (!h) return;
      S.paneW[h.dataset.resize] = 0;      // back to the stylesheet's own width
      applyPaneWidths();
      toast('Pane width reset');
    });
  }

  /* ---------- rubber-band selection over the note list ----------
     Mouse only. On a touch screen a drag across the list is a scroll, and
     taking that over would make the list unusable; phones pick notes with the
     checkbox on each card. */
  function bindRubberBand() {
    var band = $('rubber'), scroll = $('noteList');
    var active = false, x0 = 0, y0 = 0, additive = false;

    scroll.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      // only from empty space, never from a card or a control
      if (e.target.closest('.card, button, input, select, a, [data-folder-row]')) return;
      active = true;
      additive = e.shiftKey || e.ctrlKey || e.metaKey;
      x0 = e.clientX; y0 = e.clientY;
      if (!additive) { S.picked = {}; }
      band.hidden = false;
      band.style.left = x0 + 'px'; band.style.top = y0 + 'px';
      band.style.width = '0px';    band.style.height = '0px';
    });

    document.addEventListener('pointermove', function (e) {
      if (!active) return;
      var x = Math.min(x0, e.clientX), y = Math.min(y0, e.clientY);
      var w = Math.abs(e.clientX - x0), h = Math.abs(e.clientY - y0);
      band.style.left = x + 'px';  band.style.top = y + 'px';
      band.style.width = w + 'px'; band.style.height = h + 'px';
      if (w < 4 && h < 4) return;                  // a click, not yet a drag

      var r = { l: x, t: y, r: x + w, b: y + h };
      Array.prototype.forEach.call(scroll.querySelectorAll('.card'), function (c) {
        var q = c.getBoundingClientRect();
        var hit = q.left < r.r && q.right > r.l && q.top < r.b && q.bottom > r.t;
        if (hit) S.picked[c.dataset.noteId] = true;
        else if (!additive) delete S.picked[c.dataset.noteId];
        c.classList.toggle('picked', !!S.picked[c.dataset.noteId]);
        var box = c.querySelector('[data-pick-note]');
        if (box) {
          box.classList.toggle('on', !!S.picked[c.dataset.noteId]);
          box.textContent = S.picked[c.dataset.noteId] ? '✓' : '';
        }
      });
    });

    document.addEventListener('pointerup', function () {
      if (!active) return;
      active = false;
      band.hidden = true;
      if (Object.keys(S.picked).length && !S.selecting) {
        S.selecting = true;
        renderSelectBar();
      }
      renderSelectBar();
    });
  }

  /* ---------- how big the mindmap is ----------
     The wrapper carries a native resize grip, so dragging it is the browser's
     job; ours is to tell the canvas its size changed and to remember the
     height, since a canvas does not reflow on its own. */
  function bindMapSize() {
    var wrap = document.querySelector('.map-canvas-wrap');
    if (!wrap) return;

    var saved = parseInt(localStorage.getItem('sulat-mapheight'), 10);
    if (saved > 200) wrap.style.height = saved + 'px';

    var lastH = 0;

    function sync() {
      var h = Math.round(wrap.getBoundingClientRect().height);
      if (!h || h === lastH) return;
      lastH = h;
      if (S.map) S.map.resize();
      // remember only a height the person set, not one the window imposed
      if (!$('app').dataset.full && wrap.style.height) {
        try { localStorage.setItem('sulat-mapheight', parseInt(wrap.style.height, 10)); }
        catch (e) { /* private mode */ }
      }
    }

    /* ResizeObserver is the tidy way to notice the grip being dragged, but it
       is throttled in a background view and stops entirely in a hidden one --
       the same trap as requestAnimationFrame. So it is the fast path, not the
       only one: a pointer released over the wrapper and a window resize both
       run the same check, and neither can be paused out of existence. */
    if (typeof ResizeObserver === 'function') {
      var settle = 0;
      new ResizeObserver(function () {
        clearTimeout(settle);
        settle = setTimeout(sync, 60);
      }).observe(wrap);
    }
    wrap.addEventListener('pointerup', function () { setTimeout(sync, 30); });
    window.addEventListener('resize', function () { setTimeout(sync, 80); });
    document.addEventListener('sulat:mapshown', sync);
  }

  function mapShown() {
    document.dispatchEvent(new CustomEvent('sulat:mapshown'));
  }

  function toggleFullScreen() {
    var app = $('app');
    if (app.dataset.full) delete app.dataset.full;
    else app.dataset.full = 'on';
    // the canvas is sized in pixels, so it has to be told
    setTimeout(function () {
      if (S.map) { S.map.resize(); S.map.draw(); }
      mapShown();
    }, 30);
  }

  /* ---------- zooming what you are reading ----------
     A mindmap already zooms its canvas. Notes and lists had no equivalent: the
     only way to make the words bigger was to open a settings dialog. This is
     the same gesture people use everywhere else -- Ctrl with the wheel, or
     Ctrl and plus or minus -- and it moves the one number that sets the size
     of note text, list rows and mindmap labels alike.

     Touch is deliberately not handled here: a pinch is the browser's own page
     zoom and works already, and taking it over would mean fighting it. */
  function zoomText(step) {
    var next = Math.min(SIZE_MAX, Math.max(SIZE_MIN, (S.font.size || SIZE_DEFAULT) + step));
    if (next === S.font.size) {
      toast(step > 0 ? 'Already the largest text size' : 'Already the smallest text size');
      return;
    }
    S.font.size = next;
    applyFont();
    toast('Text size ' + next + 'px');
  }

  function bindTextZoom() {
    var scroller = $('editorScroll');
    if (!scroller) return;

    /* A narrower column wraps the title differently, and its height is not
       something CSS works out on its own. */
    var settle = 0;
    window.addEventListener('resize', function () {
      clearTimeout(settle);
      settle = setTimeout(function () { if (S.note) autosize($('noteTitle')); }, 120);
    });

    scroller.addEventListener('wheel', function (e) {
      if (!(e.ctrlKey || e.metaKey)) return;   // plain scrolling is left alone
      if (S.note && S.note.type === 'mindmap') return;  // the canvas zooms itself
      e.preventDefault();                      // or the browser zooms the page
      zoomText(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  }

  function closeMenus() {
    $('newMenu').hidden = true;
    $('noteMenu').hidden = true;
  }
  function toggleMenu(m, e) {
    if (e) e.stopPropagation();
    var wasHidden = m.hidden;
    closeMenus();
    m.hidden = !wasHidden;
  }

  /* ================= wiring ================= */

  function bind() {
    document.addEventListener('click', function (e) {
      if (suppressClick) return;      // this click is the tail of a drag
      var t = e.target;

      var act1 = t.closest('[data-act]');
      if (act1 && ACTIONS[act1.dataset.act]) {
        if (act1.disabled) return;
        ACTIONS[act1.dataset.act](e, act1);
        return;
      }

      var untag = t.closest('[data-untag]');
      if (untag && S.note) {
        e.stopPropagation();
        removeTagFrom(S.note.id, untag.dataset.untag);
        return;
      }

      var tm = t.closest('[data-tag-menu]');
      if (tm) {
        e.stopPropagation();
        tagMenuDialog(tm.dataset.tagMenu);
        return;
      }

      var fm = t.closest('[data-folder-menu]');
      if (fm) { e.stopPropagation(); folderMenuDialog(fm.dataset.folderMenu); return; }

      var ol = t.closest('[data-olFolder], [data-ol-folder]');
      if (ol) {
        var fid = ol.dataset.olFolder;
        S.expanded[fid] = !S.expanded[fid];
        renderList();
        return;
      }

      var tw = t.closest('[data-twist]');
      if (tw) {
        e.stopPropagation();
        S.expanded[tw.dataset.twist] = !S.expanded[tw.dataset.twist];
        renderTree();
        return;
      }

      var nav = t.closest('[data-view]');
      if (nav) {
        S.view = nav.dataset.view;
        if (S.layout === 'tabs') {
          S.q = '';
          $('search').value = '';
          $('noteList').scrollTop = 0;
        }
        /* Going into a folder opens it in the tree, so its subfolders are
           there where you would look for them. The twist still closes it
           again -- only the parents above you are held open. */
        if (folderById(S.view)) S.expanded[S.view] = true;
        S.picked = {};
        delete $('app').dataset.nav;
        /* Choosing a folder is a browsing move, so put its contents in the
           viewer rather than leaving whatever note happened to be open. The
           note is already saved; nothing is lost by closing it. */
        if (S.note) { flush(); showEmpty(); }
        renderTree(); renderList(); renderSelectBar();
        renderFolderOverview();
        return;
      }

      var pick = t.closest('[data-pickNote], [data-pick-note]');
      if (pick) {
        e.stopPropagation();
        var pid = pick.dataset.pickNote;
        if (!S.selecting) { S.selecting = true; S.picked = {}; }
        if (S.picked[pid]) delete S.picked[pid]; else S.picked[pid] = true;
        if (!pickedIds().length) S.selecting = false;
        renderSelectBar();
        renderList();
        return;
      }

      var bin = t.closest('[data-binNote], [data-bin-note]');
      if (bin) {
        e.stopPropagation();
        binNote(bin.dataset.binNote);
        return;
      }

      var card = t.closest('[data-note-id]');
      if (card) {
        var id = card.dataset.noteId;
        S.hitQuery = plainQuery();
        /* Clicking a card always opens it.

           It used to toggle the tick instead whenever selection mode happened
           to be on, which left the list looking dead: notes ticked one after
           another and the editor never changed. Selecting is what the checkbox,
           a rubber-band drag, and Ctrl or Shift click are for -- all of them
           deliberate. Nothing can now put the list into a state where clicking
           a note does not open it. */
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
          if (S.picked[id]) delete S.picked[id]; else S.picked[id] = true;
          // Repaint just this card: a full re-render would throw away the
          // list's scroll position on every tick.
          var on = !!S.picked[id];
          card.classList.toggle('picked', on);
          var box = card.querySelector('.card-check');
          if (box) { box.classList.toggle('on', on); box.textContent = on ? '✓' : ''; }
          if (!S.selecting && pickedIds().length) S.selecting = true;
          if (!pickedIds().length) S.selecting = false;
          renderSelectBar();
        } else {
          openNote(id);
        }
        return;
      }

      var rm = t.closest('[data-remove-image]');
      if (rm) {
        var imgId = rm.dataset.removeImage;
        editNote('Remove image', function () {
          S.note.images = (S.note.images || []).filter(function (x) { return x !== imgId; });
          S.note.updatedAt = Date.now();
        }).then(function () { renderGallery(); renderList(); renderUndoButtons(); });
        return;
      }

      var lb = t.closest('[data-lightbox]');
      if (lb) {
        $('lightboxImg').src = lb.src;
        $('lightbox').hidden = false;
        return;
      }

      var tog = t.closest('[data-toggle]');
      if (tog) {
        var iid = tog.dataset.toggle;
        var it = S.note.items[itemIndex(iid)];
        var label = it.done ? 'Uncheck item' : 'Check item';
        editNote(label, function () {
          it.done = !it.done;
          syncParents();
          S.note.updatedAt = Date.now();
        }).then(function () {
          renderItems();          // parents above may have changed too
          updateCount(); renderUndoButtons();
        });
        return;
      }

      var sub = t.closest('[data-sub-item]');
      if (sub) { addSubItem(sub.dataset.subItem); return; }

      var mv = t.closest('[data-move-item]');
      if (mv) { moveItem(mv.dataset.moveItem, parseInt(mv.dataset.dir, 10)); return; }

      var kill = t.closest('[data-kill-item]');
      if (kill) { removeItem(kill.dataset.killItem); return; }

      if (!t.closest('.menu')) closeMenus();
      if (!t.closest('#imgBar') && !t.closest('img[data-img]')) hideImgBar();
    });

    $('lightbox').addEventListener('click', function () { $('lightbox').hidden = true; });

    /* --- editor inputs --- */

    $('noteTitle').addEventListener('input', function () {
      autosize(this);               // grow with the text, however many lines
      if (!S.note) return;          // editor is showing its empty state
      beginBurst('Edit title');
      S.note.title = this.value;
      touch();
    });
    // It wraps, but it is still a title: Enter moves on rather than adding a line.
    $('noteTitle').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (!S.note) return;
      if (S.note.type === 'text') $('noteRich').focus();
      else if (S.note.type === 'list') {
        var first = document.querySelector('#listItems [data-item]');
        if (first) first.focus();
      } else this.blur();
    });
    $('editorScroll').addEventListener('scroll', function () {
      if (selectedImg) placeImgGrip(selectedImg);
    }, { passive: true });

    var rich = $('noteRich');
    rich.addEventListener('input', function () {
      if (!S.note) return;
      capitaliseSentence(rich);
      saveRich('Edit text');
    });
    rich.addEventListener('blur', function () {
      if (!S.note || S.note.type !== 'text') return;
      if (S.saveTimer) flush();
      // Addresses typed just now become clickable once you look away. Doing it
      // mid-typing would move the caret out from under you, so it waits for
      // the blur to settle and only redraws when something actually changed.
      var current = readRich().html;
      if (linkifyHtml(current) === current) return;
      setTimeout(function () {
        if (S.note && S.note.type === 'text') { renderRich(); renderGallery(); }
      }, 0);
    });




    rich.addEventListener('click', function (e) {
      var a = e.target.closest('a[href]');
      if (a) {
        e.preventDefault();
        window.open(a.href, '_blank', 'noopener');
      }
    });

    // clicking an image selects it and floats its layout bar above it
    rich.addEventListener('click', function (e) {
      var img = e.target.closest('img[data-img]');
      if (img) { e.stopPropagation(); showImgBar(img); }
      else hideImgBar();
    });
    // an image dragged to a new spot in the text: persist where it landed
    rich.addEventListener('drop', function () {
      setTimeout(function () { renderRichSrcs(); saveRich('Move image'); }, 0);
    });
    rich.addEventListener('dragend', function () {
      setTimeout(function () { renderRichSrcs(); saveRich('Move image'); }, 0);
    });
    $('editorScroll').addEventListener('scroll', function () {
      if (selectedImg) showImgBar(selectedImg);
    });

    /* --- list item editing --- */

    $('listItems').addEventListener('input', function (e) {
      var ta = e.target.closest('[data-item]');
      if (!ta || !S.note) return;
      beginBurst('Edit item');
      capitaliseField(ta);
      var it = S.note.items[itemIndex(ta.dataset.item)];
      it.text = ta.value;
      autosizeItem(ta);
      updateCount();
      touch();
    });

    $('listItems').addEventListener('keydown', function (e) {
      var ta = e.target.closest('[data-item]');
      if (!ta) return;
      var id = ta.dataset.item;
      var idx = itemIndex(id);
      var it = S.note.items[idx];

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        addItem(id, it.indent || 0);
      } else if (e.key === 'Backspace' && !ta.value && S.note.items.length > 1) {
        e.preventDefault();
        removeItem(id);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        indentItem(id, e.shiftKey ? -1 : 1);
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        moveItem(id, e.key === 'ArrowUp' ? -1 : 1);
      } else if (e.key === 'ArrowUp' && ta.selectionStart === 0 && idx > 0) {
        e.preventDefault();
        var up = document.querySelector('[data-item="' + S.note.items[idx - 1].id + '"]');
        if (up) up.focus();
      } else if (e.key === 'ArrowDown' && ta.selectionStart === ta.value.length &&
                 idx < S.note.items.length - 1) {
        e.preventDefault();
        var dn = document.querySelector('[data-item="' + S.note.items[idx + 1].id + '"]');
        if (dn) dn.focus();
      }
    });

    /* --- editing a mindmap node in place --- */

    var inline = $('mapInlineEdit');
    inline.addEventListener('keydown', function (e) {
      e.stopPropagation();                      // never reaches the canvas or the app
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelNodeEdit();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commitNodeEdit();
      } else if (e.key === 'Tab') {
        // commit, then straight into a new node - Tab, type, Tab, type
        e.preventDefault();
        var sibling = e.shiftKey;
        commitNodeEdit(function () {
          var n = sibling ? S.map.addSibling() : S.map.addChild();
          S.map.reveal(n);
          startNodeEdit(n);
        });
      }
    });
    inline.addEventListener('input', sizeNodeEdit);
    inline.addEventListener('blur', function () { commitNodeEdit(); });

    // any interaction with the canvas itself closes the editor first
    $('mapCanvas').addEventListener('pointerdown', function () { commitNodeEdit(); }, true);
    $('mapCanvas').addEventListener('wheel', function () { commitNodeEdit(); }, true);

    $('listItems').addEventListener('pointerdown', function (e) {
      var g = e.target.closest('[data-grip]');
      if (g) startReorder(e, g.dataset.grip);
    });
    document.addEventListener('pointermove', moveReorder);
    document.addEventListener('pointerup', endReorder);
    document.addEventListener('pointercancel', endReorder);

    /* --- search --- */

    var searchTimer = null;
    $('search').addEventListener('input', function () {
      var v = this.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { S.q = v.trim(); renderList(); }, 140);
    });

    /* --- images in --- */

    $('filePick').addEventListener('change', function () {
      attachFiles(this.files);
      this.value = '';
    });

    $('bundlePick').addEventListener('change', function () {
      var f = this.files[0];
      this.value = '';
      if (!f) return;
      runImport(f, '');
    });

    document.addEventListener('paste', function (e) {
      if (!S.note || !e.clipboardData) return;

      // Markup copied from a web page: clean it before it ever lands.
      var target = e.target;
      var inRich = target && target.closest && target.closest('#noteRich');
      var html = e.clipboardData.getData && e.clipboardData.getData('text/html');

      /* Plain unless you asked for formatting. Pasting a numbered list used to
         bring the <ol> with it, and every Enter afterwards produced another
         numbered item -- formatting nobody asked for, arriving by way of the
         clipboard and then refusing to stop.

         This has to insert the text itself rather than just stand aside:
         left to its own devices the browser pastes the text/html flavour, so
         the list would come straight back. */
      if (inRich && html && !S.keepPasteFormat && !(e.clipboardData.files || []).length) {
        e.preventDefault();
        var plain = e.clipboardData.getData('text/plain') || '';
        var sel0 = window.getSelection();
        if (sel0 && sel0.rangeCount && plain) {
          var r0 = sel0.getRangeAt(0);
          r0.deleteContents();
          // keep the line breaks; drop everything else
          var frag0 = document.createDocumentFragment();
          var NL = String.fromCharCode(10), CR = String.fromCharCode(13);
          plain.split(CR + NL).join(NL).split(CR).join(NL)
               .split(NL).forEach(function (line, i) {
            if (i) frag0.appendChild(document.createElement('br'));
            if (line) frag0.appendChild(document.createTextNode(line));
          });
          var last0 = frag0.lastChild;
          r0.insertNode(frag0);
          if (last0) {
            r0.setStartAfter(last0); r0.collapse(true);
            sel0.removeAllRanges(); sel0.addRange(r0);
          }
        }
        saveRich('Paste');
        return;
      }

      if (inRich && html && !(e.clipboardData.files || []).length) {
        e.preventDefault();
        var box = document.createElement('div');
        box.innerHTML = html;
        var stripped = sanitizeInto(box);
        var sel = window.getSelection();
        if (sel && sel.rangeCount) {
          var range = sel.getRangeAt(0);
          range.deleteContents();
          var frag = document.createDocumentFragment();
          while (box.firstChild) frag.appendChild(box.firstChild);
          var last = frag.lastChild;
          range.insertNode(frag);
          if (last) { range.setStartAfter(last); range.collapse(true);
                      sel.removeAllRanges(); sel.addRange(range); }
        }
        saveRich('Paste');
        if (stripped) {
          toast(plural(stripped, 'linked image') + ' left out — they would load from the web');
        }
        return;
      }

      var files = e.clipboardData.files;
      if (files && files.length) {
        var imgs = Array.prototype.filter.call(files, function (f) {
          return f.type && f.type.indexOf('image/') === 0;
        });
        if (imgs.length) { e.preventDefault(); attachFiles(imgs); }
      }
    });

    var veil = null, dragDepth = 0;
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('dragenter', function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') === -1) return;
      dragDepth++;
      if (!veil) {
        veil = el('div', 'drop-veil', 'Drop images into this note');
        document.body.appendChild(veil);
      }
    });
    window.addEventListener('dragleave', function () {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth && veil) { veil.remove(); veil = null; }
    });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      dragDepth = 0;
      if (veil) { veil.remove(); veil = null; }
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        attachFiles(e.dataTransfer.files);
      }
    });

    /* --- drag note cards onto a folder ---
       Pointer events rather than HTML5 drag-and-drop, because HTML5 DnD does
       not fire at all on Android. The grip works with any pointer; on a mouse
       the whole card is draggable, since there is nothing to scroll away. */

    document.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      if (e.target.closest('[data-folder-menu], [data-act]')) return;
      var grip = e.target.closest('[data-note-grip]');
      var card = e.target.closest('[data-note-id]');
      var tile = card ? null : e.target.closest('.ftile[data-view], .folder-row[data-view], .ol-row[data-view]');
      if (!card && !tile) return;
      if (e.target.closest('[data-pickNote], [data-pick-note], [data-binNote], [data-bin-note]')) return;

      var dragFolder = tile ? tile.dataset.view : null;
      if (dragFolder && !folderById(dragFolder)) return;
      var id = card ? card.dataset.noteId : null;
      // dragging one of the selected cards drags the whole selection
      var ids = (card && S.selecting && S.picked[id]) ? pickedIds() : (id ? [id] : []);

      // a mouse drags straight away; a folder always waits for the hold
      if (!tile && (grip || e.pointerType === 'mouse')) { beginNoteDrag(e, ids); return; }
      if (tile && e.pointerType === 'mouse') { beginNoteDrag(e, [], dragFolder); return; }

      /* A finger has no grip to aim at and the list has to stay scrollable,
         so a press that stays put for a moment becomes a drag. Moving before
         then is a scroll and cancels it. */
      var sx = e.clientX, sy = e.clientY, pid = e.pointerId;
      clearTimeout(pressDrag.timer);
      pressDrag = {
        x: sx, y: sy, id: pid,
        timer: setTimeout(function () {
          if (noteDragState) return;
          beginNoteDrag({ pointerId: pid, clientX: sx, clientY: sy }, ids, dragFolder);
          noteDragMove({
            pointerId: pid, clientX: sx + 9, clientY: sy + 9,
            preventDefault: function () { /* nothing to cancel here */ }
          });
          if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) { /* ignore */ } }
          toast('Drop it on a folder');
        }, 420)
      };
    });

    document.addEventListener('pointermove', function (e) {
      if (!pressDrag.timer || e.pointerId !== pressDrag.id) return;
      if (Math.hypot(e.clientX - pressDrag.x, e.clientY - pressDrag.y) > 14) {
        clearTimeout(pressDrag.timer);
        pressDrag.timer = null;
      }
    }, true);

    ['pointerup', 'pointercancel'].forEach(function (ev) {
      document.addEventListener(ev, function () {
        clearTimeout(pressDrag.timer);
        pressDrag.timer = null;
      }, true);
    });
    /* A pointermove cannot stop the page scrolling; a touchmove can. Without
       this the phone scrolls the list out from under the note being dragged
       and then cancels the whole gesture. */
    document.addEventListener('touchmove', function (e) {
      if (noteDragState && noteDragState.started) e.preventDefault();
    }, { passive: false });
    document.addEventListener('contextmenu', function (e) {
      if (noteDragState || pressDrag.timer) { e.preventDefault(); return; }
      // holding a note or a folder means "pick this up", never "select text"
      if (e.target.closest && e.target.closest('.card, .ftile, .folder-row, .ol-row')) {
        e.preventDefault();
      }
    });

    document.addEventListener('pointermove', noteDragMove);
    document.addEventListener('pointerup', endNoteDrag);
    document.addEventListener('pointercancel', endNoteDrag);

    // hold a stepper button down and it keeps stepping
    document.addEventListener('pointerdown', function (e) {
      var b = e.target.closest && e.target.closest('[data-act]');
      if (b && REPEATABLE[b.dataset.act] && !b.disabled) startHold(b);
    });
    ['pointerup', 'pointercancel', 'pointerleave', 'blur'].forEach(function (ev) {
      document.addEventListener(ev, stopHold, true);
    });

    /* --- keyboard shortcuts --- */

    document.addEventListener('keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey;
      // The note body is a contenteditable div, not a textarea. Miss that and
      // every "n" typed into a note fires the new-note shortcut.
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) ||
                   !!e.target.isContentEditable ||
                   !!(e.target.closest && e.target.closest('[contenteditable="true"]'));

      if (e.key === 'Escape') {
        closeMenus();
        $('lightbox').hidden = true;
        if (S.map && !$('mapEditor').hidden && S.map.linkMode) S.map.setLinkMode(false);
        // full screen hides the way back, so Escape has to be a way out
        else if ($('app').dataset.full) toggleFullScreen();
        return;
      }
      if (mod && !e.shiftKey && (e.key === 'c' || e.key === 'C') &&
          S.map && !$('mapEditor').hidden && !typing) {
        var copied = S.map.copySelection();
        if (copied) { e.preventDefault(); toast('Copied ' + plural(copied, 'node')); }
        return;
      }
      if (mod && !e.shiftKey && (e.key === 'v' || e.key === 'V') &&
          S.map && !$('mapEditor').hidden && !typing) {
        e.preventDefault();
        editNote('Paste nodes', function () {
          var n = S.map.pasteClipboard();
          if (n) toast('Pasted ' + plural(n, 'node'));
        });
        return;
      }
      if (mod && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_' ||
                  e.key === '0')) {
        if (S.note && S.note.type !== 'mindmap' && !typing) {
          e.preventDefault();
          if (e.key === '0') { S.font.size = SIZE_DEFAULT; applyFont(); toast('Text size reset'); }
          else zoomText((e.key === '-' || e.key === '_') ? -1 : 1);
          return;
        }
      }
      if (mod && e.key.toLowerCase() === 'd') {
        if (S.note && S.note.type === 'mindmap' && !typing) {
          e.preventDefault();          // the browser would bookmark the page
          ACTIONS['map-duplicate']();
        }
        return;
      }
      if (mod && e.key.toLowerCase() === 'l') {
        if (S.note && S.note.type === 'mindmap') { e.preventDefault(); toggleLinkMode(); }
        return;
      }
      if (mod && e.key.toLowerCase() === 'z') {
        // Inside a text box the browser's own undo is finer-grained, and our
        // input handler keeps state in sync, so let it through there.
        if (typing) return;
        e.preventDefault();
        if (e.shiftKey) ACTIONS.redo(); else ACTIONS.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        if (typing) return;
        e.preventDefault();
        ACTIONS.redo();
        return;
      }
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        flush().then(function () { toast('Saved'); });
        return;
      }
      if (mod && e.key.toLowerCase() === 'p' && S.note) {
        e.preventDefault();
        Exporter.printNotes([S.note], {
          docTitle: displayTitle(S.note),
          dates: S.exportDates,
          fmtDate: function (ts) { return fmtDate(ts, { time: true }); }
        });
        return;
      }
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        $('app').dataset.pane = 'list';
        $('search').focus();
        return;
      }
      if (typing) return;
      if (e.key === 'n' && !mod) { e.preventDefault(); newNote('text'); }
    });

    var sortSel = $('sortBy');
    if (sortSel) {
      sortSel.value = S.sortBy;
      sortSel.onchange = function () {
        S.sortBy = sortSel.value;
        try { localStorage.setItem('slate-sortby', S.sortBy); } catch (e) { /* private mode */ }
        renderList();
      };
    }

    bindMapSize();
    bindTextZoom();
    bindImgResize();
    bindImgDrag();
    bindPaneResize();
    bindRubberBand();
    bindDrawerSwipe();

    window.addEventListener('beforeunload', function () {
      if (S.saveTimer) flush();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && S.saveTimer) flush();
    });

    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      S.installPrompt = e;
      if ($('installBtn')) return;
      var foot = document.querySelector('.pane-foot');
      var b = el('button', 'ghost-btn', 'Install as app');
      b.id = 'installBtn';
      b.dataset.act = 'install';
      foot.insertBefore(b, foot.firstChild);
    });
  }

  /* ================= storage line ================= */

  function renderStorage() {
    DB.estimate().then(function (est) {
      var txt = plural(liveNotes().length, 'note');
      if (est && est.usage) txt += ' · ' + (est.usage / 1048576).toFixed(1) + ' MB';
      // Say so when running on the small fallback store, rather than let
      // someone discover the ceiling by hitting it.
      if (est && est.fallback) txt += ' of 5 MB · limited storage';
      $('storageLine').textContent = txt;
    });
  }

  /* ================= boot ================= */

  function firstRun() {
    if (S.notes.length || S.folders.length) return Promise.resolve();
    // Fixed ids, not DB.uid(): every fresh install creates this same starter
    // content. With random ids, installing on a second device and then
    // importing a backup duplicated all of it, because the two copies had
    // no id in common for the merge to recognise. A stable id means they
    // collide on purpose and the usual newer-wins import rule takes over.
    var f = DB.blankFolder('Ideas', null);
    f.id = 'seed-folder-ideas';
    var welcome = DB.blankNote('text', f.id);
    welcome.id = 'seed-note-welcome';
    welcome.title = 'Welcome to Sulat';
    welcome.body = [
      'This is yours, offline, on this device. Nothing leaves it unless you export.',
      '',
      'Three kinds of note:',
      '  • Note — long-form writing like this. No length limit.',
      '  • List — tick items off, drag the handle to reorder, Tab to indent.',
      '  • Mindmap — Tab adds a child node, Ctrl+L links two nodes, Del removes.',
      '',
      'Folders: use ＋ beside FOLDERS in the sidebar. Drag notes onto a folder to',
      'file them, or tap the folder chip at the top of a note. The ☐ button above',
      'the list turns on multi-select so you can move or export several at once.',
      '',
      'Undo works everywhere — Ctrl+Z, or the ↶ button. Redo is Ctrl+Shift+Z.',
      '',
      'Images: paste them, drop them in, or use the camera button.',
      '',
      'Export: the ⋮ menu exports one note; a folder\'s ⋯ menu exports the folder;',
      '"Backup & transfer" exports everything. PDF goes through your print dialog —',
      'pick "Save as PDF" there.',
      '',
      'To move notes to your phone: Backup & transfer → Export backup, then Import',
      'backup on the other device.'
    ].join('\n');

    var list = DB.blankNote('list', f.id);
    list.id = 'seed-note-list';
    list.title = 'Try a list';
    list.items = [
      { id: DB.uid(), text: 'Drag the handle on the left to reorder', done: false, indent: 0 },
      { id: DB.uid(), text: 'Tap the box to cross something out', done: true, indent: 0 },
      { id: DB.uid(), text: 'Press Tab to indent a sub-item', done: false, indent: 0 },
      { id: DB.uid(), text: 'like this one', done: false, indent: 1 },
      { id: DB.uid(), text: 'Enter makes the next item', done: false, indent: 0 }
    ];

    var map = DB.blankNote('mindmap', f.id);
    map.id = 'seed-note-mindmap';
    map.title = 'Try a mindmap';
    var a = { id: DB.uid(), text: 'Project', x: 0, y: 0 };
    var b = { id: DB.uid(), text: 'Research', x: 210, y: -80 };
    var c = { id: DB.uid(), text: 'Draft', x: 210, y: 0 };
    var d = { id: DB.uid(), text: 'Ship', x: 210, y: 80 };
    map.map = {
      nodes: [a, b, c, d],
      edges: [{ a: a.id, b: b.id }, { a: a.id, b: c.id }, { a: a.id, b: d.id }]
    };

    S.folders.push(f);
    S.notes.push(welcome, list, map);
    return DB.put('folders', f).then(function () {
      return DB.putMany('notes', [welcome, list, map]);
    });
  }

  function boot() {
    var saved = localStorage.getItem('slate-theme');
    if (saved) {
      document.documentElement.dataset.theme = saved;
    } else if (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) {
      document.documentElement.dataset.theme = 'dark';
    }
    setViewMode(localStorage.getItem('slate-viewmode') || 'list');
    loadFontPref();
    applyFont();
    applyUiFont();
    applyUiScale();
    applyPaneWidths();

    History.configure({ apply: applyRecords, onChange: renderUndoButtons });

    bind();
    decorateMapTools();
    load()
      .then(firstRun)
      .then(DB.migrateNotes)
      .then(function (r) {
        if (r && r.migrated) console.info('Sulat: stamped', r.migrated, 'note(s) with schema', DB.SCHEMA);
        return load();          // pick the stamped records back up
      })
      .then(purgeOldTrash)
      .then(sweepBlankNotes)
      .then(function () { return sortFoldersByType(false); })
      .then(function () {
        // reopen the tab, and the folder in it, you were last in
        if (S.layout === 'tabs') {
          if (S.tab === 'more') S.view = 'more';
          else {
            var tv = S.tabViews[S.tab], tf = tv && folderById(tv);
            S.view = (tf && folderFits(tf, S.tab)) ? tv : 'all';
          }
        }
        renderTree();
        renderList();
        renderSelectBar();
        renderStorage();
        renderUndoButtons();
        var last = localStorage.getItem('slate-last');
        // the tabs layout opens on your folders, not on whatever was open last
        if (S.layout !== 'tabs' && last && byNoteId(last) && !byNoteId(last).deletedAt) {
          openNote(last);
          if (window.innerWidth <= 900) $('app').dataset.pane = 'list';
        }
        // Reclaim images from notes deleted in earlier sessions. Deliberately
        // only at boot: within a session those deletes are still undoable.
        return DB.collectGarbage();
      })
      .then(function () {
        /* Fold away folders an older import duplicated. Same parent and same
           name is unambiguous -- a folder holds no content of its own, so
           consolidating two of them loses nothing -- which is why this does not
           stop to ask. It goes through act(), so Ctrl+Z still undoes it. */
        return mergeDuplicateFolders({ silent: true });
      })
      .then(function () {
        // a beat after opening, so it never competes with first paint
        setTimeout(function () {
          Exporter.autoBackup().then(function (r) {
            if (r && !r.skipped) {
              console.info('Sulat: daily backup kept', r.counts, Math.round(r.bytes / 1024) + ' KB');
            }
          }).catch(function (e) { console.warn('Sulat: backup skipped —', e.message); });
        }, 3000);
      })
      .catch(function (e) {
        console.error(e);
        toast('Could not open the local database: ' + e.message);
      });

    setInterval(renderStorage, 20000);

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      /* The worker serves the app from a cache, so a tab that is already open
         keeps running the old files until it is reloaded -- which is how a
         build could sit there unnoticed. When a new worker takes over, reload
         once so the new files are actually the ones running.

         hadController distinguishes "a new build replaced the old one" from
         "the very first worker just installed"; only the former is stale. */
      var hadController = !!navigator.serviceWorker.controller;
      var reloading = false;

      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!hadController || reloading) return;
        reloading = true;
        location.reload();
      });

      navigator.serviceWorker.register('sw.js').then(function (reg) {
        reg.update();
        // check again whenever the window comes back to the front, so a build
        // made while it sat in the background is picked up on return
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) reg.update();
        });
      }).catch(function () { /* offline install unavailable */ });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
