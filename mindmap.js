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
    curve:    'Curved',
    straight: 'Straight',
    sketch:   'Hand-drawn',
    dotted:   'Dotted',
    tapered:  'Tapered'
  };
  var EDGE_KEYS = Object.keys(EDGE_TYPES);
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
        image: n.image || null,
        shape: SHAPES[n.shape] ? n.shape : 'round',
        fs: n.fs || 0,           // per-node font size; 0 = follow the app setting
        w0: n.w0 || 0,           // manual width;  0 = size to content
        h0: n.h0 || 0,           // manual height; 0 = size to content
        noteId: n.noteId || null // reserved: the note this node stands for
      };
    });
    this.edges = (map && map.edges ? map.edges : []).filter(function (e) {
      return e && e.a && e.b;
    }).map(function (e) {
      var out = { a: e.a, b: e.b };
      if (EDGE_TYPES[e.t]) out.t = e.t;    // per-edge overrides of the map default
      if (e.w) out.w = e.w;
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
    this._ensureImages();
    this._layout();
    this._prune();
  };

  Mindmap.prototype.getData = function () {
    return {
      nodes: this.nodes.map(function (n) {
        var o = { id: n.id, text: n.text, x: Math.round(n.x), y: Math.round(n.y) };
        if (n.color && n.color !== 'plain') o.color = n.color;
        if (n.image) o.image = n.image;
        if (n.shape && n.shape !== 'round') o.shape = n.shape;
        if (n.fs) o.fs = Math.round(n.fs);
        if (n.w0) o.w0 = Math.round(n.w0);
        if (n.h0) o.h0 = Math.round(n.h0);
        if (n.noteId) o.noteId = n.noteId;
        return o;
      }),
      edges: this.edges.map(function (e) {
        var o = { a: e.a, b: e.b };
        if (e.t) o.t = e.t;
        if (e.w) o.w = e.w;
        return o;
      }),
      style: {
        type: this.style.type,
        width: this.style.width,
        auto: this.auto || undefined,
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
      if (n.image && out.indexOf(n.image) === -1) out.push(n.image);
    });
    return out;
  };

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
  };

  Mindmap.prototype._changed = function () {
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
      if (!n.image || self._imgCache[n.image] !== undefined) return;
      self._imgCache[n.image] = 'loading';
      self.opts.resolveImage(n.image).then(function (url) {
        if (!url) { self._imgCache[n.image] = null; return; }
        var im = new Image();
        im.onload = function () {
          self._imgCache[n.image] = im;
          // Keep the real ratio against the node. Until an image has loaded its
          // naturalWidth is 0, and the placeholder used to guess 3:2 -- so a
          // portrait photo drew stretched, then snapped when it arrived.
          if (im.naturalWidth && im.naturalHeight) {
            self._ratio[n.image] = im.naturalWidth / im.naturalHeight;
          }
          self._layout();
          self.draw();
        };
        im.onerror = function () { self._imgCache[n.image] = null; };
        im.src = url;
      }, function () { self._imgCache[n.image] = null; });
    });
  };

  Mindmap.prototype.attachImage = function (imageId, node) {
    var target = node || this.selected;
    if (!target) {
      target = this.addNodeQuiet('', undefined, undefined);
    }
    target.image = imageId;
    delete this._imgCache[imageId];
    this._ensureImages();
    this._layout();
    this.select(target);
    this._changed();
    return target;
  };

  Mindmap.prototype.detachImage = function () {
    if (!this.selected || !this.selected.image) return false;
    this.selected.image = null;
    if (!this.selected.text) this.selected.text = 'Idea';
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
    this.edges.forEach(function (e) {
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

  Mindmap.prototype._layout = function () {
    var ctx = this.ctx;
    var depth = this._depthMap();
    for (var i = 0; i < this.nodes.length; i++) {
      var n = this.nodes[i];
      var shape = SHAPES[n.shape] || SHAPES.round;

      // a node can carry its own size; otherwise its place in the branch decides
      var d = depth[n.id];
      var grade = d === 0 ? 1.18 : d === 1 ? 1.02 : 0.92;
      n._fs = n.fs || Math.max(10, Math.round(this.fontSize * grade));
      n._lh = lineHeightFor(n._fs);
      ctx.font = n._fs + 'px ' + this.fontStack;

      // a manually resized node wraps to the width you gave it
      var inner = n.w0 ? Math.max(40, n.w0 / shape.padX - PAD_X * 2) : 0;
      n.lines = inner ? this._wrapTo(n.text, inner)
                      : this._wrapTo(n.text, wrapWidthFor(n._fs));

      var im = n.image ? this._imgCache[n.image] : null;
      if (im && im !== 'loading' && im.naturalWidth) {
        var cap = inner || IMG_MAX_W;
        var capH = inner ? IMG_MAX_H * 3 : IMG_MAX_H;
        var scale = Math.min(cap / im.naturalWidth, capH / im.naturalHeight, inner ? 6 : 1);
        n.imgW = Math.round(im.naturalWidth * scale);
        n.imgH = Math.round(im.naturalHeight * scale);
      } else if (n.image) {
        // not loaded yet: reserve a box in the right shape, square if unknown
        var ar = this._ratio[n.image] || 1;
        var pw = inner || 90;
        n.imgW = Math.round(pw);
        n.imgH = Math.round(pw / ar);
      } else {
        n.imgW = 0; n.imgH = 0;
      }

      var textW = 0;
      for (var j = 0; j < n.lines.length; j++) {
        textW = Math.max(textW, ctx.measureText(n.lines[j]).width);
      }
      var contentW = Math.max(70, Math.min(wrapWidthFor(n._fs), textW), n.imgW) + PAD_X * 2;
      var contentH = PAD_Y * 2 + n.lines.length * n._lh +
                     (n.imgH ? n.imgH + (n.lines.length ? IMG_GAP : 0) : 0);

      // round shapes need slack, or the text pokes out of the outline
      n.w = n.w0 || Math.round(contentW * shape.padX);
      n.h = n.h0 || Math.round(contentH * shape.padY);

      /* Text has to fit the box too. When a node has been given a size by hand,
         re-wrap and, if the lines still stand taller than the space inside,
         step the type down until they fit. Scaling the box scales what is in
         it, which is what dragging a corner is understood to mean. */
      if (n.h0 && n.lines.length) {
        var innerH = n.h0 / shape.padY - PAD_Y * 2 - (n.imgH ? n.imgH + IMG_GAP : 0);
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
    /* In a tidy map every child sits to the right of its parent, so the line
       leaves the parent's side and arrives at the child's, like a chart --
       rather than pointing at the middle of each box. */
    if (this.auto && b.y > a.y + a.h / 2 && this.layout === 'down') {
      var pd1 = { x: a.x, y: a.y + a.h / 2 };
      var pd2 = { x: b.x, y: b.y - b.h / 2 };
      var drop = Math.max(14, (pd2.y - pd1.y) * 0.55);
      return {
        a: pd1, b: pd2,
        c1: { x: pd1.x, y: pd1.y + drop },
        c2: { x: pd2.x, y: pd2.y - drop }
      };
    }
    if (this.auto && this.layout !== 'down' && Math.abs(b.x - a.x) > (a.w + b.w) / 4) {
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

  function bezierAt(t, p0, p1, p2, p3) {
    var u = 1 - t;
    return {
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y
    };
  }

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

  var HANDLE_R = 6;      // world-space radius of a connector dot
  var GRIP = 9;          // resize grip square

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

  Mindmap.prototype.hitGrip = function (px, py) {
    var n = this.handleNode();
    if (!n) return null;
    // connectors win any overlap, so a link drag is never read as a resize
    if (this.hitHandle(px, py)) return null;
    var g = this._toScreen(n.x + n.w / 2, n.y + n.h / 2);
    return (Math.abs(g.x - px) <= 10 && Math.abs(g.y - py) <= 10) ? n : null;
  };

  // Nodes overlapping the marquee rectangle (drawn in any direction).
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
    var away = this.layout === 'left' ? -1 : 1;
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
  Mindmap.prototype.copySelection = function () {
    var picked = this.selection.length ? this.selection : (this.selected ? [this.selected] : []);
    if (!picked.length) return 0;
    var ids = {};
    picked.forEach(function (n) { ids[n.id] = true; });

    this._clip = {
      nodes: picked.map(function (n) {
        return {
          text: n.text, color: n.color, shape: n.shape, image: n.image,
          fs: n.fs, w0: n.w0, h0: n.h0,
          dx: n.x - picked[0].x, dy: n.y - picked[0].y
        };
      }),
      edges: this.edges.filter(function (e) { return ids[e.a] && ids[e.b]; })
        .map(function (e) {
          return {
            a: picked.map(function (n) { return n.id; }).indexOf(e.a),
            b: picked.map(function (n) { return n.id; }).indexOf(e.b),
            type: e.type, width: e.width
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
        fs: c.fs, w0: c.w0, h0: c.h0,
        x: baseX + c.dx, y: baseY + c.dy,
        noteId: null
      };
      this.nodes.push(n);
      made.push(n);
    }

    clip.edges.forEach(function (e) {
      if (made[e.a] && made[e.b]) {
        this.edges.push({ a: made[e.a].id, b: made[e.b].id, type: e.type, width: e.width });
      }
    }, this);

    // join the copy to whatever it was pasted onto
    if (anchor) this.edges.push({ a: anchor.id, b: made[0].id });

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
    this.edges.forEach(function (e) {
      if (!byId[e.a] || !byId[e.b]) return;
      (kids[e.a] = kids[e.a] || []).push(e.b);
      hasParent[e.b] = true;
    });
    var gx = Math.max(28, Math.round(this.gapX * 0.45));
    var gy = Math.max(6, Math.round(this.gapY * 0.22));
    var dir = LAYOUTS[this.layout] ? this.layout : 'right';
    var down = dir === 'down';

    // each node belongs to the first parent that reaches it; extra links stay links
    var seen = {}, tree = {};
    function build(id) {
      seen[id] = true;
      var own = [];
      (kids[id] || []).forEach(function (c) {
        if (!seen[c]) { seen[c] = true; own.push(c); }
      });
      tree[id] = own;
      own.forEach(build);
    }
    var roots = this.nodes.filter(function (n) { return !hasParent[n.id]; })
      .sort(function (a, b) { return down ? a.x - b.x : a.y - b.y; });
    roots.forEach(function (r) { if (!seen[r.id]) build(r.id); });
    // anything only reachable round a loop starts a tree of its own
    this.nodes.forEach(function (n) {
      if (!seen[n.id]) { roots.push(n); build(n.id); }
    });
    // brothers and sisters keep the order they appear in on screen
    Object.keys(tree).forEach(function (id) {
      tree[id].sort(function (a, b) {
        return down ? byId[a].x - byId[b].x : byId[a].y - byId[b].y;
      });
    });

    /* A branch is measured across the way it grows: a map growing sideways
       needs height for each branch, one growing downwards needs width. */
    var band = {};
    function measure(id) {
      var total = 0;
      tree[id].forEach(function (c, i) {
        total += measure(c) + (i ? (down ? gx : gy) : 0);
      });
      band[id] = Math.max(down ? byId[id].w : byId[id].h, total);
      return band[id];
    }

    // sideways: `edge` is the side of the node facing its parent
    function placeSide(id, edge, top, sign) {
      var n = byId[id];
      n.x = edge + sign * n.w / 2;
      n.y = top + band[id] / 2;
      var total = 0;
      tree[id].forEach(function (c, i) { total += band[c] + (i ? gy : 0); });
      var y = n.y - total / 2;
      var next = n.x + sign * (n.w / 2 + gx);
      tree[id].forEach(function (c) {
        placeSide(c, next, y, sign);
        y += band[c] + gy;
      });
    }

    function placeDown(id, left, topY) {
      var n = byId[id];
      n.x = left + band[id] / 2;
      n.y = topY + n.h / 2;
      var total = 0;
      tree[id].forEach(function (c, i) { total += band[c] + (i ? gx : 0); });
      var x = n.x - total / 2;
      var below = topY + n.h + gy * 3;
      tree[id].forEach(function (c) {
        placeDown(c, x, below);
        x += band[c] + gx;
      });
    }

    // both sides: the root's branches are split left and right, then each
    // side is laid out as its own little map
    function placeBoth(id) {
      var n = byId[id];
      var own = tree[id].slice();
      var right = [], left = [];
      own.forEach(function (c, i) { (i % 2 ? left : right).push(c); });
      [[right, 1], [left, -1]].forEach(function (pair) {
        var list = pair[0], sign = pair[1];
        var total = 0;
        list.forEach(function (c, i) { total += band[c] + (i ? gy : 0); });
        var y = n.y - total / 2;
        var edge = n.x + sign * (n.w / 2 + gx);
        list.forEach(function (c) {
          placeSide(c, edge, y, sign);
          y += band[c] + gy;
        });
      });
    }

    roots.forEach(function (r) { measure(r.id); });
    var first = roots[0];
    if (down) {
      var left = first.x - band[first.id] / 2, topY = first.y - first.h / 2;
      roots.forEach(function (r) {
        placeDown(r.id, left, topY);
        left += band[r.id] + gx * 3;
      });
    } else if (dir === 'both') {
      var cy = first.y;
      roots.forEach(function (r) {
        byId[r.id].y = cy;
        placeBoth(r.id);
        cy += band[r.id] + gy * 4;
      });
    } else {
      var sign = dir === 'left' ? -1 : 1;
      var edge = first.x + sign * (-first.w / 2);
      var top = first.y - band[first.id] / 2;
      roots.forEach(function (r) {
        placeSide(r.id, edge, top, sign);
        top += band[r.id] + gy * 4;
      });
    }

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

  Mindmap.prototype.setLayout = function (name) {
    this.layout = LAYOUTS[name] ? name : 'right';
    if (!this.auto) this.auto = true;      // a layout only means anything tidied
    this._changed();
    return this.layout;
  };

  /* Hang a node (and everything under it) under another one. */
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
    if (!parentEdge) return this.addNode('Idea', sel.x, sel.y + sel.h + 24);
    return this.addChild(this.byId(parentEdge.a));
  };

  Mindmap.prototype._afterSelect = function () {
    this.selected = this.selection[this.selection.length - 1] || null;
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
    this.edges.forEach(function (e) {
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

  Mindmap.prototype.descendantsOf = function (node) {
    var out = [], seen = {}, stack = [node.id], self = this;
    seen[node.id] = true;
    while (stack.length) {
      var id = stack.pop();
      this.edges.forEach(function (e) {
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
    this.linkFrom = null;
    if (existing) {
      this.edges = this.edges.filter(function (x) { return x !== existing; });
      this._changed();
      return 'unlinked';
    }
    this.edges.push({ a: a, b: b });
    this._changed();
    return 'linked';
  };

  Mindmap.prototype.fit = function () {
    var r = this.canvas.getBoundingClientRect();
    if (!this.nodes.length || !r.width) {
      this.cam = { x: r.width / 2, y: r.height / 2, s: 1 };
      this.draw();
      return;
    }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    this.nodes.forEach(function (n) {
      minX = Math.min(minX, n.x - n.w / 2); maxX = Math.max(maxX, n.x + n.w / 2);
      minY = Math.min(minY, n.y - n.h / 2); maxY = Math.max(maxY, n.y + n.h / 2);
    });
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

  // Lay down the path for one edge in the requested style.
  Mindmap.prototype._edgePath = function (ctx, ends, type, seed) {
    ctx.beginPath();
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
    for (var i = 0; i < this.edges.length; i++) {
      var e = this.edges[i];
      var ends = this.edgeEnds(e);
      if (!ends) continue;
      var isSel = this.selectedEdge === e;
      var st = this.edgeStyleOf(e);
      var col = isSel ? t.accent : t.edge;
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
      this._edgePath(ctx, ends, st.type, seed);
      ctx.stroke();
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
      var sel = this.isSelected(n);
      var pending = this.linkFrom && this.linkFrom.id === n.id;
      var paint = this.paintOf(n, t);
      var y0 = n.y - n.h / 2;

      var dropping = this._dropOn === n;
      this._shapePath(ctx, n);
      ctx.fillStyle = paint.fill;
      ctx.fill();
      ctx.strokeStyle = (sel || pending || dropping) ? t.accent : paint.line;
      ctx.lineWidth = (pending || dropping) ? 3 : (sel ? 2 : 1);
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
        var im = n.image ? this._imgCache[n.image] : null;
        var ix = n.x - n.imgW / 2;
        if (im && im !== 'loading') {
          ctx.save();
          this._roundRect(ctx, ix, cursorY, n.imgW, n.imgH, 6);
          ctx.clip();
          ctx.drawImage(im, ix, cursorY, n.imgW, n.imgH);
          ctx.restore();
        } else {
          this._roundRect(ctx, ix, cursorY, n.imgW, n.imgH, 6);
          ctx.fillStyle = t.grid;
          ctx.fill();
        }
        cursorY += n.imgH + (n.lines.length ? IMG_GAP : 0);
      }

      ctx.fillStyle = t.text;
      for (var li = 0; li < n.lines.length; li++) {
        ctx.fillText(n.lines[li], n.x, cursorY + li * n._lh + n._lh / 2);
      }
      ctx.restore();               // end the clip for this node
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

      // connector dot first, then the resize grip, then the node itself
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
          self._drag = null;
          self.select(n);
          self.opts.onNodeMenu(n, e.clientX, e.clientY);
        }, 500);
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
        self._drag = {
          node: n, moved: false, sx: p.x, sy: p.y, shift: e.shiftKey,
          movers: movers.map(function (m) { return { n: m, dx: m.x - w.x, dy: m.y - w.y }; })
        };
      } else {
        var edge2 = self.hitEdge(p.x, p.y);
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
        if (self.selectMode || e.shiftKey) {
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
      if (self._pressTimer &&
          Math.hypot(lp0.x - (self._drag ? self._drag.sx : lp0.x),
                     lp0.y - (self._drag ? self._drag.sy : lp0.y)) > 10) {
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
        var w = self.toWorld(p.x, p.y);
        self._drag.movers.forEach(function (m) {
          m.n.x = w.x + m.dx;
          m.n.y = w.y + m.dy;
        });
        self._drag.moved = true;
        // the node under the finger becomes the new parent when you let go
        var moving = self._drag.movers.map(function (m) { return m.n; });
        var over = self.hit(p.x, p.y, moving);
        if (over && self.descendantsOf(self._drag.node).indexOf(over) === -1) {
          self._dropOn = over;
        } else {
          self._dropOn = null;
        }
        self.draw();
      }
    });

    var lastTap = 0, lastNode = null;

    function endPointer(e) {
      clearTimeout(self._pressTimer);
      self._pressTimer = null;
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
            self.edges.push({ a: from.id, b: drop.id });
            self._changed();
            if (self.opts.onLinkStep) self.opts.onLinkStep('linked');
          } else if (self.opts.onLinkStep) {
            self.opts.onLinkStep('duplicate');
          }
        } else if (!drop) {
          // dropped on empty space: make a new child there
          var w = self.toWorld(lp.x, lp.y);
          var made = self.addNodeQuiet('Idea', w.x, w.y);
          made.color = from.color || 'plain';
          self.edges.push({ a: from.id, b: made.id });
          self._layout();
          self.select(made);
          self._changed();
          if (self.opts.onRename) self.opts.onRename(made, true);
        }
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
        self.reparent(self._drag.node, self._dropOn);
        self._dropOn = null;
      } else if (self._drag && self._drag.moved) {
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
      var n = self.hit(p.x, p.y);
      if (n && self.opts.onRename) {
        self.select(n);
        self.opts.onRename(n);
      } else if (!n) {
        var w = self.toWorld(p.x, p.y);
        var made = self.addNode('Idea', w.x, w.y);
        if (self.opts.onRename) self.opts.onRename(made);
      }
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
