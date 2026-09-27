/* Sulat - mindmap canvas.
   Nodes are rounded rects holding wrapped text and, optionally, an image;
   edges are bezier curves that stop at the node borders so the join is
   visible. Pointer events drive pan / zoom / drag so mouse and touch behave
   the same, and the canvas takes keyboard focus so Tab, Enter and Delete work
   like an outliner. */
(function (global) {
  'use strict';

  var PAD_X = 14, PAD_Y = 10;
  var DEF_SIZE = 14;
  var DEF_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  // wrap width and line height both follow the font size
  function wrapWidthFor(size) { return Math.round(size * 13.5); }
  function lineHeightFor(size) { return Math.round(size * 1.35); }
  var IMG_MAX_W = 160, IMG_MAX_H = 120, IMG_GAP = 7;
  var PICS_MAX = 6;          // more than this in one box and none of them read
  var MIN_NODE_FS = 7;      // type stops shrinking here; below it is unreadable

  /* How far a new child sits from its parent. The vertical figure was 72 and
     fixed, which left a lot of air between siblings on anything but a crowded
     map -- and no way to close it. */
  var LAYOUTS = {
    right: 'To the right',
    left: 'To the left',
    both: 'Both sides',
    down: 'Downwards'
  };

  var GAP_X_DEFAULT = 120;
  var GAP_Y_DEFAULT = 52;
  var EDGE_HIT = 9;          // px from a curve that still counts as a click
  var DRAG_SLOP = 4;         // px before a press becomes a drag
  var KISS = 14;             // world px the two boxes must overlap by to join
  var REACH = 95;            // and how far the beam will stretch to find one
  var PULL = 70;             // how much further from its parent before it lets go
  var HAND_PULL = 2.2;       // and how much more of that when you arrange by hand

  /* Node colours. Each entry carries a light and a dark fill so a map looks
     right in both themes, plus a border that reads on either. */
  var PALETTE = {
    plain:  { label: 'Default', light: null,      dark: null,      line: null },
    red:    { label: 'Red',     light: '#f7dad3', dark: '#4b2a24', line: '#c05a3e' },
    orange: { label: 'Orange',  light: '#fae4cd', dark: '#4a3520', line: '#c07f31' },
    yellow: { label: 'Yellow',  light: '#f8efc9', dark: '#453e1e', line: '#b39a2b' },
    green:  { label: 'Green',   light: '#d9ebd6', dark: '#243a27', line: '#4f8a51' },
    blue:   { label: 'Blue',    light: '#d6e4f2', dark: '#22323f', line: '#3f7ba6' },
    purple: { label: 'Purple',  light: '#e3dcf0', dark: '#312a44', line: '#7a63ab' },
    pink:   { label: 'Pink',    light: '#f6dbe6', dark: '#432631', line: '#b25980' }
  };
  var COLOR_KEYS = Object.keys(PALETTE);

  /* Node outlines. Square and circle force equal width and height; ellipse and
     diamond need extra room because the corners of the text box stick out. */
  var SHAPES = {
    round:   { label: 'Rounded',   padX: 1,    padY: 1 },
    rect:    { label: 'Rectangle', padX: 1,    padY: 1 },
    square:  { label: 'Square',    padX: 1,    padY: 1,   equal: true },
    circle:  { label: 'Circle',    padX: 1.3,  padY: 1.3, equal: true },
    ellipse: { label: 'Ellipse',   padX: 1.28, padY: 1.3 },
    diamond: { label: 'Diamond',   padX: 1.5,  padY: 1.5 }
  };
  var SHAPE_KEYS = Object.keys(SHAPES);

  var EDGE_TYPES = {
    elbow: 'Elbow',
    curve:    'Curved',
    straight: 'Straight',
    sketch:   'Hand-drawn',
    dotted:   'Dotted',
    tapered:  'Tapered'
  };
  var EDGE_KEYS = Object.keys(EDGE_TYPES);

  /* One colour per branch off the middle, so you can tell at a glance which
     limb a node belongs to. Deliberately the same hues as the node palette. */
  var BRANCH_COLORS = ['#d98a3d', '#7fa85a', '#5b93c9', '#b06fa8', '#d0705f',
                       '#4fa5a0', '#c9a23d', '#8a7fd0'];
  var DEF_EDGE = { type: 'curve', width: 1.8 };

  /* A node's colour is either a palette key or a plain hex the user picked.
     Hex needs a tint for the fill, and saturation nudging, so a little colour
     maths lives here. */
  function isHex(c) { return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c); }

  function hexToRgb(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  function rgbToHex(r, g, b) {
    function two(v) { return ('0' + Math.round(Math.max(0, Math.min(255, v))).toString(16)).slice(-2); }
    return '#' + two(r) + two(g) + two(b);
  }

  function mixHex(hex, towards, amount) {
    var a = hexToRgb(hex), b = hexToRgb(towards);
    return rgbToHex(a[0] + (b[0] - a[0]) * amount,
                    a[1] + (b[1] - a[1]) * amount,
                    a[2] + (b[2] - a[2]) * amount);
  }

  function hexToHsl(hex) {
    var c = hexToRgb(hex).map(function (v) { return v / 255; });
    var max = Math.max.apply(null, c), min = Math.min.apply(null, c);
    var l = (max + min) / 2, h = 0, sat = 0;
    if (max !== min) {
      var d = max - min;
      sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === c[0]) h = (c[1] - c[2]) / d + (c[1] < c[2] ? 6 : 0);
      else if (max === c[1]) h = (c[2] - c[0]) / d + 2;
      else h = (c[0] - c[1]) / d + 4;
      h /= 6;
    }
    return [h, sat, l];
  }

  function hslToHex(h, sat, l) {
    function hue(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    if (sat === 0) return rgbToHex(l * 255, l * 255, l * 255);
    var q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
    var p = 2 * l - q;
    return rgbToHex(hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255);
  }

  function saturate(hex, delta) {
    var hsl = hexToHsl(hex);
    return hslToHex(hsl[0], Math.max(0, Math.min(1, hsl[1] + delta)), hsl[2]);
  }

  function Mindmap(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts || {};
    this.nodes = [];
    this.edges = [];
    this.cam = { x: 0, y: 0, s: 1 };
    this.selected = null;      // the primary node, for rename / image
    this.selection = [];       // every selected node
    this.selectedEdge = null;
    this.selectMode = false;   // drag on empty space draws a marquee
    this._marquee = null;
    this.style = { type: DEF_EDGE.type, width: DEF_EDGE.width };  // default for all edges
    this.linkMode = false;
    this.linkFrom = null;
    this._cursor = null;       // world point, for the link rubber band
    this._hover = null;        // node under the pointer, for its connectors
    this._linking = null;      // { from } while dragging out of a connector
    this._resizing = null;     // { node, w0, sx }
    this.gapX = GAP_X_DEFAULT;
    this.gapY = GAP_Y_DEFAULT;
    this._clip = null;         // nodes copied, waiting to be pasted
    this._imgCache = {};       // imageId -> HTMLImageElement | 'loading' | null
    this._ratio = {};          // imageId -> width/height, kept once known
    this._pointers = new Map();
    this._drag = null;
    this._pinch = null;
    this._raf = null;
    this.fontStack = DEF_STACK;
    this.fontSize = DEF_SIZE;
    this.lineH = lineHeightFor(DEF_SIZE);
    this.maxW = wrapWidthFor(DEF_SIZE);
    canvas.tabIndex = 0;       // needed for keydown
    this._bind();
  }

  Mindmap.prototype._fontCss = function () {
    return this.fontSize + 'px ' + this.fontStack;
  };

  Mindmap.prototype.setFont = function (stack, size) {
    this.fontStack = stack || DEF_STACK;
    this.fontSize = size || DEF_SIZE;
    this.lineH = lineHeightFor(this.fontSize);
    this.maxW = wrapWidthFor(this.fontSize);
    this._layout();
    this.draw();
  };

  Mindmap.prototype.isDark = function () {
    var t = document.documentElement.dataset.theme;
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  };

  Mindmap.prototype.theme = function () {
    var cs = getComputedStyle(document.documentElement);
    function v(name, fb) { return (cs.getPropertyValue(name) || '').trim() || fb; }
    return {
      node: v('--map-node', '#20222a'),
      accent: v('--accent', '#c8a27a'),
      text: v('--map-text', '#e8e6e1'),
      edge: v('--map-edge', '#4a4d57'),
      grid: v('--map-grid', '#232530'),
      danger: v('--danger', '#e0705f'),
      border: v('--line', '#2c2f38')
    };
  };

  // Resolve a node's fill + border for the current theme.
  Mindmap.prototype.paintOf = function (node, t) {
    if (isHex(node.color)) {
      // tint the chosen colour towards the page so the text stays readable
      var ground = this.isDark() ? '#1b1d23' : '#ffffff';
      return { fill: mixHex(node.color, ground, this.isDark() ? 0.72 : 0.78), line: node.color };
    }
    var p = PALETTE[node.color];
    if (!p || !p.line) return { fill: t.node, line: t.border };
    return { fill: this.isDark() ? p.dark : p.light, line: p.line };
  };

  /* ---------- data ---------- */

  Mindmap.prototype.setData = function (map) {
    this.nodes = (map && map.nodes ? map.nodes : []).map(function (n) {
      return {
        id: n.id, text: n.text || '', x: n.x || 0, y: n.y || 0,
        color: isHex(n.color) ? n.color : (PALETTE[n.color] ? n.color : 'plain'),
        // `image` is the first of them, kept so everything that only knows
        // about one picture -- export, housekeeping, an older build reading
        // the same backup -- still sees something sensible
        pics: (n.pics && n.pics.length ? n.pics.slice()
               : (n.image ? [n.image] : [])).slice(0, PICS_MAX),
        picS: (n.picS || []).slice(0, PICS_MAX),   // a size of its own, per picture
        image: (n.pics && n.pics.length ? n.pics[0] : n.image) || null,
        shape: SHAPES[n.shape] ? n.shape : 'round',
        fs: n.fs || 0,           // per-node font size; 0 = follow the app setting
        w0: n.w0 || 0,           // manual width;  0 = size to content
        h0: n.h0 || 0,           // manual height; 0 = size to content
        collapsed: !!n.collapsed, // its branch is folded away behind a handle
        free: !!n.free,          // put here by hand; auto-arrange leaves it be
        layout: n.layout || null, // this branch grows its own way
        checklist: !!n.checklist, // its children carry boxes to tick
        done: !!n.done,          // and this one has been ticked
        noteId: n.noteId || null // reserved: the note this node stands for
      };
    });
    this.edges = (map && map.edges ? map.edges : []).filter(function (e) {
      return e && e.a && e.b;
    }).map(function (e) {
      var out = { a: e.a, b: e.b };
      if (EDGE_TYPES[e.t]) out.t = e.t;    // per-edge overrides of the map default
      if (e.w) out.w = e.w;
      /* A relationship, not a branch: it says two things are connected
         without either being under the other, and carries its own words. */
      if (e.rel) {
        out.rel = true;
        out.label = e.label || '';
        if (e.k1) out.k1 = { a: +e.k1.a || 0, o: +e.k1.o || 0 };
        if (e.k2) out.k2 = { a: +e.k2.a || 0, o: +e.k2.o || 0 };
      }
      return out;
    });
    var st = (map && map.style) || {};
    this.style = {
      type: EDGE_TYPES[st.type] ? st.type : DEF_EDGE.type,
      width: st.width || DEF_EDGE.width
    };
    /* Auto-arrange: on for anything new, so a map never turns into a heap.
       A map that was built by hand keeps the setting it was saved with. */
    this.auto = st.auto === undefined ? this.nodes.length <= 1 : !!st.auto;
    this.layout = LAYOUTS[st.layout] ? st.layout : 'right';
    this.selected = null;
    this.selection = [];
    this.selectedEdge = null;
    this.selectMode = false;
    this._marquee = null;
    this.linkFrom = null;
    this.branchColors = st.branch === undefined ? this.nodes.length <= 1 : !!st.branch;
    this._branches = null;
    this._hasBranchLayout = null;      // a fresh map, so work it out again
    this._ensureImages();
    this._layout();
    this._prune();
  };

  Mindmap.prototype.getData = function () {
    return {
      nodes: this.nodes.map(function (n) {
        var o = { id: n.id, text: n.text, x: Math.round(n.x), y: Math.round(n.y) };
        if (n.color && n.color !== 'plain') o.color = n.color;
        var pics = n.pics && n.pics.length ? n.pics : (n.image ? [n.image] : []);
        if (pics.length) o.image = pics[0];
        if (pics.length > 1) o.pics = pics.slice();
        if ((n.picS || []).some(function (v) { return v && v !== 1; })) {
          o.picS = n.picS.slice(0, pics.length);
        }
        if (n.shape && n.shape !== 'round') o.shape = n.shape;
        if (n.fs) o.fs = Math.round(n.fs);
        if (n.w0) o.w0 = Math.round(n.w0);
        if (n.h0) o.h0 = Math.round(n.h0);
        if (n.collapsed) o.collapsed = true;
        if (n.free) o.free = true;
        if (n.layout && LAYOUTS[n.layout]) o.layout = n.layout;
        if (n.checklist) o.checklist = true;
        if (n.done) o.done = true;
        if (n.noteId) o.noteId = n.noteId;
        return o;
      }),
      edges: this.edges.map(function (e) {
        var o = { a: e.a, b: e.b };
        if (e.t) o.t = e.t;
        if (e.w) o.w = e.w;
        if (e.rel) {
          o.rel = true;
          if (e.label) o.label = e.label;
          if (e.k1) o.k1 = e.k1;
          if (e.k2) o.k2 = e.k2;
        }
        return o;
      }),
      style: {
        type: this.style.type,
        width: this.style.width,
        auto: this.auto || undefined,
        branch: this.branchColors ? true : undefined,
        layout: this.layout === 'right' ? undefined : this.layout
      }
    };
  };

  /* The node a reader would call the centre: the root of the biggest tree, or
     failing that whichever node has the most links. Used to title an untitled
     mindmap and to name its exports. */
  Mindmap.centralNode = function (map) {
    var nodes = (map && map.nodes) || [];
    if (!nodes.length) return null;
    var edges = (map && map.edges) || [];
    var hasParent = {}, degree = {};
    nodes.forEach(function (n) { degree[n.id] = 0; });
    edges.forEach(function (e) {
      hasParent[e.b] = true;
      degree[e.a] = (degree[e.a] || 0) + 1;
      degree[e.b] = (degree[e.b] || 0) + 1;
    });
    var roots = nodes.filter(function (n) { return !hasParent[n.id]; });
    var pool = roots.length ? roots : nodes;
    return pool.reduce(function (best, n) {
      return (degree[n.id] || 0) > (degree[best.id] || 0) ? n : best;
    }, pool[0]);
  };

  Mindmap.prototype.centralNode = function () {
    return Mindmap.centralNode(this.getData());
  };

  // Every image id referenced by the map, so the note can track them.
  Mindmap.prototype.imageIds = function () {
    var out = [];
    this.nodes.forEach(function (n) {
      picsOf(n).forEach(function (id) {
        if (id && out.indexOf(id) === -1) out.push(id);
      });
    });
    return out;
  };

  // every picture in a node, whichever way it was stored
  function picsOf(n) {
    if (!n) return [];
    if (n.pics && n.pics.length) return n.pics;
    return n.image ? [n.image] : [];
  }

  // Drop edges whose endpoints no longer exist, and any exact duplicates.
  Mindmap.prototype._prune = function () {
    var self = this, seen = {};
    this.edges = this.edges.filter(function (e) {
      if (!self.byId(e.a) || !self.byId(e.b) || e.a === e.b) return false;
      var key = e.a < e.b ? e.a + '|' + e.b : e.b + '|' + e.a;
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });

    /* One parent, always. A branch line arriving at a node that already has a
       parent is not a second place in the order -- there is no such thing --
       so it becomes a relationship, which is what a link between two children
       means. Maps built before the rule existed are tidied up here. */
    var taken = {};
    this.edges.forEach(function (e) {
      if (e.rel) return;
      if (taken[e.b]) {
        e.rel = true;
        if (e.label === undefined) e.label = '';
      } else taken[e.b] = true;
    });
  };

  Mindmap.prototype._changed = function () {
    this._branches = null;
    this._hasBranchLayout = null;      // work it out again when next asked
    this._prune();
    if (this.auto) this.arrange();
    if (this.opts.onChange) this.opts.onChange();
    this.draw();
  };

  /* ---------- images ---------- */

  Mindmap.prototype._ensureImages = function () {
    var self = this;
    if (!this.opts.resolveImage) return;
    this.nodes.forEach(function (n) {
      picsOf(n).forEach(function (pid) {
        if (!pid || self._imgCache[pid] !== undefined) return;
        self._imgCache[pid] = 'loading';
        self.opts.resolveImage(pid).then(function (url) {
          if (!url) { self._imgCache[pid] = null; return; }
          var im = new Image();
          im.onload = function () {
            self._imgCache[pid] = im;
            /* Keep the real ratio against the picture. Until one has loaded
               its naturalWidth is 0, and the placeholder used to guess 3:2 --
               so a portrait photo drew stretched, then snapped when it
               arrived. */
            if (im.naturalWidth && im.naturalHeight) {
              self._ratio[pid] = im.naturalWidth / im.naturalHeight;
            }
            self._layout();
            self.draw();
          };
          im.onerror = function () { self._imgCache[pid] = null; };
          im.src = url;
        }, function () { self._imgCache[pid] = null; });
      });
    });
  };

  Mindmap.prototype.attachImage = function (imageId, node) {
    var target = node || this.selected;
    if (!target) {
      target = this.addNodeQuiet('', undefined, undefined);
    }
    var pics = picsOf(target).slice();
    if (pics.indexOf(imageId) === -1 && pics.length < PICS_MAX) pics.push(imageId);
    target.pics = pics;
    target.image = pics[0] || null;
    delete this._imgCache[imageId];
    this._ensureImages();
    this._layout();
    this.select(target);
    this._changed();
    return target;
  };

  /* Takes the last picture out, so pressing it again and again empties the
     node one picture at a time rather than all at once by surprise. */
  Mindmap.prototype.detachImage = function () {
    var n = this.selected;
    if (!n) return false;
    var pics = picsOf(n).slice();
    if (!pics.length) return false;
    pics.pop();
    n.pics = pics;
    n.image = pics[0] || null;
    if (!pics.length && !n.text) n.text = 'Idea';
    this._layout();
    this._changed();
    return pics.length;
  };

  Mindmap.prototype.picCount = function (node) { return picsOf(node).length; };

  /* Put a different picture in the place of the chosen one, keeping whatever
     size it had been given and where it sits in the row. */
  Mindmap.prototype.replacePic = function (imageId) {
    var sel = this.selectedPic;
    if (!sel || !imageId) return false;
    var n = this.byId(sel.nodeId);
    if (!n) return false;
    var pics = picsOf(n).slice();
    if (sel.i >= pics.length) return false;
    pics[sel.i] = imageId;
    n.pics = pics;
    n.image = pics[0] || null;
    delete this._imgCache[imageId];
    this._ensureImages();
    this._layout();
    this._changed();
    return true;
  };

  /* ---------- text measuring / layout ---------- */

  Mindmap.prototype._wrap = function (text) {
    var ctx = this.ctx;
    ctx.font = this._fontCss();
    var words = String(text || '').split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    var lines = [], line = '';
    for (var i = 0; i < words.length; i++) {
      var probe = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(probe).width > this.maxW && line) {
        lines.push(line);
        line = words[i];
      } else {
        line = probe;
      }
    }
    lines.push(line);
    return lines;
  };

  // Wraps at whatever font the caller has already set on the context -- layout
  // sets each node's own size first, so this must not overwrite it.
  /* Wrapping on spaces alone is not enough: a single unbroken run -- a URL, a
     long identifier, a row of the same letter -- has no space to break at, so
     it stayed one line and ran straight out of both sides of the node. Anything
     wider than the box is now cut mid-word, the way a browser's
     `overflow-wrap: anywhere` would. */
  Mindmap.prototype._breakWord = function (word, width) {
    var ctx = this.ctx, out = [], part = '';
    for (var i = 0; i < word.length; i++) {
      var probe = part + word[i];
      if (part && ctx.measureText(probe).width > width) {
        out.push(part);
        part = word[i];
      } else {
        part = probe;
      }
    }
    if (part) out.push(part);
    return out;
  };

  Mindmap.prototype._wrapTo = function (text, width) {
    var ctx = this.ctx;
    var words = String(text || '').split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    var lines = [], line = '';
    for (var i = 0; i < words.length; i++) {
      var word = words[i];

      // too long to fit on a line of its own, whatever we do with spaces
      if (ctx.measureText(word).width > width) {
        if (line) { lines.push(line); line = ''; }
        var pieces = this._breakWord(word, width);
        for (var k = 0; k < pieces.length - 1; k++) lines.push(pieces[k]);
        line = pieces[pieces.length - 1] || '';
        continue;
      }

      var probe = line ? line + ' ' + word : word;
      if (ctx.measureText(probe).width > width && line) { lines.push(line); line = word; }
      else { line = probe; }
    }
    if (line) lines.push(line);
    return lines;
  };

  /* How far each node sits from the top of its branch. Used to draw a
     parent a little larger than its children, the way a heading is larger
     than the text under it. */
  Mindmap.prototype._depthMap = function () {
    var byId = {}, kids = {}, hasParent = {};
    this.nodes.forEach(function (n) { byId[n.id] = n; });
    this.branchEdges().forEach(function (e) {
      if (!byId[e.a] || !byId[e.b]) return;
      (kids[e.a] = kids[e.a] || []).push(e.b);
      hasParent[e.b] = true;
    });
    var depth = {}, queue = [];
    this.nodes.forEach(function (n) {
      if (!hasParent[n.id]) { depth[n.id] = 0; queue.push(n.id); }
    });
    if (!queue.length && this.nodes.length) {
      depth[this.nodes[0].id] = 0;
      queue.push(this.nodes[0].id);
    }
    var guard = 0;
    while (queue.length && guard++ < 6000) {
      var id = queue.shift();
      (kids[id] || []).forEach(function (c) {
        if (depth[c] === undefined) { depth[c] = depth[id] + 1; queue.push(c); }
      });
    }
    return depth;
  };

  /* Everything folded away: the children of a collapsed node, and theirs,
     all the way down. Worked out once per layout and read everywhere else --
     drawing, hit testing, arranging and fitting all have to agree about what
     is on screen. */
  Mindmap.prototype._hiddenMap = function () {
    var kids = {}, byId = {};
    this.nodes.forEach(function (n) { byId[n.id] = n; });
    this.branchEdges().forEach(function (e) {
      if (byId[e.a] && byId[e.b]) (kids[e.a] = kids[e.a] || []).push(e.b);
    });
    var hidden = {}, seen = {};
    var walk = function (id, under) {
      if (seen[id]) return;
      seen[id] = true;
      if (under) hidden[id] = true;
      var fold = under || !!(byId[id] && byId[id].collapsed);
      (kids[id] || []).forEach(function (c) { walk(c, fold); });
    };
    var hasParent = {};
    this.branchEdges().forEach(function (e) { if (byId[e.b]) hasParent[e.b] = true; });
    this.nodes.forEach(function (n) { if (!hasParent[n.id]) walk(n.id, false); });
    this.nodes.forEach(function (n) { if (!seen[n.id]) walk(n.id, false); });
    return hidden;
  };

  // how many nodes are folded away under this one
  Mindmap.prototype.hiddenUnder = function (node) {
    return node ? this.descendantsOf(node).length : 0;
  };

  /* Does this node carry a box? Only if the node above it was made a
     checklist -- the parent decides for its own children, nobody else. */
  Mindmap.prototype.isTickable = function (node) {
    if (!node) return false;
    // the node heading a list belongs to it: a list of jobs where the job
    // itself cannot be marked done is half a list
    if (node.checklist) return true;
    var par = this.parentOf(node);
    return !!(par && par.checklist);
  };

  Mindmap.prototype.toggleChecklist = function (node) {
    if (!node) return false;
    if (!this.descendantsOf(node).length) return false;
    node.checklist = !node.checklist;
    if (!node.checklist) {
      // no longer a list, so nothing under it stays ticked
      var self = this;
      this.branchEdges().forEach(function (e) {
        if (e.a !== node.id) return;
        var kid = self.byId(e.b);
        if (kid) delete kid.done;
      });
    }
    this._layout();
    this._changed();
    return true;
  };

  /* The node and everything below it, all at once. Ticking off half a
     branch is never what you meant by "make this a list". */
  Mindmap.prototype.toggleChecklistBranch = function (node) {
    if (!node) return 0;
    var all = [node].concat(this.descendantsOf(node));
    var parents = all.filter(function (n) {
      return this.branchEdges().some(function (e) { return e.a === n.id; });
    }, this);
    if (!parents.length) return 0;
    var turningOn = !node.checklist;
    parents.forEach(function (p) { p.checklist = turningOn; });
    if (!turningOn) all.forEach(function (n) { delete n.done; delete n.checklist; });
    this._layout();
    this._changed();
    return all.length;
  };

  Mindmap.prototype.toggleDone = function (node) {
    if (!this.isTickable(node)) return false;
    node.done = !node.done;
    // a branch done is done all the way down; nothing under it is still open
    var on = node.done, self = this;
    this.descendantsOf(node).forEach(function (k) {
      if (self.isTickable(k)) k.done = on;
    });
    /* And going the other way: a parent is done once all of its children are,
       and stops being done the moment one is unticked again. */
    var up = this.parentOf(node);
    var guard = 0;
    while (up && this.isTickable(up) && guard++ < 64) {
      var kids = [];
      this.branchEdges().forEach(function (e) {
        if (e.a !== up.id) return;
        var k = self.byId(e.b);
        if (k) kids.push(k);
      });
      var all = kids.length && kids.every(function (k) { return k.done; });
      if (!!up.done === !!all) break;
      up.done = all;
      up = this.parentOf(up);
    }
    this._changed();
    return true;
  };

  // where the tick box sits: inside the node, against its leading edge
  Mindmap.prototype.tickBox = function (n) {
    if (!this.isTickable(n)) return null;
    var s = Math.min(TICK, n.h * 0.68);
    return { x: n.x - n.w / 2 + s * 0.62, y: n.y, s: s };
  };

  Mindmap.prototype.hitTick = function (px, py) {
    var p = this.toWorld(px, py);
    for (var i = this.nodes.length - 1; i >= 0; i--) {
      var n = this.nodes[i];
      if (this._hidden && this._hidden[n.id]) continue;
      var b = this.tickBox(n);
      if (!b) continue;
      var r = b.s * 0.9;
      if (Math.abs(p.x - b.x) <= r && Math.abs(p.y - b.y) <= r) return n;
    }
    return null;
  };

  // the circle that makes a node's children into a list, opposite the fold one
  Mindmap.prototype.checkPoint = function (n) {
    if (!n || !this.descendantsOf(n).length) return null;
    var f = this.foldPoint(n);
    if (!f) return null;
    if (Math.abs(f.y - n.y) > Math.abs(f.x - n.x)) {
      return { x: n.x, y: n.y - (f.y - n.y) };        // mirrored vertically
    }
    return { x: n.x - (f.x - n.x), y: n.y };          // mirrored across
  };

  Mindmap.prototype.hitCheckToggle = function (px, py) {
    var p = this.toWorld(px, py);
    var r = Math.max(7, FOLD_R / this.cam.s);
    for (var i = this.nodes.length - 1; i >= 0; i--) {
      var n = this.nodes[i];
      if (this._hidden && this._hidden[n.id]) continue;
      if (!this.isSelected(n)) continue;              // only on the node you are on
      var pt = this.checkPoint(n);
      if (!pt) continue;
      if (Math.hypot(p.x - pt.x, p.y - pt.y) <= r * 1.35) return n;
    }
    return null;
  };

  Mindmap.prototype.toggleCollapse = function (node) {
    if (!node) return false;
    if (!this.descendantsOf(node).length) return false;
    node.collapsed = !node.collapsed;
    if (node.collapsed) {
      // nothing folded away may stay selected, or the tools would act on
      // something you cannot see
      var gone = this.descendantsOf(node);
      this.selection = this.selection.filter(function (s) { return gone.indexOf(s) === -1; });
      this.selected = this.selection[this.selection.length - 1] || null;
      if (this.opts.onSelect) this.opts.onSelect(this.selected);
    }
    this._layout();
    this._changed();
    return true;
  };

  Mindmap.prototype._layout = function () {
    var ctx = this.ctx;
    var depth = this._depthMap();
    this._hidden = this._hiddenMap();
    for (var i = 0; i < this.nodes.length; i++) {
      var n = this.nodes[i];
      var shape = SHAPES[n.shape] || SHAPES.round;

      /* A node can carry its own size; otherwise how far down the branch it
         sits decides. The middle of a map is the title of the thing, the ones
         off it are its headings, and the rest is the text -- so they are
         graded like a page, in the type and in the room around it. */
      var d = depth[n.id];
      var grade = d === 0 ? 1.55 : d === 1 ? 1.14 : 0.95;
      var roomy = d === 0 ? 1.5 : d === 1 ? 1.15 : 1;
      var padX = PAD_X * roomy, padY = PAD_Y * roomy;
      n._fs = n.fs || Math.max(10, Math.round(this.fontSize * grade));
      n._lh = lineHeightFor(n._fs);
      ctx.font = n._fs + 'px ' + this.fontStack;

      // a manually resized node wraps to the width you gave it
      var inner = n.w0 ? Math.max(40, n.w0 / shape.padX - padX * 2) : 0;
      n.lines = inner ? this._wrapTo(n.text, inner)
                      : this._wrapTo(n.text, wrapWidthFor(n._fs));

      /* The pictures in this node, laid out to suit the room they have. How
         many go across follows the shape of the space, so making the node
         wider spreads them out and making it taller stacks them, without
         anyone having to say so. Each keeps its own proportions, and can be
         given a size of its own on top of that. */
      var pics = picsOf(n);
      var scales = n.picS || [];
      n._pics = [];
      n.imgW = 0; n.imgH = 0;
      if (pics.length) {
        var room = 0;
        if (n.h0) {
          room = n.h0 / shape.padY - padY * 2 -
                 (n.lines.length ? n.lines.length * n._lh + IMG_GAP : 0);
        }
        var cols, band, cell;
        if (!inner) {
          /* No size given yet, so the block sets its own: roughly square,
             three across at the most, each picture about a thumbnail. */
          cols = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(pics.length))));
          cell = pics.length === 1 ? IMG_MAX_W : 100;
          band = cell * cols + IMG_GAP * (cols - 1);
        } else {
          band = inner;
          if (pics.length === 1) {
            cols = 1;
          } else if (room > 20) {
            // both sizes known: the arrangement that best fills the box
            cols = Math.round(Math.sqrt(pics.length * band / room));
            cols = Math.max(1, Math.min(pics.length, cols));
          } else {
            cols = Math.max(1, Math.min(pics.length, Math.round(band / 150)));
          }
          cell = (band - IMG_GAP * (cols - 1)) / cols;
        }
        /* Laid along the row and wrapped when the next will not fit, rather
           than dropped into fixed slots. A picture given a size of its own
           then pushes the ones after it along instead of covering them. */
        var x = 0, rowTop = 0, rowH = 0, widest = 0;
        for (var pi = 0; pi < pics.length; pi++) {
          var pid = pics[pi];
          var pim = this._imgCache[pid];
          var pr = (pim && pim !== 'loading' && pim.naturalWidth)
            ? pim.naturalWidth / pim.naturalHeight
            : (this._ratio[pid] || 1);
          var own = scales[pi] || 1;
          var cw = cell * own, ch = cw / pr;
          // one picture in a box still sized to its own text stays modest
          if (pics.length === 1 && !inner) {
            if (pim && pim !== 'loading' && pim.naturalWidth) {
              var fit = Math.min(IMG_MAX_W / pim.naturalWidth,
                                 IMG_MAX_H / pim.naturalHeight, 1);
              cw = pim.naturalWidth * fit * own;
              ch = pim.naturalHeight * fit * own;
            } else {
              cw = 90 * own; ch = cw / pr;
            }
          }
          // never wider than the room there is, or it would spill out of the box
          if (cw > band) { ch = ch * (band / cw); cw = band; }
          if (x > 0 && x + cw > band + 0.5) {
            x = 0;
            rowTop += rowH + IMG_GAP;
            rowH = 0;
          }
          n._pics.push({ id: pid, i: pi, dx: Math.round(x), dy: Math.round(rowTop),
                         w: Math.round(cw), h: Math.round(ch) });
          x += cw + IMG_GAP;
          rowH = Math.max(rowH, ch);
          widest = Math.max(widest, x - IMG_GAP);
        }
        n.imgW = Math.round(widest);
        n.imgH = Math.round(rowTop + rowH);

        // taller than the room it was given: bring the whole block down to fit
        if (room > 12 && n.imgH > room) {
          var k = room / n.imgH;
          n._pics.forEach(function (q) {
            q.dx = Math.round(q.dx * k); q.dy = Math.round(q.dy * k);
            q.w = Math.round(q.w * k); q.h = Math.round(q.h * k);
          });
          n.imgW = Math.round(n.imgW * k);
          n.imgH = Math.round(room);
        }
      }

      var textW = 0;
      for (var j = 0; j < n.lines.length; j++) {
        textW = Math.max(textW, ctx.measureText(n.lines[j]).width);
      }
      // a node in a list carries a box, which needs its own room on the left
      var tickRoom = this.isTickable(n) ? Math.min(TICK, 22) + 6 : 0;
      var contentW = Math.max(70 * roomy, Math.min(wrapWidthFor(n._fs), textW), n.imgW) +
                     padX * 2 + tickRoom;
      var contentH = padY * 2 + n.lines.length * n._lh +
                     (n.imgH ? n.imgH + (n.lines.length ? IMG_GAP : 0) : 0);

      // round shapes need slack, or the text pokes out of the outline
      n.w = n.w0 || Math.round(contentW * shape.padX);
      n.h = n.h0 || Math.round(contentH * shape.padY);

      /* Text has to fit the box too. When a node has been given a size by hand,
         re-wrap and, if the lines still stand taller than the space inside,
         step the type down until they fit. Scaling the box scales what is in
         it, which is what dragging a corner is understood to mean. */
      if (n.h0 && n.lines.length) {
        var innerH = n.h0 / shape.padY - padY * 2 - (n.imgH ? n.imgH + IMG_GAP : 0);
        var innerW = inner || wrapWidthFor(n._fs);
        var guard = 0;
        while (guard++ < 24 && n._fs > MIN_NODE_FS &&
               n.lines.length * n._lh > innerH) {
          n._fs = Math.max(MIN_NODE_FS, n._fs - 1);
          n._lh = lineHeightFor(n._fs);
          ctx.font = n._fs + 'px ' + this.fontStack;
          n.lines = this._wrapTo(n.text, innerW);
        }
      }

      /* A node dragged smaller than its contents used to let the picture spill
         over the outline. Fit the image inside what the node actually is, on
         both axes at once so the proportions are never touched. */
      if (n.imgH) {
        var availW = n.w / shape.padX - PAD_X * 2;
        var availH = n.h / shape.padY - PAD_Y * 2 -
                     n.lines.length * n._lh - (n.lines.length ? IMG_GAP : 0);
        var fit = Math.min(1, availW / n.imgW, availH / n.imgH);
        if (fit > 0 && fit < 1) {
          n.imgW = Math.max(8, Math.round(n.imgW * fit));
          n.imgH = Math.max(8, Math.round(n.imgH * fit));
        }
      }

      if (shape.equal) {
        var side = Math.max(n.w, n.h);
        if (!n.w0) n.w = side;
        if (!n.h0) n.h = side;
      }
    }
  };

  Mindmap.prototype.byId = function (id) {
    for (var i = 0; i < this.nodes.length; i++) {
      if (this.nodes[i].id === id) return this.nodes[i];
    }
    return null;
  };

  /* ---------- geometry ---------- */

  Mindmap.prototype.toWorld = function (px, py) {
    return { x: (px - this.cam.x) / this.cam.s, y: (py - this.cam.y) / this.cam.s };
  };

  /* `skip` leaves nodes out of the search -- used while dragging, where the
     node in your hand sits under the pointer and would always win. */
  Mindmap.prototype.hit = function (px, py, skip) {
    var p = this.toWorld(px, py);
    for (var i = this.nodes.length - 1; i >= 0; i--) {
      var n = this.nodes[i];
      if (skip && skip.indexOf(n) !== -1) continue;
      if (this._hidden && this._hidden[n.id]) continue;
      if (p.x >= n.x - n.w / 2 && p.x <= n.x + n.w / 2 &&
          p.y >= n.y - n.h / 2 && p.y <= n.y + n.h / 2) return n;
    }
    return null;
  };

  // Where the curve between two nodes should start/end: the point on the
  // border facing the other node, so links visibly touch the boxes.
  function borderPoint(from, to) {
    var dx = to.x - from.x, dy = to.y - from.y;
    if (!dx && !dy) return { x: from.x, y: from.y };
    var hw = from.w / 2, hh = from.h / 2;
    var shape = from.shape || 'round';
    var t;

    if (shape === 'circle' || shape === 'ellipse') {
      t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
    } else if (shape === 'diamond') {
      t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
    } else {
      var sx = dx === 0 ? Infinity : hw / Math.abs(dx);
      var sy = dy === 0 ? Infinity : hh / Math.abs(dy);
      t = Math.min(sx, sy);
    }
    return { x: from.x + dx * t, y: from.y + dy * t };
  }

  Mindmap.prototype.edgeEnds = function (e) {
    var a = this.byId(e.a), b = this.byId(e.b);
    if (!a || !b) return null;
    if (e.rel) {
      /* Bowed well clear of the boxes, so a relationship never reads as one
         more branch: it is a remark about two things, not a place in the
         order of them. */
      var ra = borderPoint(a, b), rb = borderPoint(b, a);
      var dx = rb.x - ra.x, dy = rb.y - ra.y;
      var len = Math.hypot(dx, dy) || 1;
      var ux = dx / len, uy = dy / len;          // along the line between them
      var px = -uy, py = ux;                     // and square across it
      /* Both control points live in that frame: how far along, and how far
         out, as fractions of the distance between the two nodes. Kept this
         way, a curve you have shaped by hand keeps its shape when either node
         moves, instead of springing back or shearing. An untouched one falls
         back to the arc it has always had. */
      var lift = Math.min(90, Math.max(34, len * 0.3)) / len;
      var k1 = e.k1 || { a: 0.25, o: lift };
      var k2 = e.k2 || { a: 0.75, o: lift };
      return {
        a: ra, b: rb, rel: true,
        c1: { x: ra.x + (ux * k1.a + px * k1.o) * len,
              y: ra.y + (uy * k1.a + py * k1.o) * len },
        c2: { x: ra.x + (ux * k2.a + px * k2.o) * len,
              y: ra.y + (uy * k2.a + py * k2.o) * len },
        frame: { ox: ra.x, oy: ra.y, ux: ux, uy: uy, px: px, py: py, len: len }
      };
    }
    /* In a tidy map every child sits to the right of its parent, so the line
       leaves the parent's side and arrives at the child's, like a chart --
       rather than pointing at the middle of each box. */
    var grows = this.layoutOf(a);          // the way THIS branch runs
    if (this.auto && b.y > a.y + a.h / 2 && grows === 'down') {
      var pd1 = { x: a.x, y: a.y + a.h / 2 };
      var pd2 = { x: b.x, y: b.y - b.h / 2 };
      var drop = Math.max(14, (pd2.y - pd1.y) * 0.55);
      return {
        a: pd1, b: pd2, down: true,
        c1: { x: pd1.x, y: pd1.y + drop },
        c2: { x: pd2.x, y: pd2.y - drop }
      };
    }
    if (this.auto && grows !== 'down' && Math.abs(b.x - a.x) > (a.w + b.w) / 4) {
      var side = b.x > a.x ? 1 : -1;
      var pa2 = { x: a.x + side * a.w / 2, y: a.y };
      var pb2 = { x: b.x - side * b.w / 2, y: b.y };
      var reach = Math.max(18, Math.abs(pb2.x - pa2.x) * 0.55);
      return {
        a: pa2, b: pb2,
        c1: { x: pa2.x + side * reach, y: pa2.y },
        c2: { x: pb2.x - side * reach, y: pb2.y }
      };
    }
    var pa = borderPoint(a, b), pb = borderPoint(b, a);
    var mx = (pa.x + pb.x) / 2;
    return { a: pa, b: pb, c1: { x: mx, y: pa.y }, c2: { x: mx, y: pb.y } };
  };

  // do these two line segments cross?
  function segCross(a1, a2, b1, b2) {
    var d = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
    if (!d) return false;
    var u = ((b1.x - a1.x) * (b2.y - b1.y) - (b1.y - a1.y) * (b2.x - b1.x)) / d;
    var v = ((b1.x - a1.x) * (a2.y - a1.y) - (b1.y - a1.y) * (a2.x - a1.x)) / d;
    return u >= 0 && u <= 1 && v >= 0 && v <= 1;
  }

  function bezierAt(t, p0, p1, p2, p3) {
    var u = 1 - t;
    return {
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y
    };
  }

  /* Every link the given stroke passes through. The curve is sampled, which
     is close enough for a gesture and far simpler than solving where a line
     meets a bezier. */
  Mindmap.prototype.edgesCrossedBy = function (from, to) {
    var out = [], hid = this._hidden || {};
    for (var i = 0; i < this.edges.length; i++) {
      var e = this.edges[i];
      if (hid[e.a] || hid[e.b]) continue;
      var ends = this.edgeEnds(e);
      if (!ends) continue;
      var prev = ends.a;
      for (var k = 1; k <= 12; k++) {
        var pt = bezierAt(k / 12, ends.a, ends.c1, ends.c2, ends.b);
        if (segCross(from, to, prev, pt)) { out.push(e); break; }
        prev = pt;
      }
    }
    return out;
  };

  Mindmap.prototype.hitEdge = function (px, py) {
    var p = this.toWorld(px, py);
    var tol = EDGE_HIT / this.cam.s;
    for (var i = this.edges.length - 1; i >= 0; i--) {
      var ends = this.edgeEnds(this.edges[i]);
      if (!ends) continue;
      for (var s = 0; s <= 20; s++) {
        var q = bezierAt(s / 20, ends.a, ends.c1, ends.c2, ends.b);
        if (Math.hypot(q.x - p.x, q.y - p.y) <= tol) return this.edges[i];
      }
    }
    return null;
  };

  var KNOB_R = 7;        // the dot you drag to bend a relationship
  var HANDLE_R = 6;      // world-space radius of a connector dot
  var GRIP = 9;          // resize grip square
  var FOLD_R = 9;        // the circle that folds a branch away
  var PIC_GRIP_R = 7;    // the corner you drag to resize a picture
  var TICK = 19;         // the box on a child of a checklist

  /* The two points that shape a relationship's curve, in world space. Only
     the selected one shows them: every relationship wearing handles would be
     a map full of dots. */
  Mindmap.prototype.edgeKnobs = function (e) {
    if (!e || !e.rel) return null;
    var ends = this.edgeEnds(e);
    if (!ends || !ends.frame) return null;
    return [{ i: 1, x: ends.c1.x, y: ends.c1.y },
            { i: 2, x: ends.c2.x, y: ends.c2.y }];
  };

  Mindmap.prototype.hitEdgeKnob = function (px, py) {
    var ks = this.edgeKnobs(this.selectedEdge);
    if (!ks) return null;
    var p = this.toWorld(px, py);
    var r = Math.max(9, KNOB_R * 1.6 / this.cam.s);
    for (var i = 0; i < ks.length; i++) {
      if (Math.hypot(p.x - ks[i].x, p.y - ks[i].y) <= r) {
        return { edge: this.selectedEdge, i: ks[i].i };
      }
    }
    return null;
  };

  // Put one control point where the hand is, written down in the chord's frame.
  Mindmap.prototype.moveEdgeKnob = function (e, i, px, py) {
    if (!e || !e.rel) return false;
    var ends = this.edgeEnds(e);
    if (!ends || !ends.frame) return false;
    var f = ends.frame, p = this.toWorld(px, py);
    function frameOf(q) {
      var rx = q.x - f.ox, ry = q.y - f.oy;
      return {
        a: Math.round(((rx * f.ux + ry * f.uy) / f.len) * 10000) / 10000,
        o: Math.round(((rx * f.px + ry * f.py) / f.len) * 10000) / 10000
      };
    }
    /* Touch one and both are written down. Leaving the other on the automatic
       arc means it drifts the next time a node moves, so the shape you let go
       of is not the shape you come back to. */
    if (!e.k1) e.k1 = frameOf(ends.c1);
    if (!e.k2) e.k2 = frameOf(ends.c2);
    if (i === 1) e.k1 = frameOf(p); else e.k2 = frameOf(p);
    this.draw();
    return true;
  };

  // back to the arc it was born with
  Mindmap.prototype.resetEdgeCurve = function (e) {
    if (!e || !e.rel || (!e.k1 && !e.k2)) return false;
    delete e.k1;
    delete e.k2;
    this._changed();
    return true;
  };

  /* The words on a relationship, as a thing you can point at. Their box is
     worked out while drawing and remembered on the edge. */
  Mindmap.prototype.hitEdgeLabel = function (px, py) {
    var p = this.toWorld(px, py);
    for (var i = this.edges.length - 1; i >= 0; i--) {
      var e = this.edges[i], box = e._label;
      if (!e.rel || !box) continue;
      if (Math.abs(p.x - box.x) <= box.w / 2 &&
          Math.abs(p.y - box.y) <= box.h / 2) return e;
    }
    return null;
  };

  // where the words sit on screen, for putting a text box over them
  Mindmap.prototype.edgeLabelBox = function (e) {
    if (!e || !e.rel || !e._label) return null;
    var b = e._label, s = this.cam.s;
    return {
      left: b.x * s + this.cam.x - (b.w * s) / 2,
      top: b.y * s + this.cam.y - (b.h * s) / 2,
      w: b.w * s, h: b.h * s
    };
  };

  // Connector dots sit at the middle of each side.
  Mindmap.prototype.handlePoints = function (n) {
    return [
      { side: 'l', x: n.x - n.w / 2, y: n.y },
      { side: 'r', x: n.x + n.w / 2, y: n.y },
      { side: 't', x: n.x, y: n.y - n.h / 2 },
      { side: 'b', x: n.x, y: n.y + n.h / 2 }
    ];
  };

  // Which node currently shows its handles: the hovered one, else the selected.
  Mindmap.prototype.handleNode = function () {
    if (this.selection.length > 1) return null;   // ambiguous with many selected
    return this._hover || this.selected || null;
  };

  // Hit tests for the handles work in screen pixels. In world units the
  // tolerance grows as you zoom out, and a short node's corner grip starts
  // swallowing its side connector.
  Mindmap.prototype._toScreen = function (wx, wy) {
    return { x: wx * this.cam.s + this.cam.x, y: wy * this.cam.s + this.cam.y };
  };

  Mindmap.prototype.hitHandle = function (px, py) {
    var n = this.handleNode();
    if (!n) return null;
    var pts = this.handlePoints(n);
    for (var i = 0; i < pts.length; i++) {
      var sp = this._toScreen(pts[i].x, pts[i].y);
      if (Math.hypot(sp.x - px, sp.y - py) <= 11) return { node: n, side: pts[i].side };
    }
    return null;
  };

  /* Where the fold handle sits: on the edge of the node facing its
     children, so it reads as the branch's own button rather than the node's. */
  Mindmap.prototype.foldPoint = function (n) {
    if (!n || !this.descendantsOf(n).length) return null;
    var kids = [], self = this;
    this.branchEdges().forEach(function (e) {
      if (e.a === n.id) { var k = self.byId(e.b); if (k) kids.push(k); }
    });
    if (!kids.length) return null;
    var cx = 0, cy = 0;
    kids.forEach(function (k) { cx += k.x; cy += k.y; });
    cx /= kids.length; cy /= kids.length;
    var grow = this.layoutOf(n);
    if (grow === 'down' && this.auto) {
      return { x: n.x, y: n.y + n.h / 2 };
    }
    var side = cx >= n.x ? 1 : -1;
    // a collapsed node's children sit on top of it, so fall back to the way
    // the branch grows rather than to wherever they happen to be
    if (n.collapsed) side = grow === 'left' ? -1 : 1;
    return { x: n.x + side * n.w / 2, y: n.y };
  };

  Mindmap.prototype.hitFold = function (px, py) {
    var p = this.toWorld(px, py);
    var r = Math.max(7, FOLD_R / this.cam.s);
    for (var i = this.nodes.length - 1; i >= 0; i--) {
      var n = this.nodes[i];
      if (this._hidden && this._hidden[n.id]) continue;
      var pt = this.foldPoint(n);
      if (!pt) continue;
      if (Math.hypot(p.x - pt.x, p.y - pt.y) <= r * 1.35) return n;
    }
    return null;
  };

  /* The picture under this point, if the node it belongs to is the one
     selected. Only then, so that tapping a node with pictures in it still
     picks up the node -- you choose a picture from a node you are already
     working on. */
  Mindmap.prototype.hitPic = function (px, py) {
    var n = this.selected;
    if (!n || !n._pics || !n._pics.length) return null;
    if (this._hidden && this._hidden[n.id]) return null;
    var p = this.toWorld(px, py);
    var block = this._picBlock(n);
    for (var i = 0; i < n._pics.length; i++) {
      var q = n._pics[i];
      var x = block.x + q.dx, y = block.y + q.dy;
      if (p.x >= x && p.x <= x + q.w && p.y >= y && p.y <= y + q.h) {
        return { node: n, i: q.i };
      }
    }
    return null;
  };

  // where the block of pictures starts inside a node, in world coordinates
  Mindmap.prototype._picBlock = function (n) {
    var blockH = n.lines.length * n._lh + (n.imgH ? n.imgH + (n.lines.length ? IMG_GAP : 0) : 0);
    return { x: n.x - n.imgW / 2, y: n.y - blockH / 2 };
  };

  /* Bigger or smaller, one picture at a time. The size is a multiple of the
     share of the box that picture would otherwise get, so it still re-lays
     itself out when the node is resized. */
  Mindmap.prototype.scalePic = function (step) {
    var sel = this.selectedPic;
    if (!sel) return false;
    var n = this.byId(sel.nodeId);
    if (!n) return false;
    var pics = picsOf(n);
    if (sel.i >= pics.length) return false;
    var arr = (n.picS || []).slice();
    while (arr.length < pics.length) arr.push(1);
    var now = arr[sel.i] || 1;
    arr[sel.i] = Math.max(0.25, Math.min(4, Math.round((now + step) * 100) / 100));
    n.picS = arr;
    this._layout();
    this._changed();
    return true;
  };

  Mindmap.prototype.resetPic = function () {
    var sel = this.selectedPic;
    if (!sel) return false;
    var n = this.byId(sel.nodeId);
    if (!n || !n.picS) return false;
    var arr = n.picS.slice();
    arr[sel.i] = 1;
    n.picS = arr;
    this._layout();
    this._changed();
    return true;
  };

  Mindmap.prototype.selectPic = function (hit) {
    this.selectedPic = hit ? { nodeId: hit.node.id, i: hit.i } : null;
    if (this.opts.onPicSelect) this.opts.onPicSelect(this.selectedPic);
    this.draw();
  };

  // the corner of the chosen picture, for dragging it bigger or smaller
  Mindmap.prototype.hitPicGrip = function (px, py) {
    var pick = this.selectedPic;
    if (!pick) return null;
    var n = this.byId(pick.nodeId);
    if (!n || !n._pics) return null;
    var p = this.toWorld(px, py);
    var block = this._picBlock(n);
    for (var i = 0; i < n._pics.length; i++) {
      var q = n._pics[i];
      if (q.i !== pick.i) continue;
      var cx = block.x + q.dx + q.w, cy = block.y + q.dy + q.h;
      var r = Math.max(7, PIC_GRIP_R / this.cam.s) * 1.6;
      if (Math.hypot(p.x - cx, p.y - cy) <= r) return { node: n, i: q.i, w: q.w };
    }
    return null;
  };

  /* Where a picture being carried about would land: the gap it is nearest to
     in the run of the others. */
  Mindmap.prototype.picDropIndex = function (node, wx, wy) {
    if (!node || !node._pics) return 0;
    var block = this._picBlock(node);
    var best = node._pics.length, bestD = Infinity;
    for (var i = 0; i < node._pics.length; i++) {
      var q = node._pics[i];
      var midY = block.y + q.dy + q.h / 2;
      [[block.x + q.dx, i], [block.x + q.dx + q.w, i + 1]].forEach(function (pair) {
        var d = Math.hypot(wx - pair[0], wy - midY);
        if (d < bestD) { bestD = d; best = pair[1]; }
      });
    }
    return best;
  };

  // Put a picture somewhere else in the run.
  Mindmap.prototype.movePic = function (node, from, to) {
    var pics = picsOf(node).slice();
    if (from < 0 || from >= pics.length) return false;
    var scales = (node.picS || []).slice();
    while (scales.length < pics.length) scales.push(1);
    if (to > from) to--;
    if (to === from) return false;
    pics.splice(to, 0, pics.splice(from, 1)[0]);
    scales.splice(to, 0, scales.splice(from, 1)[0]);
    node.pics = pics;
    node.picS = scales;
    node.image = pics[0] || null;
    this.selectedPic = { nodeId: node.id, i: to };
    this._layout();
    this._changed();
    return true;
  };

  // Drag the corner: the size is kept as a multiple of its share of the box.
  Mindmap.prototype.sizePicTo = function (node, i, wantW) {
    var pics = picsOf(node);
    if (i < 0 || i >= pics.length) return false;
    var share = 0;
    for (var k = 0; k < node._pics.length; k++) {
      if (node._pics[k].i !== i) continue;
      share = node._pics[k].w / ((node.picS || [])[i] || 1);
    }
    if (share <= 0) return false;
    var scales = (node.picS || []).slice();
    while (scales.length < pics.length) scales.push(1);
    scales[i] = Math.max(0.25, Math.min(4, wantW / share));
    node.picS = scales;
    this._layout();
    this.draw();
    return true;
  };

  Mindmap.prototype.hitGrip = function (px, py) {
    var n = this.handleNode();
    if (!n) return null;
    // connectors win any overlap, so a link drag is never read as a resize
    if (this.hitHandle(px, py)) return null;
    var g = this._toScreen(n.x + n.w / 2, n.y + n.h / 2);
    return (Math.abs(g.x - px) <= 10 && Math.abs(g.y - py) <= 10) ? n : null;
  };

  // Nodes overlapping the marquee rectangle (drawn in any direction).
  /* The node the dragged one is touching, if any.

     Not "the pointer is inside that node" but "the two boxes have met", with a
     little daylight allowed, because that is what it looks like you are doing
     when you push one node up against another. Where several are touching, the
     nearest middle wins, so pushing into a crowd still picks one. */
  Mindmap.prototype.kissing = function (node, skip) {
    if (!node) return null;
    /* One score for every node, so that overlapping and merely-near ones are
       compared on the same footing and the nearest always wins.

         overlapping -> minus how deep, so the one pushed into hardest wins
         apart       -> plus the gap, so the closest wins

       Area used to decide it among the overlapping ones, which is a measure
       of the other node's size as much as anything: reaching for a small node
       beside a large one kept catching the large one. */
    var best = null, bestScore = Infinity, bestMid = Infinity;
    var ax0 = node.x - node.w / 2, ax1 = node.x + node.w / 2;
    var ay0 = node.y - node.h / 2, ay1 = node.y + node.h / 2;

    for (var i = 0; i < this.nodes.length; i++) {
      var m = this.nodes[i];
      if (m === node) continue;
      if (this._hidden && this._hidden[m.id]) continue;
      if (skip && skip.indexOf(m) !== -1) continue;

      var mx0 = m.x - m.w / 2, mx1 = m.x + m.w / 2;
      var my0 = m.y - m.h / 2, my1 = m.y + m.h / 2;
      var ox = Math.min(ax1, mx1) - Math.max(ax0, mx0);
      var oy = Math.min(ay1, my1) - Math.max(ay0, my0);
      var score;

      if (ox > 0 && oy > 0) {
        var deepX = Math.min(KISS, m.w * 0.5, node.w * 0.5);
        var deepY = Math.min(KISS, m.h * 0.5, node.h * 0.5);
        if (ox < deepX || oy < deepY) continue;   // a brush past is not an instruction
        score = -Math.min(ox, oy);
      } else {
        var gap = Math.hypot(Math.max(0, -ox), Math.max(0, -oy));
        if (gap > REACH) continue;
        score = gap;
      }

      // dead heats settled by which middle is closer, never by which is bigger
      var mid = Math.hypot(m.x - node.x, m.y - node.y);
      if (score < bestScore - 0.5 || (Math.abs(score - bestScore) <= 0.5 && mid < bestMid)) {
        bestScore = score;
        bestMid = mid;
        best = m;
      }
    }
    return best;
  };

  /* Cut a node loose from whatever it hangs off, quietly -- no re-arrange, no
     save. Returns the edge removed so a cancelled drag can put it back. */
  Mindmap.prototype._cutParent = function (node) {
    var cut = null;
    this.edges = this.edges.filter(function (e) {
      if (e.rel || e.b !== node.id || cut) return true;
      cut = e;
      return false;
    });
    return cut;
  };

  Mindmap.prototype.nodesInRect = function (r) {
    var left = Math.min(r.x0, r.x1), right = Math.max(r.x0, r.x1);
    var top = Math.min(r.y0, r.y1), bottom = Math.max(r.y0, r.y1);
    return this.nodes.filter(function (n) {
      return n.x + n.w / 2 >= left && n.x - n.w / 2 <= right &&
             n.y + n.h / 2 >= top && n.y - n.h / 2 <= bottom;
    });
  };

  Mindmap.prototype._localPoint = function (e) {
    var r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /* ---------- commands ---------- */

  // Build a node without firing onChange - callers that follow up with their
  // own _changed() use this so one gesture is one undo step.
  Mindmap.prototype.addNodeQuiet = function (text, x, y) {
    var r = this.canvas.getBoundingClientRect();
    var c = this.toWorld(r.width / 2, r.height / 2);
    var n = {
      id: DB.uid(),
      text: text === undefined ? 'Idea' : text,
      x: x === undefined ? c.x : x,
      y: y === undefined ? c.y : y,
      color: 'plain',
      image: null,
      noteId: null
    };
    this.nodes.push(n);
    this._layout();
    if (x === undefined) this._nudgeClear(n);
    return n;
  };

  Mindmap.prototype.addNode = function (text, x, y) {
    var n = this.addNodeQuiet(text, x, y);
    this.select(n);
    this._changed();
    return n;
  };

  // Slide a new node down until it is not sitting on top of an existing one.
  Mindmap.prototype._nudgeClear = function (node) {
    var guard = 0;
    var self = this;
    function clashes() {
      return self.nodes.some(function (o) {
        return o !== node &&
          Math.abs(o.x - node.x) < (o.w + node.w) / 2 + 12 &&
          Math.abs(o.y - node.y) < (o.h + node.h) / 2 + 10;
      });
    }
    while (clashes() && guard++ < 80) node.y += node.h + 16;
  };

  Mindmap.prototype.addChild = function (parent) {
    var p = parent || this.selected;
    if (!p) return this.addNode();
    var kids = this.edges.filter(function (e) { return e.a === p.id; }).length;
    var away = this.layoutOf(p) === 'left' ? -1 : 1;
    var n = {
      id: DB.uid(),
      text: 'Idea',
      x: p.x + away * (p.w / 2 + this.gapX),
      y: p.y + (kids ? (kids % 2 ? 1 : -1) * Math.ceil(kids / 2) * this.gapY : 0),
      color: p.color || 'plain',       // children inherit the parent's colour
      image: null,
      noteId: null
    };
    this.nodes.push(n);
    this._layout();
    this._nudgeClear(n);
    this.edges.push({ a: p.id, b: n.id });
    this.select(n);
    this._changed();
    return n;
  };

  /* Copying a selection means copying the edges between the chosen nodes as
     well -- otherwise pasting a branch gives you a heap of loose nodes rather
     than the shape you picked. Edges to anything outside the selection are
     deliberately left behind: they point at nodes the copy does not contain. */
  /* What a copy or a duplicate covers: everything chosen, plus everything
     hanging off it. Never only the node you pointed at. */
  Mindmap.prototype.withBranches = function (nodes) {
    var seen = {}, out = [];
    var self = this;
    (nodes || []).forEach(function (n) {
      if (!n || seen[n.id]) return;
      seen[n.id] = true;
      out.push(n);
      self.descendantsOf(n).forEach(function (k) {
        if (seen[k.id]) return;
        seen[k.id] = true;
        out.push(k);
      });
    });
    return out;
  };

  Mindmap.prototype.copySelection = function () {
    var chosen = this.selection.length ? this.selection : (this.selected ? [this.selected] : []);
    var picked = this.withBranches(chosen);
    if (!picked.length) return 0;
    var ids = {};
    picked.forEach(function (n) { ids[n.id] = true; });

    this._clip = {
      nodes: picked.map(function (n) {
        return {
          text: n.text, color: n.color, shape: n.shape, image: n.image,
          pics: (n.pics || []).slice(), picS: (n.picS || []).slice(),
          layout: n.layout, checklist: n.checklist, done: n.done,
          fs: n.fs, w0: n.w0, h0: n.h0,
          dx: n.x - picked[0].x, dy: n.y - picked[0].y
        };
      }),
      edges: this.edges.filter(function (e) { return ids[e.a] && ids[e.b]; })
        .map(function (e) {
          return {
            a: picked.map(function (n) { return n.id; }).indexOf(e.a),
            b: picked.map(function (n) { return n.id; }).indexOf(e.b),
            type: e.type, width: e.width,
            rel: e.rel, label: e.label
          };
        })
    };
    return picked.length;
  };

  /* Pasted onto a node, the copy hangs off it as a child; pasted onto nothing,
     it lands beside the original. Either way it is a copy: new ids throughout,
     so editing one does not touch the other. */
  Mindmap.prototype.pasteClipboard = function (onto) {
    var clip = this._clip;
    if (!clip || !clip.nodes.length) return 0;
    var anchor = onto || this.selected;
    var baseX = anchor ? anchor.x + anchor.w / 2 + this.gapX : 0;
    var baseY = anchor ? anchor.y : 0;

    var made = [];
    for (var i = 0; i < clip.nodes.length; i++) {
      var c = clip.nodes[i];
      var n = {
        id: DB.uid(),
        text: c.text, color: c.color, shape: c.shape, image: c.image || null,
        pics: (c.pics || []).slice(), picS: (c.picS || []).slice(),
        layout: c.layout || undefined,
        checklist: !!c.checklist, done: !!c.done,
        fs: c.fs, w0: c.w0, h0: c.h0,
        x: baseX + c.dx, y: baseY + c.dy,
        noteId: null
      };
      this.nodes.push(n);
      made.push(n);
    }

    clip.edges.forEach(function (e) {
      if (made[e.a] && made[e.b]) {
        var cp = { a: made[e.a].id, b: made[e.b].id, type: e.type, width: e.width };
        if (e.rel) {
          cp.rel = true;
          cp.label = e.label || '';
          if (e.k1) cp.k1 = { a: e.k1.a, o: e.k1.o };
          if (e.k2) cp.k2 = { a: e.k2.a, o: e.k2.o };
        }
        this.edges.push(cp);
      }
    }, this);

    // join the copy to whatever it was pasted onto, through the one door
    if (anchor) this.hangUnder(made[0], anchor);

    this._layout();
    this.selectMany(made);
    this._changed();
    return made.length;
  };

  /* ---------- auto-arrange ----------
     Free placement suits a small map; a big one needs order. With this on,
     every change lays the map out as a tree growing to the right: children in
     a column beside their parent, each branch given exactly the height it
     needs, nothing overlapping however many nodes there are. Siblings keep the
     order they are in on screen, so dragging one above another reorders it.
     Turning it off leaves every node where it is, free to drag again. */
  var GLIDE = 190;                                     // ms for a node to move

  Mindmap.prototype.arrange = function () {
    if (!this.nodes.length) return;
    this._layout();                                    // sizes before positions
    var was = {};
    this.nodes.forEach(function (n) { was[n.id] = { x: n.x, y: n.y }; });
    var byId = {}, kids = {}, hasParent = {};
    this.nodes.forEach(function (n) { byId[n.id] = n; });
    this.branchEdges().forEach(function (e) {
      if (!byId[e.a] || !byId[e.b]) return;
      (kids[e.a] = kids[e.a] || []).push(e.b);
      hasParent[e.b] = true;
    });
    var gx = Math.max(28, Math.round(this.gapX * 0.45));
    var gy = Math.max(6, Math.round(this.gapY * 0.22));
    /* Growing downwards, the step from one generation to the next was gy * 3
       -- about a third of what the sideways layout leaves between columns --
       so the children sat almost against the underside of their parent and
       the links had nowhere to travel. This is the room between the rows. */
    var gdown = Math.max(52, Math.round(this.gapY * 1.15));
    var dir = LAYOUTS[this.layout] ? this.layout : 'right';
    var down = dir === 'down';

    // each node belongs to the first parent that reaches it; extra links stay links
    var hid = this._hidden || {};
    var seen = {}, tree = {};
    function build(id) {
      seen[id] = true;
      var own = [];
      // a folded branch is laid out as if it were not there; its nodes keep
      // whatever coordinates they had, out of sight behind the parent
      if (!(byId[id] && byId[id].collapsed)) {
        (kids[id] || []).forEach(function (c) {
          if (!seen[c] && !hid[c]) { seen[c] = true; own.push(c); }
        });
      }
      tree[id] = own;
      own.forEach(build);
    }
    var roots = this.nodes.filter(function (n) { return !hasParent[n.id]; })
      .sort(function (a, b) { return down ? a.x - b.x : a.y - b.y; });
    roots.forEach(function (r) { if (!seen[r.id]) build(r.id); });
    // anything only reachable round a loop starts a tree of its own --
    // except what is folded away, which is not on screen to be placed
    this.nodes.forEach(function (n) {
      if (!seen[n.id] && !hid[n.id]) { roots.push(n); build(n.id); }
    });
    // brothers and sisters keep the order they appear in on screen
    Object.keys(tree).forEach(function (id) {
      tree[id].sort(function (a, b) {
        return down ? byId[a].x - byId[b].x : byId[a].y - byId[b].y;
      });
    });

    /* ---- which way each branch grows ----
       A node can carry a layout of its own, and then everything below it
       follows that one instead of the map's. It is how one map holds a
       timeline running downwards next to a list running right: the rule is
       inherited, so it is set once at the top of a branch, not on every node
       in it. Anything without one uses whatever it inherited. */
    var dirOf = {};

    /* ---- how much room a branch needs ----
       With one layout for the whole map a single number was enough: the
       branch's span across the way it grows. Mixed layouts need both sides of
       it, because a branch running downwards is wide where its neighbour
       running right is tall. So every branch is measured as a box, and a
       parent reserves the box rather than a band. */
    var box = {}, sideW = {};
    function measure(id, inherited) {
      var n = byId[id];
      var own = byId[id].layout;
      var d = (own && LAYOUTS[own]) ? own : inherited;
      dirOf[id] = d;
      var mine = tree[id];
      if (!mine.length) { box[id] = { w: n.w, h: n.h }; return box[id]; }

      var i, cb, run = 0, across = 0;
      if (d === 'down') {
        for (i = 0; i < mine.length; i++) {
          cb = measure(mine[i], d);
          run += cb.w + (i ? gx : 0);
          across = Math.max(across, cb.h);
        }
        box[id] = { w: Math.max(n.w, run), h: n.h + gdown + across };
      } else if (d === 'both') {
        // the branches split left and right, and each side is its own column
        var sides = [[], []];                          // 0 right, 1 left
        mine.forEach(function (c, k) { sides[k % 2].push(c); });
        var w = [0, 0], h = [0, 0];
        sides.forEach(function (list, k) {
          list.forEach(function (c, j) {
            var b = measure(c, d);
            h[k] += b.h + (j ? gy : 0);
            w[k] = Math.max(w[k], b.w);
          });
        });
        sideW[id] = w;
        box[id] = {
          w: n.w + (w[0] ? gx + w[0] : 0) + (w[1] ? gx + w[1] : 0),
          h: Math.max(n.h, h[0], h[1])
        };
      } else {
        for (i = 0; i < mine.length; i++) {
          cb = measure(mine[i], d);
          run += cb.h + (i ? gy : 0);
          across = Math.max(across, cb.w);
        }
        box[id] = { w: n.w + gx + across, h: Math.max(n.h, run) };
      }
      return box[id];
    }

    /* Put a branch inside the box measured for it, top-left first. Because
       each child owns a box of its own, a child that grows the other way
       fills its box from the far end and never doubles back over its parent. */
    function place(id, left, top) {
      var n = byId[id], b = box[id], d = dirOf[id], mine = tree[id];
      var i, x, y, run = 0;

      if (d === 'down') {
        n.x = left + b.w / 2;
        n.y = top + n.h / 2;
        if (!mine.length) return;
        for (i = 0; i < mine.length; i++) run += box[mine[i]].w + (i ? gx : 0);
        x = left + (b.w - run) / 2;
        var below = top + n.h + gdown;
        for (i = 0; i < mine.length; i++) {
          place(mine[i], x, below);
          x += box[mine[i]].w + gx;
        }
        return;
      }

      if (d === 'both') {
        var sides = [[], []];
        mine.forEach(function (c, k) { sides[k % 2].push(c); });
        var w = sideW[id] || [0, 0];
        n.x = left + (w[1] ? w[1] + gx : 0) + n.w / 2;
        n.y = top + b.h / 2;
        sides.forEach(function (list, k) {
          if (!list.length) return;
          var tot = 0;
          list.forEach(function (c, j) { tot += box[c].h + (j ? gy : 0); });
          var cy = n.y - tot / 2;
          list.forEach(function (c) {
            var cl = k === 0 ? n.x + n.w / 2 + gx
                             : n.x - n.w / 2 - gx - box[c].w;
            place(c, cl, cy);
            cy += box[c].h + gy;
          });
        });
        return;
      }

      var leftward = d === 'left';
      n.x = leftward ? left + b.w - n.w / 2 : left + n.w / 2;
      n.y = top + b.h / 2;
      if (!mine.length) return;
      for (i = 0; i < mine.length; i++) run += box[mine[i]].h + (i ? gy : 0);
      y = n.y - run / 2;
      for (i = 0; i < mine.length; i++) {
        var kid = mine[i];
        place(kid, leftward ? n.x - n.w / 2 - gx - box[kid].w : n.x + n.w / 2 + gx, y);
        y += box[kid].h + gy;
      }
    }

    /* A box's top-left, given where its own node should end up. Which corner
       that is depends on the way the branch grows, so it is worked out here
       once rather than at every call site. */
    function origin(id, nx, ny) {
      var n = byId[id], b = box[id], d = dirOf[id], lx;
      if (d === 'left') lx = nx + n.w / 2 - b.w;
      else if (d === 'down') lx = nx - b.w / 2;
      else if (d === 'both') {
        var w = sideW[id] || [0, 0];
        lx = nx - n.w / 2 - (w[1] ? w[1] + gx : 0);
      } else lx = nx - n.w / 2;
      return { x: lx, y: d === 'down' ? ny - n.h / 2 : ny - b.h / 2 };
    }

    roots.forEach(function (r) { measure(r.id, dir); });

    var cx = null, cy = null;
    roots.forEach(function (r) {
      // a node put somewhere by hand keeps its place; only its own
      // branch is tidied, around where you left it
      if (r.free) {
        var o = origin(r.id, r.x, r.y);
        place(r.id, o.x, o.y);
        return;
      }
      if (cx === null) {
        var first = origin(r.id, r.x, r.y);
        cx = first.x;
        cy = first.y;
      }
      place(r.id, cx, cy);
      if (down) cx += box[r.id].w + gx * 3;
      else cy += box[r.id].h + gy * 4;
    });

    // anything that moved glides there rather than jumping
    var now = Date.now();
    this.nodes.forEach(function (n) {
      var old = was[n.id];
      if (!old) return;
      if (Math.abs(old.x - n.x) < 0.5 && Math.abs(old.y - n.y) < 0.5) return;
      n._from = old;
      n._t0 = now;
    });
  };

  /* Which way a node's children grow. A node can carry a layout of its own
     and everything below it follows; without one it inherits from whichever
     ancestor does, and failing that from the map. */
  Mindmap.prototype.layoutOf = function (node) {
    var map = LAYOUTS[this.layout] ? this.layout : 'right';
    /* Walking up the tree for every edge on every frame is real work, and
       almost every map has no branch of its own to find. One pass over the
       nodes after a change settles it, and the walk only happens when there
       is something up there to walk to. */
    if (this._hasBranchLayout === null || this._hasBranchLayout === undefined) {
      this._hasBranchLayout = this.nodes.some(function (n) {
        return !!(n.layout && LAYOUTS[n.layout]);
      });
    }
    if (!this._hasBranchLayout) return map;
    var n = node, guard = 0;
    while (n && guard++ < 128) {
      if (n.layout && LAYOUTS[n.layout]) return n.layout;
      n = this.parentOf(n);
    }
    return map;
  };

  /* Give one branch a layout of its own, or take it away again so the branch
     goes back to following the map. */
  Mindmap.prototype.setBranchLayout = function (node, name) {
    if (!node) return null;
    if (name && LAYOUTS[name]) node.layout = name;
    else delete node.layout;
    if (!this.auto) this.auto = true;         // a layout only means anything tidied
    this._changed();
    return node.layout || null;
  };

  // does this branch differ from what it would otherwise inherit?
  Mindmap.prototype.branchLayout = function (node) {
    return (node && node.layout && LAYOUTS[node.layout]) ? node.layout : null;
  };

  Mindmap.prototype.setLayout = function (name) {
    this.layout = LAYOUTS[name] ? name : 'right';
    if (!this.auto) this.auto = true;      // a layout only means anything tidied
    this._changed();
    return this.layout;
  };

  /* Hang a node (and everything under it) under another one. */

  /* Where a node would come to rest if it were hung off this one now. Used to
     show the move before it is made, so the answer to "where is this going?"
     is on screen rather than in your head. */
  Mindmap.prototype.landingSpot = function (parent, node) {
    if (!parent || !node) return null;
    if (this.descendantsOf(node).indexOf(parent) !== -1) return null;

    /* With the map arranging itself, where a node ends up is not "beside its
       parent" -- every branch moves aside to make room. So the move is made
       here for real, the answer read off, and everything put back exactly as
       it was. Nothing outside this function ever sees the difference. */
    if (this.auto && this.nodes.length <= 400) {
      var was = this.nodes.map(function (n) {
        return { n: n, x: n.x, y: n.y, from: n._from, t0: n._t0 };
      });
      var edges = this.edges.slice();
      var hadFree = node.free;

      this._cutParent(node);
      this.edges.push({ a: parent.id, b: node.id });
      delete node.free;
      this.arrange();
      /* Read where it lands RELATIVE TO ITS NEW PARENT, not where it lands on
         the canvas. Arranging shifts the whole map aside to make room, so the
         absolute answer is correct about the map-after and useless on the map
         you are looking at -- it put the ghost half a screen from the node it
         was aiming at. The offset survives the shift; the parent carries it. */
      var dx = node.x - parent.x, dy = node.y - parent.y;
      var spot = { x: 0, y: 0, w: node.w, h: node.h };

      this.edges = edges;
      if (hadFree) node.free = hadFree;
      was.forEach(function (o) {
        o.n.x = o.x;
        o.n.y = o.y;
        o.n._from = o.from;      // and no node believes it has just travelled
        o.n._t0 = o.t0;
      });
      this._layout();
      spot.x = parent.x + dx;          // beside the parent, where you are looking
      spot.y = parent.y + dy;
      return spot;
    }

    // laid out by hand, or too big to rehearse: alongside, under the last child
    var self = this;
    var kids = [];
    this.branchEdges().forEach(function (e) {
      if (e.a !== parent.id) return;
      var k = self.byId(e.b);
      if (k && k !== node) kids.push(k);
    });
    var away = this.layoutOf(parent) === 'left' ? -1 : 1;
    var x = parent.x + away * (parent.w / 2 + this.gapX * 0.6 + node.w / 2);
    var y = parent.y;
    if (kids.length) {
      var low = -Infinity;
      kids.forEach(function (k) { low = Math.max(low, k.y + k.h / 2); });
      y = low + this.gapY * 0.5 + node.h / 2;
    }
    return { x: x, y: y, w: node.w, h: node.h };
  };

  Mindmap.prototype.reparent = function (node, parent) {
    if (!node || !parent || node === parent) return false;
    if (this.descendantsOf(node).indexOf(parent) !== -1) return false;
    this.edges = this.edges.filter(function (e) { return e.b !== node.id; });
    this.edges.push({ a: parent.id, b: node.id });
    this.select(node);
    this._changed();
    return true;
  };

  Mindmap.prototype.setAuto = function (on) {
    this.auto = !!on;
    this._changed();
  };

  Mindmap.prototype.setSpacing = function (x, y) {
    if (x) this.gapX = Math.max(60, Math.min(400, x));
    if (y) this.gapY = Math.max(24, Math.min(200, y));
  };

  Mindmap.prototype.addSibling = function () {
    var sel = this.selected;
    if (!sel) return this.addNode();
    var parentEdge = null;
    for (var i = 0; i < this.edges.length; i++) {
      if (this.edges[i].b === sel.id) { parentEdge = this.edges[i]; break; }
    }
    /* The node at the top of a branch has nothing to sit beside, so the new
       one goes under it instead -- joined either way, never adrift. */
    if (!parentEdge) return this.addChild(sel);
    return this.addChild(this.byId(parentEdge.a));
  };

  Mindmap.prototype._afterSelect = function () {
    this.selected = this.selection[this.selection.length - 1] || null;
    // a picture belongs to the node you were on; moving on lets it go
    if (this.selectedPic &&
        (!this.selected || this.selectedPic.nodeId !== this.selected.id)) {
      this.selectedPic = null;
      if (this.opts.onPicSelect) this.opts.onPicSelect(null);
    }
    this.selectedEdge = null;
    if (this.opts.onSelect) this.opts.onSelect(this.selected);
    this.draw();
  };

  Mindmap.prototype.select = function (node) {
    this.selection = node ? [node] : [];
    this._afterSelect();
  };

  Mindmap.prototype.selectMany = function (nodes) {
    this.selection = (nodes || []).slice();
    this._afterSelect();
  };

  Mindmap.prototype.toggleSelect = function (node) {
    if (!node) return;
    var i = this.selection.indexOf(node);
    if (i === -1) this.selection.push(node);
    else this.selection.splice(i, 1);
    this._afterSelect();
  };

  Mindmap.prototype.isSelected = function (node) {
    return this.selection.indexOf(node) !== -1;
  };

  Mindmap.prototype.selectAll = function () {
    this.selectMany(this.nodes);
    return this.selection.length;
  };

  // Everything hanging off this node, following links outwards.
  /* The node an arrow key should move to. */
  Mindmap.prototype.step = function (from, key) {
    if (!from) return null;
    var self = this, parentOf = {}, kids = {};
    this.branchEdges().forEach(function (e) {
      if (!self.byId(e.a) || !self.byId(e.b)) return;
      parentOf[e.b] = e.a;
      (kids[e.a] = kids[e.a] || []).push(e.b);
    });
    var byY = function (ids) {
      return ids.map(function (id) { return self.byId(id); })
        .filter(Boolean)
        .sort(function (a, b) { return a.y - b.y; });
    };
    if (key === 'ArrowLeft') return this.byId(parentOf[from.id]) || null;
    if (key === 'ArrowRight') {
      var own = byY(kids[from.id] || []);
      return own[0] || null;
    }
    var sibs = byY(kids[parentOf[from.id]] ||
      this.nodes.filter(function (n) { return !parentOf[n.id]; })
        .map(function (n) { return n.id; }));
    var at = sibs.indexOf(from);
    if (at === -1) return null;
    var next = key === 'ArrowUp' ? sibs[at - 1] : sibs[at + 1];
    return next || null;
  };

  // branch links only: a relationship is not a parent
  Mindmap.prototype.branchEdges = function () {
    return this.edges.filter(function (e) { return !e.rel; });
  };

  Mindmap.prototype.parentOf = function (node) {
    if (!node) return null;
    for (var i = 0; i < this.edges.length; i++) {
      var e = this.edges[i];
      if (!e.rel && e.b === node.id) return this.byId(e.a);
    }
    return null;
  };

  /* Hang a node under another, taking it off whatever it was under. One
     parent, always -- which is what makes a map something you can fold,
     duplicate, tick off and read out in order. */
  Mindmap.prototype.hangUnder = function (node, parent) {
    if (!node || !parent || node === parent) return false;
    if (this.descendantsOf(node).indexOf(parent) !== -1) return false;
    this._cutParent(node);
    this.edges.push({ a: parent.id, b: node.id });
    return true;
  };

  /* A link that is not a branch: both ends keep their own place in the map,
     and it can be given a word or two to say what it means. */
  Mindmap.prototype.relate = function (a, b, label) {
    if (!a || !b || a === b) return null;
    for (var i = 0; i < this.edges.length; i++) {
      var e = this.edges[i];
      if (!e.rel) continue;
      if ((e.a === a.id && e.b === b.id) || (e.a === b.id && e.b === a.id)) {
        e.label = label || e.label || '';
        this._changed();
        return e;
      }
    }
    var made = { a: a.id, b: b.id, rel: true, label: label || '' };
    this.edges.push(made);
    this._changed();
    return made;
  };

  Mindmap.prototype.descendantsOf = function (node) {
    var out = [], seen = {}, stack = [node.id], self = this;
    seen[node.id] = true;
    while (stack.length) {
      var id = stack.pop();
      this.branchEdges().forEach(function (e) {
        if (e.a === id && !seen[e.b]) {
          seen[e.b] = true;
          var child = self.byId(e.b);
          if (child) { out.push(child); stack.push(e.b); }
        }
      });
    }
    return out;
  };

  Mindmap.prototype.setSelectMode = function (on) {
    this.selectMode = !!on;
    if (this.selectMode) this.setLinkMode(false);
    this.canvas.style.cursor = this.selectMode ? 'crosshair' : '';
    if (this.opts.onSelectModeChange) this.opts.onSelectModeChange(this.selectMode);
    this.draw();
  };

  Mindmap.prototype.setColor = function (key) {
    if (!this.selection.length) return 0;
    if (!PALETTE[key] && !isHex(key)) return 0;
    this.selection.forEach(function (n) { n.color = key; });
    this._changed();
    return this.selection.length;
  };

  // Washes the selected nodes out or deepens them. A palette colour is turned
  // into its own hex first, so the two systems meet.
  Mindmap.prototype.adjustSaturation = function (delta) {
    if (!this.selection.length) return 0;
    this.selection.forEach(function (n) {
      var base = isHex(n.color) ? n.color
               : (PALETTE[n.color] && PALETTE[n.color].line) || '#8a8a8a';
      n.color = saturate(base, delta);
    });
    this._changed();
    return this.selection.length;
  };

  Mindmap.prototype.setShape = function (shape) {
    if (!SHAPES[shape] || !this.selection.length) return 0;
    this.selection.forEach(function (n) { n.shape = shape; });
    this._layout();
    this._changed();
    return this.selection.length;
  };

  // delta in px; 0 resets the node to the app-wide size
  Mindmap.prototype.nudgeFontSize = function (delta) {
    if (!this.selection.length) return 0;
    var base = this.fontSize, self = this;
    this.selection.forEach(function (n) {
      var cur = n.fs || base;
      n.fs = delta === 0 ? 0 : Math.max(9, Math.min(64, cur + delta));
      if (n.fs === base) n.fs = 0;
      // a hand-set width no longer fits once the text changes size
      if (delta !== 0) { n.w0 = 0; n.h0 = 0; }
      void self;
    });
    this._layout();
    this._changed();
    return this.selection.length;
  };

  Mindmap.prototype.fontSizeOf = function (node) {
    return (node && node.fs) || this.fontSize;
  };

  // Applies to the selected edge if there is one, otherwise to the whole map.
  Mindmap.prototype.setEdgeType = function (type) {
    if (!EDGE_TYPES[type]) return null;
    if (this.selectedEdge) { this.selectedEdge.t = type; this._changed(); return 'edge'; }
    this.style.type = type;
    this.edges.forEach(function (e) { delete e.t; });
    this._changed();
    return 'all';
  };

  Mindmap.prototype.nudgeEdgeWidth = function (delta) {
    function clamp(w) { return Math.max(0.6, Math.min(12, Math.round((w + delta) * 10) / 10)); }
    if (this.selectedEdge) {
      this.selectedEdge.w = clamp(this.selectedEdge.w || this.style.width);
      this._changed();
      return this.selectedEdge.w;
    }
    this.style.width = clamp(this.style.width);
    this.edges.forEach(function (e) { delete e.w; });
    this._changed();
    return this.style.width;
  };

  // Remove links without touching nodes. With one link picked it removes that;
  // with several nodes picked it removes every link running between them.
  Mindmap.prototype.unlinkSelected = function () {
    if (this.selectedEdge) {
      var one = this.selectedEdge;
      this.edges = this.edges.filter(function (e) { return e !== one; });
      this.selectedEdge = null;
      this._changed();
      return 1;
    }
    if (this.selection.length < 2) return 0;
    var inSel = {};
    this.selection.forEach(function (n) { inSel[n.id] = true; });
    var before = this.edges.length;
    this.edges = this.edges.filter(function (e) {
      return !(inSel[e.a] && inSel[e.b]);
    });
    var removed = before - this.edges.length;
    if (removed) this._changed();
    return removed;
  };

  Mindmap.prototype.deleteSelected = function () {
    if (this.selectedEdge) {
      var e = this.selectedEdge;
      this.edges = this.edges.filter(function (x) { return x !== e; });
      this.selectedEdge = null;
      this._changed();
      return 'link';
    }
    if (!this.selection.length) return null;
    var doomed = {};
    this.selection.forEach(function (n) { doomed[n.id] = true; });
    var count = this.selection.length;
    this.nodes = this.nodes.filter(function (n) { return !doomed[n.id]; });
    this.edges = this.edges.filter(function (e2) { return !doomed[e2.a] && !doomed[e2.b]; });
    this.select(null);
    this._changed();
    return count;
  };

  Mindmap.prototype.renameSelected = function (text) {
    if (!this.selected) return;
    this.selected.text = text;
    this._layout();
    this._changed();
  };

  Mindmap.prototype.setLinkMode = function (on) {
    this.linkMode = !!on;
    this.linkFrom = null;
    this._cursor = null;
    this.canvas.style.cursor = this.linkMode ? 'crosshair' : '';
    if (this.opts.onLinkModeChange) this.opts.onLinkModeChange(this.linkMode);
    this.draw();
  };

  // Returns 'started' | 'linked' | 'unlinked' | 'cancelled' | null
  Mindmap.prototype.linkTo = function (node) {
    if (!node) return null;
    if (!this.linkFrom) {
      this.linkFrom = node;
      this.draw();
      return 'started';
    }
    if (this.linkFrom.id === node.id) {
      this.linkFrom = null;
      this.draw();
      return 'cancelled';
    }
    var a = this.linkFrom.id, b = node.id;
    var existing = null;
    for (var i = 0; i < this.edges.length; i++) {
      var e = this.edges[i];
      if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) { existing = e; break; }
    }
    var from = this.linkFrom;
    this.linkFrom = null;
    if (existing) {
      this.edges = this.edges.filter(function (x) { return x !== existing; });
      this._changed();
      return 'unlinked';
    }
    /* Always a relationship. Branches are made by carrying one node onto
       another, and a node has exactly one parent -- so the only thing left
       for this tool to make is the other sort of connection. */
    var made = this.relate(from, node, '');
    this.selectedEdge = made;
    if (this.opts.onEdgeSelect) this.opts.onEdgeSelect(made);
    return 'related';
  };

  // the words on a relationship
  Mindmap.prototype.labelEdge = function (edge, text) {
    if (!edge || !edge.rel) return false;
    edge.label = String(text || '').replace(/\s+/g, ' ').trim();
    this._changed();
    return true;
  };

  Mindmap.prototype.fit = function () {
    var r = this.canvas.getBoundingClientRect();
    if (!this.nodes.length || !r.width) {
      this.cam = { x: r.width / 2, y: r.height / 2, s: 1 };
      this.draw();
      return;
    }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var hid = this._hidden || {};
    var shown = 0;
    this.nodes.forEach(function (n) {
      if (hid[n.id]) return;
      shown++;
      minX = Math.min(minX, n.x - n.w / 2); maxX = Math.max(maxX, n.x + n.w / 2);
      minY = Math.min(minY, n.y - n.h / 2); maxY = Math.max(maxY, n.y + n.h / 2);
    });
    if (!shown) {
      this.cam = { x: r.width / 2, y: r.height / 2, s: 1 };
      this.draw();
      return;
    }
    var pad = 48;
    var s = Math.min((r.width - pad * 2) / (maxX - minX || 1),
                     (r.height - pad * 2) / (maxY - minY || 1));
    s = Math.max(0.25, Math.min(1.4, s));
    this.cam.s = s;
    this.cam.x = r.width / 2 - ((minX + maxX) / 2) * s;
    this.cam.y = r.height / 2 - ((minY + maxY) / 2) * s;
    this.draw();
  };

  // Pan so a node is comfortably on screen (used after Tab creates one).
  Mindmap.prototype.reveal = function (node) {
    if (!node) return;
    var r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    var sx = node.x * this.cam.s + this.cam.x;
    var sy = node.y * this.cam.s + this.cam.y;
    var m = 70;
    if (sx < m) this.cam.x += m - sx;
    if (sx > r.width - m) this.cam.x -= sx - (r.width - m);
    if (sy < m) this.cam.y += m - sy;
    if (sy > r.height - m) this.cam.y -= sy - (r.height - m);
    this.draw();
  };

  // Straight to a size, keeping whatever is in the middle in the middle.
  Mindmap.prototype.zoomTo = function (scale) {
    var r = this.canvas.getBoundingClientRect();
    var cx = r.width / 2, cy = r.height / 2;
    var before = this.toWorld(cx, cy);
    this.cam.s = Math.max(0.2, Math.min(3, scale));
    this.cam.x = cx - before.x * this.cam.s;
    this.cam.y = cy - before.y * this.cam.s;
    this.draw();
  };

  Mindmap.prototype.zoomBy = function (factor) {
    var r = this.canvas.getBoundingClientRect();
    var cx = r.width / 2, cy = r.height / 2;
    var before = this.toWorld(cx, cy);
    this.cam.s = Math.max(0.2, Math.min(3, this.cam.s * factor));
    this.cam.x = cx - before.x * this.cam.s;
    this.cam.y = cy - before.y * this.cam.s;
    this.draw();
  };

  /* ---------- rendering ---------- */

  Mindmap.prototype.resize = function () {
    var r = this.canvas.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this._dpr = dpr;
    this.draw();
  };

  Mindmap.prototype.draw = function () {
    var self = this;
    if (this._raf) return;
    this._raf = requestAnimationFrame(function () {
      self._raf = null;
      self._paint();
      if (self.opts.onCam) self.opts.onCam(self.cam.s);
      // keep the frames coming while anything is still gliding
      if (self.nodes.some(function (n) { return n._t0; })) self.draw();
    });
  };

  Mindmap.prototype._roundRect = function (ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };

  // Trace a node's outline. Callers then fill and/or stroke it.
  Mindmap.prototype._shapePath = function (ctx, n) {
    var x = n.x - n.w / 2, y = n.y - n.h / 2, w = n.w, h = n.h;
    var shape = n.shape || 'round';

    if (shape === 'circle' || shape === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(n.x, n.y, w / 2, h / 2, 0, 0, Math.PI * 2);
      return;
    }
    if (shape === 'diamond') {
      ctx.beginPath();
      ctx.moveTo(n.x, y);
      ctx.lineTo(x + w, n.y);
      ctx.lineTo(n.x, y + h);
      ctx.lineTo(x, n.y);
      ctx.closePath();
      return;
    }
    if (shape === 'rect' || shape === 'square') {
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      return;
    }
    this._roundRect(ctx, x, y, w, h, 10);
  };

  // A stable pseudo-random offset per edge, so hand-drawn lines do not shimmer
  // on every repaint.
  function jitter(seed, i) {
    var x = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
    return x - Math.floor(x) - 0.5;
  }

  function seedOf(e) {
    var str = e.a + e.b, h = 0;
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 100000;
    return h;
  }

  // Control points for a hand-drawn stroke: a gentle, stable bow off the
  // straight line. `pass` shifts them so a second stroke does not overlap.
  function sketchControls(ends, seed, pass) {
    var dx = ends.b.x - ends.a.x, dy = ends.b.y - ends.a.y;
    var len = Math.hypot(dx, dy) || 1;
    var nx = -dy / len, ny = dx / len;
    var amp = Math.min(7, len * 0.045);
    var j1 = jitter(seed, 1 + (pass || 0) * 3);
    var j2 = jitter(seed, 2 + (pass || 0) * 3);
    return {
      c1: { x: ends.a.x + dx * 0.33 + nx * amp * j1,
            y: ends.a.y + dy * 0.33 + ny * amp * j1 },
      c2: { x: ends.a.x + dx * 0.67 + nx * amp * j2,
            y: ends.a.y + dy * 0.67 + ny * amp * j2 }
    };
  }

  Mindmap.prototype.edgeStyleOf = function (e) {
    return {
      type: e.t || this.style.type,
      width: e.w || this.style.width
    };
  };

  /* Which limb each node belongs to: every child of a root takes the next
     colour, and everything under it inherits. Worked out on demand and kept
     until the map changes, because it is read once per edge and once per node
     on every frame. */
  Mindmap.prototype._branchMap = function () {
    if (this._branches) return this._branches;
    var byId = {}, kids = {}, hasParent = {};
    this.nodes.forEach(function (n) { byId[n.id] = n; });
    this.branchEdges().forEach(function (e) {
      if (!byId[e.a] || !byId[e.b]) return;
      (kids[e.a] = kids[e.a] || []).push(e.b);
      hasParent[e.b] = true;
    });
    var of = {}, seen = {}, taken = 0;
    var paint = function (id, colour) {
      if (seen[id]) return;
      seen[id] = true;
      if (colour) of[id] = colour;
      (kids[id] || []).forEach(function (c) { paint(c, colour); });
    };
    var roots = this.nodes.filter(function (n) { return !hasParent[n.id]; });
    roots.forEach(function (r) {
      seen[r.id] = true;
      (kids[r.id] || []).forEach(function (c) {
        paint(c, BRANCH_COLORS[taken++ % BRANCH_COLORS.length]);
      });
    });
    this._branches = of;
    return of;
  };

  Mindmap.prototype.branchColorOf = function (node) {
    if (!this.branchColors || !node) return null;
    return this._branchMap()[node.id] || null;
  };

  // Lay down the path for one edge in the requested style.
  Mindmap.prototype._edgePath = function (ctx, ends, type, seed) {
    ctx.beginPath();
    if (type === 'elbow') {
      /* Out of the parent, along, then square into the child -- the shape a
         family tree is drawn in, and much easier to follow by eye than a
         bundle of curves when a node has many children. */
      var a = ends.a, b = ends.b;
      var r = Math.min(10, Math.abs(b.y - a.y) / 2, Math.abs(b.x - a.x) / 2);
      ctx.moveTo(a.x, a.y);
      if (ends.down) {
        var my = (a.y + b.y) / 2;
        if (r > 1) {
          ctx.lineTo(a.x, my - Math.sign(my - a.y) * 0);
          ctx.lineTo(a.x, my);
          ctx.arcTo(a.x, my, b.x, my, r);
          ctx.lineTo(b.x, my);
          ctx.arcTo(b.x, my, b.x, b.y, r);
        } else {
          ctx.lineTo(a.x, my);
          ctx.lineTo(b.x, my);
        }
        ctx.lineTo(b.x, b.y);
        return;
      }
      var mx = a.x + (b.x - a.x) * 0.45;
      if (r > 1) {
        ctx.lineTo(mx - Math.sign(b.x - a.x) * r, a.y);
        ctx.arcTo(mx, a.y, mx, b.y, r);
        ctx.lineTo(mx, b.y - Math.sign(b.y - a.y) * r);
        ctx.arcTo(mx, b.y, b.x, b.y, r);
      } else {
        ctx.lineTo(mx, a.y);
        ctx.lineTo(mx, b.y);
      }
      ctx.lineTo(b.x, b.y);
      return;
    }
    if (type === 'straight' || type === 'dotted') {
      ctx.moveTo(ends.a.x, ends.a.y);
      ctx.lineTo(ends.b.x, ends.b.y);
      return;
    }
    if (type === 'sketch') {
      // A pen wavers, it does not zigzag: one smooth curve whose two control
      // points are nudged off the straight line by a small fixed amount.
      var pts = sketchControls(ends, seed);
      ctx.moveTo(ends.a.x, ends.a.y);
      ctx.bezierCurveTo(pts.c1.x, pts.c1.y, pts.c2.x, pts.c2.y, ends.b.x, ends.b.y);
      return;
    }
    ctx.moveTo(ends.a.x, ends.a.y);
    ctx.bezierCurveTo(ends.c1.x, ends.c1.y, ends.c2.x, ends.c2.y, ends.b.x, ends.b.y);
  };

  Mindmap.prototype._paint = function () {
    /* Measure before painting. On a phone the canvas changes height on its own
       -- the address bar slides away, the keyboard opens -- and a resize event
       does not always arrive. Painting at the old size while taps are measured
       at the new one is what made a tap land on the node above the one you
       touched, so the two are kept in step here instead. */
    var box = this.canvas.getBoundingClientRect();
    if (box.width && box.height) {
      var want = Math.min(window.devicePixelRatio || 1, 2.5);
      if (Math.abs(this.canvas.width - box.width * want) > 1 ||
          Math.abs(this.canvas.height - box.height * want) > 1) {
        this.canvas.width = Math.max(1, Math.round(box.width * want));
        this.canvas.height = Math.max(1, Math.round(box.height * want));
        this._dpr = want;
      }
    }
    /* A node that has just moved is drawn on its way there. The real
       coordinates are put back before this returns, so hit testing, saving
       and everything else still sees where the node actually is. */
    var flying = null, nowMs = Date.now();
    for (var fi = 0; fi < this.nodes.length; fi++) {
      var fn = this.nodes[fi];
      if (!fn._t0) continue;
      var k = (nowMs - fn._t0) / GLIDE;
      if (k >= 1) { fn._t0 = 0; fn._from = null; continue; }
      var ease = 1 - Math.pow(1 - k, 3);
      (flying = flying || []).push({ n: fn, x: fn.x, y: fn.y });
      fn.x = fn._from.x + (fn.x - fn._from.x) * ease;
      fn.y = fn._from.y + (fn.y - fn._from.y) * ease;
    }

    var ctx = this.ctx, t = this.theme();
    var dpr = this._dpr || 1;
    var W = this.canvas.width, H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.scale(dpr, dpr);
    ctx.translate(this.cam.x, this.cam.y);
    ctx.scale(this.cam.s, this.cam.s);

    var vw = W / dpr / this.cam.s, vh = H / dpr / this.cam.s;
    var ox = -this.cam.x / this.cam.s, oy = -this.cam.y / this.cam.s;
    var step = 40;
    ctx.fillStyle = t.grid;
    for (var gx = Math.floor(ox / step) * step; gx < ox + vw; gx += step) {
      for (var gy = Math.floor(oy / step) * step; gy < oy + vh; gy += step) {
        ctx.fillRect(gx, gy, 1.4, 1.4);
      }
    }

    // edges, border-to-border, in whatever style each one is set to
    var hid = this._hidden || {};
    for (var i = 0; i < this.edges.length; i++) {
      var e = this.edges[i];
      if (hid[e.a] || hid[e.b]) continue;      // a folded branch draws nothing
      var ends = this.edgeEnds(e);
      if (!ends) continue;
      var isSel = this.selectedEdge === e;
      var st = this.edgeStyleOf(e);
      var branch = e.rel ? null : this.branchColorOf(this.byId(e.b));
      var col = isSel ? t.accent : (branch || t.edge);
      if (e.rel && !isSel) col = t.ink3 || t.edge;
      var lw = isSel ? st.width + 1.4 : st.width;

      if (st.type === 'tapered') {
        // a filled sliver, thick where it leaves the parent and a point at the child
        var half = Math.max(1.2, lw * 1.9);
        var dxT = ends.b.x - ends.a.x, dyT = ends.b.y - ends.a.y;
        var lenT = Math.hypot(dxT, dyT) || 1;
        var nxT = -dyT / lenT * half, nyT = dxT / lenT * half;
        var mxT = (ends.a.x + ends.b.x) / 2, myT = (ends.a.y + ends.b.y) / 2;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(ends.a.x + nxT, ends.a.y + nyT);
        ctx.quadraticCurveTo(mxT + nxT * 0.6, myT + nyT * 0.6, ends.b.x, ends.b.y);
        ctx.quadraticCurveTo(mxT - nxT * 0.6, myT - nyT * 0.6, ends.a.x - nxT, ends.a.y - nyT);
        ctx.closePath();
        ctx.fill();
        continue;                      // the taper is its own arrow head
      }

      ctx.strokeStyle = col;
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      if (st.type === 'dotted') ctx.setLineDash([lw * 0.6, lw * 2.6]);

      var seed = seedOf(e);
      if (e.rel) ctx.setLineDash([7, 6]);
      this._edgePath(ctx, ends, e.rel ? 'curve' : st.type, seed);
      ctx.stroke();
      if (e.rel) ctx.setLineDash([]);
      if (st.type === 'sketch') {       // a second, fainter stroke reads as ink
        var p2 = sketchControls(ends, seed, 1);
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(ends.a.x, ends.a.y);
        ctx.bezierCurveTo(p2.c1.x, p2.c1.y, p2.c2.x, p2.c2.y, ends.b.x, ends.b.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.setLineDash([]);

      if (e.rel) {
        /* Its words, in a box on the middle of the arc -- the one place both
           ends can see, and out of the way of everything else. */
        var mid = bezierAt(0.5, ends.a, ends.c1, ends.c2, ends.b);
        var words = (e.label || '').trim() || 'relates to';
        ctx.font = Math.max(10, Math.round(this.fontSize * 0.82)) + 'px ' + this.fontStack;
        var tw = ctx.measureText(words).width;
        var bh = Math.max(16, this.fontSize * 1.35);
        var bw = tw + 14;
        this._roundRect(ctx, mid.x - bw / 2, mid.y - bh / 2, bw, bh, 5);
        ctx.fillStyle = t.node;
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = isSel ? t.accent : col;
        ctx.stroke();
        ctx.fillStyle = isSel ? t.accent : t.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(words, mid.x, mid.y);
        e._label = { x: mid.x, y: mid.y, w: bw, h: bh };
        continue;                       // a relationship points at neither end
      }

      // arrow head, pointing along the last bit of whatever path was drawn
      var tip, pre;
      if (st.type === 'curve') {
        tip = bezierAt(1, ends.a, ends.c1, ends.c2, ends.b);
        pre = bezierAt(0.92, ends.a, ends.c1, ends.c2, ends.b);
      } else {
        tip = ends.b;
        pre = { x: ends.a.x + (ends.b.x - ends.a.x) * 0.92,
                y: ends.a.y + (ends.b.y - ends.a.y) * 0.92 };
      }
      var ang = Math.atan2(tip.y - pre.y, tip.x - pre.x);
      var head = Math.max(7, lw * 4);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x - head * Math.cos(ang - 0.4), tip.y - head * Math.sin(ang - 0.4));
      ctx.lineTo(tip.x - head * Math.cos(ang + 0.4), tip.y - head * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fill();
    }

    var bandFrom = this._linking ? this._linking.from
                 : (this.linkMode && this.linkFrom ? this.linkFrom : null);
    if (bandFrom && this._cursor) {
      ctx.strokeStyle = t.accent;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(bandFrom.x, bandFrom.y);
      ctx.lineTo(this._cursor.x, this._cursor.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (var k = 0; k < this.nodes.length; k++) {
      var n = this.nodes[k];
      if (hid[n.id]) continue;
      var sel = this.isSelected(n);
      var pending = this.linkFrom && this.linkFrom.id === n.id;
      var paint = this.paintOf(n, t);
      var y0 = n.y - n.h / 2;

      var dropping = this._dropOn === n;
      this._shapePath(ctx, n);
      ctx.fillStyle = paint.fill;
      ctx.fill();
      var limb = (n.color === 'plain' || !n.color) ? this.branchColorOf(n) : null;
      ctx.strokeStyle = (sel || pending || dropping) ? t.accent : (limb || paint.line);
      ctx.lineWidth = (pending || dropping) ? 3 : (sel ? 2 : (limb ? 1.6 : 1));
      if (dropping) ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      /* Clip to the outline before drawing anything inside it. The wrapping
         above should already fit, but measurement and the real glyphs can
         disagree by a pixel or two, and a node that leaks its text is much
         worse than one that trims a hair off a descender. */
      ctx.save();
      this._shapePath(ctx, n);
      ctx.clip();

      ctx.font = n._fs + 'px ' + this.fontStack;
      // centre the block of content inside the shape
      var blockH = n.lines.length * n._lh + (n.imgH ? n.imgH + (n.lines.length ? IMG_GAP : 0) : 0);
      var cursorY = n.y - blockH / 2;
      if (n.imgH) {
        var ix = n.x - n.imgW / 2;
        for (var pj = 0; pj < (n._pics || []).length; pj++) {
          var q = n._pics[pj];
          var qim = this._imgCache[q.id];
          var qx = ix + q.dx, qy = cursorY + q.dy;
          if (qim && qim !== 'loading') {
            ctx.save();
            this._roundRect(ctx, qx, qy, q.w, q.h, 6);
            ctx.clip();
            ctx.drawImage(qim, qx, qy, q.w, q.h);
            ctx.restore();
          } else {
            this._roundRect(ctx, qx, qy, q.w, q.h, 6);
            ctx.fillStyle = t.grid;
            ctx.fill();
          }
          if (this.selectedPic && this.selectedPic.nodeId === n.id &&
              this.selectedPic.i === q.i) {
            this._roundRect(ctx, qx, qy, q.w, q.h, 6);
            ctx.strokeStyle = t.accent;
            ctx.lineWidth = 2.5 / this.cam.s;
            ctx.setLineDash([5 / this.cam.s, 4 / this.cam.s]);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
        cursorY += n.imgH + (n.lines.length ? IMG_GAP : 0);
      }

      var tick = this.tickBox(n);
      var shiftText = tick ? tick.s * 0.7 : 0;
      ctx.fillStyle = t.text;
      if (n.done) ctx.globalAlpha = 0.55;        // done, so quieter
      for (var li = 0; li < n.lines.length; li++) {
        var ly = cursorY + li * n._lh + n._lh / 2;
        ctx.fillText(n.lines[li], n.x + shiftText, ly);
        if (n.done) {
          // ruled through, the width of the words and no more
          var lw2 = ctx.measureText(n.lines[li]).width;
          ctx.strokeStyle = t.text;
          ctx.lineWidth = Math.max(1, n._fs * 0.075);
          ctx.beginPath();
          ctx.moveTo(n.x + shiftText - lw2 / 2, ly);
          ctx.lineTo(n.x + shiftText + lw2 / 2, ly);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      if (tick) {
        /* A box to tick is the one thing in a node you are meant to aim at,
           so it is drawn like a control and not like a hairline: its own
           panel, a full-strength outline, and the accent when it is on. It
           was in the node's edge colour before and all but vanished. */
        var half = tick.s / 2;
        this._roundRect(ctx, tick.x - half, tick.y - half, tick.s, tick.s, 4);
        ctx.globalAlpha = n.done ? 1 : 0.9;
        ctx.fillStyle = n.done ? t.accent
          : (this.isDark() ? '#101219' : '#ffffff');
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = Math.max(1.8, tick.s * 0.13);
        ctx.strokeStyle = t.accent;
        ctx.stroke();
        if (n.done) {
          ctx.strokeStyle = t.node;
          ctx.lineWidth = Math.max(1.6, tick.s * 0.14);
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(tick.x - half * 0.44, tick.y + half * 0.04);
          ctx.lineTo(tick.x - half * 0.08, tick.y + half * 0.42);
          ctx.lineTo(tick.x + half * 0.5, tick.y - half * 0.42);
          ctx.stroke();
        }
      }
      ctx.restore();               // end the clip for this node
    }


    /* The fold handle: a small circle on the side of every node that has
       children, minus while the branch is open and plus with a count while it
       is away. Drawn after the nodes so it is never painted over. */
    for (var fk = 0; fk < this.nodes.length; fk++) {
      var fn2 = this.nodes[fk];
      if (hid[fn2.id]) continue;
      var fp = this.foldPoint(fn2);
      if (!fp) continue;
      var fr = Math.max(6, FOLD_R / this.cam.s);
      ctx.beginPath();
      ctx.arc(fp.x, fp.y, fr, 0, Math.PI * 2);
      ctx.fillStyle = fn2.collapsed ? t.accent : t.node;
      ctx.fill();
      ctx.lineWidth = 1.4 / this.cam.s;
      ctx.strokeStyle = this.branchColorOf(fn2) || t.edge;
      ctx.stroke();

      var bar = fr * 0.52;
      ctx.lineWidth = Math.max(1.4, 1.8 / this.cam.s);
      ctx.strokeStyle = fn2.collapsed ? t.node : t.text;
      ctx.beginPath();
      ctx.moveTo(fp.x - bar, fp.y);
      ctx.lineTo(fp.x + bar, fp.y);
      if (fn2.collapsed) {
        ctx.moveTo(fp.x, fp.y - bar);
        ctx.lineTo(fp.x, fp.y + bar);
      }
      ctx.stroke();

      if (fn2.collapsed) {
        var count = this.hiddenUnder(fn2);
        if (count) {
          ctx.font = Math.max(8, 9 / this.cam.s) + 'px ' + this.fontStack;
          ctx.fillStyle = t.text;
          ctx.textAlign = 'center';
          ctx.fillText(String(count), fp.x, fp.y + fr * 2.1);
        }
      }
    }


    /* The join being made. While a node is being carried onto another, the
       line it is about to hang from is drawn between them, ends marked --
       so you can see what it will join to before letting go, rather than
       finding out afterwards. */
    if (this._drag && this._drag.moved && this._dropOn && this._drag.node) {
      var da = this._drag.node, db = this._dropOn;
      var pa = borderPoint(da, db), pb = borderPoint(db, da);
      /* Once the boxes overlap the two border points are almost on top of
         each other, so the line all but disappears at the very moment it
         matters. Give it a length of its own, pointing away from the node it
         will hang from. */
      var STUB = Math.max(46, 58 / this.cam.s);
      var vx = pa.x - pb.x, vy = pa.y - pb.y;
      var vlen = Math.hypot(vx, vy);
      if (vlen < STUB) {
        if (vlen < 0.5) {                    // dead centre: point at the node's middle
          vx = da.x - db.x; vy = da.y - db.y;
          vlen = Math.hypot(vx, vy) || 1;
        }
        pa = { x: pb.x + vx / vlen * STUB, y: pb.y + vy / vlen * STUB };
      }
      ctx.save();
      // the node it will hang from, lit up rather than just outlined
      this._shapePath(ctx, db);
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = t.accent;
      ctx.fill();
      ctx.globalAlpha = 1;

      /* A run of arrowheads travelling towards the node it has found, each
         smaller than the one behind it -- a signal going somewhere, rather
         than a line that happens to be there. */
      var bx = pb.x - pa.x, by = pb.y - pa.y;
      var blen = Math.hypot(bx, by) || 1;
      var ux = bx / blen, uy = by / blen;
      var ang = Math.atan2(uy, ux);
      var big = Math.max(7, 10 / this.cam.s);
      var stepB = big * 1.7;
      var crawl = (Date.now() / 22) % stepB;
      ctx.fillStyle = t.accent;
      for (var d = crawl; d < blen; d += stepB) {
        var along = d / blen;                       // 0 at your hand, 1 at the target
        var size = big * (1 - 0.62 * along);        // shrinking as it arrives
        var px2 = pa.x + ux * d, py2 = pa.y + uy * d;
        ctx.globalAlpha = 0.3 + 0.7 * along;
        ctx.beginPath();
        ctx.moveTo(px2 + Math.cos(ang) * size, py2 + Math.sin(ang) * size);
        ctx.lineTo(px2 + Math.cos(ang + 2.5) * size * 0.8,
                   py2 + Math.sin(ang + 2.5) * size * 0.8);
        ctx.lineTo(px2 + Math.cos(ang - 2.5) * size * 0.8,
                   py2 + Math.sin(ang - 2.5) * size * 0.8);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.restore();

      /* And where it is going to sit once it gets there. */
      var spot = this.landingSpot(db, da);
      if (spot) {
        ctx.save();
        ctx.setLineDash([6 / this.cam.s, 5 / this.cam.s]);
        ctx.strokeStyle = t.accent;
        ctx.lineWidth = Math.max(1.6, 2 / this.cam.s);
        this._roundRect(ctx, spot.x - spot.w / 2, spot.y - spot.h / 2, spot.w, spot.h, 10);
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = t.accent;
        ctx.fill();
        ctx.globalAlpha = 0.85;
        ctx.stroke();
        ctx.setLineDash([]);

        // the link it will arrive on, sketched in
        var lp = borderPoint(db, spot);
        ctx.globalAlpha = 0.5;
        ctx.setLineDash([5 / this.cam.s, 4 / this.cam.s]);
        ctx.beginPath();
        ctx.moveTo(lp.x, lp.y);
        ctx.lineTo(spot.x - (spot.x - lp.x) * 0.06, spot.y - (spot.y - lp.y) * 0.06);
        ctx.stroke();
        ctx.restore();
      }
      this._beaming = true;
    }

    /* The corner grip on the chosen picture, for dragging it bigger. */
    var pick = this.selectedPic;
    if (pick) {
      var pn = this.byId(pick.nodeId);
      if (pn && pn._pics && !hid[pn.id]) {
        for (var gi = 0; gi < pn._pics.length; gi++) {
          if (pn._pics[gi].i !== pick.i) continue;
          var gq = pn._pics[gi];
          var gb = this._picBlock(pn);
          var cx2 = gb.x + gq.dx + gq.w, cy2 = gb.y + gq.dy + gq.h;
          var gr = Math.max(4, PIC_GRIP_R / this.cam.s);
          ctx.beginPath();
          ctx.arc(cx2, cy2, gr, 0, Math.PI * 2);
          ctx.fillStyle = t.accent;
          ctx.fill();
          ctx.lineWidth = 1.5 / this.cam.s;
          ctx.strokeStyle = t.node;
          ctx.stroke();
        }
      }
    }


    /* Where a picture being carried would drop: a bar in the gap it would go
       into, so the order it will end up in is visible before letting go. */
    if (this._picMove && this._picDown && this._picAt !== null &&
        this._picAt !== undefined) {
      var mn = this._picDown.node;
      if (mn && mn._pics && mn._pics.length) {
        var mb = this._picBlock(mn);
        var at = Math.max(0, Math.min(mn._pics.length, this._picAt));
        var ref = mn._pics[Math.min(at, mn._pics.length - 1)];
        var barX = at >= mn._pics.length
          ? mb.x + ref.dx + ref.w + IMG_GAP / 2
          : mb.x + ref.dx - IMG_GAP / 2;
        ctx.strokeStyle = t.accent;
        ctx.lineWidth = Math.max(2.5, 3 / this.cam.s);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(barX, mb.y + ref.dy);
        ctx.lineTo(barX, mb.y + ref.dy + ref.h);
        ctx.stroke();
      }
    }

    /* The circle that turns a node's children into a list. Only on the node
       you are working on, so a map is not covered in them. */
    for (var ck = 0; ck < this.nodes.length; ck++) {
      var cn = this.nodes[ck];
      if (hid[cn.id] || !this.isSelected(cn)) continue;
      var cp = this.checkPoint(cn);
      if (!cp) continue;
      var cr = Math.max(6, FOLD_R / this.cam.s);
      ctx.beginPath();
      ctx.arc(cp.x, cp.y, cr, 0, Math.PI * 2);
      ctx.fillStyle = cn.checklist ? t.accent : t.node;
      ctx.fill();
      ctx.lineWidth = 1.4 / this.cam.s;
      ctx.strokeStyle = cn.checklist ? t.accent : t.edge;
      ctx.stroke();
      var cb = cr * 0.5;
      ctx.lineWidth = Math.max(1.4, 1.8 / this.cam.s);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = cn.checklist ? t.node : t.text;
      ctx.beginPath();
      if (cn.checklist) {                     // already a list: show a tick
        ctx.moveTo(cp.x - cb * 0.8, cp.y);
        ctx.lineTo(cp.x - cb * 0.15, cp.y + cb * 0.7);
        ctx.lineTo(cp.x + cb * 0.85, cp.y - cb * 0.7);
      } else {                                 // not yet: a plus
        ctx.moveTo(cp.x - cb, cp.y);
        ctx.lineTo(cp.x + cb, cp.y);
        ctx.moveTo(cp.x, cp.y - cb);
        ctx.lineTo(cp.x, cp.y + cb);
      }
      ctx.stroke();
    }

    /* The two handles on the chosen relationship, with a thin line back to
       the end each one governs -- so which dot bends which half of the curve
       is something you can see rather than something you discover. */
    var knobs = this.edgeKnobs(this.selectedEdge);
    if (knobs) {
      var ke = this.edgeEnds(this.selectedEdge);
      var kr = Math.max(5, KNOB_R / this.cam.s);
      ctx.save();
      ctx.strokeStyle = t.accent;
      ctx.lineWidth = Math.max(0.8, 1 / this.cam.s);
      ctx.globalAlpha = 0.45;
      ctx.setLineDash([3 / this.cam.s, 3 / this.cam.s]);
      ctx.beginPath();
      ctx.moveTo(ke.a.x, ke.a.y);
      ctx.lineTo(knobs[0].x, knobs[0].y);
      ctx.moveTo(ke.b.x, ke.b.y);
      ctx.lineTo(knobs[1].x, knobs[1].y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      knobs.forEach(function (k) {
        ctx.beginPath();
        ctx.arc(k.x, k.y, kr, 0, Math.PI * 2);
        ctx.fillStyle = t.accent;
        ctx.fill();
        ctx.lineWidth = Math.max(1.2, 1.6 / this.cam.s);
        ctx.strokeStyle = t.node;
        ctx.stroke();
      }, this);
      ctx.restore();
    }

    /* The blade, and the links it has caught so far shown struck through. */
    if (this._blade && this._blade.pts.length > 1) {
      var bp = this._blade.pts;
      ctx.save();
      ctx.strokeStyle = t.danger || '#e0705f';
      ctx.lineWidth = Math.max(2, 2.5 / this.cam.s);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([7 / this.cam.s, 5 / this.cam.s]);
      ctx.beginPath();
      ctx.moveTo(bp[0].x, bp[0].y);
      for (var bi = 1; bi < bp.length; bi++) ctx.lineTo(bp[bi].x, bp[bi].y);
      ctx.stroke();
      ctx.setLineDash([]);

      var self2 = this;
      this._blade.cut.forEach(function (e) {
        var en = self2.edgeEnds(e);
        if (!en) return;
        var mid = bezierAt(0.5, en.a, en.c1, en.c2, en.b);
        var r2 = Math.max(6, 8 / self2.cam.s);
        ctx.strokeStyle = t.danger || '#e0705f';
        ctx.lineWidth = Math.max(2, 2.6 / self2.cam.s);
        ctx.beginPath();
        ctx.moveTo(mid.x - r2, mid.y - r2);
        ctx.lineTo(mid.x + r2, mid.y + r2);
        ctx.moveTo(mid.x + r2, mid.y - r2);
        ctx.lineTo(mid.x - r2, mid.y + r2);
        ctx.stroke();
      });
      ctx.restore();
    }

    if (this._marquee) {
      var m = this._marquee;
      var mx = Math.min(m.x0, m.x1), my = Math.min(m.y0, m.y1);
      var mw = Math.abs(m.x1 - m.x0), mh = Math.abs(m.y1 - m.y0);
      ctx.fillStyle = t.accent;
      ctx.globalAlpha = 0.12;
      ctx.fillRect(mx, my, mw, mh);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = t.accent;
      ctx.lineWidth = 1.5 / this.cam.s;
      ctx.setLineDash([5 / this.cam.s, 4 / this.cam.s]);
      ctx.strokeRect(mx, my, mw, mh);
      ctx.setLineDash([]);
    }

    // connectors + resize grip on the hovered / selected node
    var hn = this.handleNode();
    if (hn && !this.linkMode) {
      var r = Math.max(3.5, HANDLE_R / this.cam.s);
      this.handlePoints(hn).forEach(function (pt) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
        ctx.fillStyle = t.accent;
        ctx.fill();
        ctx.lineWidth = 1.5 / this.cam.s;
        ctx.strokeStyle = t.node;
        ctx.stroke();
      }, this);

      var g = Math.max(5, GRIP / this.cam.s);
      var gx = hn.x + hn.w / 2, gy = hn.y + hn.h / 2;
      ctx.beginPath();
      ctx.moveTo(gx - g, gy);
      ctx.lineTo(gx, gy);
      ctx.lineTo(gx, gy - g);
      ctx.strokeStyle = t.accent;
      ctx.lineWidth = 2.5 / this.cam.s;
      ctx.stroke();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // whatever was drawn mid-flight goes back to where it really is
    if (flying) {
      for (var ri = 0; ri < flying.length; ri++) {
        flying[ri].n.x = flying[ri].x;
        flying[ri].n.y = flying[ri].y;
      }
    }
  };

  /* ---------- input ---------- */

  Mindmap.prototype._bind = function () {
    var self = this, c = this.canvas;
    c.style.touchAction = 'none';

    c.addEventListener('pointerdown', function (e) {
      c.focus({ preventScroll: true });
      try { c.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
      /* A finger that ends without a pointerup -- the phone taking the
         gesture for a scroll, or the address bar sliding in -- would stay in
         this map for ever, and the next tap would look like the second finger
         of a pinch: nothing gets selected and the highlight stays on the node
         you tapped before. The first finger of any new gesture clears
         whatever was left behind. A mouse is always primary. */
      if (e.isPrimary) self._pointers.clear();
      self._pointers.set(e.pointerId, self._localPoint(e));

      if (self._pointers.size === 2) {
        var pts = Array.from(self._pointers.values());
        self._pinch = {
          d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
          s: self.cam.s,
          mid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
        };
        self._drag = null;
        return;
      }

      var p = self._localPoint(e);

      /* The middle button means "move the map", whatever is under the
         pointer. Caught here, before a single thing is hit-tested, because
         pressing the wheel over a node used to pick the node up instead. */
      if (e.button === 1) {
        e.preventDefault();
        self._picDown = null;
        self._picSize = null;
        self._picMove = false;
        self._dropOn = null;
        self._drag = { pan: true, sx: p.x, sy: p.y, cx: self.cam.x, cy: self.cam.y };
        c.style.cursor = 'grabbing';
        return;
      }

      /* A handle on the chosen relationship comes before anything else: it
         floats free of the boxes and can easily be lying over one. */
      var knob = self.linkMode ? null : self.hitEdgeKnob(p.x, p.y);
      if (knob) {
        self._knob = knob;
        self._drag = null;
        c.style.cursor = 'grabbing';
        return;
      }

      // connector dot first, then the resize grip, then the node itself
      /* The fold circle first. It is drawn on top of everything, and on a
         node's edge it can land on the same spot as a connector dot -- so
         whichever is asked first is the one that gets the tap. */
      // the box on a node in a list, and the circle that makes one
      var tickAt = self.linkMode ? null : self.hitTick(p.x, p.y);
      if (tickAt) {
        self._drag = null;
        self.toggleDone(tickAt);
        return;
      }
      var listAt = self.linkMode ? null : self.hitCheckToggle(p.x, p.y);
      if (listAt) {
        self._drag = null;
        self.toggleChecklist(listAt);
        if (self.opts.onSelect) self.opts.onSelect(self.selected);
        return;
      }

      var fold = self.linkMode ? null : self.hitFold(p.x, p.y);
      if (fold) {
        self._drag = null;
        self.toggleCollapse(fold);
        return;
      }

      /* The corner of the chosen picture: dragging it resizes that picture
         and nothing else, so it is asked about before anything else. */
      var pgrip = self.linkMode ? null : self.hitPicGrip(p.x, p.y);
      if (pgrip) {
        self._drag = null;
        self._picDown = null;
        var w0 = self.toWorld(p.x, p.y);
        self._picSize = { node: pgrip.node, i: pgrip.i, w: pgrip.w, sx: w0.x };
        return;
      }

      /* A picture inside the node you are already on. Only noted here: a
         press that turns into a drag is either the picture being carried to
         another place in the row, or the node being picked up. */
      self._picDown = self.linkMode ? null : self.hitPic(p.x, p.y);
      if (self._picDown) {
        var pw = self.toWorld(p.x, p.y);
        self._picDown.sx = p.x;
        self._picDown.sy = p.y;
        self._picDown.wx = pw.x;
        self._picDown.wy = pw.y;
      }

      var handle = self.linkMode ? null : self.hitHandle(p.x, p.y);
      if (handle) {
        self.select(handle.node);
        self._linking = { from: handle.node };
        self._cursor = self.toWorld(p.x, p.y);
        self._drag = null;
        self.draw();
        return;
      }
      var grip = self.linkMode ? null : self.hitGrip(p.x, p.y);
      if (grip) {
        self.select(grip);
        self._resizing = {
          node: grip, w0: grip.w, h0: grip.h,
          ratio: grip.h / (grip.w || 1), moved: false
        };
        self._drag = null;
        return;
      }

      var n = self.hit(p.x, p.y);
      /* A finger cannot hover, so the dots would otherwise stay on whichever
         node the pointer passed over last -- which read as the controls being
         stuck on the node you selected before. */
      if (e.pointerType !== 'mouse') self._hover = n;

      // held still on a node: its menu, the same one the right button gives
      if (n && e.pointerType !== 'mouse' && self.opts.onNodeMenu) {
        clearTimeout(self._pressTimer);
        self._pressTimer = setTimeout(function () {
          self._pressTimer = null;
          // already carrying it somewhere: that is not a long press
          if (self._drag && self._drag.moved) return;
          self._drag = null;
          self.select(n);
          self.opts.onNodeMenu(n, e.clientX, e.clientY);
        }, 620);
      }

      if (self.linkMode) {
        if (n) {
          var r = self.linkTo(n);
          if (self.opts.onLinkStep) self.opts.onLinkStep(r);
        } else {
          var edge = self.hitEdge(p.x, p.y);
          if (edge) {
            self.edges = self.edges.filter(function (x) { return x !== edge; });
            self._changed();
            if (self.opts.onLinkStep) self.opts.onLinkStep('unlinked');
          }
        }
        return;
      }

      if (n) {
        // Shift decides on pointerup: a shift-click toggles the selection, a
        // shift-drag moves the node together with everything under it.
        if (!e.shiftKey && !self.isSelected(n)) self.select(n);

        var movers;
        if (e.shiftKey) movers = [n].concat(self.descendantsOf(n));
        else if (self.isSelected(n) && self.selection.length > 1) movers = self.selection.slice();
        else movers = [n];

        var w = self.toWorld(p.x, p.y);
        // how far each one sits from its parent right now, to measure the pull against
        var gaps = {};
        movers.forEach(function (m) {
          var par = self.parentOf(m);
          if (par) gaps[m.id] = Math.hypot(m.x - par.x, m.y - par.y);
        });
        self._drag = {
          node: n, moved: false, sx: p.x, sy: p.y, shift: e.shiftKey, gaps: gaps,
          movers: movers.map(function (m) { return { n: m, dx: m.x - w.x, dy: m.y - w.y }; })
        };
      } else {
        var edge2 = self.hitEdgeLabel(p.x, p.y) || self.hitEdge(p.x, p.y);
        if (edge2) {
          self.selection = [];
          self.selected = null;
          self.selectedEdge = edge2;
          if (self.opts.onSelect) self.opts.onSelect(null);
          if (self.opts.onEdgeSelect) self.opts.onEdgeSelect(edge2);
          self.draw();
          self._drag = null;
          return;
        }
        if (e.shiftKey && (e.ctrlKey || e.metaKey)) {
          /* A blade. Drawn across the map, it cuts every link it passes
             through -- which is the thing you actually want to say, rather
             than picking a thin curve out and pressing a button about it. */
          var bw = self.toWorld(p.x, p.y);
          self._blade = { pts: [bw], cut: [] };
          self._drag = null;
          self.draw();
          return;
        }
        if (self.selectMode || e.shiftKey) {
          // shift and drag rounds up everything the box touches, as it always did
          var mw = self.toWorld(p.x, p.y);
          self._marquee = {
            x0: mw.x, y0: mw.y, x1: mw.x, y1: mw.y,
            base: e.shiftKey ? self.selection.slice() : []
          };
          self._drag = null;
          self.draw();
          return;
        }
        self.select(null);
        self._drag = { pan: true, sx: p.x, sy: p.y, cx: self.cam.x, cy: self.cam.y };
      }
    });

    c.addEventListener('pointermove', function (e) {
      var lp0 = self._localPoint(e);

      if (self._knob) {
        self.moveEdgeKnob(self._knob.edge, self._knob.i, lp0.x, lp0.y);
        return;
      }

      if (self._resizing) {
        var wp = self.toWorld(lp0.x, lp0.y);
        var rz = self._resizing;
        var wantW = Math.max(60, Math.min(1200, Math.round((wp.x - rz.node.x) * 2)));
        var wantH = Math.max(40, Math.min(1200, Math.round((wp.y - rz.node.y) * 2)));
        if (e.shiftKey) {
          // uniform: follow whichever axis was dragged further, keep the ratio
          if (Math.abs(wantW - rz.w0) >= Math.abs(wantH - rz.h0)) wantH = Math.round(wantW * rz.ratio);
          else wantW = Math.round(wantH / (rz.ratio || 1));
        }
        rz.node.w0 = wantW;
        rz.node.h0 = wantH;
        rz.moved = true;
        self._layout();
        self.draw();
        return;
      }
      if (self._linking) {
        self._cursor = self.toWorld(lp0.x, lp0.y);
        self._hover = self.hit(lp0.x, lp0.y) || self._linking.from;
        self.draw();
        return;
      }
      if (self._blade) {
        var bp = self.toWorld(lp0.x, lp0.y);
        var last = self._blade.pts[self._blade.pts.length - 1];
        if (Math.hypot(bp.x - last.x, bp.y - last.y) > 2) {
          self.edgesCrossedBy(last, bp).forEach(function (e) {
            if (self._blade.cut.indexOf(e) === -1) self._blade.cut.push(e);
          });
          self._blade.pts.push(bp);
          self.draw();
        }
        return;
      }
      if (self._marquee) {
        var mw = self.toWorld(lp0.x, lp0.y);
        self._marquee.x1 = mw.x;
        self._marquee.y1 = mw.y;
        self.selectMany(self._marquee.base.concat(
          self.nodesInRect(self._marquee).filter(function (n) {
            return self._marquee.base.indexOf(n) === -1;
          })
        ));
        return;
      }
      if (self.linkMode && self.linkFrom) {
        self._cursor = self.toWorld(lp0.x, lp0.y);
        self.draw();
      }
      // hovering a node reveals its connectors, so linking needs no mode
      if (!self._drag && !self._pinch) {
        var over = self.hit(lp0.x, lp0.y);
        if (over !== self._hover) { self._hover = over; self.draw(); }
        if (!self.linkMode && !over) {
          var grabbable = self.hitEdgeKnob(lp0.x, lp0.y);
          var words = grabbable ? null : self.hitEdgeLabel(lp0.x, lp0.y);
          c.style.cursor = grabbable ? 'grab' : (words ? 'text' : '');
        }
      }
      if (!self._pointers.has(e.pointerId)) return;
      self._pointers.set(e.pointerId, self._localPoint(e));

      if (self._pinch && self._pointers.size === 2) {
        var pts = Array.from(self._pointers.values());
        var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        var ns = Math.max(0.2, Math.min(3, self._pinch.s * (d / (self._pinch.d || 1))));
        var m = self._pinch.mid;
        var before = self.toWorld(m.x, m.y);
        self.cam.s = ns;
        self.cam.x = m.x - before.x * ns;
        self.cam.y = m.y - before.y * ns;
        self.draw();
        return;
      }
      if (self._picSize) {
        var pw2 = self.toWorld(lp0.x, lp0.y);
        var ps = self._picSize;
        self.sizePicTo(ps.node, ps.i, Math.max(18, ps.w + (pw2.x - ps.sx)));
        return;
      }

      /* A picture carried along the row. The one under the finger is drawn
         where the finger is, and the gap it would drop into is marked. */
      if (self._picDown && self.selectedPic &&
          self.selectedPic.nodeId === self._picDown.node.id &&
          self.selectedPic.i === self._picDown.i) {
        if (!self._picMove &&
            Math.hypot(lp0.x - self._picDown.sx, lp0.y - self._picDown.sy) > DRAG_SLOP * 2) {
          self._picMove = true;
          self._drag = null;
        }
        if (self._picMove) {
          var mw = self.toWorld(lp0.x, lp0.y);
          self._picAt = self.picDropIndex(self._picDown.node, mw.x, mw.y);
          self.draw();
          return;
        }
      }

      if (self._pressTimer && self._drag &&
          Math.hypot(lp0.x - self._drag.sx, lp0.y - self._drag.sy) > 6) {
        clearTimeout(self._pressTimer);
        self._pressTimer = null;
      }
      if (!self._drag) return;
      var p = self._localPoint(e);
      if (self._drag.pan) {
        self.cam.x = self._drag.cx + (p.x - self._drag.sx);
        self.cam.y = self._drag.cy + (p.y - self._drag.sy);
        self.draw();
      } else {
        if (!self._drag.moved &&
            Math.hypot(p.x - self._drag.sx, p.y - self._drag.sy) < DRAG_SLOP) return;

        /* Letting go of a parent takes a deliberate pull. A short drag just
           moves the node about; only once it has been carried a good way from
           where it started does the link give. Cutting on the first flicker
           made nodes fall off their branch by accident, which is worse than
           having to mean it. */
        var w = self.toWorld(p.x, p.y);
        self._drag.movers.forEach(function (m) {
          m.n.x = w.x + m.dx;
          m.n.y = w.y + m.dy;
        });
        self._drag.moved = true;

        /* Does it come off? Measured as how much further from its parent it
           has been taken, not how far the finger has travelled -- carrying a
           node in a circle back to where it was is not asking for anything.
           A map you arrange by hand asks for a much longer pull, because
           moving nodes about is the whole business there. */
        if (!self._drag.cuts) {
          var reach = PULL * (self.auto ? 1 : HAND_PULL);
          var carried = self._drag.movers.map(function (m) { return m.n; });
          var loose = [];
          carried.forEach(function (nd) {
            var par = self.parentOf(nd);
            if (!par || carried.indexOf(par) !== -1) return;   // moving together
            var was = self._drag.gaps[nd.id];
            var now = Math.hypot(nd.x - par.x, nd.y - par.y);
            if (was === undefined || now < was + reach) return;
            loose.push(nd);
          });
          if (loose.length) {
            self._drag.cuts = [];
            loose.forEach(function (nd) {
              var cut = self._cutParent(nd);
              if (cut) self._drag.cuts.push(cut);
            });
            self.draw();
          }
        }

        // touching another node is what joins them, so the whole branch is
        // off limits -- a node cannot be hung underneath itself
        var moving = self._drag.movers.map(function (m) { return m.n; });
        var off = moving.slice();
        moving.forEach(function (mv) {
          self.descendantsOf(mv).forEach(function (d) {
            if (off.indexOf(d) === -1) off.push(d);
          });
        });
        self._dropOn = self.kissing(self._drag.node, off);
        self.draw();
      }
    });

    var lastTap = 0, lastNode = null;

    function endPointer(e) {
      clearTimeout(self._pressTimer);
      self._pressTimer = null;

      if (self._knob) {
        self._knob = null;
        c.style.cursor = '';
        self._changed();                       // one save, at the end of the drag
        self._pointers.delete(e.pointerId);
        return;
      }
      if (e.button === 1 || (self._drag && self._drag.pan)) {
        c.style.cursor = self.linkMode ? 'crosshair' : '';
      }

      if (self._picSize) {
        self._picSize = null;
        self._picDown = null;
        self._changed();                       // one save, at the end of the drag
        self._pointers.delete(e.pointerId);
        return;
      }

      if (self._picMove && self._picDown) {
        var moved = self._picDown;
        var at = self._picAt;
        self._picMove = false;
        self._picAt = null;
        self._picDown = null;
        if (at !== null && at !== undefined) self.movePic(moved.node, moved.i, at);
        else self.draw();
        self._pointers.delete(e.pointerId);
        if (self._pointers.size === 0) self._drag = null;
        return;
      }

      if (self._blade) {
        var cut = self._blade.cut;
        self._blade = null;
        if (cut.length) {
          self.edges = self.edges.filter(function (x) { return cut.indexOf(x) === -1; });
          self._changed();
          if (self.opts.onCut) self.opts.onCut(cut.length);
        } else {
          self.draw();
        }
        self._pointers.delete(e.pointerId);
        return;
      }

      var tapped = self._picDown;
      self._picDown = null;
      if (tapped && !(self._drag && self._drag.moved)) {
        var same = self.selectedPic &&
                   self.selectedPic.nodeId === tapped.node.id &&
                   self.selectedPic.i === tapped.i;
        self.selectPic(same ? null : tapped);   // tap it again to let it go
        self._pointers.delete(e.pointerId);
        if (self._pointers.size === 0) self._drag = null;
        return;
      }
      if (self._marquee) {
        self._marquee = null;
        self._pointers.delete(e.pointerId);
        self.draw();
        return;
      }
      if (self._drag && self._drag.shift && !self._drag.moved) {
        // a shift-click that never moved: add or remove from the selection
        self.toggleSelect(self._drag.node);
        self._drag = null;
        self._pointers.delete(e.pointerId);
        return;
      }
      if (self._resizing) {
        var wasResize = self._resizing;
        self._resizing = null;
        self._pointers.delete(e.pointerId);
        if (wasResize.moved) self._changed();
        return;
      }
      if (self._linking) {
        var lp = self._localPoint(e);
        var drop = self.hit(lp.x, lp.y);
        var from = self._linking.from;
        self._linking = null;
        self._cursor = null;
        self._pointers.delete(e.pointerId);
        if (drop && drop.id !== from.id) {
          var dup = self.edges.some(function (x) {
            return (x.a === from.id && x.b === drop.id) || (x.a === drop.id && x.b === from.id);
          });
          if (!dup) {
            /* A relationship, the same as the link tool makes. A branch comes
               from carrying one node onto another, and a node has exactly one
               parent -- so a thread drawn between two of them can only be the
               other sort of connection, the kind with words on it. */
            var made = self.relate(from, drop, '');
            self.selectedEdge = made;
            if (self.opts.onEdgeSelect) self.opts.onEdgeSelect(made);
            if (self.opts.onLinkStep) self.opts.onLinkStep('related');
          } else if (self.opts.onLinkStep) {
            self.opts.onLinkStep('duplicate');
          }
        }
        /* A connector let go over empty space used to make a node there. It
           reads well and goes wrong constantly: every slip of the hand while
           linking left another "Idea" behind. Nodes come from the + button,
           the node menu and Tab/Enter, all of which you meant to press. */
        self.draw();
        return;
      }
      if (e.pointerType === 'touch' && e.type === 'pointerup' && !self.linkMode) {
        var p = self._localPoint(e);
        var n = self.hit(p.x, p.y);
        var now = Date.now();
        if (n && lastNode && lastNode.id === n.id && now - lastTap < 340 &&
            !(self._drag && self._drag.moved) && self.opts.onRename) {
          self.select(n);
          self.opts.onRename(n);
        }
        lastTap = now;
        lastNode = n;
      }
      self._pointers.delete(e.pointerId);
      if (self._pointers.size < 2) self._pinch = null;
      if (self._drag && self._drag.moved && self._dropOn) {
        /* Joined on. It may never have been pulled far enough to come off by
           itself -- dropping it onto another node says what you meant either
           way -- so the old link goes now if it is still there. */
        /* Everything being carried goes under it, not only the one under
           the finger -- and in the order they were lying in, so the branch
           reads the way it looked. A node whose own parent came along keeps
           that parent: the group arrives with its shape intact. */
        var group = self._drag.movers.map(function (m) { return m.n; });
        var landing = group.filter(function (nd) {
          var par = self.parentOf(nd);
          return !par || group.indexOf(par) === -1;
        }).sort(function (a, b) { return a.y - b.y; });

        landing.forEach(function (nd) {
          self.hangUnder(nd, self._dropOn);
          delete nd.free;                    // back in the tree; arrange it
        });
        if (landing.length > 1 && self.opts.onHung) self.opts.onHung(landing.length);
        self.selectMany(group);
        self._dropOn = null;
        self._changed();
      } else if (self._drag && self._drag.moved) {
        /* Let go in open space. If it came off its branch on the way it is a
           node of its own now, and it stays exactly where it was put --
           tidying it away to the bottom of the map is how it used to get lost
           the moment it was detached. */
        if (self._drag.cuts && self._drag.cuts.length) self._drag.node.free = true;
        self._dropOn = null;
        self._changed();
      }
      if (self._pointers.size === 0) self._drag = null;
    }
    c.addEventListener('contextmenu', function (e) {
      if (!self.opts.onNodeMenu) return;
      var p = self._localPoint(e);
      var n = self.hit(p.x, p.y);
      e.preventDefault();
      if (!n) return;
      self.select(n);
      self.opts.onNodeMenu(n, e.clientX, e.clientY);
    });

    /* Chrome answers a middle click with its scroll-anywhere cursor, and
       follows it with an auxclick. Neither belongs on a canvas being panned. */
    c.addEventListener('mousedown', function (e) {
      if (e.button === 1) e.preventDefault();
    });
    c.addEventListener('auxclick', function (e) {
      if (e.button === 1) e.preventDefault();
    });

    c.addEventListener('pointerup', endPointer);
    c.addEventListener('pointercancel', endPointer);

    c.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = self._localPoint(e);
      var before = self.toWorld(p.x, p.y);
      var ns = Math.max(0.2, Math.min(3, self.cam.s * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      self.cam.s = ns;
      self.cam.x = p.x - before.x * ns;
      self.cam.y = p.y - before.y * ns;
      self.draw();
    }, { passive: false });

    c.addEventListener('dblclick', function (e) {
      if (self.linkMode) return;
      var p = self._localPoint(e);

      // a handle, double-clicked, gives the curve its plain arc back
      var kn = self.hitEdgeKnob(p.x, p.y);
      if (kn) { self.resetEdgeCurve(kn.edge); return; }

      /* The words on a relationship are edited where they lie, like a node's
         are -- a dialog for three words in the middle of a map is a detour. */
      var lab = self.hitEdgeLabel(p.x, p.y);
      if (lab) {
        self.selectedEdge = lab;
        self.draw();
        if (self.opts.onEdgeRename) self.opts.onEdgeRename(lab);
        return;
      }

      var n = self.hit(p.x, p.y);
      if (n && self.opts.onRename) {
        self.select(n);
        self.opts.onRename(n);
      }
      // double-clicking the canvas used to make a node too: same reason, gone
    });

    c.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;   // app-level shortcuts
      var handled = true;
      if (e.key === 'Tab') {
        var made = e.shiftKey ? self.addSibling() : self.addChild();
        self.reveal(made);
        if (made && self.opts.onRename) self.opts.onRename(made, true);
      } else if (e.key === 'Enter') {
        // Enter makes the next one along, the way every outline works
        if (self.selected) {
          var sib = self.addSibling();
          self.reveal(sib);
          if (sib && self.opts.onRename) self.opts.onRename(sib, true);
        } else handled = false;
      } else if (e.key === 'F2') {
        if (self.selected && self.opts.onRename) self.opts.onRename(self.selected);
        else handled = false;
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!self.deleteSelected()) handled = false;
      } else if (e.key === 'Escape') {
        if (self.linkMode) self.setLinkMode(false);
        else if (self.selectMode) self.setSelectMode(false);
        else self.select(null);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
                 e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (!self.selected) { handled = false; }
        else if (e.shiftKey && !self.auto) {
          // hand placement: shift and an arrow nudges the node itself
          var step = 20;
          if (e.key === 'ArrowUp') self.selected.y -= step;
          if (e.key === 'ArrowDown') self.selected.y += step;
          if (e.key === 'ArrowLeft') self.selected.x -= step;
          if (e.key === 'ArrowRight') self.selected.x += step;
          self.reveal(self.selected);
          self._changed();
        } else {
          // the arrows walk the map: out to a child, back to the parent,
          // up and down between the nodes that share a parent
          var go = self.step(self.selected, e.key);
          if (go) { self.select(go); self.reveal(go); }
          else handled = false;
        }
      } else {
        handled = false;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    });
  };

  /* ---------- SVG output for PDF / HTML export ---------- */

  Mindmap.toSVG = function (map, opts) {
    opts = opts || {};
    var images = opts.images || {};       // imageId -> { url (data URI), w, h }
    var dark = !!opts.dark;
    var size = opts.fontSize || DEF_SIZE;
    var stack = opts.fontStack || DEF_STACK;
    var lineH = lineHeightFor(size);
    var maxW = wrapWidthFor(size);
    var probe = document.createElement('canvas').getContext('2d');
    probe.font = size + 'px ' + stack;

    function wrap(text, width) {
      var words = String(text || '').split(/\s+/).filter(Boolean);
      if (!words.length) return [];
      var lines = [], line = '';
      for (var i = 0; i < words.length; i++) {
        var pr = line ? line + ' ' + words[i] : words[i];
        if (probe.measureText(pr).width > width && line) { lines.push(line); line = words[i]; }
        else { line = pr; }
      }
      lines.push(line);
      return lines;
    }

    var nodes = (map && map.nodes ? map.nodes : []).map(function (n) {
      var fs = n.fs || size;
      var lh = lineHeightFor(fs);
      var shape = SHAPES[n.shape] ? n.shape : 'round';
      var sh = SHAPES[shape];
      probe.font = fs + 'px ' + stack;
      var lines = wrap(n.text, n.w0 ? Math.max(40, n.w0 / sh.padX - PAD_X * 2) : wrapWidthFor(fs));
      var textW = 0;
      lines.forEach(function (l) { textW = Math.max(textW, probe.measureText(l).width); });
      var imgW = 0, imgH = 0, rec = n.image ? images[n.image] : null;
      if (rec && rec.w && rec.h) {
        var scale = Math.min(IMG_MAX_W / rec.w, IMG_MAX_H / rec.h, 1);
        imgW = Math.round(rec.w * scale);
        imgH = Math.round(rec.h * scale);
      }
      var cw = Math.max(70, Math.min(wrapWidthFor(fs), textW), imgW) + PAD_X * 2;
      var ch = PAD_Y * 2 + lines.length * lh + (imgH ? imgH + (lines.length ? IMG_GAP : 0) : 0);
      var w = n.w0 || Math.round(cw * sh.padX);
      var h = n.h0 || Math.round(ch * sh.padY);
      if (sh.equal) {
        var side = Math.max(w, h);
        if (!n.w0) w = side;
        if (!n.h0) h = side;
      }
      return {
        id: n.id, x: n.x || 0, y: n.y || 0, lines: lines, color: n.color,
        shape: shape, fs: fs, lh: lh,
        img: rec || null, imgW: imgW, imgH: imgH, w: w, h: h
      };
    });
    if (!nodes.length) return '';

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(function (n) {
      minX = Math.min(minX, n.x - n.w / 2); maxX = Math.max(maxX, n.x + n.w / 2);
      minY = Math.min(minY, n.y - n.h / 2); maxY = Math.max(maxY, n.y + n.h / 2);
    });
    var pad = 24;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    var W = maxX - minX, H = maxY - minY;
    var idx = {};
    nodes.forEach(function (n) { idx[n.id] = n; });

    var stroke = opts.edge || '#8b8f9a';
    var baseFill = opts.node || '#f2f0ec';
    var baseLine = opts.border || '#c9c6bf';
    var text = opts.text || '#1a1a1a';

    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    var parts = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="' +
      minX + ' ' + minY + ' ' + W + ' ' + H + '" width="' + Math.round(W) +
      '" height="' + Math.round(H) + '" font-family="' + stack.replace(/"/g, "'") + '">'];

    if (opts.background) {
      parts.push('<rect x="' + minX + '" y="' + minY + '" width="' + W + '" height="' + H +
        '" fill="' + opts.background + '"/>');
    }

    var mapStyle = (map && map.style) || {};
    var defType = EDGE_TYPES[mapStyle.type] ? mapStyle.type : DEF_EDGE.type;
    var defWidth = mapStyle.width || DEF_EDGE.width;

    (map.edges || []).forEach(function (e) {
      var a = idx[e.a], b = idx[e.b];
      if (!a || !b) return;
      var pa = borderPoint(a, b), pb = borderPoint(b, a);
      var type = EDGE_TYPES[e.t] ? e.t : defType;
      var lw = e.w || defWidth;
      var mx = (pa.x + pb.x) / 2;

      if (type === 'tapered') {
        var dxT = pb.x - pa.x, dyT = pb.y - pa.y;
        var lenT = Math.hypot(dxT, dyT) || 1;
        var half = Math.max(1.2, lw * 1.9);
        var nxT = -dyT / lenT * half, nyT = dxT / lenT * half;
        var mxT = (pa.x + pb.x) / 2, myT = (pa.y + pb.y) / 2;
        parts.push('<path d="M' + (pa.x + nxT) + ' ' + (pa.y + nyT) +
          ' Q' + (mxT + nxT * 0.6) + ' ' + (myT + nyT * 0.6) + ' ' + pb.x + ' ' + pb.y +
          ' Q' + (mxT - nxT * 0.6) + ' ' + (myT - nyT * 0.6) + ' ' +
          (pa.x - nxT) + ' ' + (pa.y - nyT) + ' Z" fill="' + stroke + '"/>');
        return;
      }

      var d;
      if (type === 'straight' || type === 'dotted') {
        d = 'M' + pa.x + ' ' + pa.y + ' L' + pb.x + ' ' + pb.y;
      } else if (type === 'sketch') {
        var sc = sketchControls({ a: pa, b: pb }, seedOf(e));
        d = 'M' + pa.x + ' ' + pa.y + ' C' + sc.c1.x + ' ' + sc.c1.y + ' ' +
            sc.c2.x + ' ' + sc.c2.y + ' ' + pb.x + ' ' + pb.y;
      } else {
        d = 'M' + pa.x + ' ' + pa.y + ' C' + mx + ' ' + pa.y + ' ' + mx +
            ' ' + pb.y + ' ' + pb.x + ' ' + pb.y;
      }
      parts.push('<path d="' + d + '" fill="none" stroke="' + stroke +
        '" stroke-width="' + lw + '" stroke-linecap="round"' +
        (type === 'dotted' ? ' stroke-dasharray="' + (lw * 0.6) + ',' + (lw * 2.6) + '"' : '') +
        '/>');
    });

    nodes.forEach(function (n) {
      var pal = PALETTE[n.color];
      var fill, line;
      if (isHex(n.color)) {
        fill = mixHex(n.color, dark ? '#1b1d23' : '#ffffff', dark ? 0.72 : 0.78);
        line = n.color;
      } else {
        fill = (pal && pal.line) ? (dark ? pal.dark : pal.light) : baseFill;
        line = (pal && pal.line) ? pal.line : baseLine;
      }
      var x0 = n.x - n.w / 2, y0 = n.y - n.h / 2;

      if (n.shape === 'circle' || n.shape === 'ellipse') {
        parts.push('<ellipse cx="' + n.x + '" cy="' + n.y + '" rx="' + (n.w / 2) +
          '" ry="' + (n.h / 2) + '" fill="' + fill + '" stroke="' + line +
          '" stroke-width="1"/>');
      } else if (n.shape === 'diamond') {
        parts.push('<polygon points="' + n.x + ',' + y0 + ' ' + (x0 + n.w) + ',' + n.y +
          ' ' + n.x + ',' + (y0 + n.h) + ' ' + x0 + ',' + n.y +
          '" fill="' + fill + '" stroke="' + line + '" stroke-width="1"/>');
      } else {
        parts.push('<rect x="' + x0 + '" y="' + y0 + '" width="' + n.w + '" height="' + n.h +
          '" rx="' + (n.shape === 'rect' || n.shape === 'square' ? 0 : 10) +
          '" fill="' + fill + '" stroke="' + line + '" stroke-width="1"/>');
      }

      var blockH = n.lines.length * n.lh +
                   (n.imgH ? n.imgH + (n.lines.length ? IMG_GAP : 0) : 0);
      var cursorY = n.y - blockH / 2;
      if (n.img && n.imgH) {
        parts.push('<image x="' + (n.x - n.imgW / 2) + '" y="' + cursorY + '" width="' + n.imgW +
          '" height="' + n.imgH + '" preserveAspectRatio="xMidYMid slice" href="' + n.img.url + '"/>');
        cursorY += n.imgH + (n.lines.length ? IMG_GAP : 0);
      }
      n.lines.forEach(function (l, li) {
        parts.push('<text x="' + n.x + '" y="' + (cursorY + li * n.lh + n.lh / 2) +
          '" fill="' + text + '" font-size="' + n.fs + '" text-anchor="middle" ' +
          'dominant-baseline="middle">' + esc(l) + '</text>');
      });
    });
    parts.push('</svg>');
    return parts.join('');
  };

  Mindmap.isHexColor = isHex;
  Mindmap.saturateHex = saturate;
  Mindmap.PALETTE = PALETTE;
  Mindmap.COLOR_KEYS = COLOR_KEYS;
  Mindmap.SHAPES = SHAPES;
  Mindmap.SHAPE_KEYS = SHAPE_KEYS;
  Mindmap.EDGE_TYPES = EDGE_TYPES;
  Mindmap.LAYOUTS = LAYOUTS;
  Mindmap.EDGE_KEYS = EDGE_KEYS;
  global.Mindmap = Mindmap;
})(window);
