'use strict';

/*
 * 固定参考流程：
 * 8-bit straight sRGB 输入 → sRGB 解码 → sRGB-linear/Display-P3-linear →
 * 逐分量裁入 [0,1] → 5^3 四面体插值 → Display-P3-linear/sRGB-linear →
 * 与 8-bit sRGB 背景做 straight-alpha 合成 → sRGB 编码 → 8-bit 裁断。
 *
 * 不读取 ICC，也不做设备/印刷模拟。
 */

const Proof = (() => {
  const LUT_SIZE = 5;
  const LUT_STEP = 4;
  const LUT_COUNT = 125;

  // 由 sRGB D65 / Display-P3 D65 的高精度 RGB↔XYZ 矩阵相乘得到。
  // 使用彼此在双精度下互逆的一对数值，避免恒等 LUT 把基色误标成越界。
  const SRGB_TO_P3 = [
    [0.8224619687143623, 0.1775380312856375, 0],
    [0.03319419885096169, 0.9668058011490383, 0],
    [0.01708263072111998, 0.07239744066396345, 0.9105199286149166]
  ];

  const P3_TO_SRGB = [
    [1.2249401762805598, -0.22494017628055962, 0],
    [-0.04205695470968825, 1.0420569547096883, 0],
    [-0.019637554590334356, -0.07863604555063188, 1.0982736001409663]
  ];

  function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  function matVec(m, v) {
    return [
      m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
      m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
      m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]
    ];
  }

  function decodeSrgb(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function encodeSrgb(c) {
    return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  }

  function decodeByte(b) {
    return decodeSrgb(b / 255);
  }

  // 这里刻意先编码、再裁到八位，不在线性域提前 clamp。
  function encodeToByte(v) {
    const q = encodeSrgb(v) * 255;
    if (!Number.isFinite(q) || q <= 0) return 0;
    if (q >= 255) return 255;
    return Math.round(q);
  }

  function parseGrid(input) {
    const obj = typeof input === 'string' ? JSON.parse(input) : input;
    if (!obj || typeof obj !== 'object') throw new Error('网格必须是 JSON 对象。');
    const width = obj.width;
    const height = obj.height;
    if (!Number.isInteger(width) || !Number.isInteger(height) ||
        width < 1 || height < 1 || width > 128 || height > 128) {
      throw new Error('width 和 height 必须是 1–128 的整数。');
    }
    if (!Array.isArray(obj.data)) throw new Error('缺少 data 数组。');
    const expected = width * height * 4;
    if (obj.data.length !== expected) {
      throw new Error(`data 长度应为 ${expected}（RGBA × 像素数），实际为 ${obj.data.length}。`);
    }
    const bytes = new Uint8ClampedArray(expected);
    for (let i = 0; i < expected; i++) {
      const v = obj.data[i];
      if (!Number.isInteger(v) || v < 0 || v > 255) {
        throw new Error(`data[${i}] 必须是 0–255 的整数。`);
      }
      bytes[i] = v;
    }
    return { width, height, bytes };
  }

  function parseLut(input) {
    const obj = typeof input === 'string' ? JSON.parse(input) : input;
    if (!obj || typeof obj !== 'object') throw new Error('LUT 必须是 JSON 对象。');
    if (obj.axisOrder !== undefined) {
      const order = obj.axisOrder;
      if (!Array.isArray(order) || order.length !== 3 ||
          order[0] !== 'R' || order[1] !== 'G' || order[2] !== 'B') {
        throw new Error('本实现固定 LUT 轴顺序为 ["R","G","B"]（R 最快、B 最慢）。');
      }
    }
    const raw = obj.entries || obj.lut || obj.data;
    if (!Array.isArray(raw)) throw new Error('缺少 entries / lut / data 数组。');

    const out = new Float64Array(LUT_COUNT * 3);
    if (raw.length === LUT_COUNT && Array.isArray(raw[0])) {
      for (let i = 0; i < LUT_COUNT; i++) {
        const item = raw[i];
        if (!Array.isArray(item) || item.length !== 3) {
          throw new Error(`LUT[${i}] 必须是包含三个分量的数组。`);
        }
        for (let c = 0; c < 3; c++) {
          const v = item[c];
          if (!isFiniteNumber(v) || v < 0 || v > 1) {
            throw new Error(`LUT[${i}][${c}] 必须是 [0,1] 内有限数。`);
          }
          out[i * 3 + c] = v;
        }
      }
    } else if (raw.length === LUT_COUNT * 3) {
      for (let i = 0; i < LUT_COUNT * 3; i++) {
        const v = raw[i];
        if (!isFiniteNumber(v) || v < 0 || v > 1) {
          throw new Error(`LUT 扁平数组[${i}] 必须是 [0,1] 内有限数。`);
        }
        out[i] = v;
      }
    } else {
      throw new Error(`LUT 必须包含 ${LUT_COUNT} 个 RGB 表项，或 ${LUT_COUNT * 3} 个扁平分量。`);
    }
    return out;
  }

  function makeIdentityLut() {
    const lut = new Float64Array(LUT_COUNT * 3);
    for (let b = 0; b < LUT_SIZE; b++) {
      for (let g = 0; g < LUT_SIZE; g++) {
        for (let r = 0; r < LUT_SIZE; r++) {
          const i = ((b * LUT_SIZE + g) * LUT_SIZE + r) * 3;
          lut[i] = r / LUT_STEP;
          lut[i + 1] = g / LUT_STEP;
          lut[i + 2] = b / LUT_STEP;
        }
      }
    }
    return lut;
  }

  function lutFetch(lut, r, g, b) {
    const i = ((b * LUT_SIZE + g) * LUT_SIZE + r) * 3;
    return [lut[i], lut[i + 1], lut[i + 2]];
  }

  // 相等分量时使用固定裁决：R 的排序优先级高于 G，G 高于 B。
  // 该裁决与 fragment shader 中的比较完全相同；数学上权重会使次序差异退化。
  function sortPair(values, axes, i, j) {
    if (values[i] < values[j] ||
        (values[i] === values[j] && axes[i] > axes[j])) {
      let t = values[i]; values[i] = values[j]; values[j] = t;
      t = axes[i]; axes[i] = axes[j]; axes[j] = t;
    }
  }

  function tetraCell(p3) {
    const scaled = [p3[0] * LUT_STEP, p3[1] * LUT_STEP, p3[2] * LUT_STEP];
    // 最高格点边界使用 low=3、f=1；顶点 3+f 仍为合法格点 4。
    const low = [
      Math.min(Math.floor(scaled[0]), LUT_STEP - 1),
      Math.min(Math.floor(scaled[1]), LUT_STEP - 1),
      Math.min(Math.floor(scaled[2]), LUT_STEP - 1)
    ];
    let f0 = scaled[0] - low[0];
    let f1 = scaled[1] - low[1];
    let f2 = scaled[2] - low[2];

    if (f0 < 0) f0 = 0; else if (f0 > 1) f0 = 1;
    if (f1 < 0) f1 = 0; else if (f1 > 1) f1 = 1;
    if (f2 < 0) f2 = 0; else if (f2 > 1) f2 = 1;

    const values = [f0, f1, f2];
    const axes = [0, 1, 2];
    // 三个元素的完整降序比较：数值大的在前；相等时 R>G>B。
    sortPair(values, axes, 0, 1);
    sortPair(values, axes, 0, 2);
    sortPair(values, axes, 1, 2);

    const firstAxis = axes[0];
    const secondAxis = axes[1];
    const thirdAxis = axes[2];

    const vertexMasks = [
      0,
      1 << firstAxis,
      (1 << firstAxis) | (1 << secondAxis),
      (1 << firstAxis) | (1 << secondAxis) | (1 << thirdAxis)
    ];
    const weights = [
      1 - values[0],
      values[0] - values[1],
      values[1] - values[2],
      values[2]
    ];
    const vertices = vertexMasks.map(mask => [
      low[0] + ((mask >> 0) & 1),
      low[1] + ((mask >> 1) & 1),
      low[2] + ((mask >> 2) & 1)
    ]);

    return { low, fractions: [f0, f1, f2], values, axes, vertexMasks, weights, vertices };
  }

  function tetraInterpolate(lut, p3) {
    const cell = tetraCell(p3);
    const out = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const v = lutFetch(lut, cell.vertices[k][0], cell.vertices[k][1], cell.vertices[k][2]);
      for (let c = 0; c < 3; c++) out[c] += cell.weights[k] * v[c];
    }
    return { value: out, cell };
  }

  function backgroundLinear(bgBytes) {
    return [decodeByte(bgBytes[0]), decodeByte(bgBytes[1]), decodeByte(bgBytes[2])];
  }

  function evaluatePixel(inputBytes, lut, bgLinear) {
    const sourceSrgb = [decodeByte(inputBytes[0]), decodeByte(inputBytes[1]), decodeByte(inputBytes[2])];
    const alpha = inputBytes[3] / 255;

    const p3Raw = matVec(SRGB_TO_P3, sourceSrgb);
    const p3Clamped = [clamp01(p3Raw[0]), clamp01(p3Raw[1]), clamp01(p3Raw[2])];
    const tetra = tetraInterpolate(lut, p3Clamped);
    const p3Out = tetra.value;

    const srgbLinear = matVec(P3_TO_SRGB, p3Out);
    const outOfGamutBeforeComposite = srgbLinear.some(v => v < 0 || v > 1);

    // straight alpha：颜色分量保持不乘 alpha，透明像素的颜色仍完整经过 LUT。
    const composited = [
      alpha * srgbLinear[0] + (1 - alpha) * bgLinear[0],
      alpha * srgbLinear[1] + (1 - alpha) * bgLinear[1],
      alpha * srgbLinear[2] + (1 - alpha) * bgLinear[2]
    ];

    const encodedRaw = [encodeSrgb(composited[0]), encodeSrgb(composited[1]), encodeSrgb(composited[2])];
    const output = [encodeToByte(composited[0]), encodeToByte(composited[1]), encodeToByte(composited[2]), 255];
    const compositedClampedForDisplay = [clamp01(composited[0]), clamp01(composited[1]), clamp01(composited[2])];

    return {
      inputBytes: Array.from(inputBytes),
      sourceSrgb,
      p3Raw,
      p3Clamped,
      tetra: tetra.cell,
      p3Out,
      srgbLinear,
      alpha,
      composited,
      compositedClampedForDisplay,
      encodedRaw,
      output,
      outOfGamutBeforeComposite
    };
  }

  function processGrid(grid, lut, bgBytes) {
    const { width, height, bytes } = grid;
    const output = new Uint8ClampedArray(width * height * 4);
    const outOfGamut = new Uint8Array(width * height);
    const bg = backgroundLinear(bgBytes);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4;
        const result = evaluatePixel(bytes.subarray(p, p + 4), lut, bg);
        output[p] = result.output[0];
        output[p + 1] = result.output[1];
        output[p + 2] = result.output[2];
        output[p + 3] = 255;
        outOfGamut[y * width + x] = result.outOfGamutBeforeComposite ? 1 : 0;
      }
    }
    return { output, outOfGamut, width, height };
  }

  function maxChannelDifference(a, b) {
    const n = Math.min(a.length, b.length);
    let max = 0;
    let first = -1;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(a[i] - b[i]);
      if (d > max) {
        max = d;
        first = i;
      }
    }
    return { max, first, length: n };
  }

  function flipRowsRGBA(bytes, width, height) {
    const out = new Uint8ClampedArray(bytes.length);
    for (let y = 0; y < height; y++) {
      const srcY = height - 1 - y;
      out.set(bytes.subarray(srcY * width * 4, (srcY + 1) * width * 4), y * width * 4);
    }
    return out;
  }

  const VERT_SRC = `#version 300 es
precision highp float;
const vec2 POS[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
const vec2 UV[3] = vec2[3](vec2(0.0, 0.0), vec2(2.0, 0.0), vec2(0.0, 2.0));
out vec2 vUV;
void main() {
  gl_Position = vec4(POS[gl_VertexID], 0.0, 1.0);
  vUV = UV[gl_VertexID];
}`;

  const FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;

