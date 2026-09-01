/* Sulat - undo / redo.

   Every reversible action is stored as two lists of record snapshots: what the
   affected rows looked like before, and what they look like after. A record is
   { store, id, value } where a null value means "this row did not exist" — so
   creating, editing and deleting all use the same machinery, and one entry can
   span several notes and folders at once (bulk move, empty trash).

   Typing is coalesced: begin() takes a snapshot at the start of a burst and
   commit() closes it once the user pauses, so undo steps are sentences rather
   than keystrokes. */
(function (global) {
  'use strict';

  var LIMIT = 150;

  var undoStack = [];
  var redoStack = [];
  var applyFn = null;
  var onChange = null;
  var open = null;      // an in-progress burst

  function clone(v) {
    if (v === null || v === undefined) return null;
    // Blobs cannot survive JSON, but history only ever tracks notes and
    // folders; image rows are referenced by id and never edited in place.
    return JSON.parse(JSON.stringify(v));
  }

  function rec(store, id, value) {
    return { store: store, id: id, value: clone(value) };
  }

  function configure(cfg) {
    applyFn = cfg.apply;
    onChange = cfg.onChange || null;
  }

  function notify() { if (onChange) onChange(); }

  function push(label, before, after) {
    if (!before.length && !after.length) return;
    undoStack.push({ label: label, before: before, after: after });
    if (undoStack.length > LIMIT) undoStack.shift();
    redoStack.length = 0;
    notify();
  }

  /* ---- burst capture, for typing ---- */

  // Start (or extend) a burst. `key` identifies what is being edited; a new
  // key closes the previous burst so switching notes never merges edits.
  function begin(key, label, records) {
    if (open && open.key === key) return;
    commit();
    open = { key: key, label: label, before: records.slice() };
  }

  function commit(afterRecords) {
    if (!open) return;
    var entry = open;
    open = null;
    var after = afterRecords || (entry.after || null);
    if (!after) return;
    push(entry.label, entry.before, after);
  }

  // Close the current burst using a fresh snapshot supplied by the caller.
  function commitWith(records) {
    if (!open) return;
    var entry = open;
    open = null;
    var changed = JSON.stringify(entry.before) !== JSON.stringify(records);
    if (changed) push(entry.label, entry.before, records);
  }

  function abandon() { open = null; }

  function isOpen(key) { return !!(open && (key === undefined || open.key === key)); }

  /* ---- stepping ---- */

  function undo() {
    if (!undoStack.length) return Promise.resolve(null);
    var e = undoStack.pop();
    redoStack.push(e);
    notify();
    return applyFn(e.before).then(function () { return e.label; });
  }

  function redo() {
    if (!redoStack.length) return Promise.resolve(null);
    var e = redoStack.pop();
    undoStack.push(e);
    notify();
    return applyFn(e.after).then(function () { return e.label; });
  }

  function canUndo() { return undoStack.length > 0; }
  function canRedo() { return redoStack.length > 0; }
  function nextUndoLabel() { return undoStack.length ? undoStack[undoStack.length - 1].label : null; }
  function nextRedoLabel() { return redoStack.length ? redoStack[redoStack.length - 1].label : null; }

  function clear() {
    undoStack.length = 0;
    redoStack.length = 0;
    open = null;
    notify();
  }

  global.History = {
    configure: configure,
    rec: rec,
    clone: clone,
    push: push,
    begin: begin,
    commit: commit,
    commitWith: commitWith,
    abandon: abandon,
    isOpen: isOpen,
    undo: undo,
    redo: redo,
    canUndo: canUndo,
    canRedo: canRedo,
    nextUndoLabel: nextUndoLabel,
    nextRedoLabel: nextRedoLabel,
    clear: clear
  };
})(window);
