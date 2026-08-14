/**
 * Headless DOM-stub test for the bead-pattern tool's mobile / iPad logic.
 *
 * Loads the REAL app.js (plus its palette + data dependencies) inside a
 * Node `vm` context with a minimal DOM stub, then exercises the §十六
 * (16-part mobile optimization) behaviors that are testable without a browser:
 *
 *   - Undo / redo round-trip + consecutive ops + redo-clears-on-new-edit
 *   - Lock-aware history (locked misclick creates NO undo entry)
 *   - Eraser clears colorId AND done; eraser obeys lock
 *   - Fill obeys lock (blocks filled targets, allows empty regions)
 *   - Two-finger pinch = zoom + pan with NO cell mutation
 *   - Multi-touch guard: single-finger action suppressed right after a pinch
 *   - 5-tool consistency (paint/eraser/move/eyedropper/fill) + BIEF fix
 *   - Mobile bottom MARD palette bar populated
 *   - Reference hide / show + ☰ sidebar drawer + auto-collapse on mobile
 *   - Trash button clearly labeled (🗑 清空画布)
 *   - MARD palette / highlight / lock all behave normally
 *   - Desktop mouse handlers still bound (move tool preserved)
 *
 * Run: node test/headless-mobile-test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

function FakeClassList() { this._s = new Set(); }
FakeClassList.prototype.add = function (c) { this._s.add(c); };
FakeClassList.prototype.remove = function (c) { this._s.delete(c); };
FakeClassList.prototype.contains = function (c) { return this._s.has(c); };
FakeClassList.prototype.toggle = function (c, force) {
  if (force === undefined) {
    if (this._s.has(c)) { this._s.delete(c); return false; }
    this._s.add(c); return true;
  }
  if (force) this._s.add(c); else this._s.delete(c);
  return !!force;
};

// No-op 2D context proxy: every method is a no-op, every property is settable.
const ctxProxy = new Proxy({}, {
  get(t, p) { return (p in t) ? t[p] : function () { return undefined; }; },
  set(t, p, v) { t[p] = v; return true; }
});

const sharedParentRect = { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 };

function makeEl() {
  const el = {
    style: {},
    dataset: {},
    _handlers: {},
    children: [],
    classList: new FakeClassList(),
    _text: '',
    _html: '',
    value: '',
    disabled: false,
    checked: false,
    className: '',
    width: 0,
    height: 0,
    addEventListener(type, fn) { (el._handlers[type] = el._handlers[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const a = el._handlers[type]; if (!a) return;
      const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    },
    appendChild(c) { el.children.push(c); return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); },
    remove() {},
    setAttribute() {},
    getAttribute() { return null; },
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }; },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    focus() {}, blur() {},
    closest() { return null; },
    getContext() { return ctxProxy; }
  };
  el.parentNode = {
    getBoundingClientRect() { return sharedParentRect; },
    classList: new FakeClassList(),
    style: {}
  };
  Object.defineProperty(el, 'textContent', {
    get() { return el._text; }, set(v) { el._text = v; el._html = ''; }
  });
  // Setting innerHTML is treated as replacing content -> clears children too.
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) { el._html = v; el._text = ''; el.children = []; }
  });
  return el;
}

const byId = {};
const bySel = {};
const documentObj = {
  _domReady: [],
  _h: {},
  getElementById(id) { return byId[id] || (byId[id] = makeEl()); },
  createElement() { return makeEl(); },
  querySelector(sel) { return bySel[sel] || (bySel[sel] = makeEl()); },
  querySelectorAll() { return []; },
  addEventListener(type, fn) {
    if (type === 'DOMContentLoaded') documentObj._domReady.push(fn);
    else documentObj._h[type] = (documentObj._h[type] || []).concat(fn);
  },
  removeEventListener() {},
  body: makeEl()
};

const localStorageObj = (function () {
  const m = {};
  return {
    getItem(k) { return (k in m) ? m[k] : null; },
    setItem(k, v) { m[k] = String(v); },
    removeItem(k) { delete m[k]; }
  };
})();

const sandbox = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  performance: { now: function () { return Date.now(); } },
  requestAnimationFrame: function () { return 0; },
  cancelAnimationFrame: function () {},
  localStorage: localStorageObj,
  // indexedDB intentionally left UNDEFINED -> forces localStorage fallback path
  document: documentObj
};
// window === sandbox so `global.PALETTES = ...` (palettes.js) lands on the
// context global and is visible to app.js; also satisfies window.* references.
sandbox.window = sandbox;
sandbox.addEventListener = function () {};
sandbox.removeEventListener = function () {};

// ---------------------------------------------------------------------------
// Load all sources as ONE concatenated script so top-level const/let (palette
// data) stay in a single lexical scope and remain visible across "files".
// ---------------------------------------------------------------------------

const files = [
  'js/bead-palette.js',
  'data/palettes/mard-standard.js',
  'data/palettes/mard-full.js',
  'js/palettes.js',
  'js/app.js'
];
const combined = files.map(read).join('\n;\n');

vm.createContext(sandbox);
try {
  vm.runInContext(combined, sandbox, { filename: 'bead-combined.js' });
} catch (e) {
  console.error('FATAL: failed to evaluate sources in vm:', e);
  process.exit(2);
}

// Trigger DOMContentLoaded -> instantiates BeadTool + runs init()
documentObj._domReady.forEach(function (fn) { fn(); });

const bt = sandbox.window.beadTool;
if (!bt) {
  console.error('FATAL: window.beadTool was not created by init()');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Tiny assertion framework
// ---------------------------------------------------------------------------

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name); console.log('  ✗ ' + name); }
}
function eq(name, a, b) {
  ok(name + '  (' + JSON.stringify(a) + ' === ' + JSON.stringify(b) + ')', a === b);
}
function cellsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function fire(el, type, ev) {
  (el._handlers[type] || []).forEach(function (h) { h(ev); });
}
function t(x, y) { return { clientX: x, clientY: y }; }
function touchEv(touches, changed) {
  return { preventDefault() {}, touches: touches, changedTouches: changed || touches };
}
// Fresh 8x8 grid + clean undo state. Keeps tests isolated.
function resetGrid(idx) {
  bt.undoStack = []; bt.redoStack = [];
  bt.createBlankGrid(8, 8, false);
  bt._strokeSnap = null; bt._strokeChanged = false;
  bt.highlightCurrent = false;
  bt.selectedColorIndex = (idx == null ? 2 : idx);
}

// ===========================================================================
console.log('\n=== MARD palette / baseline ===');
resetGrid();
ok('grid created 8x8', bt.grid && bt.grid.width === 8 && bt.grid.height === 8);
eq('default palette is mard-standard', bt.paletteId, 'mard-standard');
ok('MARD palette loaded (>200 colors)', bt.palette.length > 200);

// ===========================================================================
console.log('\n=== (一) Undo / Redo ===');
resetGrid();
bt.beginStroke(); bt.paintCell(0, 0); bt.endStroke();
eq('paint set cells[0]=2', bt.grid.cells[0], 2);
eq('one undo entry after paint', bt.undoStack.length, 1);

bt.undo();
eq('undo reverted cells[0]=-1', bt.grid.cells[0], -1);
eq('redo stack has 1 entry', bt.redoStack.length, 1);

bt.redo();
eq('redo restored cells[0]=2', bt.grid.cells[0], 2);

// consecutive ops undoable
bt.beginStroke(); bt.paintCell(1, 0); bt.endStroke();   // idx = 0*8 + 1 = 1
bt.beginStroke(); bt.paintCell(2, 0); bt.endStroke();   // idx = 2
eq('two more paints -> 3 undo entries', bt.undoStack.length, 3);
bt.undo(); bt.undo();
eq('two undos cleared cells[1] & cells[2]',
   bt.grid.cells[1] === -1 && bt.grid.cells[2] === -1, true);
// redo re-applies the LAST undone op (paint 1,0)
bt.redo();
eq('redo re-applied paint(1,0) -> cells[1]=2', bt.grid.cells[1], 2);
eq('redo left the still-undone paint(2,0) -> cells[2]=-1', bt.grid.cells[2], -1);

// new edit after undo clears redo history
bt.beginStroke(); bt.paintCell(3, 0); bt.endStroke();   // idx = 3
eq('new edit cleared redo history', bt.redoStack.length, 0);

// ===========================================================================
console.log('\n=== (六) Per-cell lock: misclick on locked cell -> NO undo entry ===');
resetGrid();
bt.selectedColorIndex = 2;
bt.beginStroke(); bt.paintCell(0, 0); bt.endStroke();
eq('filled cells[0]=2 (unlocked)', bt.grid.cells[0], 2);
eq('1 undo entry from fill', bt.undoStack.length, 1);

// lock that cell via the batch action (only locks currently-filled cells)
bt.lockFilledCells();
eq('lockFilledCells locked the filled cell', bt.grid.locks[0], 1);
eq('lockFilledCells did NOT lock empty cells', bt.grid.locks[5], 0);
eq('lockFilledCells pushed one undo entry (history-aware)', bt.undoStack.length, 2);

const beforeLockHist = bt.undoStack.length;
bt._lastLockToast = 0;
bt.selectedColorIndex = 2;
bt.beginStroke(); const rLockSame = bt.paintCell(0, 0); bt.endStroke();
eq('locked paint (same color) returns false', rLockSame, false);
eq('locked misclick did NOT add undo entry', bt.undoStack.length, beforeLockHist);
eq('locked cell unchanged (still 2)', bt.grid.cells[0], 2);

bt.selectedColorIndex = 5;
bt.beginStroke(); const rLockDiff = bt.paintCell(0, 0); bt.endStroke();
eq('locked paint (diff color) returns false', rLockDiff, false);
eq('still no new undo entry', bt.undoStack.length, beforeLockHist);
eq('locked cell still 2 (not overwritten to 5)', bt.grid.cells[0], 2);

// undo of the lock *action* restores the pre-lock state (lock is reversible)
bt.undo();
eq('undo of lock-action unlocks the cell', bt.grid.locks[0], 0);
eq('undo restores cell color (still 2)', bt.grid.cells[0], 2);

// ===========================================================================
console.log('\n=== (三/四) Batch lock only locks filled; NEW fills stay unlocked ===');
resetGrid();
bt.selectedColorIndex = 2;
bt.beginStroke(); bt.paintCell(0, 0); bt.endStroke();   // cells[0]=2
bt.beginStroke(); bt.paintCell(1, 0); bt.endStroke();   // cells[1]=2
bt.lockFilledCells();
eq('first batch lock locks filled cells[0]', bt.grid.locks[0], 1);
eq('first batch lock locks filled cells[1]', bt.grid.locks[1], 1);
eq('empty cell NOT locked', bt.grid.locks[10], 0);

// paint NEW cells AFTER lock -> they must NOT auto-lock
bt.selectedColorIndex = 4;
bt.beginStroke(); bt.paintCell(2, 0); bt.endStroke();   // cells[2]=4
bt.beginStroke(); bt.paintCell(3, 0); bt.endStroke();   // cells[3]=4
eq('newly filled cells[2] is NOT auto-locked', bt.grid.locks[2], 0);
eq('newly filled cells[3] is NOT auto-locked', bt.grid.locks[3], 0);

// second batch lock only locks the still-unlocked filled cells
bt.lockFilledCells();
eq('second batch lock now locks cells[2]', bt.grid.locks[2], 1);
eq('second batch lock now locks cells[3]', bt.grid.locks[3], 1);
eq('already-locked cells[0] stays locked', bt.grid.locks[0], 1);

// ===========================================================================
console.log('\n=== (六) Eraser clears colorId AND done; eraser obeys per-cell lock ===');
resetGrid();
bt.selectedColorIndex = 4;
bt.beginStroke(); bt.paintCell(2, 2); bt.endStroke();        // cells[2,2]=4
bt.beginStroke(); bt.toggleProgress(2, 2); bt.endStroke();   // mark done
eq('cell (2,2) painted', bt.grid.cells[2 * 8 + 2], 4);
eq('cell (2,2) marked done', bt.grid.done[2 * 8 + 2], 1);

bt.beginStroke(); const rErase = bt.eraseCell(2, 2); bt.endStroke();
eq('erase returns true', rErase, true);
eq('erase cleared colorId (-1)', bt.grid.cells[2 * 8 + 2], -1);
eq('erase cleared done flag (0)', bt.grid.done[2 * 8 + 2], 0);

// eraser obeys per-cell lock
bt.selectedColorIndex = 3;
bt.beginStroke(); bt.paintCell(1, 1); bt.endStroke();        // allowed (was empty)
eq('filled (1,1)=3 (unlocked)', bt.grid.cells[1 * 8 + 1], 3);
bt.grid.locks[1 * 8 + 1] = 1;                                // lock it directly
const beforeEraseLock = bt.undoStack.length;
bt.beginStroke(); const rEraseLock = bt.eraseCell(1, 1); bt.endStroke();
eq('erase on locked filled cell returns false', rEraseLock, false);
eq('locked cell NOT erased (still 3)', bt.grid.cells[1 * 8 + 1], 3);
eq('erase-on-locked added no undo entry', bt.undoStack.length, beforeEraseLock);

// ===========================================================================
console.log('\n=== (六) Fill obeys per-cell lock (block start + protect during flood) ===');
resetGrid();
bt.selectedColorIndex = 2;
bt.beginStroke(); bt.paintCell(0, 0); bt.endStroke();        // cells[0]=2 (filled)
bt.grid.locks[0] = 1;                                        // lock it
bt.selectedColorIndex = 7;
bt.beginStroke(); const rFillLocked = bt.fillCell(0, 0); bt.endStroke();
eq('fill started on locked filled cell returns false', rFillLocked, false);
eq('locked start cell unchanged', bt.grid.cells[0], 2);

// empty-region fill always allowed
bt.selectedColorIndex = 9;
bt.beginStroke(); const rFillEmpty = bt.fillCell(5, 5); bt.endStroke();
ok('fill on empty region allowed (returns true)', rFillEmpty === true);
eq('empty cell (5,5) got fill color 9', bt.grid.cells[5 * 8 + 5], 9);

// flood must NOT recolor a locked cell in its path
resetGrid();
bt.selectedColorIndex = 2;
for (var fx = 0; fx < 8; fx++) { bt.beginStroke(); bt.paintCell(fx, 0); bt.endStroke(); }
bt.grid.locks[4] = 1;                                        // lock middle of the strip
bt.undoStack = []; bt.redoStack = [];                        // isolate this check
bt.selectedColorIndex = 5;
bt.beginStroke(); const rFlood = bt.fillCell(0, 0); bt.endStroke();
eq('flood from (0,0) returns true', rFlood, true);
eq('unlocked strip cells recolored to 5', bt.grid.cells[0], 5);
eq('locked middle cell (4,0) stays 2 (protected)', bt.grid.cells[4], 2);

// ===========================================================================
console.log('\n=== (六) Eyedropper reads locked cells (read-only, allowed) ===');
resetGrid();
bt.selectedColorIndex = 6;
bt.beginStroke(); bt.paintCell(3, 3); bt.endStroke();   // cells[3,3]=6
bt.grid.locks[3 * 8 + 3] = 1;                            // lock it
bt.eyedropCell(3, 3);
eq('eyedropper (read) works on locked cell -> selects color 6', bt.selectedColorIndex, 6);

// ===========================================================================
console.log('\n=== (三/十五) Two-finger pinch = zoom + pan, NO cell mutation ===');
resetGrid();
bt.cellSize = 20; bt.panX = 50; bt.panY = 30;
const cellsBefore = Int16Array.from(bt.grid.cells);
const undoBefore = bt.undoStack.length;

const canvas = bt.canvas;
fire(canvas, 'touchstart', touchEv([t(100, 100), t(200, 100)]));
eq('isPinching true after 2-finger start', bt.isPinching, true);
eq('_multiTouch true after 2-finger start', bt._multiTouch, true);

fire(canvas, 'touchmove', touchEv([t(80, 120), t(220, 120)]));
eq('cellSize zoomed to 28', bt.cellSize, 28);
eq('panX preserved by clamp (10)', bt.panX, 10);
eq('panY preserved by clamp (22)', bt.panY, 22);

fire(canvas, 'touchend', touchEv([], []));
eq('_multiTouch reset after all fingers up', bt._multiTouch, false);

ok('NO cell mutated during two-finger gesture', cellsEqual(bt.grid.cells, cellsBefore));
eq('NO undo entry created by gesture', bt.undoStack.length, undoBefore);

// ===========================================================================
console.log('\n=== (十五) Multi-touch guard: single-finger suppressed right after pinch ===');
bt.isPinching = false; bt._multiTouch = false; bt.isDragging = false;
bt.touchMoved = false; bt._touchCount = 0; bt.tool = 'paint';
fire(canvas, 'touchstart', touchEv([t(100, 100), t(200, 100)]));
fire(canvas, 'touchmove', touchEv([t(80, 120), t(220, 120)]));
fire(canvas, 'touchend', touchEv([t(150, 110)]));     // lift ONE finger: residue remains
eq('_multiTouch still true with 1 finger remaining', bt._multiTouch, true);

bt.tool = 'paint';
fire(canvas, 'touchstart', touchEv([t(150, 110)]));    // single tap while residue
eq('single-finger action suppressed after pinch (isDragging false)', bt.isDragging, false);

fire(canvas, 'touchend', touchEv([], []));             // fully release
eq('_multiTouch cleared after full release', bt._multiTouch, false);

bt.tool = 'paint';
fire(canvas, 'touchstart', touchEv([t(150, 110)]));    // genuine single tap now
eq('single-finger action works after full release (isDragging true)', bt.isDragging, true);
bt.isDragging = false;

// ===========================================================================
console.log('\n=== (十一) Tool consistency (6 tools) + BIEF fix ===');
const tools = ['paint', 'eraser', 'unlock', 'move', 'eyedropper', 'fill'];
tools.forEach(function (tl) {
  bt.selectTool(tl);
  eq('selectTool("' + tl + '") sets this.tool', bt.tool, tl);
});
eq('exactly 6 distinct tools', tools.length, 6);

const html = read('index.html');
ok('tool buttons use data-tool for all 6 (paint/eraser/unlock/move/eyedropper/fill)',
   ['paint', 'eraser', 'unlock', 'move', 'eyedropper', 'fill'].every(function (k) {
     return html.indexOf('data-tool="' + k + '"') !== -1;
   }));
// eraser also exists in the sidebar, so scope the check to the TOP toolbar only
var tbStart = html.indexOf('class="canvas-toolbar"');
var topToolbar = html.slice(tbStart, tbStart + 2000);
ok('top canvas toolbar has all 7 tools incl 解锁 + 参考 (data-tool)',
   ['paint', 'eraser', 'unlock', 'move', 'eyedropper', 'fill', 'reference'].every(function (k) {
     return topToolbar.indexOf('data-tool="' + k + '"') !== -1;
   }));
ok('顶部工具栏三组清晰分组: 拼豆编辑 / 参考图 / 画布',
   topToolbar.indexOf('拼豆编辑') !== -1 && topToolbar.indexOf('参考图') !== -1 && topToolbar.indexOf('画布') !== -1);
ok('顶部工具栏区分画布缩放与参考图控制 (ref-mode-toggle 在顶栏)', html.indexOf('id="ref-mode-toggle"') !== -1);
ok('BIEF misleading label removed (no "B/I/E/F")', html.indexOf('B/I/E/F') === -1);
ok('tool heading now lists 6 names (画笔·橡皮·解锁·移动·吸管·填充)',
   html.indexOf('画笔 · 橡皮 · 解锁 · 移动 · 吸管 · 填充') !== -1);
ok('undo button present (btn-undo)', html.indexOf('id="btn-undo"') !== -1);
ok('redo button present (btn-redo)', html.indexOf('id="btn-redo"') !== -1);
ok('lock toggle present (btn-lock-toggle)', html.indexOf('id="btn-lock-toggle"') !== -1);
ok('按颜色解锁 button present (btn-unlock-by-color)', html.indexOf('id="btn-unlock-by-color"') !== -1);
ok('highlight toggle present (btn-highlight-toggle)', html.indexOf('id="btn-highlight-toggle"') !== -1);
ok('sidebar ☰ toggle present (btn-toggle-sidebar)', html.indexOf('id="btn-toggle-sidebar"') !== -1);
ok('canvas-container has id (参考图工具容器层手势)', html.indexOf('id="canvas-container"') !== -1);

// ===========================================================================
console.log('\n=== (七/九) Mobile bottom MARD palette bar ===');
bt.renderMobilePalette();
const mpBar = byId['mobile-palette-bar'];
ok('mobile palette bar populated with one swatch per color',
   mpBar && mpBar.children.length === bt.palette.length && bt.palette.length > 0);
ok('紧凑色卡条每个色块含 MARD 编号 (mp-id)', mpBar && mpBar.children[0] && mpBar.children[0].children.length >= 1 && mpBar.children[0].children[0].textContent === bt.palette[0].id);

// ===========================================================================
console.log('\n=== (十四) Reference hide / show + (八) ☰ drawer + auto-collapse ===');
resetGrid();
bt.toggleReferencePane();
ok('reference pane hidden after toggle', byId['reference-pane'].classList.contains('hidden'));
bt.showReferencePane();
ok('reference pane shown again via showReferencePane', !byId['reference-pane'].classList.contains('hidden'));

bt._sbTouched = false;
bt.toggleSidebar();   // also creates + caches the '.main' element
const mainEl = documentObj.querySelector('.main');
ok('☰ toggle collapses sidebar (sb-collapsed added)', mainEl.classList.contains('sb-collapsed'));
bt.toggleSidebar();
ok('☰ toggle reopens sidebar', !mainEl.classList.contains('sb-collapsed'));

bt._sbTouched = false;
sandbox.matchMedia = function (q) {
  // simulate an iPad / touch device: the new query (max-width:1024px),(pointer:coarse) matches
  return { matches: /pointer:\s*coarse/.test(q) || /max-width:\s*1024px/.test(q) };
};
bt.maybeAutoCollapseSidebar();
ok('auto-collapse triggers on mobile (touch/coarse) viewport', mainEl.classList.contains('sb-collapsed'));

// desktop (fine pointer, wide) must NOT auto-collapse
bt._sbTouched = false;
mainEl.classList.remove('sb-collapsed');
sandbox.matchMedia = function () { return { matches: false }; };
bt.maybeAutoCollapseSidebar();
ok('desktop viewport does NOT auto-collapse', !mainEl.classList.contains('sb-collapsed'));
sandbox.matchMedia = undefined;

// ===========================================================================
console.log('\n=== (十) Trash button clearly labeled ===');
ok('🗑 clear-canvas button present (btn-clear-canvas)', html.indexOf('id="btn-clear-canvas"') !== -1);
ok('clear button labeled 清空画布', html.indexOf('清空画布') !== -1);

// ===========================================================================
console.log('\n=== (十六) MARD / highlight / lock normal ===');
resetGrid();
bt.highlightCurrent = true;
bt.selectedColorIndex = 0;
bt.beginStroke(); bt.paintCell(4, 4); bt.endStroke();
eq('paint with highlight on works (cells set)', bt.grid.cells[4 * 8 + 4], 0);
bt.highlightCurrent = false;

// per-cell lock: lock a filled cell, ensure empty is paintable & filled is protected
bt.selectedColorIndex = 1;
bt.beginStroke(); bt.paintCell(6, 6); bt.endStroke();   // cells[6,6]=1
bt.grid.locks[6 * 8 + 6] = 1;                            // lock it (per-cell)
bt.selectedColorIndex = 8;
const rFilledLock = bt.paintCell(6, 6);
eq('filled locked cell protected (returns false)', rFilledLock, false);
eq('filled locked cell (6,6) stays 1', bt.grid.cells[6 * 8 + 6], 1);
// empty cell still paintable (lock is per-cell, NOT a global mode)
bt.selectedColorIndex = 8;
const rEmpty = bt.paintCell(7, 7);
eq('empty cell paintable even though another cell is locked', rEmpty, true);

// ===========================================================================
console.log('\n=== (新增) 解锁: 单格解锁工具 + 按颜色解锁 ===');
resetGrid();
// 造一个「已填 + 已锁定」的格子
bt.selectedColorIndex = 2;
bt.beginStroke(); bt.paintCell(3, 3); bt.endStroke();   // cells[3,3] = 2
bt.grid.locks[3 * 8 + 3] = 1;                            // 直接锁它 (模拟 lockFilledCells 后的状态)
bt.undoStack = []; bt.redoStack = [];                     // 清空历史, 让「解锁」成为唯一可撤销条目
eq('前置: 格子(3,3) 已锁定', bt.grid.locks[3 * 8 + 3], 1);

// 单格解锁 (通过工具方法): 只清锁, 保留颜色, 进入撤销历史
bt.selectTool('unlock');
eq('selectTool("unlock") 选中解锁工具', bt.tool, 'unlock');
bt.beginStroke();
var rUnlock = bt.unlockCell(3, 3);
bt.endStroke();
eq('unlockCell 返回 true (成功解锁)', rUnlock, true);
eq('解锁后 locks[3,3] = 0', bt.grid.locks[3 * 8 + 3], 0);
eq('解锁后颜色保留 (cells[3,3] 仍 = 2)', bt.grid.cells[3 * 8 + 3], 2);
eq('解锁进入撤销历史 (1 条)', bt.undoStack.length, 1);

// 撤销解锁 -> 恢复锁定
bt.undo();
eq('撤销解锁后 locks[3,3] 恢复 = 1', bt.grid.locks[3 * 8 + 3], 1);
eq('撤销解锁后颜色仍保留 (cells[3,3] = 2)', bt.grid.cells[3 * 8 + 3], 2);
bt.redo();
eq('重做解锁后 locks[3,3] = 0', bt.grid.locks[3 * 8 + 3], 0);

// 解锁未锁定格子: 无操作, 不产生历史
resetGrid();
bt.beginStroke();
var rUnlock2 = bt.unlockCell(0, 0);
bt.endStroke();
eq('解锁未锁定格子返回 false', rUnlock2, false);
eq('解锁未锁定格子不产生撤销历史', bt.undoStack.length, 0);

// 按颜色解锁: 只解「已锁定且颜色等于当前选中颜色」的格子
resetGrid();
bt.selectedColorIndex = 2;
bt.beginStroke(); bt.paintCell(0, 0); bt.endStroke();   // cells[0] = 2 (色2)
bt.beginStroke(); bt.paintCell(1, 0); bt.endStroke();   // cells[1] = 2 (色2)
bt.selectedColorIndex = 5;
bt.beginStroke(); bt.paintCell(2, 0); bt.endStroke();   // cells[2] = 5 (色5)
bt.grid.locks[0] = 1; bt.grid.locks[1] = 1; bt.grid.locks[2] = 1;   // 三个都锁
bt.undoStack = []; bt.redoStack = [];                                 // 清空历史
bt.selectedColorIndex = 2;   // 选色2 -> 应只解 cells[0] 与 cells[1]
bt.unlockByColor();
eq('按颜色解锁: cells[0] (色2) 解锁', bt.grid.locks[0], 0);
eq('按颜色解锁: cells[1] (色2) 解锁', bt.grid.locks[1], 0);
eq('按颜色解锁: cells[2] (色5) 仍锁定', bt.grid.locks[2], 1);
eq('按颜色解锁: cells[2] 颜色保留 (仍=5)', bt.grid.cells[2], 5);
eq('按颜色解锁进入撤销历史', bt.undoStack.length, 1);
bt.undo();
eq('撤销按颜色解锁: cells[0] 恢复锁定', bt.grid.locks[0], 1);
eq('撤销按颜色解锁: cells[1] 恢复锁定', bt.grid.locks[1], 1);

// ===========================================================================
console.log('\n=== (十六#22) Desktop mouse handlers still bound ===');
ok('mousedown handler bound on canvas (desktop paint/drag)', !!(canvas._handlers['mousedown'] && canvas._handlers['mousedown'].length));
ok('mousemove handler bound on canvas', !!(canvas._handlers['mousemove'] && canvas._handlers['mousemove'].length));
ok('mouseup handler bound on canvas', !!(canvas._handlers['mouseup'] && canvas._handlers['mouseup'].length));
bt.selectTool('move');
eq('move tool preserved for desktop', bt.tool, 'move');

// ===========================================================================
console.log('\n=== (新增) 参考图叠加模式 / 对齐 / 工具路由 / Excel 移除 ===');

// Excel 功能已彻底移除
ok('exportXLSX 方法已移除', typeof bt.exportXLSX === 'undefined');
ok('全局 BeadXLSX 模块未加载 (xlsx-export.js 已删)', typeof sandbox.BeadXLSX === 'undefined');

// 拼豆板颜色 (需求七): 默认白 + 侧栏可设置
eq('默认拼豆板颜色为白色', bt.boardColor, '#ffffff');
bt.boardColor = '#e9e9ee'; bt.renderGrid();
ok('自定义板颜色后 renderGrid 不报错', true);
ok('侧栏新增 拼豆板颜色 控制 (board-color-mode)', html.indexOf('id="board-color-mode"') !== -1);

// 默认叠加模式 + 切换
eq('默认 overlayMode = true', bt.overlayMode, true);
var modeBtn = byId['ref-mode-toggle'];
bt.setOverlayMode(false);
eq('setOverlayMode(false) -> overlayMode=false', bt.overlayMode, false);
ok('分栏模式按钮文案含 叠加', modeBtn && modeBtn.textContent.indexOf('叠加') !== -1);
bt.setOverlayMode(true);
eq('setOverlayMode(true) -> overlayMode=true', bt.overlayMode, true);
ok('叠加模式按钮文案含 分栏', modeBtn && modeBtn.textContent.indexOf('分栏') !== -1);

// 参考图工具可选中 (第 5 个画布工具)
bt.selectTool('reference');
eq('可选择 reference 工具', bt.tool, 'reference');
bt.selectTool('paint');

// 参考图移动 (独立图层, workspace 坐标): 只改 refX/refY, 不动画布/格子
resetGrid();
bt.overlayMode = true; bt.cellSize = 30; bt.panX = 10; bt.panY = 20;
bt.referenceImage = { naturalWidth: 100, naturalHeight: 100 };
bt.refImgW = 100; bt.refImgH = 100;
bt.refX = 0; bt.refY = 0; bt.refScale = 1;
bt.refDragStartX = 0; bt.refDragStartY = 0;
bt.refMoveTo(60, 30);
eq('refMoveTo 更新 refX (+60)', bt.refX, 60);
eq('refMoveTo 更新 refY (+30)', bt.refY, 30);
eq('参考图移动不影响画布 panX', bt.panX, 10);
eq('参考图移动不影响画布 panY', bt.panY, 20);
eq('参考图移动不影响画布 cellSize', bt.cellSize, 30);
ok('参考图移动不改格子', bt.grid.cells.every(function (c) { return c === -1; }));

// 参考图缩放 (独立图层): 只改 refScale/refX/refY, 不动画布
bt.refScale = 1; bt.refX = 0; bt.refY = 0; bt.refBaseScale = 1; bt._refPinchDist = 1;
bt.refPinchTo(400, 300, 2);
ok('refPinchTo 缩放参考图 (refScale≈2)', Math.abs(bt.refScale - 2) < 1e-6);
eq('参考图缩放不影响画布 cellSize', bt.cellSize, 30);
ok('参考图缩放不改格子', bt.grid.cells.every(function (c) { return c === -1; }));

// 一键对齐画布 (一次性 contain+居中): 不改画布
resetGrid();
bt.overlayMode = true;
bt.referenceImage = { naturalWidth: 100, naturalHeight: 100 };
bt.refImgW = 100; bt.refImgH = 100;
bt.canvas.getBoundingClientRect = function () { return { left: 100, top: 50, width: 800, height: 600, right: 900, bottom: 650 }; };
byId['workspace'].getBoundingClientRect = function () { return { left: 0, top: 0, width: 1000, height: 700, right: 1000, bottom: 700 }; };
bt.cellSize = 30; bt.panX = 10; bt.panY = 20;
bt.alignReferenceToCanvas();
ok('对齐: refScale = min(800/100, 600/100) = 6', Math.abs(bt.refScale - 6) < 1e-6);
eq('对齐: refX 居中 (100 + 400 - 300 = 200)', bt.refX, 200);
eq('对齐: refY 居中 (50 + 300 - 300 = 50)', bt.refY, 50);
eq('对齐: 不改画布 cellSize', bt.cellSize, 30);
eq('对齐: 不改画布 panX', bt.panX, 10);
eq('对齐: 不改画布 panY', bt.panY, 20);

// 关键(独立图层): 画布缩放/平移后, 参考图 refX/refY/refScale 保持不变 (不再跟随)
bt.refScale = 6; bt.refX = 200; bt.refY = 50;
bt.cellSize = 40; bt.panX = 100; bt.applyCanvasTransform();
eq('画布缩放后参考图 refScale 不变 (仍 6)', bt.refScale, 6);
eq('画布平移后参考图 refX 不变 (仍 200)', bt.refX, 200);
eq('画布平移后参考图 refY 不变 (仍 50)', bt.refY, 50);

// 切换分栏/叠加不重算参考图 (不跳动)
bt.refX = 123; bt.refY = 45; bt.refScale = 2.5;
bt.setOverlayMode(false);
eq('切分栏 refX 保持', bt.refX, 123);
eq('切分栏 refY 保持', bt.refY, 45);
eq('切分栏 refScale 保持', bt.refScale, 2.5);
bt.setOverlayMode(true);
eq('切回叠加 refX 保持', bt.refX, 123);
eq('切回叠加 refY 保持', bt.refY, 45);
eq('切回叠加 refScale 保持', bt.refScale, 2.5);

// clampPan: 画布≤视口时允许自由平移 (不强制居中)
resetGrid();
bt.cellSize = 20;
bt.canvas.parentNode.getBoundingClientRect = function () { return { left: 0, top: 0, width: 1000, height: 700, right: 1000, bottom: 700 }; };
bt.panX = 300; bt.panY = 200;
bt.clampPan();
eq('画布≤视口: 自由平移 panX 不被强制居中', bt.panX, 300);
eq('画布≤视口: 自由平移 panY 不被强制居中', bt.panY, 200);

// ===========================================================================
console.log('\n=== (新增) 顶部统一缩放 (随工具切换目标) + 窄窗口叠加 CSS 修复 ===');
// zoomTarget: 参考图工具 -> ref, 其他(含移动画布) -> canvas
resetGrid();
bt.selectTool('move');
eq('移动画布工具 -> zoomTarget=canvas', bt.zoomTarget(), 'canvas');
bt.selectTool('reference');
eq('参考工具 -> zoomTarget=ref', bt.zoomTarget(), 'ref');
bt.selectTool('paint');
eq('填色工具 -> zoomTarget=canvas', bt.zoomTarget(), 'canvas');

// 画布百分比缩放: 只改 cellSize, 不动参考图
resetGrid();
bt.cellSize = 30; bt.baseCellSize = 20; bt.panX = 0; bt.panY = 0;
bt.referenceImage = { naturalWidth: 100, naturalHeight: 100 };
bt.refImgW = 100; bt.refImgH = 100;
bt.refScale = 1; bt.refX = 0; bt.refY = 0;
bt.selectTool('move');
bt.zoomToPercent(125);
ok('zoomToPercent(125) -> cellSize = 25 (20*1.25)', Math.abs(bt.cellSize - 25) < 1e-9);
eq('zoomToPercent 不改参考图 refScale', bt.refScale, 1);
eq('zoomToPercent 不改参考图 refX', bt.refX, 0);

// 参考图百分比缩放: 只改 refScale/refX/refY, 不动画布
resetGrid();
bt.cellSize = 30; bt.baseCellSize = 20; bt.panX = 10; bt.panY = 20;
bt.referenceImage = { naturalWidth: 100, naturalHeight: 100 };
bt.refImgW = 100; bt.refImgH = 100;
bt.refScale = 1; bt.refX = 0; bt.refY = 0;
bt.selectTool('reference');
bt.refZoomToPercent(57);
ok('refZoomToPercent(57) -> refScale = 0.57', Math.abs(bt.refScale - 0.57) < 1e-9);
eq('refZoomToPercent 不改画布 cellSize', bt.cellSize, 30);
eq('refZoomToPercent 不改画布 panX', bt.panX, 10);
eq('refZoomToPercent 不改画布 panY', bt.panY, 20);

// updateZoomLabel: 目标标签随工具切换
bt.selectTool('move');
bt.updateZoomLabel();
eq('移动画布工具 -> 标签=画布', byId['zoom-target-label'].textContent, '画布');
bt.selectTool('reference');
bt.updateZoomLabel();
eq('参考工具 -> 标签=参考图', byId['zoom-target-label'].textContent, '参考图');

// HTML: 顶部一套统一缩放 (zoom-level 为输入框) + 浮动参考缩放条已移除
ok('顶部统一缩放: zoom-target-label + zoom-level 输入框存在',
   html.indexOf('id="zoom-target-label"') !== -1 &&
   html.indexOf('id="zoom-level"') !== -1 &&
   html.indexOf('class="zoom-input"') !== -1);
ok('浮动参考图缩放条已移除 (无 ref-zoom-in / ref-zoom-level)',
   html.indexOf('id="ref-zoom-in"') === -1 && html.indexOf('id="ref-zoom-level"') === -1);

// 窄窗口叠加修复 (CSS): 窄屏媒体规则仅作用分栏模式 + 叠加面板强制 height:auto
const cssText = read('css/style.css');
ok('窄屏媒体规则限定分栏模式 (workspace:not(.overlay-mode))',
   cssText.indexOf('.workspace:not(.overlay-mode)') !== -1);
var overlayRefStart = cssText.indexOf('.workspace.overlay-mode .reference-pane');
var overlayRefCss = cssText.slice(overlayRefStart, overlayRefStart + 400);
ok('叠加参考面板强制 height:auto (窄窗口不裁剪为 40%)',
   overlayRefStart !== -1 && overlayRefCss.indexOf('height: auto') !== -1);

// ===========================================================================
console.log('\n=== RESULT ===');
console.log('  PASS: ' + pass + '   FAIL: ' + fail);
if (fail > 0) {
  console.log('  Failed checks:');
  failures.forEach(function (f) { console.log('   - ' + f); });
  process.exit(1);
} else {
  console.log('  All headless checks passed.');
  process.exit(0);
}