uniform highp usampler2D uInput;
uniform vec3 uLut[125];
uniform vec3 uBackground;
in vec2 vUV;
out vec4 outColor;

vec3 decodeSrgb(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), greaterThan(c, vec3(0.04045)));
}

vec3 encodeSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
             greaterThan(c, vec3(0.0031308)));
}

int lutIndex(int r, int g, int b) {
  return (b * 5 + g) * 5 + r;
}

vec3 lutFetch(ivec3 i) {
  return uLut[lutIndex(i.r, i.g, i.b)];
}

void sortPair(inout float va, inout int aa, inout float vb, inout int ab) {
  if (va < vb || (va == vb && aa > ab)) {
    float tv = va; va = vb; vb = tv;
    int ta = aa; aa = ab; ab = ta;
  }
}

vec3 tetraLookup(vec3 p) {
  vec3 s = clamp(p, vec3(0.0), vec3(1.0)) * 4.0;
  ivec3 low = ivec3(floor(s));
  // 最高格点边界使用 low=3、f=1；顶点 3+f 仍为合法格点 4。
  low = clamp(low, ivec3(0), ivec3(3));
  vec3 frac = clamp(s - vec3(low), vec3(0.0), vec3(1.0));

  float fA = frac.r; int aA = 0;
  float fB = frac.g; int aB = 1;
  float fC = frac.b; int aC = 2;
  sortPair(fA, aA, fB, aB);
  sortPair(fA, aA, fC, aC);
  sortPair(fB, aB, fC, aC);

  vec3 result = vec3(0.0);
  result += (1.0 - fA) * lutFetch(low);
  ivec3 v1 = low;
  v1[aA] += 1;
  result += (fA - fB) * lutFetch(v1);
  ivec3 v2 = v1;
  v2[aB] += 1;
  result += (fB - fC) * lutFetch(v2);
  ivec3 v3 = v2;
  v3[aC] += 1;
  result += fC * lutFetch(v3);
  return result;
}

