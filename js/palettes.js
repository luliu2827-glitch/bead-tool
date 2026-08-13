/**
 * 拼豆色卡注册表 (Palette Registry)
 *
 * 每个色卡是一个独立的数据模块，未来新增品牌 (Perler / Artkal / Hama ...)
 * 只需新增一个 data/palettes/xxx.js 数据文件并在此注册，无需修改
 * 核心的图片匹配算法 (算法始终基于 RGB / LAB 距离，与色卡 ID 无关)。
 *
 * 数据文件通过全局变量暴露:
 *   - MARD_STANDARD / MARD_FULL  (见 data/palettes/*.js)
 *   - BEAD_PALETTE               (见 js/bead-palette.js, Phase 1 通用 45 色, 仅用于兼容旧存档)
 */
(function (global) {
  'use strict';

  var palettes = {};

  // MARD Standard (默认) — 标准 221 色
  if (typeof MARD_STANDARD !== 'undefined') {
    palettes['mard-standard'] = {
      id: 'mard-standard',
      name: 'MARD Standard',
      label: 'MARD Standard (221 colors)',
      desc: 'MARD 标准 221 色 (A–H + M 系列)',
      colors: MARD_STANDARD
    };
  }

  // MARD Full — 完整 291 色 (含扩展系列 P/Q/R/T/Y/ZG)
  if (typeof MARD_FULL !== 'undefined') {
    palettes['mard-full'] = {
      id: 'mard-full',
      name: 'MARD Full',
      label: 'MARD Full (291 colors)',
      desc: 'MARD 完整 291 色 (标准 221 + 扩展 70)',
      colors: MARD_FULL
    };
  }

  // Legacy — Phase 1 通用 45 色 (仅用于兼容旧 localStorage 存档)
  if (typeof BEAD_PALETTE !== 'undefined') {
    palettes['legacy'] = {
      id: 'legacy',
      name: '通用色卡',
      label: '通用色卡 (45 colors, 兼容旧档)',
      desc: 'Phase 1 通用 45 色，仅用于读取旧存档',
      colors: BEAD_PALETTE.map(function (c) {
        return {
          id: c.id,
          series: '?',
          nameZh: c.name,
          nameEn: c.name,
          hex: c.hex,
          rgb: null,   // 运行时由 app.js 计算
          lab: null
        };
      })
    };
  }

  var DEFAULT_PALETTE = 'mard-standard';

  // 暴露接口
  global.PALETTES = palettes;
  global.DEFAULT_PALETTE = palettes[DEFAULT_PALETTE] ? DEFAULT_PALETTE : Object.keys(palettes)[0];

})(typeof window !== 'undefined' ? window : this);
