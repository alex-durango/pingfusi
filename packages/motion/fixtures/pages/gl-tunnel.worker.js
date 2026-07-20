// Fixture: worker-rendered WebGL parallax tunnel with CLOSED-FORM ground truth.
// Mirrors the floema.com Images.worker architecture (OffscreenCanvas transferred into a
// dedicated worker, rAF loop inside the worker, scroll progress posted from the page)
// so the GL tap is gated against the same shape it must capture in the wild.
//
// Ground truth (asserted by harness/gl-gate.js):
//   COUNT 12 items on a radius-5 ring, z-spacing 3 (tunnel length 36)
//   idle speed 20 u/s toward the camera; wrap at z > -0.5 back by 36
//   intro burst: v = idle + (200 - idle) * 2^(-t/150ms)
//   scroll speed law: target = idle + SPAN·(1 − 2^(−K·progress)) — a PERSISTENT level
//   (the floema.com-measured shape), approached with a fast lerp (τ ≈ 80ms)
//   camera fovY 45°, fog near 2 / far 40
const COUNT = 12;
const RADIUS = 5;
const SPACING = 3;
const IDLE = 20;
const INTRO_V0 = 200;
const INTRO_HALF = 150;
const SPAN = 60;
const K = 6;
const LERP_TAU = 80;
const FOG_NEAR = 2;
const FOG_FAR = 40;

let gl = null;
let canvas = null;
let prog = null;
let loc = {};
let items = [];
let t0 = null;
let lastT = null;
let scrollLevel = 0; // current scroll-linked speed component (lerps toward its target)
let scrollTarget = 0;

const VS = `#version 300 es
in vec2 pos;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
out float vDepth;
void main() {
  vec4 mv = modelViewMatrix * vec4(pos, 0.0, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const FS = `#version 300 es
precision highp float;
in float vDepth;
uniform float opacity;
uniform float fogNear;
uniform float fogFar;
uniform vec3 fogColor;
uniform vec3 tint;
out vec4 color;
void main() {
  float fog = clamp((vDepth - fogNear) / (fogFar - fogNear), 0.0, 1.0);
  color = vec4(mix(tint, fogColor, fog), opacity);
}`;

function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
}

function init(data) {
  canvas = data.canvas;
  canvas.width = data.width;
  canvas.height = data.height;
  gl = canvas.getContext('webgl2', { alpha: false, antialias: false });
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  for (const n of ['projectionMatrix', 'modelViewMatrix', 'opacity', 'fogNear', 'fogFar', 'fogColor', 'tint']) {
    loc[n] = gl.getUniformLocation(prog, n);
  }
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
  const pos = gl.getAttribLocation(prog, 'pos');
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

  items = Array.from({ length: COUNT }, (_, i) => {
    const angle = (i / COUNT) * Math.PI * 2;
    return {
      x: Math.cos(angle) * RADIUS,
      y: Math.sin(angle) * RADIUS,
      z: -(i + 1) * SPACING,
      sx: 1 + (i % 3) * 0.25,
      sy: (1 + (i % 3) * 0.25) * 0.75,
      tint: [((i * 53) % 255) / 255, ((i * 97) % 255) / 255, ((i * 151) % 255) / 255],
    };
  });
  requestAnimationFrame(tick);
}

function tick() {
  const now = performance.now();
  if (t0 == null) t0 = now;
  const dt = lastT == null ? 16.7 : Math.min(100, now - lastT);
  lastT = now;

  const intro = (INTRO_V0 - IDLE) * Math.pow(2, -(now - t0) / INTRO_HALF);
  scrollLevel += (scrollTarget - scrollLevel) * (1 - Math.pow(2, -dt / LERP_TAU));
  const v = IDLE + intro + scrollLevel;
  for (const it of items) {
    it.z += (v * dt) / 1000;
    if (it.z > -0.5) it.z -= COUNT * SPACING;
  }

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.95, 0.94, 0.92, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(prog);
  gl.uniformMatrix4fv(loc.projectionMatrix, false, new Float32Array(perspective(Math.PI / 4, canvas.width / canvas.height, 0.1, 100)));
  gl.uniform1f(loc.fogNear, FOG_NEAR);
  gl.uniform1f(loc.fogFar, FOG_FAR);
  gl.uniform3f(loc.fogColor, 0.95, 0.94, 0.92);
  for (const it of items) {
    gl.uniformMatrix4fv(
      loc.modelViewMatrix,
      false,
      new Float32Array([it.sx, 0, 0, 0, 0, it.sy, 0, 0, 0, 0, 1, 0, it.x, it.y, it.z, 1]),
    );
    gl.uniform1f(loc.opacity, 1);
    gl.uniform3f(loc.tint, ...it.tint);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  requestAnimationFrame(tick);
}

self.onmessage = (e) => {
  const d = e.data;
  if (d.type === 'init') init(d);
  else if (d.type === 'scroll') {
    scrollTarget = SPAN * (1 - Math.pow(2, -K * d.progress));
  }
};
