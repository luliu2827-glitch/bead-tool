/**
 * 拼豆电子图纸工具 - 主应用逻辑
 * 功能: 图片导入、像素化、颜色匹配、网格编辑、进度标记、MARD 色卡、PNG 导出
 *
 * 设计要点:
 *  - 核心图片匹配算法只依赖 RGB / LAB 颜色距离, 与色卡 ID (A1/A2/...) 无关。
 *  - 色卡为可插拔模块 (见 js/palettes.js 与 data/palettes/*.js), 新增品牌只需增加
 *    一个数据文件并在注册表中登记, 无需改动匹配算法。
 *  - grid.cells 存储「当前色卡的颜色索引」; 切换色卡时按官方色号 (id) 重新映射,
 *    以保留已绘制内容。
 */
(function () {
  'use strict';

  // ========== 颜色工具函数 ==========

  function hexToRgb(hex) {
    var h = hex.replace('#', '');
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  }

  function rgbToHex(r, g, b) {
    var h = function (v) {
      var s = Math.max(0, Math.min(255, Math.round(v))).toString(16);
      return s.length < 2 ? '0' + s : s;
    };
    return '#' + h(r) + h(g) + h(b);
  }

  function rgbToLab(r, g, b) {
    r = r / 255; g = g / 255; b = b / 255;
    r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
    g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
    b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;
    r *= 100; g *= 100; b *= 100;
    var x = r * 0.4124 + g * 0.3576 + b * 0.1805;
    var y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    var z = r * 0.0193 + g * 0.1192 + b * 0.9505;
    var xn = 95.047, yn = 100.0, zn = 108.883;
    var fx = x / xn, fy = y / yn, fz = z / zn;
    fx = fx > 0.008856 ? Math.cbrt(fx) : 7.787 * fx + 16 / 116;
    fy = fy > 0.008856 ? Math.cbrt(fy) : 7.787 * fy + 16 / 116;
    fz = fz > 0.008856 ? Math.cbrt(fz) : 7.787 * fz + 16 / 116;
    return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
  }

  // 根据背景色亮度返回可读的文字颜色 (黑 / 白)
  function textColorFor(hex) {
    var rgb = hexToRgb(hex);
    var lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    return lum > 0.6 ? '#000000' : '#ffffff';
  }

  // 取颜色显示名 (优先中文名)
  function colorName(c) {
    return (c && (c.nameZh || c.name)) || '';
  }

  // 落子 / 填充动画时长 (ms)
  var ANIM_MS = 240;

  // 空白画布尺寸上限 (避免过大导致卡顿)
  var MAX_BLANK = 200;

  // 缓出 (easeOutCubic)
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  // ========== 本地存档 (IndexedDB, 适合保存参考图片) ==========
  function openBeadDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('beadToolDB', 1);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }
  function beadDBPut(key, val) {
    return openBeadDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(val, key);
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    });
  }
  function beadDBGet(key) {
    return openBeadDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('kv', 'readonly');
        var r = tx.objectStore('kv').get(key);
        r.onsuccess = function () { db.close(); resolve(r.result); };
        r.onerror = function () { db.close(); reject(r.error); };
      });
    });
  }

  // ========== 主应用类 ==========

  function BeadTool() {
    // 网格数据
    this.grid = null; // { width, height, cells: Int16Array(-1=空), done: Uint8Array }

    // 源图片
    this.sourceImage = null;

    // 工具状态
    this.selectedColorIndex = 0;
    this.tool = 'paint';   // paint, eyedropper, eraser, fill
    this.mode = 'edit';    // edit, progress

    // 当前色卡
    this.paletteId = null;        // 例如 'mard-standard'
    this.paletteMeta = null;      // PALETTES[id]
    this.palette = [];            // 当前色卡颜色数组
    this.paletteById = {};        // id -> color
    this.paletteIndexById = {};   // id -> 在 palette 中的索引

    // 颜色筛选
    this.seriesFilter = 'all';
    this.colorSearch = '';

    // 渲染参数
    this.cellSize = 20;
    this.showGrid = true;
    this.hoverCell = null;

    // 交互状态
    this.isDragging = false;
    this.lastPaintedIdx = -1;
    this.dragStartButton = -1;

    // 电子拼豆制作模式
    // 锁定已填充: 逐格状态保存在 grid.locks (Uint8Array, 0/1), 通过 lockFilledCells() 一次性批量锁定, 非持续模式
    this.highlightCurrent = false; // 高亮当前颜色 (突出当前色号的目标格子)
    this.animCells = {};           // 落子动画: idx -> 起始时间戳
    this._animRAF = null;

    // 参考图片 (制作参考, 仅作视觉对照, 不参与颜色匹配)
    this.referenceImage = null;    // Image 对象
    this.referenceDataUrl = null;  // dataURL, 用于保存
    this.refImgW = 0;
    this.refImgH = 0;
    this.refScale = 1;             // 参考图视口缩放 (叠加模式由网格参数推导, 分栏模式为可见值)
    this.refOffsetX = 0;           // 参考图视口平移 (px, 同上)
    this.refOffsetY = 0;
    this.refOpacity = 1;           // 1 = 100%
    // 网格锚定模型 (叠加模式): 参考图以"格子坐标"为锚, 随画布缩放/平移一起移动并保持像素↔格子对应
    this.refCellX = 0;             // 参考图左上角对应的格子 X (浮点)
    this.refCellY = 0;             // 参考图左上角对应的格子 Y (浮点)
    this.refPerCell = 1;           // 每个格子对应多少参考图像素 (uniform, 1:1 时 = refImgW/grid.width)
    this.refScaleExtra = 1;        // 用户额外缩放系数 (叠加模式自由缩放参考图, 默认 1 = 与画布 1:1)
    // 拼豆板颜色 (需求七): 默认白, 可选浅灰 / 自定义
    this.boardColor = '#ffffff';
    this.boardColorMode = 'white'; // 'white' | 'gray' | 'custom'
    this.refDragging = false;
    this.refLastX = 0;
    this.refLastY = 0;

    // 参考图叠加模式 (默认开启: 参考图覆盖在拼豆画布上)
    this.overlayMode = true;
    this.isRefMoving = false;       // 参考图工具: 拖动中
    this.isRefPinching = false;     // 参考图工具: 双指缩放中
    this.refDragOriginX = 0; this.refDragOriginY = 0;
    this.refDragStartX = 0; this.refDragStartY = 0;
    this._refPinchDist = 1; this.refBaseScale = 1;

    // 撤销 / 重做
    this.undoStack = [];
    this.redoStack = [];
    this.maxUndo = 30;
    // 一次连续操作 (一次点击 / 一次拖动笔画) 的快照状态
    this._strokeSnap = null;
    this._strokeChanged = false;
    this._lastLockToast = 0;   // 锁定提示节流时间戳
    this._sbTouched = false;    // 用户是否手动开关过侧栏 (避免反复自动收起)
    this._touchCount = 0;       // 当前屏幕上的手指数量
    this._multiTouch = false;    // 本次手势是否曾出现多指 (防止多指后误触填色)

    // 画布平移 / 缩放 (视图变换)
    this.panX = 0;            // 画布左上角相对容器左上角的平移 (px)
    this.panY = 0;
    this.baseCellSize = 20;   // 「100%」对应的基准格子像素 (随图纸尺寸变化)

    // 平移 / 捏合交互状态
    this.isPanning = false;
    this.panStartX = 0; this.panStartY = 0;
    this.panOriginX = 0; this.panOriginY = 0;
    this.isPinching = false;
    this.pinchStartDist = 0; this.pinchBaseSize = 0;
    this.pinchMidX = 0; this.pinchMidY = 0;
    // 双指平移: 记录手势起点处画面内容坐标, 使捏合 + 拖动同时生效
    this.pinchStartMidX = 0; this.pinchStartMidY = 0;
    this.pinchContentX = 0; this.pinchContentY = 0;
    this.touchMoved = false;
    this.touchStartX = 0; this.touchStartY = 0;
    this._suppressMouseUntil = 0;

    // 预计算调色板 (由当前色卡构建)
    this.paletteRgb = [];
    this.paletteLab = [];

    // DOM 元素引用
    this.canvas = null;
    this.ctx = null;
  }

  // ========== 色卡加载 ==========

  BeadTool.prototype.loadPalette = function (paletteId, silent) {
    var self = this;
    var meta = PALETTES[paletteId];
    if (!meta) {
      paletteId = DEFAULT_PALETTE;
      meta = PALETTES[paletteId];
    }
    if (!meta) return;

    this.paletteId = paletteId;
    this.paletteMeta = meta;
    this.palette = meta.colors;

    // 建立索引映射
    this.paletteById = {};
    this.paletteIndexById = {};
    this.palette.forEach(function (c, i) {
      self.paletteById[c.id] = c;
      self.paletteIndexById[c.id] = i;
    });

    // 预计算 RGB / Lab
    this.paletteRgb = this.palette.map(function (c) {
      return c.rgb ? c.rgb : hexToRgb(c.hex);
    });
    this.paletteLab = this.palette.map(function (c, i) {
      if (c.lab) return c.lab;
      var rgb = self.paletteRgb[i];
      return rgbToLab(rgb.r, rgb.g, rgb.b);
    });

    // 选中色号越界则归零
    if (this.selectedColorIndex >= this.palette.length) this.selectedColorIndex = 0;

    // 更新 UI
    var sel = document.getElementById('palette-select');
    if (sel) sel.value = paletteId;
    var cnt = document.getElementById('palette-count');
    if (cnt) cnt.textContent = this.palette.length + ' colors';

    this.renderSeriesFilter();
    this.renderColorList();
    this.updateSelectedColorInfo();
    this.renderMobilePalette();

    try { localStorage.setItem('bead-palette-id', paletteId); } catch (e) {}
  };

  // 切换色卡: 按官方色号 (id) 重新映射已有图纸
  BeadTool.prototype.setPalette = function (paletteId) {
    if (paletteId === this.paletteId || !PALETTES[paletteId]) return;

    var oldPalette = this.palette;            // 当前色卡颜色数组 (尚未切换)
    var target = PALETTES[paletteId];         // 目标色卡
    // 建立「目标色卡 id -> index」映射, 用于按官方色号重映射
    // 注意: 此时 this.paletteIndexById 仍属于旧色卡, 必须用目标色卡自己的映射
    var targetIndexById = {};
    target.colors.forEach(function (c, i) { targetIndexById[c.id] = i; });

    if (this.grid) {
      var newCells = new Int16Array(this.grid.cells.length);
      var dropped = 0;
      for (var i = 0; i < this.grid.cells.length; i++) {
        var oldIdx = this.grid.cells[i];
        if (oldIdx < 0) { newCells[i] = -1; continue; }
        var oldColor = oldPalette[oldIdx];
        if (oldColor && targetIndexById[oldColor.id] !== undefined) {
          newCells[i] = targetIndexById[oldColor.id];
        } else {
          newCells[i] = -1;
          dropped++;
        }
      }
      this.grid.cells = newCells;
    }

    this.loadPalette(paletteId);

    if (this.grid) {
      this.renderGrid();
      this.updateStats();
    }
    if (dropped > 0) {
      this.toast('已切换到 ' + PALETTES[paletteId].name + ' (丢弃 ' + dropped + ' 个新色卡没有的颜色)', 'warning');
    } else {
      this.toast('已切换到 ' + PALETTES[paletteId].name, 'success');
    }
  };

  // ========== 颜色统计 (按数量排序) ==========

  BeadTool.prototype.getColorCounts = function () {
    if (!this.grid) return [];
    var counts = {};
    var cells = this.grid.cells;
    for (var i = 0; i < cells.length; i++) {
      if (cells[i] >= 0) counts[cells[i]] = (counts[cells[i]] || 0) + 1;
    }
    var arr = Object.keys(counts).map(function (k) {
      return { idx: parseInt(k, 10), count: counts[k] };
    });
    arr.sort(function (a, b) { return b.count - a.count; });
    return arr;
  };

  // ========== 初始化 ==========

  BeadTool.prototype.init = function () {
    var self = this;

    // 确定初始色卡 (优先使用上次选择)
    var savedPalette = null;
    try { savedPalette = localStorage.getItem('bead-palette-id'); } catch (e) {}
    var initial = (savedPalette && PALETTES[savedPalette]) ? savedPalette : DEFAULT_PALETTE;
    this.loadPalette(initial, true);

    // 填充色卡下拉选项
    var sel = document.getElementById('palette-select');
    if (sel) {
      sel.innerHTML = '';
      Object.keys(PALETTES).forEach(function (k) {
        var opt = document.createElement('option');
        opt.value = k;
        opt.textContent = PALETTES[k].label || PALETTES[k].name;
        sel.appendChild(opt);
      });
      sel.value = this.paletteId;
    }

    // 获取 canvas
    this.canvas = document.getElementById('grid-canvas');
    this.ctx = this.canvas.getContext('2d');

    // 绑定事件
    this.bindEvents();
    this.bindKeyboard();

    // 恢复上次的分栏比例
    try {
      var savedW = localStorage.getItem('bead-split-w');
      var refPane0 = document.getElementById('reference-pane');
      if (savedW && refPane0) { refPane0.style.width = savedW; refPane0.style.maxWidth = 'none'; }
    } catch (e) {}

    // 窗口尺寸变化时重新约束画布平移, 避免画布被移出可视区
    window.addEventListener('resize', function () {
      self.clampPan();
      self.applyCanvasTransform();
    });

    // 尝试加载已保存的图纸
    this.loadFromStorage(true);

    // 更新 UI
    this.updateRefToggleLabel();
    this.setOverlayMode(this.overlayMode);   // 应用默认叠加模式 (参考图覆盖画布)
    this.updateMakeToggles();
    this.updateUndoRedoButtons();
    this.updateUI();
  };

  // ========== 颜色选择器 (搜索 / 系列筛选) ==========

  BeadTool.prototype.renderSeriesFilter = function () {
    var container = document.getElementById('series-filter');
    if (!container) return;
    var self = this;

    // 收集当前色卡中的系列 (按出现顺序, 但用固定顺序更友好)
    var order = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'M', 'P', 'Q', 'R', 'T', 'Y', 'ZG'];
    var present = {};
    this.palette.forEach(function (c) { present[c.series] = 1; });
    var series = order.filter(function (s) { return present[s]; });

    container.innerHTML = '';
    var mk = function (key, label) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'series-chip' + (self.seriesFilter === key ? ' active' : '');
      chip.textContent = label;
      chip.dataset.series = key;
      chip.addEventListener('click', function () {
        self.seriesFilter = key;
        self.renderSeriesFilter();
        self.renderColorList();
      });
      return chip;
    };
    container.appendChild(mk('all', '全部'));
    series.forEach(function (s) { container.appendChild(mk(s, s)); });
  };

  BeadTool.prototype.renderColorList = function () {
    var container = document.getElementById('color-list');
    if (!container) return;
    var self = this;

    var q = this.colorSearch.trim().toLowerCase();
    var list = this.palette.filter(function (c) {
      if (self.seriesFilter !== 'all' && c.series !== self.seriesFilter) return false;
      if (q) {
        var hay = (c.id + ' ' + (c.nameZh || '') + ' ' + (c.nameEn || '') + ' ' + c.hex).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });

    container.innerHTML = '';
    if (list.length === 0) {
      container.innerHTML = '<div class="color-empty">没有匹配的颜色</div>';
      return;
    }

    list.forEach(function (c) {
      var idx = self.paletteIndexById[c.id];
      var item = document.createElement('div');
      item.className = 'color-item' + (idx === self.selectedColorIndex ? ' selected' : '');
      item.dataset.index = idx;
      item.title = c.id + ' ' + colorName(c) + ' ' + c.hex;
      item.innerHTML =
        '<div class="ci-swatch" style="background:' + c.hex + '"></div>' +
        '<div class="ci-info">' +
        '<div class="ci-id">' + c.id + '</div>' +
        '<div class="ci-name">' + colorName(c) + '</div>' +
        '</div>' +
        '<div class="ci-hex">' + c.hex.toUpperCase() + '</div>';
      item.addEventListener('click', function () { self.selectColor(idx); });
      // 右键色卡不弹出浏览器菜单 (颜色选取统一为左键)
      item.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      container.appendChild(item);
    });
  };

  BeadTool.prototype.selectColor = function (idx) {
    if (idx < 0 || idx >= this.palette.length) return;
    this.selectedColorIndex = idx;
    document.querySelectorAll('#color-list .color-item').forEach(function (el) {
      el.classList.toggle('selected', parseInt(el.dataset.index, 10) === idx);
    });
    this.updateSelectedColorInfo();
    this.updateCurrentColorStats();
    this.updateMobilePaletteSelection();
    if (this.highlightCurrent) this.renderGrid();
    // 选了颜色自动切到画笔
    if (this.tool === 'eraser') this.selectTool('paint');
  };

  BeadTool.prototype.updateSelectedColorInfo = function () {
    var c = this.palette[this.selectedColorIndex];
    if (!c) return;
    var el = document.getElementById('selected-color-info');
    el.innerHTML =
      '<div class="swatch" style="background:' + c.hex + '"></div>' +
      '<span class="name">MARD ' + c.id + ' · ' + colorName(c) + '</span>' +
      '<span class="code">' + c.hex.toUpperCase() + '</span>';
  };

  // ========== 移动端: 底部 MARD 色卡条 ==========

  BeadTool.prototype.renderMobilePalette = function () {
    var bar = document.getElementById('mobile-palette-bar');
    if (!bar) return;
    var self = this;
    bar.innerHTML = '';
    this.palette.forEach(function (c, i) {
      var sw = document.createElement('div');
      sw.className = 'mp-swatch' + (i === self.selectedColorIndex ? ' selected' : '');
      sw.style.background = c.hex;
      sw.title = 'MARD ' + c.id + ' ' + colorName(c);
      sw.dataset.index = i;
      // 紧凑底部布局也显示 MARD 色号, 方便区分相近颜色
      var lbl = document.createElement('span');
      lbl.className = 'mp-id';
      lbl.textContent = c.id;
      sw.appendChild(lbl);
      sw.addEventListener('click', function () { self.selectColor(i); });
      bar.appendChild(sw);
    });
  };

  BeadTool.prototype.updateMobilePaletteSelection = function () {
    var bar = document.getElementById('mobile-palette-bar');
    if (!bar) return;
    var self = this;
    bar.querySelectorAll('.mp-swatch').forEach(function (el) {
      el.classList.toggle('selected', parseInt(el.dataset.index, 10) === self.selectedColorIndex);
    });
  };

  // ========== 制作模式开关 (顶部工具栏 + 侧栏同步) ==========

  BeadTool.prototype.updateMakeToggles = function () {
    var hb = document.getElementById('btn-highlight-toggle');
    var hc = document.getElementById('toggle-highlight-current');
    if (hb) hb.classList.toggle('on', this.highlightCurrent);
    if (hc) hc.checked = this.highlightCurrent;
  };

  // ========== 侧栏 (移动端抽屉) ==========

  BeadTool.prototype.maybeAutoCollapseSidebar = function () {
    if (this._sbTouched) return;
    var m = (typeof window !== 'undefined' && window.matchMedia)
      ? window.matchMedia('(max-width: 1024px), (pointer: coarse)') : null;
    if (m && m.matches) {
      var main = document.querySelector('.main');
      if (main) main.classList.add('sb-collapsed');
      this._sbTouched = true;  // 仅自动收起一次, 之后由用户手动控制
    }
  };

  BeadTool.prototype.toggleSidebar = function () {
    var main = document.querySelector('.main');
    if (!main) return;
    main.classList.toggle('sb-collapsed');
    this._sbTouched = true;  // 用户已手动操作, 不再自动收起
  };

  // ========== 清空画布 (🗑) ==========

  BeadTool.prototype.clearCanvas = function () {
    if (!this.grid) { this.toast('没有可清空的画布', 'warning'); return; }
    var self = this;
    this.confirmDialog('清空整个画布？格子内容会被清空（保留尺寸），可撤销。', function () {
      self.beginStroke();
      self.grid.cells.fill(-1);
      self.grid.done.fill(0);
      self.grid.locks.fill(0);
      self.endStroke();
      self.renderGrid();
      self.updateStats();
      self.toast('画布已清空', 'success');
    });
  };

  // ========== 锁定已填充 (一次性批量操作, 非持续模式) ==========

  // 点击「锁定已填充」: 仅把当前「已填色且尚未锁定」的格子锁定。
  // 空白格子不锁定; 已锁定的保持锁定; 之后新填的格子不会自动锁定。
  // 再次点击才进行下一次批量锁定。锁定作为一次笔画进入撤销历史。
  BeadTool.prototype.lockFilledCells = function () {
    if (!this.grid) { this.toast('没有可锁定的画布', 'warning'); return; }
    this.beginStroke();
    var n = 0;
    for (var i = 0; i < this.grid.cells.length; i++) {
      if (this.grid.cells[i] >= 0 && this.grid.locks[i] === 0) {
        this.grid.locks[i] = 1;
        this._strokeChanged = true;
        n++;
      }
    }
    this.endStroke();
    this.renderGrid();
    var lb = document.getElementById('btn-lock-toggle');
    if (n > 0) {
      this.toast('已锁定 ' + n + ' 个已填格子（新填的格子不会自动锁定，再次点击可锁定新填的）', 'success');
      if (lb) {
        lb.classList.add('on');
        setTimeout(function () { if (lb) lb.classList.remove('on'); }, 700);
      }
    } else {
      this.toast('没有新的可锁定格子（已填的都锁过了）', 'info');
    }
  };

  // ========== 工具选择 ==========

  BeadTool.prototype.selectTool = function (tool) {
    this.tool = tool;
    document.querySelectorAll('.tool-btn').forEach(function (el) {
      el.classList.toggle('active', el.dataset.tool === tool);
    });
    this.canvas.className = '';
    if (this.mode === 'progress') {
      this.canvas.classList.add('mode-progress');
    } else {
      this.canvas.classList.add('tool-' + tool);
    }
  };

  BeadTool.prototype.setMode = function (mode) {
    this.mode = mode;
    document.querySelectorAll('.mode-btn').forEach(function (el) {
      el.classList.toggle('active', el.dataset.mode === mode);
    });
    this.selectTool(this.tool);
    var pa = document.getElementById('progress-actions');
    if (pa) pa.style.display = mode === 'progress' ? 'block' : 'none';
    this.renderGrid();
  };

  // ========== 事件绑定 ==========

  BeadTool.prototype.bindEvents = function () {
    var self = this;

    // --- 文件导入 ---
    var dropZone = document.getElementById('drop-zone');
    var fileInput = document.getElementById('file-input');

    dropZone.addEventListener('click', function () { fileInput.click(); });

    fileInput.addEventListener('change', function (e) {
      if (e.target.files[0]) self.loadImageFile(e.target.files[0]);
    });

    ['dragenter', 'dragover'].forEach(function (evt) {
      dropZone.addEventListener(evt, function (e) {
        e.preventDefault(); e.stopPropagation();
        dropZone.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      dropZone.addEventListener(evt, function (e) {
        e.preventDefault(); e.stopPropagation();
        dropZone.classList.remove('dragover');
      });
    });
    dropZone.addEventListener('drop', function (e) {
      var file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) {
        self.loadImageFile(file);
      } else {
        self.toast('请拖入图片文件', 'error');
      }
    });

    document.getElementById('btn-remove-image').addEventListener('click', function () {
      self.sourceImage = null;
      document.getElementById('image-preview').style.display = 'none';
      document.getElementById('drop-zone').style.display = 'block';
    });

    // --- 像素化设置 ---
    document.getElementById('auto-height').addEventListener('change', function () {
      document.getElementById('grid-height').disabled = this.checked;
      if (this.checked && self.sourceImage) self.updateAutoHeight();
    });
    document.getElementById('grid-width').addEventListener('change', function () {
      if (document.getElementById('auto-height').checked && self.sourceImage) {
        self.updateAutoHeight();
      }
    });
    document.getElementById('btn-generate').addEventListener('click', function () {
      self.generatePattern();
    });

    // --- 色卡选择 ---
    var paletteSel = document.getElementById('palette-select');
    if (paletteSel) {
      paletteSel.addEventListener('change', function () { self.setPalette(this.value); });
    }
    var searchInput = document.getElementById('color-search');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        self.colorSearch = this.value;
        self.renderColorList();
      });
    }

    // --- 工具按钮 ---
    document.querySelectorAll('.tool-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { self.selectTool(this.dataset.tool); });
    });

    // --- 模式切换 ---
    document.querySelectorAll('.mode-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { self.setMode(this.dataset.mode); });
    });

    // --- 电子拼豆制作模式开关 ---
    // 「锁定已填充」是一次性批量操作 (见 lockFilledCells), 不再是持续模式
    var lockEl = document.getElementById('toggle-lock-filled');
    if (lockEl) lockEl.addEventListener('click', function () {
      self.lockFilledCells();
    });
    var hlEl = document.getElementById('toggle-highlight-current');
    if (hlEl) hlEl.addEventListener('change', function () {
      self.highlightCurrent = this.checked;
      self.updateMakeToggles();
      self.renderGrid();
      self.updateCurrentColorStats();
      self.toast(this.checked ? '已开启：高亮当前颜色' : '已关闭：高亮当前颜色', this.checked ? 'success' : '');
    });

    // --- 空白画布尺寸 (电子拼豆) ---
    var sizeChips = document.getElementById('blank-size-chips');
    if (sizeChips) {
      sizeChips.querySelectorAll('button').forEach(function (btn) {
        btn.addEventListener('click', function () {
          sizeChips.querySelectorAll('button').forEach(function (b) { b.classList.remove('active'); });
          if (btn.dataset.custom) {
            // 自定义: 不修改数值, 仅聚焦宽度输入框让用户输入
            var iw = document.getElementById('blank-width');
            if (iw) iw.focus();
            btn.classList.add('active');
            return;
          }
          var w = parseInt(btn.dataset.w, 10), h = parseInt(btn.dataset.h, 10);
          var iw = document.getElementById('blank-width'), ih = document.getElementById('blank-height');
          if (iw) iw.value = w;
          if (ih) ih.value = h;
          btn.classList.add('active');
        });
      });
    }
    var blankW = document.getElementById('blank-width');
    var blankH = document.getElementById('blank-height');
    if (blankW) blankW.addEventListener('input', self._clearSizeChipActiveOnCustom);
    if (blankH) blankH.addEventListener('input', self._clearSizeChipActiveOnCustom);
    var blankBtn = document.getElementById('btn-blank-canvas');
    if (blankBtn) blankBtn.addEventListener('click', function () {
      self.createBlankGrid(null, null, true);
    });

    // --- 顶栏按钮 ---
    document.getElementById('btn-zoom-in').addEventListener('click', function () {
      self.zoomCenter(1.25);
    });
    document.getElementById('btn-zoom-out').addEventListener('click', function () {
      self.zoomCenter(1 / 1.25);
    });
    var fitBtn = document.getElementById('btn-fit');
    if (fitBtn) fitBtn.addEventListener('click', function () { self.fitCanvas(); });
    var resetBtn = document.getElementById('btn-zoom-reset');
    if (resetBtn) resetBtn.addEventListener('click', function () { self.resetZoom100(); });
    document.getElementById('btn-toggle-grid').addEventListener('click', function () {
      self.showGrid = !self.showGrid;
      this.classList.toggle('active', self.showGrid);
      self.renderGrid();
    });
    document.getElementById('btn-save').addEventListener('click', function () {
      self.saveToStorage();
    });
    document.getElementById('btn-load').addEventListener('click', function () {
      self.loadFromStorage(false);
    });
    document.getElementById('btn-export-png').addEventListener('click', function () {
      self.exportPNG();
    });

    // --- 撤销 / 重做 ---
    var undoBtn = document.getElementById('btn-undo');
    if (undoBtn) undoBtn.addEventListener('click', function () { self.undo(); });
    var redoBtn = document.getElementById('btn-redo');
    if (redoBtn) redoBtn.addEventListener('click', function () { self.redo(); });

    // --- 制作模式开关 (顶部工具栏) ---
    // 「锁定已填充」为一次性批量锁定动作
    var lockBtn = document.getElementById('btn-lock-toggle');
    if (lockBtn) lockBtn.addEventListener('click', function () {
      self.lockFilledCells();
    });
    var hlBtn = document.getElementById('btn-highlight-toggle');
    if (hlBtn) hlBtn.addEventListener('click', function () {
      self.highlightCurrent = !self.highlightCurrent;
      self.updateMakeToggles();
      self.renderGrid();
      self.updateCurrentColorStats();
      self.toast(self.highlightCurrent ? '已开启：高亮当前颜色' : '已关闭：高亮当前颜色', self.highlightCurrent ? 'success' : '');
    });

    // --- 清空画布 (🗑) ---
    var clearBtn = document.getElementById('btn-clear-canvas');
    if (clearBtn) clearBtn.addEventListener('click', function () { self.clearCanvas(); });

    // --- 移动端侧栏开关 (☰) ---
    var sbBtn = document.getElementById('btn-toggle-sidebar');
    if (sbBtn) sbBtn.addEventListener('click', function () { self.toggleSidebar(); });

    // --- Canvas 交互 ---
    this.canvas.addEventListener('mousedown', function (e) { self.handleMouseDown(e); });
    this.canvas.addEventListener('mousemove', function (e) { self.handleMouseMove(e); });
    this.canvas.addEventListener('mouseup', function (e) { self.handleMouseUp(e); });
    this.canvas.addEventListener('mouseleave', function () {
      self.hoverCell = null;
      self.renderGrid();
      document.getElementById('coord-display').textContent = '';
    });
    // 颜色选取统一为「左键」操作: 点色卡选色 / 吸管工具(I)点画布取色。
    // 画布右键不再吸色, 仅阻止浏览器默认菜单, 避免与左键选色逻辑冲突。
    this.canvas.addEventListener('contextmenu', function (e) {
      e.preventDefault();
    });
    this.canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (self.tool === 'reference') {
        self.refZoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
      } else {
        self.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
      }
    }, { passive: false });

    // 全局 mouseup: 在画布外松开也能结束平移 / 拖画
    document.addEventListener('mouseup', function () { self.handleMouseUp(); });

    // --- 触摸: 单指移动/填色, 双指捏合缩放 (手机 / iPad) ---
    this.canvas.addEventListener('touchstart', function (e) {
      e.preventDefault();
      self._touchActive = true;
      self._suppressMouseUntil = Date.now() + 700;
      self._touchCount = e.touches.length;
      if (e.touches.length >= 2) self._multiTouch = true;
      if (e.touches.length === 2) {
        if (self.tool === 'reference') {
          // 参考图工具: 双指捏合 = 缩放参考图 (不动画布)
          self.isRefPinching = true; self.touchMoved = true;
          var rmx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          var rmy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          var rdist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY) || 1;
          self.refPinchStart(rmx, rmy, rdist);
          return;
        }
        self.isPanning = false; self.isDragging = false; self.isPinching = true; self.touchMoved = true;
        var dx = e.touches[0].clientX - e.touches[1].clientX;
        var dy = e.touches[0].clientY - e.touches[1].clientY;
        self.pinchStartDist = Math.hypot(dx, dy) || 1;
        self.pinchBaseSize = self.cellSize;
        var crect = self.canvas.parentNode.getBoundingClientRect();
        self.pinchStartMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - crect.left;
        self.pinchStartMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - crect.top;
        // 记录手势起点处的画布内容坐标, 使双指捏合缩放 + 双指拖动平移同时生效
        self.pinchContentX = (self.pinchStartMidX - self.panX) / self.pinchBaseSize;
        self.pinchContentY = (self.pinchStartMidY - self.panY) / self.pinchBaseSize;
        return;
      }
      var t = e.touches[0];
      self.touchStartX = t.clientX; self.touchStartY = t.clientY; self.touchMoved = false;
      if (self._multiTouch) return;  // 多指手势残留, 不启动单指绘制
      if (self.tool === 'move') {
        self.isPanning = true;
        self.panStartX = t.clientX; self.panStartY = t.clientY;
        self.panOriginX = self.panX; self.panOriginY = self.panY;
      } else if (self.tool === 'reference') {
        // 参考图工具: 单指拖动 = 移动参考图 (不改格子 / 不动画布)
        self.isRefMoving = true;
        self.refMoveStart(t.clientX, t.clientY);
      } else if (self.tool === 'paint' || self.tool === 'eraser') {
        self.isDragging = true; self.dragStartButton = 0; self.lastPaintedIdx = -1;
        self.beginStroke();  // 一次笔画开始 (可能是单击或拖动)
      }
    }, { passive: false });

    this.canvas.addEventListener('touchmove', function (e) {
      e.preventDefault();
      self._touchCount = e.touches.length;
      if (self.isPinching && e.touches.length >= 2) {
        if (self.isRefPinching) {
          // 参考图工具: 双指捏合缩放参考图
          var rdx = e.touches[0].clientX - e.touches[1].clientX;
          var rdy = e.touches[0].clientY - e.touches[1].clientY;
          var rdist = Math.hypot(rdx, rdy) || 1;
          var rmidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          var rmidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          self.refPinchTo(rmidX, rmidY, rdist);
          return;
        }
        var dx = e.touches[0].clientX - e.touches[1].clientX;
        var dy = e.touches[0].clientY - e.touches[1].clientY;
        var dist = Math.hypot(dx, dy) || 1;
        var newSize = Math.max(2, Math.min(60, self.pinchBaseSize * (dist / self.pinchStartDist)));
        // 双指中点 (容器坐标)
        var crect = self.canvas.parentNode.getBoundingClientRect();
        var midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - crect.left;
        var midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - crect.top;
        // 双指捏合缩放 + 双指拖动平移 (同步生效), 不修改任何格子
        self.cellSize = newSize;
        self.panX = midX - self.pinchContentX * newSize;
        self.panY = midY - self.pinchContentY * newSize;
        self.setupCanvas();
        self.clampPan();
        self.applyCanvasTransform();
        self.updateZoomLabel();
        return;
      }
      if (self.isPanning) {
        var t = e.touches[0];
        self.panX = self.panOriginX + (t.clientX - self.panStartX);
        self.panY = self.panOriginY + (t.clientY - self.panStartY);
        self.clampPan(); self.applyCanvasTransform();
        return;
      }
      if (e.touches.length === 1 && !self._multiTouch) {
        var t2 = e.touches[0];
        if (Math.abs(t2.clientX - self.touchStartX) > 6 || Math.abs(t2.clientY - self.touchStartY) > 6) {
          self.touchMoved = true;
        }
        if (self.isRefMoving && self.tool === 'reference') {
          self.refMoveTo(t2.clientX, t2.clientY);
        } else if (self.isDragging && (self.tool === 'paint' || self.tool === 'eraser')) {
          var cell = self.getCellFromClient(t2.clientX, t2.clientY);
          if (cell) {
            var idx = cell.y * self.grid.width + cell.x;
            if (idx !== self.lastPaintedIdx) {
              if (self.tool === 'paint') { self.paintCell(cell.x, cell.y); self.lastPaintedIdx = idx; }
              else if (self.tool === 'eraser') { self.eraseCell(cell.x, cell.y); self.lastPaintedIdx = idx; }
            }
          }
        }
      }
    }, { passive: false });

    this.canvas.addEventListener('touchend', function (e) {
      e.preventDefault();
      self._touchCount = e.touches.length;
      if (self.isPinching) {
        if (e.touches.length < 2) { self.isPinching = false; self.touchMoved = true; } else return;
      }
      if (self.isPanning) self.isPanning = false;
      if (self.isRefMoving) self.isRefMoving = false;
      if (self.isRefPinching && e.touches.length < 2) self.isRefPinching = false;
      if (self.isDragging && (self.tool === 'paint' || self.tool === 'eraser')) {
        self.isDragging = false; self.lastPaintedIdx = -1; self.dragStartButton = -1;
        self.endStroke();
      }
      // 未移动的单击: 在非移动工具下执行对应动作 (多指残留时不触发)
      if (!self.touchMoved && self.tool !== 'move' && e.changedTouches.length >= 1 && !self._multiTouch) {
        var t = e.changedTouches[0];
        var cell = self.getCellFromClient(t.clientX, t.clientY);
        if (cell) {
          if (self.tool === 'eyedropper') self.eyedropCell(cell.x, cell.y);
          else if (self.tool === 'fill') { self.beginStroke(); self.fillCell(cell.x, cell.y); self.endStroke(); }
          else if (self.tool === 'paint') { self.beginStroke(); self.paintCell(cell.x, cell.y); self.endStroke(); }
          else if (self.tool === 'eraser') { self.beginStroke(); self.eraseCell(cell.x, cell.y); self.endStroke(); }
        }
      }
      self.touchMoved = false;
      self._touchActive = false;
      self._suppressMouseUntil = Date.now() + 700;
      if (self._touchCount === 0) self._multiTouch = false;
    }, { passive: false });
    this.canvas.addEventListener('touchcancel', function () {
      self.isPanning = false; self.isDragging = false; self.isPinching = false; self.touchMoved = false;
    });

    // --- 分隔条: 拖动调整参考图 / 画布比例 (鼠标 + 触摸) ---
    var splitter = document.getElementById('splitter');
    if (splitter) {
      splitter.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        try { splitter.setPointerCapture(e.pointerId); } catch (_) {}
        splitter.classList.add('dragging');
        var ws = document.getElementById('workspace');
        var refPane = document.getElementById('reference-pane');
        var startX = e.clientX;
        var startW = refPane.getBoundingClientRect().width;
        var move = function (ev) {
          var wsRect = ws.getBoundingClientRect();
          var newW = startW + (ev.clientX - startX);
          var minW = wsRect.width * 0.15;
          var maxW = wsRect.width * 0.75;
          newW = Math.max(minW, Math.min(maxW, newW));
          refPane.style.width = newW + 'px';
          refPane.style.maxWidth = 'none';
          if (self.canvas) { self.clampPan(); self.applyCanvasTransform(); }
        };
        var up = function () {
          splitter.classList.remove('dragging');
          splitter.removeEventListener('pointermove', move);
          splitter.removeEventListener('pointerup', up);
          try { splitter.releasePointerCapture(e.pointerId); } catch (_) {}
          try { localStorage.setItem('bead-split-w', refPane.style.width); } catch (_) {}
        };
        splitter.addEventListener('pointermove', move);
        splitter.addEventListener('pointerup', up);
      });
    }

    // --- 参考图片 (制作参考) ---
    var refFile = document.getElementById('reference-file-input');
    var openRef = function () { if (refFile) refFile.click(); };
    document.getElementById('btn-upload-reference').addEventListener('click', openRef);
    document.getElementById('btn-ref-upload-side').addEventListener('click', openRef);
    if (refFile) refFile.addEventListener('change', function (e) {
      if (e.target.files[0]) self.loadReferenceFile(e.target.files[0]);
    });
    document.getElementById('ref-zoom-in').addEventListener('click', function () {
      self.refZoomCenter(1.2);
    });
    document.getElementById('ref-zoom-out').addEventListener('click', function () {
      self.refZoomCenter(1 / 1.2);
    });
    document.getElementById('ref-fit').addEventListener('click', function () {
      self.refFitWindow();
    });
    document.getElementById('ref-reset').addEventListener('click', function () {
      self.refReset100();
    });
    var refOpacity = document.getElementById('ref-opacity');
    if (refOpacity) refOpacity.addEventListener('input', function () {
      self.refOpacity = parseInt(this.value, 10) / 100;
      var val = document.getElementById('ref-opacity-val');
      if (val) val.textContent = this.value + '%';
      self.applyRefTransform();
    });
    document.getElementById('ref-remove').addEventListener('click', function () {
      self.refRemove();
    });
    document.getElementById('ref-mode-toggle').addEventListener('click', function () {
      self.setOverlayMode(!self.overlayMode);
    });
    document.getElementById('ref-align').addEventListener('click', function () {
      self.alignReferenceToCanvas();
    });
    document.getElementById('btn-toggle-reference').addEventListener('click', function () {
      self.toggleReferencePane();
    });
    // 拼豆板颜色 (需求七): 白 / 浅灰 / 自定义
    var boardMode = document.getElementById('board-color-mode');
    if (boardMode) {
      boardMode.value = self.boardColorMode || 'white';
      var customRow = document.getElementById('board-custom-row');
      if (customRow) customRow.style.display = (self.boardColorMode === 'custom') ? '' : 'none';
      var boardCustom = document.getElementById('board-color-custom');
      if (boardCustom) boardCustom.value = self.boardColor || '#ffffff';
      boardMode.addEventListener('change', function () {
        var mode = this.value;
        self.boardColorMode = mode;
        var cr = document.getElementById('board-custom-row');
        if (cr) cr.style.display = (mode === 'custom') ? '' : 'none';
        if (mode === 'white') self.boardColor = '#ffffff';
        else if (mode === 'gray') self.boardColor = '#e9e9ee';
        else { var bc = document.getElementById('board-color-custom'); if (bc) self.boardColor = bc.value; }
        if (self.grid) self.renderGrid();
      });
      if (boardCustom) boardCustom.addEventListener('input', function () {
        self.boardColor = this.value;
        self.boardColorMode = 'custom';
        if (boardMode) boardMode.value = 'custom';
        var cr = document.getElementById('board-custom-row');
        if (cr) cr.style.display = '';
        if (self.grid) self.renderGrid();
      });
    }
    // 参考图: 拖拽平移 + 滚轮缩放
    var refVp = document.getElementById('reference-viewport');
    if (refVp) {
      refVp.addEventListener('mousedown', function (e) {
        if (self.overlayMode) return;   // 叠加模式由画布层统一处理参考图操作
        if (e.target.closest('button, input, label')) return;
        self.refDragging = true;
        self.refLastX = e.clientX; self.refLastY = e.clientY;
        e.preventDefault();
        var move = function (ev) {
          if (!self.refDragging) return;
          self.refOffsetX += ev.clientX - self.refLastX;
          self.refOffsetY += ev.clientY - self.refLastY;
          self.refLastX = ev.clientX; self.refLastY = ev.clientY;
          self.applyRefTransform();
        };
        var up = function () {
          self.refDragging = false;
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
      refVp.addEventListener('wheel', function (e) {
        if (self.overlayMode) return;
        e.preventDefault();
        self.refZoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
      }, { passive: false });
      // 参考图触摸: 单指拖动平移, 双指捏合缩放 (与画布操作相互独立)
      refVp.addEventListener('touchstart', function (e) {
        if (self.overlayMode) return;
        if (e.target.closest('button, input, label')) return;
        e.preventDefault();
        if (e.touches.length === 2) {
          self._refPinch = true;
          var ddx = e.touches[0].clientX - e.touches[1].clientX;
          var ddy = e.touches[0].clientY - e.touches[1].clientY;
          self._refPinchDist = Math.hypot(ddx, ddy) || 1;
          return;
        }
        self.refDragging = true;
        self.refLastX = e.touches[0].clientX; self.refLastY = e.touches[0].clientY;
      }, { passive: false });
      refVp.addEventListener('touchmove', function (e) {
        if (e.target.closest('button, input, label')) return;
        e.preventDefault();
        if (self._refPinch && e.touches.length >= 2) {
          var ddx = e.touches[0].clientX - e.touches[1].clientX;
          var ddy = e.touches[0].clientY - e.touches[1].clientY;
          var dist = Math.hypot(ddx, ddy) || 1;
          self.refZoomAt((e.touches[0].clientX + e.touches[1].clientX) / 2,
                         (e.touches[0].clientY + e.touches[1].clientY) / 2,
                         dist / self._refPinchDist);
          self._refPinchDist = dist;
          return;
        }
        if (self.refDragging) {
          self.refOffsetX += e.touches[0].clientX - self.refLastX;
          self.refOffsetY += e.touches[0].clientY - self.refLastY;
          self.refLastX = e.touches[0].clientX; self.refLastY = e.touches[0].clientY;
          self.applyRefTransform();
        }
      }, { passive: false });
      refVp.addEventListener('touchend', function (e) {
        if (e.touches.length < 2) self._refPinch = false;
        self.refDragging = false;
      });
    }

    // --- 进度操作 ---
    var pa = document.getElementById('progress-actions');
    if (pa) {
      pa.querySelector('[data-action="clear"]').addEventListener('click', function () {
        if (self.grid) {
          self.pushUndo();
          self.grid.done.fill(0);
          self.renderGrid();
          self.updateStats();
          self.toast('进度已清除');
        }
      });
      pa.querySelector('[data-action="complete"]').addEventListener('click', function () {
        if (self.grid) {
          self.pushUndo();
          self.grid.done.fill(1);
          self.renderGrid();
          self.updateStats();
          self.toast('已全部标记完成', 'success');
        }
      });
    }
  };

  BeadTool.prototype.bindKeyboard = function () {
    var self = this;
    document.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      switch (e.key.toLowerCase()) {
        case 'b': self.selectTool('paint'); break;
        case 'i': self.selectTool('eyedropper'); break;
        case 'e': self.selectTool('eraser'); break;
        case 'f': self.selectTool('fill'); break;
        case 'g':
          self.showGrid = !self.showGrid;
          document.getElementById('btn-toggle-grid').classList.toggle('active', self.showGrid);
          self.renderGrid();
          break;
        case 'z':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); self.undo(); }
          break;
        case 'y':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); self.redo(); }
          break;
        case '1':
        case '2':
          self.setMode(e.key === '1' ? 'edit' : 'progress');
          break;
      }
    });
  };

  // ========== 图片加载 ==========

  BeadTool.prototype.loadImageFile = function (file) {
    var self = this;
    var reader = new FileReader();
    reader.onload = function (e) {
      var img = new Image();
      img.onload = function () {
        self.sourceImage = img;
        self.showImagePreview(e.target.result);
        self.updateAutoHeight();
        self.toast('图片已加载: ' + img.width + 'x' + img.height, 'success');
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  };

  BeadTool.prototype.showImagePreview = function (src) {
    document.getElementById('preview-img').src = src;
    document.getElementById('image-size').textContent =
      this.sourceImage.width + ' x ' + this.sourceImage.height;
    document.getElementById('image-preview').style.display = 'block';
    document.getElementById('drop-zone').style.display = 'none';
  };

  BeadTool.prototype.updateAutoHeight = function () {
    if (!this.sourceImage) return;
    if (!document.getElementById('auto-height').checked) return;
    var w = parseInt(document.getElementById('grid-width').value) || 29;
    var ratio = this.sourceImage.height / this.sourceImage.width;
    var h = Math.max(1, Math.round(w * ratio));
    document.getElementById('grid-height').value = h;
  };

  // ========== 参考图片 (制作参考) ==========

  BeadTool.prototype.loadReferenceFile = function (file) {
    if (!file) return;
    var self = this;
    var reader = new FileReader();
    reader.onload = function (e) {
      var src = e.target.result;
      var img = new Image();
      img.onload = function () {
        self.referenceImage = img;
        self.referenceDataUrl = src;
        self.refImgW = img.naturalWidth;
        self.refImgH = img.naturalHeight;
        self.showReferencePane();
        document.getElementById('reference-img').src = src;
        self.refFitWindow();
        self.updateRefStatus(file.name);
        self.toast('参考图已加载: ' + img.naturalWidth + 'x' + img.naturalHeight, 'success');
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  };

  BeadTool.prototype.showReferencePane = function () {
    var pane = document.getElementById('reference-pane');
    if (pane) pane.classList.remove('hidden');
    var sp = document.getElementById('splitter');
    if (sp) sp.classList.remove('hidden');
    var ph = document.getElementById('reference-placeholder');
    if (ph) ph.style.display = 'none';
    var img = document.getElementById('reference-img');
    if (img) img.style.display = 'block';
    this.updateRefToggleLabel();
  };

  // 将参考图变换应用到 DOM (叠加模式: 由网格锚定参数推导; 分栏模式: 沿用视口可见值)
  BeadTool.prototype.applyRefTransform = function () {
    var stage = document.getElementById('reference-stage');
    if (!stage) return;
    if (this.overlayMode && this.referenceImage && this.grid) {
      this.computeRefViewportTransform();
    }
    stage.style.transform =
      'translate(' + this.refOffsetX + 'px,' + this.refOffsetY + 'px) scale(' + this.refScale + ')';
    var img = document.getElementById('reference-img');
    if (img) img.style.opacity = this.refOpacity;
    var zl = document.getElementById('ref-zoom-level');
    if (zl) zl.textContent = Math.round(this.refScale * 100) + '%';
  };

  // 叠加模式: 由网格锚定参数 + 画布变换推导参考图视口变换 (参考图与格子真正对应, 缩放/平移画布时同步)
  BeadTool.prototype.computeRefViewportTransform = function () {
    var vp = document.getElementById('reference-viewport');
    var container = this.canvas ? this.canvas.parentNode : null;
    if (!vp || !container) return;
    var vpRect = vp.getBoundingClientRect();
    var cRect = container.getBoundingClientRect();
    // 网格原点(格 0,0 左上角)在参考视口本地坐标中的位置
    var ax = (cRect.left + this.panX) - vpRect.left;
    var ay = (cRect.top + this.panY) - vpRect.top;
    this.refScale = (this.cellSize / this.refPerCell) * this.refScaleExtra;
    this.refOffsetX = ax + this.refCellX * this.cellSize;
    this.refOffsetY = ay + this.refCellY * this.cellSize;
  };

  // 叠加模式: 在屏幕点 (clientX,clientY) 把额外缩放改为 newExtra, 并保持该点下的格子不动 (像素↔格子对应)
  BeadTool.prototype.refSetScaleAt = function (clientX, clientY, newExtra) {
    var vp = document.getElementById('reference-viewport');
    var container = this.canvas ? this.canvas.parentNode : null;
    if (!vp || !container) return;
    newExtra = Math.max(0.05, Math.min(20, newExtra));
    var vpRect = vp.getBoundingClientRect();
    var cRect = container.getBoundingClientRect();
    var ax = (cRect.left + this.panX) - vpRect.left;
    var ay = (cRect.top + this.panY) - vpRect.top;
    var curScale = (this.cellSize / this.refPerCell) * this.refScaleExtra;
    var vx = clientX - vpRect.left, vy = clientY - vpRect.top;
    var ix = (vx - (ax + this.refCellX * this.cellSize)) / curScale;
    var iy = (vy - (ay + this.refCellY * this.cellSize)) / curScale;
    var gx = this.refCellX + ix / this.refPerCell;
    var gy = this.refCellY + iy / this.refPerCell;
    this.refScaleExtra = newExtra;
    if (Math.abs(newExtra - 1) < 1e-6) {
      this.refCellX = gx - (vx - ax) / this.cellSize;
      this.refCellY = gy - (vy - ay) / this.cellSize;
    } else {
      this.refCellX = (vx - ax - gx * this.cellSize * newExtra) / (this.cellSize * (1 - newExtra));
      this.refCellY = (vy - ay - gy * this.cellSize * newExtra) / (this.cellSize * (1 - newExtra));
    }
    this.applyRefTransform();
  };

  // 以视口内某点为焦点缩放 (叠加模式改额外系数并锁定格子; 分栏模式改视口缩放)
  BeadTool.prototype.refZoomAt = function (clientX, clientY, factor) {
    if (this.overlayMode && this.referenceImage && this.grid) {
      this.refSetScaleAt(clientX, clientY, this.refScaleExtra * factor);
      return;
    }
    var vp = document.getElementById('reference-viewport');
    if (!vp) return;
    var rect = vp.getBoundingClientRect();
    var cx = clientX - rect.left, cy = clientY - rect.top;
    var stageX = (cx - this.refOffsetX) / this.refScale;
    var stageY = (cy - this.refOffsetY) / this.refScale;
    this.refScale = Math.max(0.1, Math.min(8, this.refScale * factor));
    this.refOffsetX = cx - stageX * this.refScale;
    this.refOffsetY = cy - stageY * this.refScale;
    this.applyRefTransform();
  };

  BeadTool.prototype.refZoomCenter = function (factor) {
    var vp = document.getElementById('reference-viewport');
    if (!vp) return;
    var rect = vp.getBoundingClientRect();
    this.refZoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  };

  // 参考图"适应": 叠加模式 = 1:1 对齐画布; 分栏模式 = 适配视口
  BeadTool.prototype.refFitWindow = function () {
    if (this.overlayMode && this.referenceImage && this.grid) {
      this.alignReferenceToCanvas();
      return;
    }
    var vp = document.getElementById('reference-viewport');
    if (!this.referenceImage || !vp) return;
    var rect = vp.getBoundingClientRect();
    var s = Math.min(rect.width / this.refImgW, rect.height / this.refImgH) || 1;
    this.refScale = Math.max(0.1, Math.min(8, s));
    this.refOffsetX = (rect.width - this.refImgW * this.refScale) / 2;
    this.refOffsetY = (rect.height - this.refImgH * this.refScale) / 2;
    this.applyRefTransform();
  };

  // 参考图"100%": 叠加模式 = 复位额外缩放(保留位置); 分栏模式 = 复位视口缩放
  BeadTool.prototype.refReset100 = function () {
    if (this.overlayMode && this.referenceImage && this.grid) {
      this.refScaleExtra = 1;
      this.applyRefTransform();
      return;
    }
    if (!this.referenceImage) return;
    var vp = document.getElementById('reference-viewport');
    var rect = vp ? vp.getBoundingClientRect() : { width: 0, height: 0 };
    this.refScale = 1;
    this.refOffsetX = (rect.width - this.refImgW) / 2;
    this.refOffsetY = (rect.height - this.refImgH) / 2;
    this.applyRefTransform();
  };

  // ========== 参考图叠加 / 对齐 ==========

  // 进入 / 退出叠加模式 (参考图覆盖画布)
  BeadTool.prototype.setOverlayMode = function (on) {
    this.overlayMode = !!on;
    var ws = document.querySelector('.workspace');
    if (ws) ws.classList.toggle('overlay-mode', this.overlayMode);
    var btn = document.getElementById('ref-mode-toggle');
    if (btn) btn.textContent = this.overlayMode ? '⬓ 分栏' : '⬓ 叠加';
    if (this.overlayMode && this.referenceImage) {
      // 进入叠加时, 若有图纸则对齐到画布范围, 否则适配视口
      if (this.grid) this.alignReferenceToCanvas();
      else this.refFitWindow();
    }
  };

  // 参考图自由移动 (参考图工具 / 视口拖拽共用)
  BeadTool.prototype.refMoveStart = function (cx, cy) {
    this.refDragOriginX = this.refOffsetX;
    this.refDragOriginY = this.refOffsetY;
    this.refDragStartX = cx; this.refDragStartY = cy;
  };
  BeadTool.prototype.refMoveTo = function (cx, cy) {
    if (this.overlayMode && this.referenceImage && this.grid) {
      // 屏幕位移换算为格子位移 (1 格 = cellSize 屏幕 px), 保持像素↔格子对应
      this.refCellX += (cx - this.refDragStartX) / this.cellSize;
      this.refCellY += (cy - this.refDragStartY) / this.cellSize;
      this.refDragStartX = cx; this.refDragStartY = cy;
      this.applyRefTransform();
      return;
    }
    this.refOffsetX = this.refDragOriginX + (cx - this.refDragStartX);
    this.refOffsetY = this.refDragOriginY + (cy - this.refDragStartY);
    this.applyRefTransform();
  };

  // 参考图双指捏合缩放 (叠加模式锁定格子; 分栏模式原始视口缩放)
  BeadTool.prototype.refPinchStart = function (midX, midY, dist) {
    this.refBaseScale = (this.overlayMode && this.grid) ? this.refScaleExtra : this.refScale;
    this._refPinchDist = dist || 1;
  };
  BeadTool.prototype.refPinchTo = function (midX, midY, dist) {
    if (this.overlayMode && this.referenceImage && this.grid) {
      this.refSetScaleAt(midX, midY, this.refBaseScale * (dist / this._refPinchDist));
      return;
    }
    var vp = document.getElementById('reference-viewport');
    if (!vp) return;
    var rect = vp.getBoundingClientRect();
    var cx = midX - rect.left, cy = midY - rect.top;
    var stageX = (cx - this.refOffsetX) / this.refScale;
    var stageY = (cy - this.refOffsetY) / this.refScale;
    var newScale = Math.max(0.05, Math.min(20, this.refBaseScale * (dist / this._refPinchDist)));
    this.refScale = newScale;
    this.refOffsetX = cx - stageX * newScale;
    this.refOffsetY = cy - stageY * newScale;
    this.applyRefTransform();
  };

  // 一键对齐画布: 参考图左上角对应格子 (0,0), 每个格子 = refImgW/grid.width 像素 (1:1, 保持参考图比例), 不改画布
  BeadTool.prototype.alignReferenceToCanvas = function () {
    if (!this.referenceImage) { this.toast('还没有参考图', 'warning'); return; }
    if (!this.grid) { this.refFitWindow(); return; }
    this.refPerCell = this.refImgW / this.grid.width;
    this.refCellX = 0; this.refCellY = 0; this.refScaleExtra = 1;
    this.applyRefTransform();
    this.toast('参考图已对齐画布', 'success');
  };

  BeadTool.prototype.refRemove = function () {
    this.referenceImage = null;
    this.referenceDataUrl = null;
    this.refScale = 1; this.refOffsetX = 0; this.refOffsetY = 0; this.refOpacity = 1;
    var img = document.getElementById('reference-img');
    if (img) { img.src = ''; img.style.display = 'none'; }
    var pane = document.getElementById('reference-pane');
    if (pane) pane.classList.add('hidden');
    var sp = document.getElementById('splitter');
    if (sp) sp.classList.add('hidden');
    var ph = document.getElementById('reference-placeholder');
    if (ph) ph.style.display = 'flex';
    this.updateRefToggleLabel();
    var oel = document.getElementById('ref-opacity');
    if (oel) oel.value = 100;
    var ovel = document.getElementById('ref-opacity-val');
    if (ovel) ovel.textContent = '100%';
    this.updateRefStatus(null);
    this.toast('参考图已移除');
  };

  // 仅隐藏/显示参考图面板 (保留图片数据、缩放、位置、透明度)
  BeadTool.prototype.toggleReferencePane = function () {
    var pane = document.getElementById('reference-pane');
    if (!pane) return;
    var sp = document.getElementById('splitter');
    if (pane.classList.contains('hidden')) {
      pane.classList.remove('hidden');
      if (sp) sp.classList.remove('hidden');
      if (!this.referenceImage) {
        var ph = document.getElementById('reference-placeholder');
        if (ph) ph.style.display = 'flex';
      }
    } else {
      pane.classList.add('hidden');
      if (sp) sp.classList.add('hidden');
    }
    this.updateRefToggleLabel();
  };

  // 顶栏「参考图」按钮: 始终可见, 根据面板显隐切换文案
  BeadTool.prototype.updateRefToggleLabel = function () {
    var btn = document.getElementById('btn-toggle-reference');
    if (!btn) return;
    var pane = document.getElementById('reference-pane');
    var hidden = pane && pane.classList.contains('hidden');
    btn.textContent = hidden ? '🖼️ 显示参考图' : '🖼️ 隐藏参考图';
    btn.classList.toggle('active', !hidden);
  };

  BeadTool.prototype.updateRefStatus = function (name) {
    var el = document.getElementById('ref-status');
    if (!el) return;
    el.textContent = name ? ('参考图: ' + name) : '未上传参考图';
  };

  // 从存档恢复参考图 (opts: opacity/perCell/cellX/cellY/scaleExtra/imgW/imgH; 旧档回退视口模型)
  BeadTool.prototype.restoreReference = function (dataUrl, opts) {
    opts = opts || {};
    var self = this;
    var img = new Image();
    img.onload = function () {
      self.referenceImage = img;
      self.referenceDataUrl = dataUrl;
      self.refImgW = img.naturalWidth;
      self.refImgH = img.naturalHeight;
      self.refOpacity = (opts.opacity == null ? 1 : opts.opacity);
      // 网格锚定参数 (优先), 否则回退到旧版视口缩放/平移
      if (opts.perCell != null) {
        self.refPerCell = opts.perCell;
        self.refCellX = (opts.cellX == null ? 0 : opts.cellX);
        self.refCellY = (opts.cellY == null ? 0 : opts.cellY);
        self.refScaleExtra = (opts.scaleExtra == null ? 1 : opts.scaleExtra);
      } else {
        self.refPerCell = (self.grid && self.grid.width) ? self.refImgW / self.grid.width : 1;
        self.refCellX = 0; self.refCellY = 0; self.refScaleExtra = 1;
        self.refScale = (opts.scale == null ? 1 : opts.scale);
        self.refOffsetX = (opts.ox == null ? 0 : opts.ox);
        self.refOffsetY = (opts.oy == null ? 0 : opts.oy);
      }
      self.showReferencePane();
      document.getElementById('reference-img').src = dataUrl;
      var oel = document.getElementById('ref-opacity');
      if (oel) oel.value = Math.round(self.refOpacity * 100);
      var ovel = document.getElementById('ref-opacity-val');
      if (ovel) ovel.textContent = Math.round(self.refOpacity * 100) + '%';
      self.applyRefTransform();
    };
    img.src = dataUrl;
  };

  // ========== 像素化 & 颜色匹配 ==========

  BeadTool.prototype.generatePattern = function () {
    if (!this.sourceImage) { this.toast('请先导入图片', 'error'); return; }
    var self = this;
    this.showLoading('正在生成图纸...');
    setTimeout(function () {
      var w = parseInt(document.getElementById('grid-width').value) || 29;
      var h = parseInt(document.getElementById('grid-height').value) || 29;
      var method = document.getElementById('match-method').value;
      var useDither = document.getElementById('dithering').checked;
      w = Math.max(1, Math.min(200, w));
      h = Math.max(1, Math.min(200, h));

      var tmpCanvas = document.createElement('canvas');
      tmpCanvas.width = w; tmpCanvas.height = h;
      var tmpCtx = tmpCanvas.getContext('2d');
      tmpCtx.imageSmoothingEnabled = true;
      tmpCtx.drawImage(self.sourceImage, 0, 0, w, h);
      var imgData = tmpCtx.getImageData(0, 0, w, h);

      var total = w * h;
      var cells = new Int16Array(total);
      cells.fill(-1);

      if (useDither) {
        self.applyDithering(imgData, w, h, method, cells);
      } else {
        var data = imgData.data;
        for (var i = 0; i < total; i++) {
          var r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
          if (a < 128) cells[i] = -1;
          else cells[i] = self.matchColor(r, g, b, method);
        }
      }

      self.grid = {
        width: w, height: h,
        cells: cells,
        done: new Uint8Array(total),
        locks: new Uint8Array(total)
      };
      self.undoStack = [];
      self.redoStack = [];
      self.baseCellSize = self.calcCellSize(w, h);
      self.fitCanvas();
      self.maybeAutoCollapseSidebar();
      self.updateUndoRedoButtons();
      self.updateStats();
      self.hideLoading();
      self.toast('图纸已生成: ' + w + 'x' + h + ' (' + total + '颗) · 色卡: ' + self.paletteMeta.name, 'success');
    }, 50);
  };

  // 返回「当前色卡」中最接近的颜色索引
  BeadTool.prototype.matchColor = function (r, g, b, method) {
    return method === 'lab' ? this.matchColorLab(r, g, b) : this.matchColorRgb(r, g, b);
  };

  BeadTool.prototype.matchColorLab = function (r, g, b) {
    var lab = rgbToLab(r, g, b);
    var minDist = Infinity, minIdx = 0;
    for (var i = 0; i < this.paletteLab.length; i++) {
      var p = this.paletteLab[i];
      var dL = lab.L - p.L, da = lab.a - p.a, db = lab.b - p.b;
      var dist = dL * dL + da * da + db * db;
      if (dist < minDist) { minDist = dist; minIdx = i; }
    }
    return minIdx;
  };

  BeadTool.prototype.matchColorRgb = function (r, g, b) {
    var minDist = Infinity, minIdx = 0;
    for (var i = 0; i < this.paletteRgb.length; i++) {
      var p = this.paletteRgb[i];
      var rmean = (r + p.r) / 2;
      var dr = r - p.r, dg = g - p.g, db = b - p.b;
      var dist = (2 + rmean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rmean) / 256) * db * db;
      if (dist < minDist) { minDist = dist; minIdx = i; }
    }
    return minIdx;
  };

  BeadTool.prototype.applyDithering = function (imgData, w, h, method, cells) {
    var data = imgData.data;
    var buf = new Float32Array(w * h * 4);
    for (var i = 0; i < data.length; i++) buf[i] = data[i];

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var idx = (y * w + x) * 4;
        var oldR = buf[idx], oldG = buf[idx + 1], oldB = buf[idx + 2], oldA = buf[idx + 3];
        if (oldA < 128) { cells[y * w + x] = -1; continue; }
        var ci = this.matchColor(oldR, oldG, oldB, method);
        cells[y * w + x] = ci;
        var nc = this.paletteRgb[ci];
        var errR = oldR - nc.r, errG = oldG - nc.g, errB = oldB - nc.b;
        var distribute = function (nx, ny, factor) {
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) return;
          var ni = (ny * w + nx) * 4;
          buf[ni] += errR * factor; buf[ni + 1] += errG * factor; buf[ni + 2] += errB * factor;
        };
        distribute(x + 1, y, 7 / 16);
        distribute(x - 1, y + 1, 3 / 16);
        distribute(x, y + 1, 5 / 16);
        distribute(x + 1, y + 1, 1 / 16);
      }
    }
  };

  BeadTool.prototype.createBlankGrid = function (w, h, confirmFirst) {
    // 读取尺寸: 优先用传入值, 否则用「空白画布」面板的输入框
    if (w == null || h == null) {
      w = parseInt(document.getElementById('blank-width') && document.getElementById('blank-width').value, 10);
      h = parseInt(document.getElementById('blank-height') && document.getElementById('blank-height').value, 10);
    }
    if (!isFinite(w) || w < 1) w = 1;
    if (!isFinite(h) || h < 1) h = 1;
    w = Math.max(1, Math.min(MAX_BLANK, w));
    h = Math.max(1, Math.min(MAX_BLANK, h));
    // 把校验后的尺寸写回输入框
    var iw = document.getElementById('blank-width'), ih = document.getElementById('blank-height');
    if (iw) iw.value = w;
    if (ih) ih.value = h;

    var self = this;
    var doCreate = function () {
      var total = w * h;
      self.grid = { width: w, height: h, cells: new Int16Array(total).fill(-1), done: new Uint8Array(total), locks: new Uint8Array(total) };
      self.undoStack = [];
      self.redoStack = [];
      self.baseCellSize = self.calcCellSize(w, h);
      self.fitCanvas();
      self.maybeAutoCollapseSidebar();
      self.updateUndoRedoButtons();
      self.updateStats();
      self.toast('空白画布已创建: ' + w + 'x' + h, 'success');
    };

    // 当前画布已有拼豆时, 修改尺寸需确认, 避免误清作品
    if (confirmFirst && this.grid && this.hasPaintedCells()) {
      this.confirmDialog('修改画布尺寸将清空当前画布，是否继续？', doCreate);
      return;
    }
    doCreate();
  };

  // 当前画布是否存在已填充 (非空白) 的格子
  BeadTool.prototype.hasPaintedCells = function () {
    if (!this.grid) return false;
    for (var i = 0; i < this.grid.cells.length; i++) {
      if (this.grid.cells[i] >= 0) return true;
    }
    return false;
  };

  // 用户在宽度/高度输入框手动输入时, 取消预设尺寸高亮 (表示进入自定义)
  BeadTool.prototype._clearSizeChipActiveOnCustom = function () {
    var chips = document.getElementById('blank-size-chips');
    if (chips) chips.querySelectorAll('button').forEach(function (b) { b.classList.remove('active'); });
  };

  // 通用确认弹窗: [取消] [继续]
  BeadTool.prototype.confirmDialog = function (message, onConfirm) {
    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML =
      '<div class="confirm-box">' +
      '<div class="confirm-msg"></div>' +
      '<div class="confirm-actions">' +
      '<button type="button" class="confirm-cancel">取消</button>' +
      '<button type="button" class="confirm-ok">继续</button>' +
      '</div></div>';
    overlay.querySelector('.confirm-msg').textContent = message;
    document.body.appendChild(overlay);
    var close = function () { overlay.remove(); };
    overlay.querySelector('.confirm-cancel').addEventListener('click', close);
    overlay.querySelector('.confirm-ok').addEventListener('click', function () { close(); onConfirm(); });
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
  };

  // ========== 网格渲染 ==========

  BeadTool.prototype.calcCellSize = function (w, h) {
    var maxDim = Math.max(w, h);
    if (maxDim <= 20) return 28;
    if (maxDim <= 40) return 20;
    if (maxDim <= 60) return 14;
    if (maxDim <= 100) return 10;
    return 6;
  };

  BeadTool.prototype.setCellSize = function (size) {
    size = Math.max(2, Math.min(60, size));
    this.cellSize = size;
    this.updateZoomLabel();
    if (this.grid) this.setupCanvas();
  };

  BeadTool.prototype.setupCanvas = function () {
    if (!this.grid) return;
    var w = this.grid.width * this.cellSize;
    var h = this.grid.height * this.cellSize;
    this.canvas.width = w; this.canvas.height = h;
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this.applyCanvasTransform();
    this.renderGrid();
  };

  // ========== 画布平移 / 缩放 (视图变换) ==========

  // 将平移量应用到 canvas 元素 (缩放由 cellSize 重新渲染实现, 平移由 transform 实现)
  BeadTool.prototype.applyCanvasTransform = function () {
    if (!this.canvas) return;
    this.canvas.style.transform = 'translate(' + this.panX + 'px,' + this.panY + 'px)';
    this.canvas.style.transformOrigin = '0 0';
    // 叠加模式下, 画布平移/缩放后自动同步参考图 (保持像素↔格子对应)
    if (this.overlayMode && this.referenceImage && this.grid) this.applyRefTransform();
  };

  // 约束平移边界: 保证画布至少可见 minVisible px, 不会完全移出可视区
  BeadTool.prototype.clampPan = function () {
    if (!this.canvas || !this.grid) return;
    var container = this.canvas.parentNode;
    if (!container) return;
    var crect = container.getBoundingClientRect();
    var cw = crect.width, ch = crect.height;
    if (cw <= 0 || ch <= 0) return;
    var canvasW = this.grid.width * this.cellSize;
    var canvasH = this.grid.height * this.cellSize;
    var m = 40; // 至少可见 40px
    if (canvasW <= cw) this.panX = (cw - canvasW) / 2;
    else this.panX = Math.max(m - canvasW, Math.min(cw - m, this.panX));
    if (canvasH <= ch) this.panY = (ch - canvasH) / 2;
    else this.panY = Math.max(m - canvasH, Math.min(ch - m, this.panY));
  };

  // 以客户端坐标 (clientX/clientY) 为焦点缩放 (鼠标滚轮 / 缩放按钮通用)
  BeadTool.prototype.zoomAt = function (clientX, clientY, factor) {
    if (!this.grid) return;
    var oldSize = this.cellSize;
    var newSize = Math.max(2, Math.min(60, oldSize * factor));
    if (newSize === oldSize) return;
    var container = this.canvas.parentNode;
    if (!container) return;
    var crect = container.getBoundingClientRect();
    var px = clientX - crect.left, py = clientY - crect.top;
    var internalX = (px - this.panX) / oldSize;
    var internalY = (py - this.panY) / oldSize;
    this.cellSize = newSize;
    this.panX = px - internalX * newSize;
    this.panY = py - internalY * newSize;
    this.setupCanvas();
    this.clampPan();
    this.applyCanvasTransform();
    this.updateZoomLabel();
  };

  // 以容器中心为焦点缩放
  BeadTool.prototype.zoomCenter = function (factor) {
    if (!this.grid) return;
    var container = this.canvas.parentNode;
    if (!container) return;
    var crect = container.getBoundingClientRect();
    this.zoomAt(crect.left + crect.width / 2, crect.top + crect.height / 2, factor);
  };

  // 直接设置格子像素尺寸, 以容器坐标 (cx,cy) 为焦点保持该点不动
  BeadTool.prototype.zoomToSize = function (size, cx, cy) {
    if (!this.grid) return;
    size = Math.max(2, Math.min(60, size));
    var oldSize = this.cellSize;
    if (size === oldSize) return;
    var internalX = (cx - this.panX) / oldSize;
    var internalY = (cy - this.panY) / oldSize;
    this.cellSize = size;
    this.panX = cx - internalX * size;
    this.panY = cy - internalY * size;
    this.setupCanvas();
    this.clampPan();
    this.applyCanvasTransform();
    this.updateZoomLabel();
  };

  // 适应窗口: 缩放使整张画布正好放进容器并居中
  BeadTool.prototype.fitCanvas = function () {
    if (!this.grid) return;
    var container = this.canvas.parentNode;
    if (!container) return;
    var crect = container.getBoundingClientRect();
    var cw = crect.width, ch = crect.height;
    if (cw <= 0 || ch <= 0) { this.setupCanvas(); return; }
    var fit = Math.min(cw / this.grid.width, ch / this.grid.height);
    var newSize = Math.max(2, Math.min(60, Math.floor(fit)));
    this.cellSize = newSize;
    this.panX = (cw - this.grid.width * newSize) / 2;
    this.panY = (ch - this.grid.height * newSize) / 2;
    this.setupCanvas();
    this.updateZoomLabel();
  };

  // 恢复 100% (基准格子尺寸) 并居中
  BeadTool.prototype.resetZoom100 = function () {
    if (!this.grid) return;
    var base = this.baseCellSize || this.calcCellSize(this.grid.width, this.grid.height);
    var container = this.canvas.parentNode;
    if (!container) return;
    var crect = container.getBoundingClientRect();
    this.cellSize = base;
    this.panX = (crect.width - this.grid.width * base) / 2;
    this.panY = (crect.height - this.grid.height * base) / 2;
    this.setupCanvas();
    this.updateZoomLabel();
  };

  BeadTool.prototype.updateZoomLabel = function () {
    var el = document.getElementById('zoom-level');
    if (!el) return;
    var base = this.baseCellSize || 20;
    el.textContent = Math.round(this.cellSize / base * 100) + '%';
  };

  // 由客户端坐标计算格子 (供鼠标/触摸共用)
  BeadTool.prototype.getCellFromClient = function (clientX, clientY) {
    if (!this.grid) return null;
    var rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    var scaleX = this.canvas.width / rect.width;
    var scaleY = this.canvas.height / rect.height;
    var x = Math.floor((clientX - rect.left) * scaleX / this.cellSize);
    var y = Math.floor((clientY - rect.top) * scaleY / this.cellSize);
    if (x < 0 || x >= this.grid.width || y < 0 || y >= this.grid.height) return null;
    return { x: x, y: y };
  };

  BeadTool.prototype.renderGrid = function () {
    if (!this.grid) {
      document.getElementById('canvas-empty').style.display = 'flex';
      return;
    }
    document.getElementById('canvas-empty').style.display = 'none';

    var ctx = this.ctx;
    var cs = this.cellSize;
    var gw = this.grid.width, gh = this.grid.height;
    var showId = cs >= 22; // 足够大时显示 MARD 色号
    var now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var hasAnim = Object.keys(this.animCells).length > 0;

    ctx.fillStyle = this.boardColor || '#ffffff';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    for (var y = 0; y < gh; y++) {
      for (var x = 0; x < gw; x++) {
        var idx = y * gw + x;
        var ci = this.grid.cells[idx];
        var isDone = this.grid.done[idx];
        var px = x * cs, py = y * cs;

        if (ci >= 0) {
          var color = this.palette[ci];
          ctx.fillStyle = color.hex;
          ctx.fillRect(px, py, cs, cs);

          if (this.mode === 'progress' && isDone) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
            ctx.fillRect(px, py, cs, cs);
            if (cs >= 10) {
              ctx.strokeStyle = '#27ae60';
              ctx.lineWidth = Math.max(1, cs / 10);
              ctx.beginPath();
              var cx = px + cs / 2, cy = py + cs / 2, r = cs * 0.25;
              ctx.moveTo(cx - r, cy);
              ctx.lineTo(cx - r * 0.3, cy + r * 0.6);
              ctx.lineTo(cx + r, cy - r * 0.5);
              ctx.stroke();
            }
          }

          // 显示 MARD 色号
          if (showId) {
            ctx.fillStyle = textColorFor(color.hex);
            ctx.font = 'bold ' + Math.max(8, Math.floor(cs * 0.30)) + 'px -apple-system, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(color.id, px + cs / 2, py + cs / 2);
          }

          // --- 制作模式: 高亮当前颜色 / 降低其他颜色强调 ---
          if (this.highlightCurrent && !isDone) {
            if (ci === this.selectedColorIndex) {
              // 当前颜色目标格子: 高亮环
              var hlw = Math.max(2, cs * 0.12);
              ctx.strokeStyle = '#FFC107';
              ctx.lineWidth = hlw;
              ctx.strokeRect(px + hlw / 2, py + hlw / 2, cs - hlw, cs - hlw);
              ctx.strokeStyle = 'rgba(255,193,7,0.45)';
              ctx.lineWidth = Math.max(1, cs * 0.05);
              var inner = hlw + Math.max(1, cs * 0.05);
              ctx.strokeRect(px + inner, py + inner, cs - 2 * inner, cs - 2 * inner);
            } else {
              // 其他颜色目标格子: 降低视觉强调 (不遮挡拼豆颜色)
              ctx.fillStyle = 'rgba(232,232,238,0.5)';
              ctx.fillRect(px, py, cs, cs);
            }
          }

          // --- 落子 / 填充动画 ---
          if (hasAnim && this.animCells[idx] !== undefined) {
            var e2 = now - this.animCells[idx];
            if (e2 < ANIM_MS) {
              var p = easeOut(e2 / ANIM_MS);
              var s = cs * (0.5 + 0.5 * p); // 由小放大到原尺寸
              var ccx = px + cs / 2, ccy = py + cs / 2;
              ctx.fillStyle = color.hex;
              ctx.fillRect(ccx - s / 2, ccy - s / 2, s, s);
              ctx.fillStyle = 'rgba(255,255,255,' + (0.55 * (1 - p)) + ')';
              ctx.fillRect(px, py, cs, cs);
            }
          }

          // 锁定格子 (逐格): 显示锁定标记 (虚线边框 + 🔒), 让用户明确知道该格受保护
          if (this.grid.locks[idx] === 1) {
            ctx.strokeStyle = 'rgba(0,0,0,0.5)';
            ctx.lineWidth = Math.max(1, cs * 0.06);
            ctx.setLineDash([Math.max(2, cs * 0.18), Math.max(2, cs * 0.18)]);
            ctx.strokeRect(px + ctx.lineWidth / 2, py + ctx.lineWidth / 2, cs - ctx.lineWidth, cs - ctx.lineWidth);
            ctx.setLineDash([]);
            var lsize = Math.max(8, Math.floor(cs * 0.42));
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            ctx.font = 'bold ' + lsize + 'px -apple-system, sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText('🔒', px + 1, py + 1);
          }
        } else {
          // 空单元格: 使用拼豆板颜色 (默认纯白, 可在侧栏设置白/浅灰/自定义)
          ctx.fillStyle = this.boardColor || '#ffffff';
          ctx.fillRect(px, py, cs, cs);
        }
      }
    }

    // 网格线
    if (this.showGrid && cs >= 6) {
      ctx.strokeStyle = cs >= 14 ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var lx = 0; lx <= gw; lx++) { var xPos = lx * cs + 0.5; ctx.moveTo(xPos, 0); ctx.lineTo(xPos, gh * cs); }
      for (var ly = 0; ly <= gh; ly++) { var yPos = ly * cs + 0.5; ctx.moveTo(0, yPos); ctx.lineTo(gw * cs, yPos); }
      ctx.stroke();

      if (cs >= 8) {
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (var bx = 0; bx <= gw; bx += 10) { var bxPos = bx * cs + 0.5; ctx.moveTo(bxPos, 0); ctx.lineTo(bxPos, gh * cs); }
        for (var by = 0; by <= gh; by += 10) { var byPos = by * cs + 0.5; ctx.moveTo(0, byPos); ctx.lineTo(gw * cs, byPos); }
        ctx.stroke();
      }
    }

    // hover 高亮
    if (this.hoverCell) {
      var hx = this.hoverCell.x * cs, hy = this.hoverCell.y * cs;
      ctx.strokeStyle = '#4A90D9';
      ctx.lineWidth = 2;
      ctx.strokeRect(hx + 1, hy + 1, cs - 2, cs - 2);
      if (this.tool === 'paint' && this.mode === 'edit') {
        ctx.fillStyle = this.palette[this.selectedColorIndex].hex;
        ctx.globalAlpha = 0.5;
        ctx.fillRect(hx, hy, cs, cs);
        ctx.globalAlpha = 1;
      }
    }
  };

  // ========== 鼠标交互 ==========

  BeadTool.prototype.getCellFromEvent = function (e) {
    return this.getCellFromClient(e.clientX, e.clientY);
  };

  BeadTool.prototype.handleMouseDown = function (e) {
    if (this._suppressMouseUntil && Date.now() < this._suppressMouseUntil) return;
    if (!this.grid) return;
    // 移动画布工具: 左键拖动平移, 不填色 / 不吸色
    if (this.tool === 'move') {
      this.isPanning = true;
      this.panStartX = e.clientX; this.panStartY = e.clientY;
      this.panOriginX = this.panX; this.panOriginY = this.panY;
      e.preventDefault();
      return;
    }
    // 参考图工具: 左键拖动 = 移动参考图 (不填色 / 不动画布)
    if (this.tool === 'reference') {
      this.isRefMoving = true;
      this.refMoveStart(e.clientX, e.clientY);
      e.preventDefault();
      return;
    }
    var cell = this.getCellFromEvent(e);
    if (!cell) return;
    this.isDragging = true;
    this.dragStartButton = e.button;
    this.lastPaintedIdx = -1;
    if (this.mode === 'progress') { this.beginStroke(); this.toggleProgress(cell.x, cell.y); this.endStroke(); return; }
    if (e.button === 0) {
      switch (this.tool) {
        case 'paint': this.beginStroke(); this.paintCell(cell.x, cell.y); break;
        case 'eyedropper': this.eyedropCell(cell.x, cell.y); break;
        case 'eraser': this.beginStroke(); this.eraseCell(cell.x, cell.y); break;
        case 'fill': this.beginStroke(); this.fillCell(cell.x, cell.y); this.endStroke(); break;
      }
    }
  };

  BeadTool.prototype.handleMouseMove = function (e) {
    if (this._suppressMouseUntil && Date.now() < this._suppressMouseUntil) return;
    if (!this.grid) return;
    // 平移中: 更新画布位置
    if (this.isPanning) {
      var dx = e.clientX - this.panStartX;
      var dy = e.clientY - this.panStartY;
      this.panX = this.panOriginX + dx;
      this.panY = this.panOriginY + dy;
      this.clampPan();
      this.applyCanvasTransform();
      return;
    }
    // 参考图工具: 左键拖动 = 移动参考图
    if (this.tool === 'reference' && this.isRefMoving) {
      this.refMoveTo(e.clientX, e.clientY);
      return;
    }
    // 移动工具下不显示填色高亮 / 坐标
    if (this.tool === 'move') return;
    var cell = this.getCellFromEvent(e);
    if (cell) {
      document.getElementById('coord-display').textContent = 'X: ' + (cell.x + 1) + '  Y: ' + (cell.y + 1);
    } else {
      document.getElementById('coord-display').textContent = '';
    }
    var changed = false;
    if (cell) {
      if (!this.hoverCell || this.hoverCell.x !== cell.x || this.hoverCell.y !== cell.y) {
        this.hoverCell = cell; changed = true;
      }
    } else if (this.hoverCell) {
      this.hoverCell = null; changed = true;
    }
    if (this.isDragging && cell && this.mode === 'edit' && this.dragStartButton === 0) {
      var idx = cell.y * this.grid.width + cell.x;
      if (idx !== this.lastPaintedIdx) {
        if (this.tool === 'paint') { this.paintCell(cell.x, cell.y); this.lastPaintedIdx = idx; }
        else if (this.tool === 'eraser') { this.eraseCell(cell.x, cell.y); this.lastPaintedIdx = idx; }
      }
    }
    if (changed || this.isDragging) this.renderGrid();
  };

  BeadTool.prototype.handleMouseUp = function () {
    this.isDragging = false; this.lastPaintedIdx = -1; this.dragStartButton = -1;
    this.isPanning = false;
    this.isRefMoving = false;
    this.endStroke();
  };

  // ========== 工具操作 ==========

  BeadTool.prototype.paintCell = function (x, y) {
    var idx = y * this.grid.width + x;
    var cur = this.grid.cells[idx];
    // 锁定格子 (逐格): 已锁定的格子不可被覆盖
    if (this.grid.locks[idx] === 1) { this.notifyLocked(); return false; }
    if (cur !== this.selectedColorIndex) {
      this._strokeChanged = true;
      this.grid.cells[idx] = this.selectedColorIndex;
      this.renderCell(x, y);
      this.updateStats();
      this.triggerFillAnim(idx);
      return true;
    }
    return false;
  };

  BeadTool.prototype.eraseCell = function (x, y) {
    var idx = y * this.grid.width + x;
    // 锁定格子 (逐格): 不能擦除锁定的格子
    if (this.grid.locks[idx] === 1) { this.notifyLocked(); return false; }
    if (this.grid.cells[idx] !== -1) {
      this._strokeChanged = true;
      this.grid.cells[idx] = -1; this.grid.done[idx] = 0;
      this.renderCell(x, y); this.updateStats();
      return true;
    }
    return false;
  };

  BeadTool.prototype.eyedropCell = function (x, y) {
    var idx = y * this.grid.width + x;
    var ci = this.grid.cells[idx];
    if (ci >= 0) {
      this.selectColor(ci);
      this.toast('已吸取: MARD ' + this.palette[ci].id + ' ' + colorName(this.palette[ci]), 'success');
      // 吸取完成后自动切回填色, 方便继续填色
      if (this.tool === 'eyedropper') this.selectTool('paint');
    } else {
      this.toast('该格子为空', 'warning');
    }
  };

  BeadTool.prototype.fillCell = function (startX, startY) {
    var gw = this.grid.width, gh = this.grid.height;
    var startIdx = startY * gw + startX;
    var targetColor = this.grid.cells[startIdx];
    var fillColor = this.selectedColorIndex;
    // 锁定格子 (逐格): 不能从锁定的格子发起填充, 也不能在填充过程中改写锁定的格子
    if (this.grid.locks[startIdx] === 1) { this.notifyLocked(); return false; }
    if (targetColor === fillColor) return false;
    var stack = [[startX, startY]];
    var visited = new Uint8Array(gw * gh);
    var count = 0;
    while (stack.length > 0) {
      var pt = stack.pop();
      var px = pt[0], py = pt[1];
      if (px < 0 || px >= gw || py < 0 || py >= gh) continue;
      var idx = py * gw + px;
      if (visited[idx]) continue;
      if (this.grid.locks[idx] === 1) { visited[idx] = 1; continue; } // 锁定格视为墙, 不改写不扩散
      if (this.grid.cells[idx] !== targetColor) continue;
      visited[idx] = 1;
      this.grid.cells[idx] = fillColor;
      count++;
      stack.push([px + 1, py]); stack.push([px - 1, py]);
      stack.push([px, py + 1]); stack.push([px, py - 1]);
    }
    if (count > 0) { this._strokeChanged = true; this.triggerFillAnim(startIdx); }
    this.renderGrid(); this.updateStats();
    this.toast('填充了 ' + count + ' 颗', 'success');
    return count > 0;
  };

  BeadTool.prototype.toggleProgress = function (x, y) {
    var idx = y * this.grid.width + x;
    if (this.grid.cells[idx] < 0) return;
    this._strokeChanged = true;
    this.grid.done[idx] = this.grid.done[idx] ? 0 : 1;
    this.renderCell(x, y);
    this.updateStats();
  };

  BeadTool.prototype.renderCell = function () { this.renderGrid(); };

  // 触发某格子的落子动画
  BeadTool.prototype.triggerFillAnim = function (idx) {
    if (idx < 0) return;
    var self = this;
    this.animCells[idx] = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (this._animRAF) return;
    var tick = function () {
      var now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      var active = false;
      for (var k in self.animCells) {
        if (now - self.animCells[k] < ANIM_MS) active = true; else delete self.animCells[k];
      }
      self.renderGrid();
      self._animRAF = active ? requestAnimationFrame(tick) : null;
    };
    this._animRAF = requestAnimationFrame(tick);
  };

  // ========== 撤销 / 重做 ==========

  // 一次连续操作开始: 记录操作前快照 (此时尚未修改, 不计入历史)
  BeadTool.prototype.beginStroke = function () {
    if (!this.grid) return;
    this._strokeSnap = {
      cells: new Int16Array(this.grid.cells),
      done: new Uint8Array(this.grid.done),
      locks: new Uint8Array(this.grid.locks)
    };
    this._strokeChanged = false;
  };

  // 一次连续操作结束: 仅有实际修改才写入撤销历史, 并清空重做历史
  BeadTool.prototype.endStroke = function () {
    if (this._strokeSnap && this._strokeChanged) {
      this.undoStack.push(this._strokeSnap);
      if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
      this.redoStack = [];
    }
    this._strokeSnap = null;
    this._strokeChanged = false;
    this.updateUndoRedoButtons();
  };

  // 兼容旧调用: 直接把当前状态压入撤销栈并清空重做 (用于整体重置等)
  BeadTool.prototype.pushUndo = function () {
    if (!this.grid) return;
    this.undoStack.push({
      cells: new Int16Array(this.grid.cells),
      done: new Uint8Array(this.grid.done),
      locks: new Uint8Array(this.grid.locks)
    });
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    this.redoStack = [];
    this.updateUndoRedoButtons();
  };

  BeadTool.prototype.undo = function () {
    if (!this.grid || this.undoStack.length === 0) { this.toast('没有可撤销的操作', 'warning'); return; }
    // 当前状态存入重做栈, 便于之后重做
    this.redoStack.push({
      cells: new Int16Array(this.grid.cells),
      done: new Uint8Array(this.grid.done),
      locks: new Uint8Array(this.grid.locks)
    });
    var snap = this.undoStack.pop();
    this.grid.cells = snap.cells;
    this.grid.done = snap.done;
    this.grid.locks = snap.locks;
    this.renderGrid(); this.updateStats();
    this.updateUndoRedoButtons();
    this.toast('已撤销');
  };

  BeadTool.prototype.redo = function () {
    if (!this.grid || this.redoStack.length === 0) { this.toast('没有可重做的操作', 'warning'); return; }
    this.undoStack.push({
      cells: new Int16Array(this.grid.cells),
      done: new Uint8Array(this.grid.done),
      locks: new Uint8Array(this.grid.locks)
    });
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    var snap = this.redoStack.pop();
    this.grid.cells = snap.cells;
    this.grid.done = snap.done;
    this.grid.locks = snap.locks;
    this.renderGrid(); this.updateStats();
    this.updateUndoRedoButtons();
    this.toast('已重做');
  };

  BeadTool.prototype.updateUndoRedoButtons = function () {
    var u = document.getElementById('btn-undo');
    var r = document.getElementById('btn-redo');
    if (u) u.disabled = !this.grid || this.undoStack.length === 0;
    if (r) r.disabled = !this.grid || this.redoStack.length === 0;
  };

  // 锁定格子被尝试修改时的轻提示 (节流, 避免拖动时刷屏)
  BeadTool.prototype.notifyLocked = function () {
    var now = Date.now();
    if (now - this._lastLockToast < 1500) return;
    this._lastLockToast = now;
    this.toast('该格子已锁定，无法修改', 'warning');
  };

  // ========== 统计 ==========

  BeadTool.prototype.updateStats = function () {
    var infoEl = document.getElementById('grid-info');
    if (!this.grid) {
      document.getElementById('stat-total').textContent = '0';
      document.getElementById('stat-colors').textContent = '0';
      document.getElementById('stat-done').textContent = '0 / 0';
      document.getElementById('progress-fill').style.width = '0%';
      document.getElementById('progress-text').textContent = '0%';
      document.getElementById('color-breakdown').innerHTML = '';
      if (infoEl) infoEl.textContent = '未加载图纸';
      return;
    }
    if (infoEl) infoEl.textContent = this.grid.width + ' x ' + this.grid.height + ' 格 · ' + this.paletteMeta.name;

    var counts = this.getColorCounts();
    var total = 0, doneCount = 0;
    for (var i = 0; i < this.grid.cells.length; i++) {
      if (this.grid.cells[i] >= 0) { total++; if (this.grid.done[i]) doneCount++; }
    }

    document.getElementById('stat-total').textContent = total;
    document.getElementById('stat-colors').textContent = counts.length;
    document.getElementById('stat-done').textContent = doneCount + ' / ' + total;
    var pct = total > 0 ? Math.round(doneCount / total * 100) : 0;
    document.getElementById('progress-fill').style.width = pct + '%';
    document.getElementById('progress-text').textContent = pct + '%';
    document.getElementById('stat-remaining').textContent = (total - doneCount);

    // 全部完成提示
    var comp = document.getElementById('stat-complete');
    if (comp) {
      if (total > 0 && doneCount === total) {
        comp.style.display = 'block';
        comp.textContent = '🎉 全部完成！共 ' + total + ' 颗';
      } else {
        comp.style.display = 'none';
      }
    }

    this.updateCurrentColorStats();

    var self = this;
    var html = counts.map(function (item) {
      var c = self.palette[item.idx];
      return '<div class="breakdown-row" data-idx="' + item.idx + '" title="MARD ' + c.id + ' ' + colorName(c) + '">' +
        '<div class="swatch" style="background:' + c.hex + '"></div>' +
        '<span class="bid">MARD ' + c.id + '</span>' +
        '<span class="bname">' + colorName(c) + '</span>' +
        '<span class="count">' + item.count + '</span>' +
        '</div>';
    }).join('');
    var container = document.getElementById('color-breakdown');
    container.innerHTML = html;
    container.querySelectorAll('.breakdown-row').forEach(function (row) {
      row.addEventListener('click', function () { self.selectColor(parseInt(this.dataset.idx, 10)); });
    });
  };

  // 当前颜色进度 (电子拼豆制作模式辅助)
  BeadTool.prototype.updateCurrentColorStats = function () {
    var idEl = document.getElementById('cc-id');
    var doneEl = document.getElementById('cc-done');
    var fillEl = document.getElementById('cc-fill');
    var textEl = document.getElementById('cc-text');
    if (!idEl) return;
    var c = this.palette[this.selectedColorIndex];
    idEl.textContent = c ? ('MARD ' + c.id) : '—';
    if (!this.grid) {
      if (doneEl) doneEl.textContent = '0 / 0';
      if (fillEl) fillEl.style.width = '0%';
      if (textEl) textEl.textContent = '0%';
      return;
    }
    var sel = this.selectedColorIndex;
    var total = 0, done = 0;
    for (var i = 0; i < this.grid.cells.length; i++) {
      if (this.grid.cells[i] === sel) {
        total++;
        if (this.grid.done[i]) done++;
      }
    }
    if (doneEl) doneEl.textContent = done + ' / ' + total;
    var pct = total > 0 ? Math.round(done / total * 100) : 0;
    if (fillEl) fillEl.style.width = pct + '%';
    if (textEl) textEl.textContent = pct + '%';
  };

  // ========== 导出 PNG ==========

  BeadTool.prototype.exportPNG = function () {
    if (!this.grid) { this.toast('没有图纸可导出', 'error'); return; }
    var cs = Math.max(20, this.cellSize);
    var gw = this.grid.width, gh = this.grid.height;
    var canvas = document.createElement('canvas');
    canvas.width = gw * cs; canvas.height = gh * cs;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (var y = 0; y < gh; y++) {
      for (var x = 0; x < gw; x++) {
        var ci = this.grid.cells[y * gw + x];
        if (ci >= 0) {
          ctx.fillStyle = this.palette[ci].hex;
          ctx.fillRect(x * cs, y * cs, cs, cs);
        }
      }
    }
    if (this.showGrid) {
      ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.lineWidth = 1; ctx.beginPath();
      for (var lx = 0; lx <= gw; lx++) { ctx.moveTo(lx * cs + 0.5, 0); ctx.lineTo(lx * cs + 0.5, gh * cs); }
      for (var ly = 0; ly <= gh; ly++) { ctx.moveTo(0, ly * cs + 0.5); ctx.lineTo(gw * cs, ly * cs + 0.5); }
      ctx.stroke();
    }
    var link = document.createElement('a');
    link.download = 'bead-pattern-' + this.paletteId + '-' + Date.now() + '.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
    this.toast('PNG 已导出', 'success');
  };

  // ========== 存档 (localStorage) ==========

  BeadTool.prototype.saveToStorage = function () {
    if (!this.grid) { this.toast('没有图纸可保存', 'error'); return; }
    var self = this;
    var data = {
      width: this.grid.width,
      height: this.grid.height,
      cells: Array.from(this.grid.cells),
      done: Array.from(this.grid.done),
      locks: Array.from(this.grid.locks),
      paletteId: this.paletteId,
      referenceDataUrl: this.referenceDataUrl,
      refOpacity: this.refOpacity,
      refPerCell: this.refPerCell,
      refCellX: this.refCellX,
      refCellY: this.refCellY,
      refScaleExtra: this.refScaleExtra,
      refImgW: this.refImgW,
      refImgH: this.refImgH,
      boardColor: this.boardColor,
      boardColorMode: this.boardColorMode,
      timestamp: Date.now()
    };
    // 优先 IndexedDB (可保存参考图片); 不支持时回退 localStorage
    if (typeof indexedDB === 'undefined') {
      try {
        localStorage.setItem('bead-pattern-save', JSON.stringify(data));
        this.toast('图纸已保存到本地 (localStorage)', 'success');
      } catch (e) {
        this.toast('保存失败: ' + e.message, 'error');
      }
      return;
    }
    beadDBPut('bead-save', data).then(function () {
      self.toast('已保存到本地 (参考图 + 进度)', 'success');
    }).catch(function (err) {
      // 回退
      try {
        localStorage.setItem('bead-pattern-save', JSON.stringify(data));
        self.toast('已保存到本地 (localStorage)', 'success');
      } catch (e2) {
        self.toast('保存失败: ' + (err && err.message ? err.message : err), 'error');
      }
    });
  };

  BeadTool.prototype.loadFromStorage = function (silent) {
    var self = this;
    var finish = function (data) {
      if (!data) { if (!silent) self.toast('没有找到存档', 'warning'); return; }
      // 存档携带的色卡优先 (确保 cells 索引对应正确)
      if (data.paletteId && PALETTES[data.paletteId] && data.paletteId !== self.paletteId) {
        self.loadPalette(data.paletteId, true);
      }
      self.grid = {
        width: data.width,
        height: data.height,
        cells: Int16Array.from(data.cells),
        done: Uint8Array.from(data.done),
        locks: data.locks ? Uint8Array.from(data.locks) : new Uint8Array(data.width * data.height)
      };
      self.undoStack = [];
      self.redoStack = [];
      self.baseCellSize = self.calcCellSize(data.width, data.height);
      self.fitCanvas();
      self.maybeAutoCollapseSidebar();
      self.updateUndoRedoButtons();
      // 参考图
      if (data.referenceDataUrl) {
        self.restoreReference(data.referenceDataUrl, {
          opacity: data.refOpacity,
          perCell: data.refPerCell,
          cellX: data.refCellX,
          cellY: data.refCellY,
          scaleExtra: data.refScaleExtra,
          imgW: data.refImgW,
          imgH: data.refImgH,
          scale: data.refScale,
          ox: data.refOffsetX,
          oy: data.refOffsetY
        });
        if (data.boardColor) { self.boardColor = data.boardColor; self.boardColorMode = data.boardColorMode || 'custom'; }
      }
      self.updateStats();
      if (!silent) self.toast('存档已读取: ' + data.width + 'x' + data.height, 'success');
    };

    if (typeof indexedDB === 'undefined') {
      try {
        var raw = localStorage.getItem('bead-pattern-save');
        if (raw) finish(JSON.parse(raw));
        else if (!silent) self.toast('没有找到存档', 'warning');
      } catch (e) {
        if (!silent) self.toast('读取失败: ' + e.message, 'error');
      }
      return;
    }

    beadDBGet('bead-save').then(function (data) {
      if (data) { finish(data); return; }
      // 兼容旧版 localStorage 存档 (无参考图)
      try {
        var raw = localStorage.getItem('bead-pattern-save');
        if (raw) { finish(JSON.parse(raw)); return; }
      } catch (e) {}
      if (!silent) self.toast('没有找到存档', 'warning');
    }).catch(function () {
      try {
        var raw = localStorage.getItem('bead-pattern-save');
        if (raw) finish(JSON.parse(raw));
        else if (!silent) self.toast('没有找到存档', 'warning');
      } catch (e) {
        if (!silent) self.toast('读取失败', 'error');
      }
    });
  };

  // ========== UI 辅助 ==========

  BeadTool.prototype.updateUI = function () { this.updateStats(); };

  BeadTool.prototype.toast = function (msg, type) {
    var container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    var t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    t.textContent = msg;
    container.appendChild(t);
    setTimeout(function () {
      t.style.opacity = '0'; t.style.transition = 'opacity 0.3s';
      setTimeout(function () { t.remove(); }, 300);
    }, 2200);
  };

  BeadTool.prototype.showLoading = function (text) {
    var existing = document.querySelector('.loading-overlay');
    if (existing) existing.remove();
    var overlay = document.createElement('div');
    overlay.className = 'loading-overlay';
    overlay.innerHTML = '<div class="spinner"></div><div class="text">' + (text || '处理中...') + '</div>';
    document.body.appendChild(overlay);
  };

  BeadTool.prototype.hideLoading = function () {
    var overlay = document.querySelector('.loading-overlay');
    if (overlay) overlay.remove();
  };

  // ========== 启动 ==========

  document.addEventListener('DOMContentLoaded', function () {
    var tool = new BeadTool();
    tool.init();
    window.beadTool = tool;
  });

})();
