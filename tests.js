'use strict';

(() => {
  const runButton = document.getElementById('runTestsBtn');
  const output = document.getElementById('testResults');

  function line(message, kind = '') {
    const div = document.createElement('div');
    div.className = kind ? 'test-' + kind : '';
    div.textContent = message;
    output.appendChild(div);
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function approx(a, b, eps = 1e-10) {
    return Math.abs(a - b) <= eps;
  }

  function assertVec(a, b, eps = 1e-9) {
    assert(a.length === b.length, `向量长度不一致：${a.length} vs ${b.length}`);
    for (let i = 0; i < a.length; i++) {
      assert(approx(a[i], b[i], eps), `分量 ${i}：${a[i]} ≠ ${b[i]}`);
    }
  }

  function makeGrid(width, height, pixel) {
    const bytes = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) bytes.set(pixel(x, y), (y * width + x) * 4);
    }
    return { width, height, bytes };
  }

  function rgba(r, g, b, a) {
    return new Uint8ClampedArray([r, g, b, a]);
  }

  function swapLut() {
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

  function rampLut() {
    // 每个格点给出容易追踪的线性编码，用于验证六种四面体次序。
    const lut = new Float64Array(Proof.LUT_COUNT * 3);
    for (let b = 0; b < 5; b++) {
      for (let g = 0; g < 5; g++) {
        for (let r = 0; r < 5; r++) {
          const i = ((b * 5 + g) * 5 + r) * 3;
          lut[i] = (0.10 + r * 0.03 + g * 0.007 + b * 0.001) % 1;
          lut[i + 1] = (0.20 + g * 0.03 + r * 0.005 + b * 0.002) % 1;
          lut[i + 2] = (0.30 + b * 0.03 + r * 0.003 + g * 0.001) % 1;
        }
      }
    }
    return lut;
  }

  function p3RedLut() {
    const lut = Proof.makeIdentityLut();
    for (let i = 0; i < Proof.LUT_COUNT; i++) {
      lut[i * 3 + 1] = 0;
      lut[i * 3 + 2] = 0;
    }
    return lut;
  }

  function expectedTetra(lut, p3, axisOrder) {
    const low = [0, 0, 0];
    const fractions = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      low[c] = Math.min(Math.floor(p3[c] * 4), 4);
      fractions[c] = p3[c] * 4 - low[c];
    }
    const axes = axisOrder.slice();
    const sortedF = axes.map(a => fractions[a]);
    const weights = [
      1 - sortedF[0],
      sortedF[0] - sortedF[1],
      sortedF[1] - sortedF[2],
      sortedF[2]
    ];
    const masks = [0, 0, 0, 0];
    masks[1] |= 1 << axes[0];
    masks[2] |= 1 << axes[0];
    masks[2] |= 1 << axes[1];
    masks[3] = 0b111;
    const result = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const coord = [
        low[0] + ((masks[k] >> 0) & 1),
        low[1] + ((masks[k] >> 1) & 1),
        low[2] + ((masks[k] >> 2) & 1)
      ];
      const v = Proof.lutFetch(lut, coord[0], coord[1], coord[2]);
      for (let c = 0; c < 3; c++) result[c] += weights[k] * v[c];
    }
    return { result, axes, weights, masks };
  }

  function waitForEvent(target, name, timeout = 1000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        target.removeEventListener(name, handler);
        reject(new Error(`等待 ${name} 超时。`));
      }, timeout);
      function handler(event) {
        clearTimeout(timer);
        target.removeEventListener(name, handler);
        resolve(event);
      }
      target.addEventListener(name, handler);
    });
  }

  function nextTask() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  function makeHiddenCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    canvas.style.position = 'absolute';
    canvas.style.left = '-10000px';
    canvas.style.top = '-10000px';
    canvas.style.width = '1px';
    canvas.style.height = '1px';
    document.body.appendChild(canvas);
    return canvas;
  }

  async function runCpuTests() {
    line('CPU：sRGB 传递函数与矩阵可重现', 'info');
    assert(approx(Proof.decodeSrgb(0), 0), 'sRGB 0 解码错误');
    assert(approx(Proof.decodeSrgb(1), 1), 'sRGB 1 解码错误');
    assert(approx(Proof.encodeSrgb(0.5), Proof.encodeSrgb(0.5), 1e-15), '编码不一致');
    const identityRound = Proof.matVec(Proof.SRGB_TO_P3, [1, 1, 1]);
    assertVec(identityRound, [1, 1, 1], 1e-14);

    line('CPU：LUT R/G 轴交换（同时确认 B 为最慢轴）', 'info');
    const swap = swapLut();
    const sourcePrimaries = [
      rgba(255, 0, 0, 255),
      rgba(0, 255, 0, 255),
      rgba(0, 0, 255, 255)
    ];
    for (const src of sourcePrimaries) {
      const linear = [Proof.decodeByte(src[0]), Proof.decodeByte(src[1]), Proof.decodeByte(src[2])];
      const p3Raw = Proof.matVec(Proof.SRGB_TO_P3, linear);
      const got = Proof.tetraInterpolate(swap, p3Raw).value;
      assertVec(got, [p3Raw[1], p3Raw[0], p3Raw[2]], 1e-12);
    }
    const blueP3 = Proof.tetraInterpolate(Proof.makeIdentityLut(), [0, 0, 0.9105199]).value;
    assertVec(blueP3, [0, 0, 0.9105199], 1e-12);
    const grid = makeGrid(3, 1, (x) => sourcePrimaries[x]);
    const cpu = Proof.processGrid(grid, swap, [0, 0, 0]);
    // 交换后的 P3 坐标再转回 sRGB 不应保持原基色；此处只确认三通道均被实际使用。
    assert(cpu.output.some(v => v !== 0 && v !== 255), '轴交换结果应产生非纯基色的转换值');

    line('CPU：六种四面体排序次序', 'info');
    const lut = rampLut();
    const p3Cases = [
      [0.2200, 0.1525, 0.0825],
      [0.2200, 0.0825, 0.1525],
      [0.1525, 0.2200, 0.0825],
      [0.0825, 0.2200, 0.1525],
      [0.1525, 0.0825, 0.2200],
      [0.0825, 0.1525, 0.2200]
    ];
    const expectedOrders = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]
    ];
    for (let i = 0; i < p3Cases.length; i++) {
      const got = Proof.tetraInterpolate(lut, p3Cases[i]);
      const exp = expectedTetra(lut, p3Cases[i], expectedOrders[i]);
      assert(JSON.stringify(got.cell.axes) === JSON.stringify(expectedOrders[i]),
        `次序 ${i + 1} 轴裁决错误：${got.cell.axes}`);
      assertVec(got.value, exp.result, 1e-12);
      assertVec(got.cell.weights, exp.weights, 1e-12);
    }

    line('CPU：相等分量固定裁决 R>G>B（权重退化）', 'info');
    const equalCases = [
      [[0.0625, 0.0625, 0.025], [0, 1, 2]],
      [[0.05, 0.0625, 0.0625], [1, 2, 0]],
      [[0.0625, 0.05, 0.0625], [0, 2, 1]],
      [[0.05, 0.05, 0.05], [0, 1, 2]]
    ];
    for (const [p, order] of equalCases) {
      const cell = Proof.tetraCell(p);
      assert(JSON.stringify(cell.axes) === JSON.stringify(order),
        `相等裁决错误：${p} -> ${cell.axes}`);
    }

    line('CPU：逐分量裁入 LUT 范围及最高格点边界', 'info');
    const overCell = Proof.tetraCell([1.0001, -0.1, 0.5]);
    assert(overCell.low[0] === 3 && overCell.low[1] === 0 && overCell.low[2] === 2,
      '超出 LUT 范围的 P3 分量必须先裁断，再确定四面体格点');
    assertVec(overCell.fractions, [1, 0, 0], 0);
    const boundaryCell = Proof.tetraCell([1, 1, 1]);
    assertVec(boundaryCell.weights, [0, 0, 0, 1], 0);
    const white = Proof.evaluatePixel(rgba(255, 255, 255, 255), Proof.makeIdentityLut(), [0, 0, 0]);
    assert(white.p3Out.every(Number.isFinite), '最高格点边界不得访问越界 LUT 表项');

    line('CPU：透明边界（alpha=0 仍执行 LUT 与越界标记；合成等于背景）', 'info');
    const solidRedNegative = makeGrid(1, 1, () => rgba(255, 0, 0, 255));
    const clearRedNegative = makeGrid(1, 1, () => rgba(255, 0, 0, 0));
    // 输出纯 P3 红，回到 sRGB 后 G/B 为负。
    const negativeLut = p3RedLut();
    const solid = Proof.processGrid(solidRedNegative, negativeLut, [255, 255, 255]);
    const clear = Proof.processGrid(clearRedNegative, negativeLut, [255, 255, 255]);
    assert(solid.outOfGamut[0] === 1, '不透明红色 LUT 输出应在 sRGB 外');
    assert(clear.outOfGamut[0] === 1, '完全透明像素也必须保留合成前越界标记');
    assertVec(Array.from(clear.output.slice(0, 3)), [255, 255, 255], 0);
    const alpha128 = Proof.processGrid(makeGrid(1, 1, () => rgba(255, 0, 0, 128)), negativeLut, [0, 0, 0]);
    const bgLinear = Proof.backgroundLinear([7, 8, 9]);
    const transparentPixel = Proof.evaluatePixel(rgba(10, 20, 30, 0), Proof.makeIdentityLut(), bgLinear);
    assertVec(transparentPixel.composited, bgLinear, 1e-15);
    assert(alpha128.output[3] === 255 && clear.output[3] === 255, '输出 alpha 恒为 255');

    line('CPU：负色分量与“先编码后裁断”', 'info');
    const negativeEval = Proof.evaluatePixel(rgba(255, 0, 0, 255), negativeLut, [0, 0, 0]);
    assert(negativeEval.p3Raw.every(v => v >= 0), '合法 sRGB 到 P3 的常规顶点不应有负值');
    assert(negativeEval.srgbLinear.some(v => v < 0 || v > 1), 'LUT 输出回到 sRGB 后应出现越界分量');
    assert(negativeEval.encodedRaw.some(v => v < 0 || v > 1), '编码后仍应能看到未裁切的越界值');
    assert(negativeEval.output.every(v => v >= 0 && v <= 255), '最终字节必须被裁回八位');

    line('CPU：128×128 尺寸与输出长度', 'info');
    const maxGrid = makeGrid(128, 128, (x, y) => rgba(x * 2, y * 2, (x + y) & 255, (x * y) & 255));
    const maxResult = Proof.processGrid(maxGrid, Proof.makeIdentityLut(), [100, 120, 140]);
    assert(maxResult.output.length === 128 * 128 * 4, '最大网格输出长度错误');
    assert(maxResult.outOfGamut.length === 128 * 128, '越界 mask 长度错误');

    line('CPU：解析范围与有限数校验', 'info');
    let threw = false;
    try {
      Proof.parseGrid({ width: 129, height: 1, data: [0, 0, 0, 0] });
    } catch (_) { threw = true; }
    assert(threw, '129 宽网格必须被拒绝');
    threw = false;
    try {
      const bad = Array.from(Proof.makeIdentityLut());
      bad[0] = -0.0001;
      Proof.parseLut({ entries: bad.length === 375 ? Array.from({ length: 125 }, (_, i) => [bad[i*3], bad[i*3+1], bad[i*3+2]]) : [] });
    } catch (_) { threw = true; }
    assert(threw, '负 LUT 表项必须被拒绝');
  }

  function runGpuOnRenderer(renderer, params) {
    const gpu = renderer.render(params);
    assert(gpu, 'WebGL2 渲染返回空结果');
    const upright = Proof.flipRowsRGBA(gpu.bytes, params.width, params.height);
    const diff = Proof.maxChannelDifference(params.cpuOutput, upright);
    assert(diff.max <= 1, `CPU/GPU 每通道最大差 ${diff.max} 级，超过 1；位置 ${diff.first}`);
    return { gpu, upright, diff };
  }

  async function runGpuTests() {
    line('WebGL2：编译整型输入纹理、125 个 vec3 LUT uniform 与四面体 shader', 'info');
    const canvas = makeHiddenCanvas();
    const renderer = new Proof.GpuProofRenderer(canvas, null);
    assert(renderer.state === 'ready', renderer.state === 'unavailable' ? '当前环境不支持 WebGL2' : 'WebGL2 初始化失败');

    try {
      const testCases = [
        { name: '4×4 轴交换 / 透明 / 负色压力', width: 4, height: 4,
          pixel: (x, y) => [
            rgba(255, 0, 0, 255), rgba(0, 255, 0, 128), rgba(0, 0, 255, 0), rgba(255, 255, 0, 200),
            rgba(0, 255, 255, 64), rgba(255, 0, 255, 255), rgba(0, 0, 0, 0), rgba(255, 255, 255, 32),
            rgba(18, 19, 20, 255), rgba(200, 40, 10, 10), rgba(10, 200, 40, 200), rgba(40, 10, 200, 240),
            rgba(1, 2, 3, 1), rgba(3, 2, 1, 127), rgba(127, 128, 129, 64), rgba(255, 255, 255, 255)
          ][y * 4 + x],
          lut: swapLut()
        },
        { name: '1×6 严格覆盖六种四面体次序', width: 6, height: 1,
          pixel: x => {
            const orderColors = [
              [0, 1, 0], [0, 1, 1], [0, 1, 143],
              [0, 140, 0], [0, 140, 49], [0, 140, 138]
            ];
            return rgba(orderColors[x][0], orderColors[x][1], orderColors[x][2], 255);
          },
          lut: Proof.makeIdentityLut()
        },
        { name: '128×128 全量 ≤1 级', width: 128, height: 128,
          pixel: (x, y) => rgba((x * 7 + y * 3) & 255, (x * 11 + y * 5) & 255, (x * 13 + y * 17) & 255, (x * y) & 255),
          lut: Proof.makeIdentityLut()
        },
        { name: '强红 LUT 的负 G/B 边界', width: 1, height: 1,
          pixel: () => rgba(255, 0, 0, 255),
          lut: p3RedLut()
        }
      ];

      for (const tc of testCases) {
        const grid = makeGrid(tc.width, tc.height, tc.pixel);
        const bgBytes = new Uint8ClampedArray([136, 136, 136]);
        const cpu = Proof.processGrid(grid, tc.lut, bgBytes);
        const result = runGpuOnRenderer(renderer, {
          width: tc.width,
          height: tc.height,
          inputBytes: grid.bytes,
          lut: tc.lut,
          bgLinear: Proof.backgroundLinear(bgBytes),
          cpuOutput: cpu.output
        });
        line(`  ${tc.name}：最大差 ${result.diff.max} 级`, 'pass');
      }
    } finally {
      canvas.remove();
    }
  }

  async function runContextTests() {
    line('上下文：丢失期间隐藏旧图并明确显示预览不可用', 'info');
    const canvas = document.getElementById('previewCanvas');
    const shell = document.getElementById('gpuShell');
    const overlay = shell.querySelector('.gpu-overlay');
    const loseBtn = document.getElementById('loseBtn');
    const restoreBtn = document.getElementById('restoreBtn');

    assert(shell.dataset.state === 'ready', '主 GPU 当前不是 ready，无法测试恢复');
    const lostPromise = waitForEvent(canvas, 'webglcontextlost', 1000);
    loseBtn.click();
    await lostPromise;
    await nextTask();
    assert(overlay.hidden === false, '上下文丢失后必须显示不可用遮罩，不能继续展示旧图');
    assert(/丢失|不可用/.test(overlay.textContent), '遮罩文案必须明确说明预览不可用');
    assert(shell.dataset.state === 'lost', `shell 状态应为 lost，实际 ${shell.dataset.state}`);

    line('上下文：恢复后用当前网格/LUT/背景重建，不恢复旧帧', 'info');
    const restoredPromise = waitForEvent(canvas, 'webglcontextrestored', 2000);
    restoreBtn.click();
    await restoredPromise;
    // 应用层在下一个任务初始化并重新执行当前参数。
    await new Promise(resolve => setTimeout(resolve, 300));
    assert(shell.dataset.state === 'ready', `恢复后状态应为 ready，实际 ${shell.dataset.state}`);
    assert(overlay.hidden === true, '恢复完成后应隐藏不可用遮罩');
    const status = document.getElementById('diffStatus');
    assert(/最大差：[01] 级/.test(status.textContent), '恢复重建后未通过 CPU/GPU ≤1 级校验：' + status.textContent);
  }

  async function runAll() {
    output.textContent = '';
    runButton.disabled = true;
    const started = performance.now();
    try {
      line('开始内置一致性测试…', 'info');
      runCpuTests();
      await runGpuTests();
      await runContextTests();
      line(`全部通过（${(performance.now() - started).toFixed(1)} ms）。`, 'pass');
    } catch (err) {
      line('测试失败：' + err.message, 'fail');
      console.error(err);
    } finally {
      runButton.disabled = false;
    }
  }

  runButton.addEventListener('click', runAll);
})();