void main() {
  uvec4 src = texture(uInput, vUV);
  float alpha = float(src.a) / 255.0;
  vec3 sourceSrgb = decodeSrgb(vec3(src.rgb) / 255.0);

  // 列主序 mat3(c0, c1, c2)；数值与 CPU 的双精度矩阵一致（GPU 中为 highp float）。
  mat3 toP3 = mat3(
    0.8224619687143623, 0.03319419885096169, 0.01708263072111998,
    0.1775380312856375, 0.9668058011490383, 0.07239744066396345,
    0.0, -0.0000000000000000243, 0.9105199286149166
  );

  vec3 p3Raw = toP3 * sourceSrgb;
  vec3 p3Clamped = clamp(p3Raw, vec3(0.0), vec3(1.0));
  vec3 p3Out = tetraLookup(p3Clamped);

  mat3 toSrgb = mat3(
    1.2249401762805598, -0.04205695470968825, -0.019637554590334356,
   -0.22494017628055962, 1.0420569547096883, -0.07863604555063188,
    0.0, 0.0, 1.0982736001409663
  );
  vec3 srgbLinear = toSrgb * p3Out;

  vec3 composited = alpha * srgbLinear + (1.0 - alpha) * uBackground;
  vec3 encoded = encodeSrgb(composited);
  outColor = vec4(clamp(encoded, 0.0, 1.0), 1.0);
}`;

  class GpuProofRenderer {
    constructor(canvas, overlay) {
      this.canvas = canvas;
      this.overlay = overlay;
      this.state = 'initial';
      this.loseExt = null;
      this.lostExt = null;
      this.simulatedLoss = false;
      this._onLost = event => {
        event.preventDefault();
        this.state = 'lost';
        this.gl = null;
        this.program = null;
        this.texture = null;
        this.lutLocation = null;
        this.lostExt = this.loseExt;
        this.loseExt = null;
        this.lastResult = null;
        this.updateOverlay('WebGL2 上下文已丢失。旧帧已隐藏；CPU 参考结果仍可检查和导出。');
      };
      canvas.addEventListener('webglcontextlost', this._onLost);
      this.initialize();
    }

    initialize() {
      const gl = this.canvas.getContext('webgl2', {
        alpha: false,
        depth: false,
        stencil: false,
        antialias: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance'
      });
      if (!gl) {
        this.state = 'unavailable';
        this.updateOverlay('当前浏览器不支持 WebGL2。');
        return false;
      }
      this.gl = gl;
      try {
        const program = createProgram(gl);
        this.program = program;
        this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.locations = {
          input: gl.getUniformLocation(program, 'uInput'),
          lut: gl.getUniformLocation(program, 'uLut[0]'),
          background: gl.getUniformLocation(program, 'uBackground')
        };
        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);
        gl.useProgram(program);
        gl.uniform1i(this.locations.input, 0);
        this.loseExt = gl.getExtension('WEBGL_lose_context');
        this.lostExt = null;
        this.simulatedLoss = false;
        this.state = 'ready';
        this.updateOverlay('');
        return true;
      } catch (err) {
        this.state = 'error';
        this.gl = null;
        this.updateOverlay('WebGL2 初始化失败：' + (err && err.message ? err.message : String(err)));
        return false;
      }
    }

    updateOverlay(message) {
      if (!this.overlay) return;
      this.overlay.hidden = this.state === 'ready';
      const msg = this.overlay.querySelector('[data-message]');
      if (msg) msg.textContent = message || '';
    }

    requestLoss() {
      if (!this.loseExt) return false;
      this.simulatedLoss = true;
      this.loseExt.loseContext();
      return true;
    }

    restore() {
      // 旧扩展对象属于已丢失的上下文；恢复后 initialize() 会重新获取扩展。
      const ext = this.lostExt;
      if (ext) {
        this.lostExt = null;
        ext.restoreContext();
      }
    }

    render(params) {
      if (this.state === 'lost' || this.state === 'restoring' || this.state === 'unavailable' || this.state === 'error') {
        return null;
      }
      const gl = this.gl;
      if (!gl || gl.isContextLost()) {
        this.state = 'lost';
        this.updateOverlay('WebGL2 上下文已丢失。旧帧已隐藏。');
        return null;
      }

      try {
        const width = params.width;
        const height = params.height;
        if (this.canvas.width !== width) this.canvas.width = width;
        if (this.canvas.height !== height) this.canvas.height = height;

        gl.viewport(0, 0, width, height);
        gl.useProgram(this.program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(
          gl.TEXTURE_2D, 0, gl.RGBA8UI, width, height, 0,
          gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, params.inputBytes
        );
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

        const lut32 = params.lut instanceof Float32Array ? params.lut : new Float32Array(params.lut);
        gl.uniform3fv(this.locations.lut, lut32);
        gl.uniform3fv(this.locations.background, params.bgLinear);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        const bytes = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        const err = gl.getError();
        if (err !== gl.NO_ERROR) throw new Error('WebGL GL error 0x' + err.toString(16));
        this.lastResult = { bytes, width, height };
        return this.lastResult;
      } catch (err) {
        if (gl.isContextLost && gl.isContextLost()) {
          this.state = 'lost';
          this.updateOverlay('渲染期间 WebGL2 上下文丢失。旧帧已隐藏。');
        } else {
          this.state = 'error';
          this.updateOverlay('WebGL2 渲染失败：' + (err && err.message ? err.message : String(err)));
        }
        return null;
      }
    }
  }

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('着色器编译失败：\n' + log);
    }
    return shader;
  }

  function createProgram(gl) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error('着色程序链接失败：' + log);
    }
    return program;
  }

  return {
    LUT_SIZE,
    LUT_COUNT,
    SRGB_TO_P3,
    P3_TO_SRGB,
    decodeSrgb,
    encodeSrgb,
    decodeByte,
    encodeToByte,
    parseGrid,
    parseLut,
    makeIdentityLut,
    lutFetch,
    tetraCell,
    tetraInterpolate,
    backgroundLinear,
    evaluatePixel,
    processGrid,
    maxChannelDifference,
    flipRowsRGBA,
    GpuProofRenderer,
    matVec
  };
})();

if (typeof window !== 'undefined') window.Proof = Proof;
