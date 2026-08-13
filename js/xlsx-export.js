/**
 * 拼豆工具 - 零依赖 Excel (.xlsx) 导出
 *
 * 不依赖任何外部库 / CDN / 后端。使用「存储型 (store) ZIP + CRC32」手写
 * Office Open XML 结构，浏览器本地直接生成 .xlsx。完全离线可用。
 *
 * 用法:
 *   BeadXLSX.download(sheets, 'bead-pattern.xlsx')
 *
 *  sheets: [
 *     {
 *       name: 'Bead Pattern',      // 工作表名 (≤31 字符, 不含 : \ / ? * [ ])
 *       cols: [{ width: 5 }],       // 可选, 列宽
 *       rowHeight: 32,              // 可选, 行高(磅)
 *       rows: [
 *         [ { v:'A1', bg:'#F9F0CD', bold:true, align:'center' }, ... ],
 *         ...
 *       ]
 *     }, ...
 *   ]
 *   cell: { v: string|number, bg: '#RRGGBB'|null, bold: bool, align:'center'|'left' }
 */
(function (global) {
  'use strict';

  // ---------- XML 转义 ----------
  function xmlEscape(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // ---------- CRC32 (ISO-HDLC) ----------
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---------- 列字母 ----------
  function colLetter(idx) {
    var s = '';
    idx += 1;
    while (idx > 0) {
      var m = (idx - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      idx = Math.floor((idx - 1) / 26);
    }
    return s;
  }

  // ---------- 文件名合法化 ----------
  function safeSheetName(name, i) {
    var s = String(name || ('Sheet' + (i + 1))).slice(0, 31)
      .replace(/[:\\/?*\[\]]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (!s) s = 'Sheet' + (i + 1);
    return s;
  }

  // ---------- 构建 styles.xml ----------
  // 返回 { xml, xfOf: function(combo)->xfIndex }
  function buildStyles(usedColors) {
    // fills: 0=none, 1=gray125(占位), 2..=solid
    var colorFillId = {}; // hex -> fillId
    var fillXml = ['<fill><patternFill patternType="none"/></fill>',
                   '<fill><patternFill patternType="gray125"/></fill>'];
    usedColors.forEach(function (hex) {
      var argb = 'FF' + hex.replace('#', '').toUpperCase();
      colorFillId[hex.toUpperCase()] = fillXml.length; // fillId
      fillXml.push('<fill><patternFill patternType="solid">' +
        '<fgColor rgb="' + argb + '"/><bgColor indexed="64"/></patternFill></fill>');
    });

    // 收集用到的样式组合
    // combo = bold + fillId + align
    var xfList = [];     // { fontId, fillId, align, key }
    var xfOf = {};
    function getXf(bold, fillId, align) {
      var key = (bold ? 1 : 0) + '|' + fillId + '|' + align;
      if (xfOf[key] !== undefined) return xfOf[key];
      var xf = { fontId: bold ? 1 : 0, fillId: fillId, align: align, key: key };
      xfOf[key] = xfList.length;
      xfList.push(xf);
      return xfOf[key];
    }

    return {
      xml: function () {
        var fontsXml =
          '<fonts count="2">' +
          '<font><sz val="11"/><name val="Calibri"/></font>' +
          '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
          '</fonts>';
        var fillsXml =
          '<fills count="' + fillXml.length + '">' + fillXml.join('') + '</fills>';
        var bordersXml = '<borders count="1"><border/></borders>';
        var cellStyleXfs = '<cellStyleXfs count="1">' +
          '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>' +
          '</cellStyleXfs>';
        var cellStyles = '<cellStyles count="1">' +
          '<cellStyle name="Normal" xfId="0" builtinId="0"/>' +
          '</cellStyles>';
        var xfs = xfList.map(function (xf) {
          var alignXml = xf.align ?
            '<alignment horizontal="' + xf.align + '" vertical="center"/>' : '';
          return '<xf numFmtId="0" fontId="' + xf.fontId + '" fillId="' + xf.fillId +
            '" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1">' +
            alignXml + '</xf>';
        });
        var cellXfsXml = '<cellXfs count="' + xfs.length + '">' + xfs.join('') + '</cellXfs>';
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          fontsXml + fillsXml + bordersXml + cellStyleXfs + cellStyles + cellXfsXml +
          '</styleSheet>';
      },
      getXf: getXf,
      colorFillId: colorFillId
    };
  }

  // ---------- 构建 sheetN.xml ----------
  function buildSheet(sheet, idx, styleApi) {
    var rowsXml = [];
    var colsXml = '';
    if (sheet.cols && sheet.cols.length) {
      var cols = sheet.cols.map(function (c, i) {
        return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' +
          (c.width || 8) + '" customWidth="1"/>';
      }).join('');
      colsXml = '<cols>' + cols + '</cols>';
    }
    var rowH = sheet.rowHeight ? ' ht="' + sheet.rowHeight + '" customHeight="1"' : '';
    (sheet.rows || []).forEach(function (row, r) {
      var cells = [];
      (row || []).forEach(function (cell, c) {
        var ref = colLetter(c) + (r + 1);
        cell = cell || {};
        var bg = cell.bg ? cell.bg.toUpperCase() : null;
        var fillId = bg ? (styleApi.colorFillId[bg] !== undefined ? styleApi.colorFillId[bg] : 0) : 0;
        var bold = !!cell.bold;
        var align = cell.align || (bg ? 'center' : 'left');
        var xf = styleApi.getXf(bold, fillId, align);
        var sAttr = ' s="' + xf + '"';
        if (cell.v === undefined || cell.v === null || cell.v === '') {
          cells.push('<c r="' + ref + '"' + sAttr + '/>');
        } else if (typeof cell.v === 'number') {
          cells.push('<c r="' + ref + '"' + sAttr + '><v>' + cell.v + '</v></c>');
        } else {
          cells.push('<c r="' + ref + '"' + sAttr + ' t="inlineStr"><is><t>' +
            xmlEscape(cell.v) + '</t></is></c>');
        }
      });
      rowsXml.push('<row r="' + (r + 1) + '"' + rowH + '>' + cells.join('') + '</row>');
    });
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      colsXml +
      '<sheetData>' + rowsXml.join('') + '</sheetData>' +
      '</worksheet>';
  }

  // ---------- 打包 ZIP (store) ----------
  function makeZip(files) {
    var enc = new TextEncoder();
    var parts = [];
    var central = [];
    var offset = 0;
    var cdSize = 0;

    files.forEach(function (f) {
      var nameBytes = enc.encode(f.name);
      var data = f.bytes;
      var crc = crc32(data);

      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true); // UTF-8 文件名
      lh.setUint16(8, 0, true);      // store
      lh.setUint16(10, 0, true);
      lh.setUint16(12, 0, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true);
      lh.setUint32(22, data.length, true);
      lh.setUint16(26, nameBytes.length, true);
      lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), nameBytes, data);

      var cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, 0, true);
      cd.setUint16(14, 0, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint16(30, 0, true);
      cd.setUint16(32, 0, true);
      cd.setUint16(34, 0, true);
      cd.setUint16(36, 0, true);
      cd.setUint32(38, 0, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer));
      central.push(nameBytes);
      cdSize += 46 + nameBytes.length;

      offset += 30 + nameBytes.length + data.length;
    });

    var eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(4, 0, true);
    eocd.setUint16(6, 0, true);
    eocd.setUint16(8, files.length, true);
    eocd.setUint16(10, files.length, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, offset, true);
    eocd.setUint16(20, 0, true);

    return new Blob(parts.concat(central, [new Uint8Array(eocd.buffer)]), {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  }

  // ---------- 组装 workbook ----------
  function generate(sheets) {
    var enc = new TextEncoder();

    // 收集所有使用到的填充颜色
    var usedColors = [];
    var seen = {};
    sheets.forEach(function (sheet) {
      (sheet.rows || []).forEach(function (row) {
        (row || []).forEach(function (cell) {
          if (cell && cell.bg) {
            var h = cell.bg.toUpperCase();
            if (!seen[h]) { seen[h] = 1; usedColors.push(h); }
          }
        });
      });
    });

    var styleApi = buildStyles(usedColors);

    // 预构建各 sheet XML (此过程会把用到的 xf 注册进 styleApi)
    var sheetXmls = sheets.map(function (s, i) {
      return buildSheet(s, i, styleApi);
    });

    var stylesXml = styleApi.xml();

    // 工作表名
    var names = sheets.map(function (s, i) { return safeSheetName(s.name, i); });

    // [Content_Types].xml
    var overrides = '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
    sheetXmls.forEach(function (_, i) {
      overrides += '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
    });
    var contentTypes =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      overrides +
      '</Types>';

    // _rels/.rels
    var rootRels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';

    // xl/workbook.xml
    var sheetEls = '';
    sheetXmls.forEach(function (_, i) {
      sheetEls += '<sheet name="' + xmlEscape(names[i]) + '" sheetId="' + (i + 1) +
        '" r:id="rId' + (i + 1) + '"/>';
    });
    var workbookXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets>' + sheetEls + '</sheets>' +
      '</workbook>';

    // xl/_rels/workbook.xml.rels
    var wbRels = '<Relationship Id="rId' + (sheetXmls.length + 1) +
      '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
    sheetXmls.forEach(function (_, i) {
      wbRels = '<Relationship Id="rId' + (i + 1) +
        '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' +
        (i + 1) + '.xml"/>' + wbRels;
    });
    var workbookRels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      wbRels +
      '</Relationships>';

    // 组装文件列表
    var files = [
      { name: '[Content_Types].xml', bytes: enc.encode(contentTypes) },
      { name: '_rels/.rels', bytes: enc.encode(rootRels) },
      { name: 'xl/workbook.xml', bytes: enc.encode(workbookXml) },
      { name: 'xl/_rels/workbook.xml.rels', bytes: enc.encode(workbookRels) },
      { name: 'xl/styles.xml', bytes: enc.encode(stylesXml) }
    ];
    sheetXmls.forEach(function (xml, i) {
      files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', bytes: enc.encode(xml) });
    });

    return makeZip(files);
  }

  // ---------- 对外接口 ----------
  function download(sheets, filename) {
    var blob = generate(sheets);
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename || ('bead-pattern-' + Date.now() + '.xlsx');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  global.BeadXLSX = { generate: generate, download: download };

})(typeof window !== 'undefined' ? window : this);
