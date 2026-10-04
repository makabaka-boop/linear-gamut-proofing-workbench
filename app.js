'use strict';

(() => {
  const $ = id => document.getElementById(id);

  const els = {
    gridInput: $('gridInput'),
    lutInput: $('lutInput'),
    gridFile: $('gridFile'),
    lutFile: $('lutFile'),
    sampleGridBtn: $('sampleGridBtn'),
    identityLutBtn: $('identityLutBtn'),
    swapLutBtn: $('swapLutBtn'),
    p3RedLutBtn: $('p3RedLutBtn'),
    bgColor: $('bgColor'),
    markerToggle: $('markerToggle'),
    applyBtn: $('applyBtn'),
    downloadBtn: $('downloadBtn'),
    loseBtn: $('loseBtn'),
    restoreBtn: $('restoreBtn'),
    validation: $('validation'),
    diffStatus: $('diffStatus'),
    shell: $('gpuShell'),
    preview: $('previewCanvas'),
    marker: $('markerCanvas'),
    overlay: document.querySelector('.gpu-overlay'),
    runTestsBtn: $('runTestsBtn'),
    testResults: $('testResults'),
    pixelX: $('pixelX'),
    pixelY: $('pixelY'),
    pixelBtn: $('pixelBtn'),
    inspector: $('inspector')
  };

  const state = {
    grid: null,
    lut: null,
    bgBytes: [136, 136, 136],
    bgLinear: null,
    cpu: null,
    gpuUpright: null,
    gpuDiff: null,
    selected: { x: 0, y: 0 },
    restoreRequested: false
  };

  function setStatus(el, message, kind = 'info') {
    el.textContent = message || '';
    el.className = 'status' + (message ? ' ' + kind : '');
  }

  function parseHex(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) throw new Error('背景颜色必须是 #rrggbb。');
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function lutToJson(lut) {
    const entries = [];
    for (let i = 0; i < Proof.LUT_COUNT; i++) {
      entries.push([
        Math.round(lut[i * 3] * 1e9) / 1e9 || 0,
        Math.round(lut[i * 3 + 1] * 1e9) / 1e9 || 0,
        Math.round(lut[i * 3 + 2] * 1e9) / 1e9 || 0
      ]);
    }
    return JSON.stringify({
      colorSpace: 'linear-display-p3',
      size: [5, 5, 5],
      axisOrder: ['R', 'G', 'B'],
      range: [0, 1],
      entries
    }, null, 2);
  }

  function makeSwapLut() {
    const lut = new Float64Array(Proof.LUT_COUNT * 3);
    for (let b = 0; b < 5; b++) {
      for (let g = 0; g < 5; g++) {
        for (let r = 0; r < 5; r++) {
          const i = ((b * 5 + g) * 5 + r) * 3;
      lut[i] = g / 4;
      lut[i + 1] = r / 4;
      lut[i + 2] = b / 4;
        }
      }
    }
    return lut;
  }

  function makeP3RedLut() {
    // 对 P3 红通道加压；再回到线性 sRGB 后可产生负 G/B 或 R>1 的越界边界。
    const lut = Proof.makeIdentityLut();
    for (let i = 0; i < Proof.LUT_COUNT; i++) {
      const r = lut[i * 3], g = lut[i * 3 + 1], b = lut[i * 3 + 2];
      lut[i * 3] = Math.max(0, Math.min(1, Math.pow(r, 0.55)));
      lut[i * 3 + 1] = Math.max(0, Math.min(1, g * 0.28));
      lut[i * 3 + 2] = Math.max(0, Math.min(1, b * 0.18));
    }
    return lut;
  }

  function makeSampleGrid() {
    return {
      width: 4,
      height: 2,
      data: [
        255, 0, 0, 255,     0, 255, 0, 255,     0, 0, 255, 255,   255, 255, 0, 255,
        0, 255, 255, 128,   255, 0, 255, 64,    255, 255, 255, 0, 16, 16, 16, 255
      ]
    };
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('文件读取失败。'));
      reader.readAsText(file);
    });
  }

  const renderer = new Proof.GpuProofRenderer(els.preview, els.overlay);
  els.shell.dataset.state = renderer.state;

  els.preview.addEventListener('webglcontextlost', () => {
    els.shell.dataset.state = 'lost';
    // 释放仍可能合成在页面上的旧后备缓冲；恢复成功后再按当前参数重建。
    els.preview.width = 1;
    els.preview.height = 1;
  });

  els.preview.addEventListener('webglcontextrestored', () => {
    // 上下文恢复后重新获取 GL、着色器资源，并用当前参数重建图像。
    state.restoreRequested = true;
    els.shell.dataset.state = 'restoring';
    renderer.state = 'restoring';
    renderer.updateOverlay('WebGL2 上下文正在恢复，正在重建当前参数……');
    window.setTimeout(() => {
      const ok = renderer.initialize();
      els.shell.dataset.state = renderer.state;
      if (ok && state.grid && state.lut) {
        runPipeline('GPU 上下文已恢复，并已用当前参数重建；未显示旧帧。');
      }
      state.restoreRequested = false;
    }, 0);
  });

  function resizeCanvases(width, height) {
    for (const canvas of [els.preview, els.marker]) {
      canvas.width = width;
      canvas.height = height;
      canvas.style.setProperty('--canvas-w', String(width));
      canvas.style.setProperty('--canvas-h', String(height));
    }
  }

  function drawMarkers() {
    const ctx = els.marker.getContext('2d');
    const { width, height, outOfGamut } = state.cpu;
    const img = ctx.createImageData(width, height);
    const visible = els.markerToggle.checked;
    for (let i = 0; i < width * height; i++) {
      const on = visible && outOfGamut[i];
      img.data[i * 4] = 0;
      img.data[i * 4 + 1] = 255;
      img.data[i * 4 + 2] = 255;
      img.data[i * 4 + 3] = on ? 190 : 0;
    }
    ctx.putImageData(img, 0, 0);
  }

  function clearMarkers() {
    const ctx = els.marker.getContext('2d');
    ctx.clearRect(0, 0, els.marker.width, els.marker.height);
  }

  function runPipeline(successMessage = '') {
    try {
      const gridText = els.gridInput.value;
      const lutText = els.lutInput.value;
      state.grid = Proof.parseGrid(gridText);
      state.lut = Proof.parseLut(lutText);
      state.bgBytes = parseHex(els.bgColor.value);
      state.bgLinear = Proof.backgroundLinear(state.bgBytes);

      resizeCanvases(state.grid.width, state.grid.height);
      state.cpu = Proof.processGrid(state.grid, state.lut, state.bgBytes);
      drawMarkers();

      const gpuReadback = renderer.render({
        width: state.grid.width,
        height: state.grid.height,
        inputBytes: state.grid.bytes,
        lut: state.lut,
        bgLinear: state.bgLinear
      });
      els.shell.dataset.state = renderer.state;

      if (gpuReadback) {
        state.gpuUpright = Proof.flipRowsRGBA(gpuReadback.bytes, gpuReadback.width, gpuReadback.height);
        state.gpuDiff = Proof.maxChannelDifference(state.cpu.output, state.gpuUpright);
        if (state.gpuDiff.max <= 1) {
          setStatus(
            els.diffStatus,
            `CPU 与 GPU 每通道最大差：${state.gpuDiff.max} 级（要求 ≤1）。`,
            'ok'
          );
        } else {
          const channel = state.gpuDiff.first >= 0 ? ['R', 'G', 'B', 'A'][state.gpuDiff.first % 4] : '?';
          setStatus(
            els.diffStatus,
            `错误：CPU 与 GPU 最大差 ${state.gpuDiff.max} 级（通道 ${channel}），超出每通道一级要求。`,
            'error'
          );
        }
      } else {
        state.gpuUpright = null;
        state.gpuDiff = null;
        setStatus(els.diffStatus, 'GPU 预览不可用；CPU 参考处理仍可检查并可下载。', 'warn');
      }

      clampSelected();
      updateInspector();
      setStatus(
        els.validation,
        successMessage ||
        `已处理 ${state.grid.width}×${state.grid.height}；越界像素 ${countOutOfGamut()} 个；输出由背景 ${els.bgColor.value} 合成为不透明图。`,
        'ok'
      );
    } catch (err) {
      setStatus(els.validation, '参数错误：' + err.message, 'error');
    }
  }

  function countOutOfGamut() {
    if (!state.cpu) return 0;
    let count = 0;
    for (const v of state.cpu.outOfGamut) if (v) count++;
    return count;
  }

  function clampSelected() {
    if (!state.grid) return;
    state.selected.x = Math.max(0, Math.min(state.grid.width - 1, Number(state.selected.x) || 0));
    state.selected.y = Math.max(0, Math.min(state.grid.height - 1, Number(state.selected.y) || 0));
    els.pixelX.max = String(state.grid.width - 1);
    els.pixelY.max = String(state.grid.height - 1);
    els.pixelX.value = String(state.selected.x);
    els.pixelY.value = String(state.selected.y);
  }

  function fmt(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return String(v);
    if (Number.isInteger(v)) return String(v);
    const s = Math.abs(v) < 1e-11 ? '0' : v.toPrecision(8).replace(/\.?0+(?:e|$)/i, '$1');
    return s.replace('e', 'e');
  }

  function rangeClass(v) {
    if (v < 0) return 'neg';
    if (v > 1) return 'over';
    return 'ok';
  }

  function vec3(v, inUnit = true) {
    return `<tr><td>${v.map(x => `<span class="${inUnit ? rangeClass(x) : ''}">${fmt(x)}</span>`).join('</td><td>')}</td></tr>`;
  }

  function addStage(title, body) {
    return `<div class="stage-title">${title}</div><table>${body}</table>`;
  }

  function rgbTableHeader() {
    return '<tr><th>R / X</th><th>G / Y</th><th>B / 值</th></tr>';
  }

  function updateInspector() {
    if (!state.grid || !state.lut) {
      els.inspector.innerHTML = '<p class="help">应用参数后可在此查看逐阶段数值。</p>';
      return;
    }
    const { x, y } = state.selected;
    const p = (y * state.grid.width + x) * 4;
    const result = Proof.evaluatePixel(
      state.grid.bytes.subarray(p, p + 4),
      state.lut,
      state.bgLinear
    );
    const axisNames = ['R', 'G', 'B'];
    const order = result.tetra.axes.map(a => axisNames[a]).join(' → ');
    const vertices = result.tetra.vertices;
    const masks = result.tetra.vertexMasks;
    const oog = result.outOfGamutBeforeComposite;

    let html = `
      <div class="summary-grid">
        <div class="summary-card"><b>像素坐标</b>(${x}, ${y})</div>
        <div class="summary-card"><b>源 alpha</b>${result.alpha}（${result.inputBytes[3]} / 255，非预乘）</div>
        <div class="summary-card"><b>合成前越界</b>${oog ? '是' : '否'}</div>
        <div class="summary-card"><b>背景</b>${state.bgBytes.join(', ')}</div>
      </div>`;

    html += addStage('输入字节：straight 8-bit sRGB RGBA', `
      <tr><th>R</th><th>G</th><th>B</th><th>A</th></tr>
      <tr><td>${result.inputBytes.join('</td><td>')}</td></tr>
    `);

    html += addStage('① sRGB 解码（线性 sRGB，尚未乘 alpha）', rgbTableHeader() + vec3(result.sourceSrgb));
    html += addStage('② 转换到线性 Display-P3（下一步仍逐分量裁入 LUT）', rgbTableHeader() + vec3(result.p3Raw));
    html += addStage('③ 逐分量裁入 LUT 输入范围 [0,1]', rgbTableHeader() + vec3(result.p3Clamped));

    const cellRows = `
      <tr><th>轴</th><th>低位格点</th><th>小数部分 f</th></tr>
      <tr><td>R</td><td>${result.tetra.low[0]}</td><td>${fmt(result.tetra.fractions[0])}</td></tr>
      <tr><td>G</td><td>${result.tetra.low[1]}</td><td>${fmt(result.tetra.fractions[1])}</td></tr>
      <tr><td>B</td><td>${result.tetra.low[2]}</td><td>${fmt(result.tetra.fractions[2])}</td></tr>`;
    html += addStage('④ 四面体定位（相等分量裁决：R &gt; G &gt; B）', cellRows);

    const tetraRows = `
      <tr><th>排序后 f</th><th>轴</th><th>顶点位掩码</th><th>权重</th></tr>
      ${result.tetra.values.map((v, i) => `
        <tr>
          <td>${fmt(v)}</td><td>${i === 0 ? '—' : axisNames[result.tetra.axes[i - 1]]}</td>
          <td>${masks[i]} → (${vertices[i].join(', ')})</td><td>${fmt(result.tetra.weights[i])}</td>
        </tr>`).join('')}
      <tr><td colspan="4" class="note">实际降序轴序：${order}；w0=1−f₀, w1=f₀−f₁, w2=f₁−f₂, w3=f₂。</td></tr>`;
    html += addStage('四种四面体顶点与权重', tetraRows);

    const vertexRows = `<tr><th>顶点</th><th>LUT 线性 P3 RGB</th></tr>` +
      vertices.map((v, i) => `<tr><td>V${i} (${v.join(', ')})</td><td>${Proof.lutFetch(state.lut, v[0], v[1], v[2]).map(fmt).join(', ')}</td></tr>`).join('');
    html += addStage('四面体插值取出的四个表项', vertexRows);

    html += addStage('⑤ LUT 输出：线性 Display-P3', rgbTableHeader() + vec3(result.p3Out));
    html += addStage('⑥ 转换回线性 sRGB（这一步后单独判定越界）', rgbTableHeader() + vec3(result.srgbLinear));
    html += addStage('⑦ 与背景按 straight alpha 合成', rgbTableHeader() + vec3(result.composited));
    html += addStage('仅为检查显示：合成后线性值裁到 [0,1]（不回写到参考管线）', rgbTableHeader() + vec3(result.compositedClampedForDisplay));
    html += addStage('⑧ sRGB 编码（负值在线性编码阶段不预裁）', rgbTableHeader() +
      `<tr><td>${result.encodedRaw.map(v => `<span class="${v < 0 ? 'neg' : v > 1 ? 'over' : 'ok'}">${fmt(v)}</span>`).join('</td><td>')}</td></tr>`);
    html += addStage('最终裁成八位（不透明输出 RGBA）', `
      <tr><th>R8</th><th>G8</th><th>B8</th><th>A8</th></tr>
      <tr><td>${result.output.join('</td><td>')}</td></tr>
    `);

    if (result.alpha === 0) {
      html += '<p class="help">该像素完全透明，但颜色仍经过解码、LUT 和越界标记；最终合成结果等于背景。</p>';
    }
    if (oog) {
      html += '<p class="help">青色标记来自“转换回线性 sRGB 后、合成前”的严格 &lt;0 或 &gt;1 判定，不使用容差。</p>';
    }

    els.inspector.innerHTML = html;
  }

  function downloadCpuPng() {
    if (!state.cpu) {
      setStatus(els.validation, '请先应用参数生成 CPU 结果。', 'warn');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = state.cpu.width;
    canvas.height = state.cpu.height;
    const ctx = canvas.getContext('2d');
    const image = new ImageData(new Uint8ClampedArray(state.cpu.output), state.cpu.width, state.cpu.height);
    ctx.putImageData(image, 0, 0);
    canvas.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `p3-lut-proof-${state.cpu.width}x${state.cpu.height}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }

  function selectFromEvent(event) {
    if (!state.grid) return;
    const rect = els.preview.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) * state.grid.width / rect.width);
    const y = Math.floor((event.clientY - rect.top) * state.grid.height / rect.height);
    if (x < 0 || y < 0 || x >= state.grid.width || y >= state.grid.height) return;
    state.selected = { x, y };
    clampSelected();
    updateInspector();
  }

  els.preview.addEventListener('click', selectFromEvent);

  els.applyBtn.addEventListener('click', () => runPipeline());
  els.downloadBtn.addEventListener('click', downloadCpuPng);
  els.markerToggle.addEventListener('change', () => {
    if (state.cpu) drawMarkers();
  });
  els.bgColor.addEventListener('change', () => {
    // 颜色选择器改动即进入当前参数；点击“应用参数”仍可从文本框重建全部输入。
    if (state.grid && state.lut) runPipeline('背景已更改。');
  });
  els.sampleGridBtn.addEventListener('click', () => {
    els.gridInput.value = JSON.stringify(makeSampleGrid(), null, 2);
  });
  els.identityLutBtn.addEventListener('click', () => {
    els.lutInput.value = lutToJson(Proof.makeIdentityLut());
  });
  els.swapLutBtn.addEventListener('click', () => {
    els.lutInput.value = lutToJson(makeSwapLut());
  });
  els.p3RedLutBtn.addEventListener('click', () => {
    els.lutInput.value = lutToJson(makeP3RedLut());
  });
  els.gridFile.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (file) els.gridInput.value = await readFile(file);
  });
  els.lutFile.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (file) els.lutInput.value = await readFile(file);
  });
  els.pixelBtn.addEventListener('click', () => {
    state.selected = {
      x: parseInt(els.pixelX.value, 10) || 0,
      y: parseInt(els.pixelY.value, 10) || 0
    };
    clampSelected();
    updateInspector();
  });
  els.loseBtn.addEventListener('click', () => {
    if (!renderer.requestLoss()) setStatus(els.validation, '当前状态无法请求上下文丢失。', 'warn');
  });
  els.restoreBtn.addEventListener('click', () => renderer.restore());

  // 初始化内置示例。
  els.gridInput.value = JSON.stringify(makeSampleGrid(), null, 2);
  els.lutInput.value = lutToJson(Proof.makeIdentityLut());
  runPipeline();
})();
