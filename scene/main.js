import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

const isCapture = new URLSearchParams(window.location.search).has("capture");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0E0E11);
scene.fog = new THREE.Fog(0x0E0E11, 28, 72);

const camera = new THREE.PerspectiveCamera(43, window.innerWidth / window.innerHeight, 0.1, 90);
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance",
  preserveDrawingBuffer: true,
});

renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.34;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.append(renderer.domElement);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.22,
  0.32,
  0.92,
));
composer.addPass(new OutputPass());

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(0x51A7F00D);
const range = (min, max) => min + (max - min) * random();

function createFiberTexture({ base, variance, fibers, seed }) {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  const localRandom = mulberry32(seed);
  const baseColor = new THREE.Color(base);
  const image = context.createImageData(size, size);

  for (let index = 0; index < image.data.length; index += 4) {
    const noise = (localRandom() - 0.5) * variance;
    image.data[index] = Math.max(0, Math.min(255, baseColor.r * 255 + noise));
    image.data[index + 1] = Math.max(0, Math.min(255, baseColor.g * 255 + noise));
    image.data[index + 2] = Math.max(0, Math.min(255, baseColor.b * 255 + noise));
    image.data[index + 3] = 255;
  }

  context.putImageData(image, 0, 0);
  context.globalAlpha = 0.055;
  context.lineWidth = 1;

  for (let index = 0; index < fibers; index += 1) {
    context.strokeStyle = localRandom() > 0.5 ? "#ffffff" : "#111111";
    context.beginPath();
    const y = localRandom() * size;
    context.moveTo(-20, y);
    context.bezierCurveTo(
      size * 0.3,
      y + (localRandom() - 0.5) * 4,
      size * 0.7,
      y + (localRandom() - 0.5) * 4,
      size + 20,
      y + (localRandom() - 0.5) * 3,
    );
    context.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 1);
  texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
  return texture;
}

const paperTexture = createFiberTexture({ base: 0xDEDBD3, variance: 20, fibers: 95, seed: 0xA11CE });
const darkPaperTexture = createFiberTexture({ base: 0x323238, variance: 18, fibers: 80, seed: 0xB1AC });
const blueTapeTexture = createFiberTexture({ base: 0x2267D1, variance: 22, fibers: 65, seed: 0xB10E });

const materials = {
  paper: new THREE.MeshStandardMaterial({
    color: 0xE1DED5,
    map: paperTexture,
    roughness: 0.94,
    metalness: 0,
  }),
  darkPaper: new THREE.MeshStandardMaterial({
    color: 0x8B8991,
    map: darkPaperTexture,
    roughness: 0.9,
    metalness: 0,
  }),
  blue: new THREE.MeshStandardMaterial({
    color: 0x2267D1,
    map: blueTapeTexture,
    emissive: 0x071C54,
    emissiveIntensity: 0.48,
    roughness: 0.78,
    metalness: 0,
    side: THREE.DoubleSide,
  }),
  orange: new THREE.MeshStandardMaterial({
    color: 0xEF7618,
    emissive: 0x5B1F00,
    emissiveIntensity: 0.42,
    roughness: 0.68,
    metalness: 0.08,
  }),
  graphite: new THREE.MeshStandardMaterial({
    color: 0x38383E,
    roughness: 0.72,
    metalness: 0.2,
  }),
  thread: new THREE.MeshStandardMaterial({
    color: 0x4B494B,
    roughness: 0.66,
    metalness: 0.16,
  }),
};

function tornRectangle(width, height, seed, steps = 7) {
  const localRandom = mulberry32(seed);
  const jitter = Math.min(width, height) * 0.045;
  const points = [];

  for (let index = 0; index <= steps; index += 1) {
    points.push(new THREE.Vector2(
      -width / 2 + (width * index) / steps,
      -height / 2 + (localRandom() - 0.5) * jitter,
    ));
  }

  for (let index = 1; index <= steps; index += 1) {
    points.push(new THREE.Vector2(
      width / 2 + (localRandom() - 0.5) * jitter,
      -height / 2 + (height * index) / steps,
    ));
  }

  for (let index = 1; index <= steps; index += 1) {
    points.push(new THREE.Vector2(
      width / 2 - (width * index) / steps,
      height / 2 + (localRandom() - 0.5) * jitter,
    ));
  }

  for (let index = 1; index < steps; index += 1) {
    points.push(new THREE.Vector2(
      -width / 2 + (localRandom() - 0.5) * jitter,
      height / 2 - (height * index) / steps,
    ));
  }

  const shape = new THREE.Shape();
  shape.moveTo(points[0].x, points[0].y);
  points.slice(1).forEach(({ x, y }) => shape.lineTo(x, y));
  shape.closePath();
  return shape;
}

function createPaper({
  width,
  height,
  depth = 0.09,
  seed,
  material,
  position,
  rotation,
  steps,
}) {
  const geometry = new THREE.ExtrudeGeometry(tornRectangle(width, height, seed, steps), {
    depth,
    bevelEnabled: true,
    bevelSegments: 1,
    bevelSize: Math.min(width, height) * 0.012,
    bevelThickness: depth * 0.25,
    curveSegments: 1,
  });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(position);
  mesh.rotation.order = "YXZ";
  mesh.rotation.set(rotation.x, rotation.y, rotation.z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

// 纸片以不同高度和朝向构成一条不完整的世界。
const paperSpecs = [
  [5.8, 4.0, 101, materials.paper, -3.6, -0.45, 7.2, -1.43, -0.18, -0.12],
  [5.4, 3.6, 102, materials.darkPaper, 3.1, -0.1, 5.0, -1.46, 0.16, 0.13],
  [4.4, 3.2, 103, materials.paper, 0.7, 0.15, 0.4, -1.5, -0.08, -0.06],
  [4.8, 3.5, 104, materials.darkPaper, -2.4, 0.5, -4.6, -1.38, 0.2, 0.12],
  [4.1, 3.0, 105, materials.paper, 2.2, 0.8, -8.0, -1.46, -0.16, -0.1],
  [4.5, 3.3, 106, materials.paper, -1.2, 1.15, -12.2, -1.42, 0.08, 0.08],
  [3.8, 3.0, 107, materials.darkPaper, 2.6, 1.55, -15.7, -1.5, -0.12, -0.08],
  [4.1, 3.0, 108, materials.paper, -1.8, 1.9, -19.4, -1.45, 0.16, 0.1],
  [3.5, 2.8, 109, materials.darkPaper, 1.3, 2.25, -22.8, -1.38, -0.1, -0.08],
  [3.4, 2.5, 110, materials.paper, -0.4, 2.55, -26.2, -1.47, 0.08, 0.04],
  [4.7, 2.5, 111, materials.darkPaper, -6.0, 3.1, -3.0, -0.35, 0.35, -0.3],
  [4.2, 2.3, 112, materials.paper, 6.0, 3.8, -10.5, -0.2, -0.45, 0.2],
  [3.5, 2.0, 113, materials.darkPaper, -5.0, 4.1, -15.2, -0.15, 0.22, -0.18],
  [3.1, 2.2, 114, materials.paper, 4.5, 4.5, -20.2, -0.2, -0.25, 0.28],
];

paperSpecs.forEach((spec) => createPaper({
  width: spec[0],
  height: spec[1],
  seed: spec[2],
  material: spec[3],
  position: new THREE.Vector3(spec[4], spec[5], spec[6]),
  rotation: new THREE.Euler(spec[7], spec[8], spec[9]),
}));

const pathCurve = new THREE.CatmullRomCurve3([
  new THREE.Vector3(5.4, 0.45, 11.2),
  new THREE.Vector3(3.4, 0.5, 6.0),
  new THREE.Vector3(0.7, 0.75, 0.8),
  new THREE.Vector3(-2.0, 1.05, -5.0),
  new THREE.Vector3(2.0, 1.55, -11.7),
  new THREE.Vector3(-1.4, 2.05, -18.2),
  new THREE.Vector3(0.2, 2.65, -27.6),
], false, "catmullrom", 0.35);

function createRibbonGeometry(curve, segments, width) {
  const positions = [];
  const uvs = [];
  const indices = [];
  const up = new THREE.Vector3(0, 1, 0);

  for (let index = 0; index <= segments; index += 1) {
    const progress = index / segments;
    const point = curve.getPoint(progress);
    const tangent = curve.getTangent(progress).normalize();
    const side = new THREE.Vector3().crossVectors(up, tangent).normalize();
    const tear = 0.9 + 0.18 * Math.sin(index * 2.17) + 0.08 * Math.sin(index * 5.43);
    const fold = Math.sin(progress * Math.PI * 10) * 0.035;
    const left = point.clone().addScaledVector(side, width * tear).addScaledVector(up, fold);
    const right = point.clone().addScaledVector(side, -width * (2 - tear)).addScaledVector(up, -fold);
    positions.push(left.x, left.y, left.z, right.x, right.y, right.z);
    uvs.push(progress, 0, progress, 1);

    if (index < segments) {
      const base = index * 2;
      indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

const ribbon = new THREE.Mesh(createRibbonGeometry(pathCurve, 150, 0.34), materials.blue);
ribbon.castShadow = true;
ribbon.receiveShadow = true;
scene.add(ribbon);

function createWire(points, radius = 0.018, material = materials.thread) {
  const curve = new THREE.CatmullRomCurve3(points);
  const geometry = new THREE.TubeGeometry(curve, 84, radius, 5, false);
  const wire = new THREE.Mesh(geometry, material);
  wire.castShadow = true;
  scene.add(wire);
  return wire;
}

createWire([
  new THREE.Vector3(-8, 4.6, 8),
  new THREE.Vector3(-4, 7.2, 2),
  new THREE.Vector3(2, 6.4, -7),
  new THREE.Vector3(7, 3.8, -14),
], 0.024);
createWire([
  new THREE.Vector3(7, 5.2, 5),
  new THREE.Vector3(3, 7.6, -2),
  new THREE.Vector3(-5, 5.8, -10),
  new THREE.Vector3(-7, 3.2, -20),
], 0.02);
createWire([
  new THREE.Vector3(-6, 0.8, 5),
  new THREE.Vector3(-7, 3.4, -3),
  new THREE.Vector3(-1, 5.6, -12),
  new THREE.Vector3(6, 4.2, -23),
], 0.016);
createWire([
  new THREE.Vector3(5.5, 1.2, -2),
  new THREE.Vector3(7.5, 2.8, -8),
  new THREE.Vector3(2.5, 6.2, -17),
  new THREE.Vector3(-3.5, 4.2, -28),
], 0.016);

function createExplorer() {
  const explorer = new THREE.Group();
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 1), materials.orange);
  head.position.y = 0.88;
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.62, 5, 1), materials.darkPaper);
  body.position.y = 0.46;
  const backpack = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.34, 0.15), materials.graphite);
  backpack.position.set(0, 0.5, 0.14);
  const flagPole = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.42, 6), materials.graphite);
  flagPole.position.set(0.2, 0.72, 0);
  flagPole.rotation.z = -0.12;
  const flag = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.11, 0.025), materials.orange);
  flag.position.set(0.25, 0.82, 0);
  flag.rotation.z = -0.12;

  const limbGeometry = new THREE.CylinderGeometry(0.045, 0.055, 0.42, 6);
  const leftLeg = new THREE.Mesh(limbGeometry, materials.graphite);
  const rightLeg = new THREE.Mesh(limbGeometry, materials.graphite);
  leftLeg.position.set(-0.1, 0.13, 0);
  rightLeg.position.set(0.1, 0.13, 0);
  leftLeg.rotation.z = -0.15;
  rightLeg.rotation.z = 0.15;

  explorer.add(head, body, backpack, flagPole, flag, leftLeg, rightLeg);
  explorer.traverse((object) => {
    if (object.isMesh) object.castShadow = true;
  });

  const progress = 0.52;
  const point = pathCurve.getPoint(progress);
  const tangent = pathCurve.getTangent(progress);
  explorer.position.copy(point).add(new THREE.Vector3(0, 0.16, 0));
  explorer.rotation.y = Math.atan2(tangent.x, tangent.z) + Math.PI;
  explorer.scale.setScalar(1.95);
  scene.add(explorer);
  return explorer;
}

const explorer = createExplorer();

// 远处的撕纸开口只提供方向，不解释终点。
const aperture = new THREE.Group();
aperture.position.set(0.2, 3.0, -30.8);
const apertureColors = [materials.paper, materials.darkPaper, materials.paper, materials.darkPaper];

for (let index = 0; index < 12; index += 1) {
  const angle = (index / 12) * Math.PI * 2;
  const radiusX = 2.15;
  const radiusY = 2.85;
  const shard = createPaper({
    width: range(1.0, 1.8),
    height: range(1.3, 2.1),
    depth: 0.12,
    seed: 800 + index,
    material: apertureColors[index % apertureColors.length],
    position: new THREE.Vector3(
      Math.cos(angle) * radiusX,
      Math.sin(angle) * radiusY,
      range(-0.25, 0.25),
    ),
    rotation: new THREE.Euler(range(-0.12, 0.12), range(-0.15, 0.15), angle + Math.PI / 2 + range(-0.18, 0.18)),
    steps: 5,
  });
  scene.remove(shard);
  aperture.add(shard);
}

const opening = new THREE.Mesh(
  new THREE.CircleGeometry(1.55, 64),
  new THREE.MeshBasicMaterial({ color: 0x07162E }),
);
opening.scale.y = 1.45;
opening.position.z = -0.25;
aperture.add(opening);

const farLight = new THREE.PointLight(0x5E91F0, 52, 18, 2);
farLight.position.set(0, 0, 1.8);
aperture.add(farLight);
scene.add(aperture);

function addHiddenMotifs() {
  const motorcycle = new THREE.Group();
  const wheelGeometry = new THREE.TorusGeometry(0.22, 0.025, 6, 24);
  const wheelOne = new THREE.Mesh(wheelGeometry, materials.thread);
  const wheelTwo = wheelOne.clone();
  wheelOne.position.x = -0.34;
  wheelTwo.position.x = 0.34;
  motorcycle.add(wheelOne, wheelTwo);
  const frame = createWire([
    new THREE.Vector3(-0.34, 0, 0),
    new THREE.Vector3(0, 0.32, 0),
    new THREE.Vector3(0.34, 0, 0),
    new THREE.Vector3(-0.08, 0.02, 0),
    new THREE.Vector3(-0.34, 0, 0),
  ], 0.014);
  scene.remove(frame);
  motorcycle.add(frame);
  motorcycle.position.set(2.8, 2.1, -15.2);
  motorcycle.rotation.set(-0.22, -0.4, 0.04);
  motorcycle.scale.setScalar(0.72);
  scene.add(motorcycle);

  const waveform = new THREE.Group();
  for (let index = 0; index < 13; index += 1) {
    const height = 0.08 + Math.abs(Math.sin(index * 1.7)) * 0.42;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.035, height, 0.025), materials.graphite);
    bar.position.set((index - 6) * 0.08, height / 2, 0);
    waveform.add(bar);
  }
  waveform.position.set(-2.1, 2.5, -19.2);
  waveform.rotation.set(-0.18, 0.3, -0.06);
  scene.add(waveform);
}

addHiddenMotifs();

const flakeGeometry = new THREE.BoxGeometry(0.055, 0.012, 0.08);
const flakes = new THREE.InstancedMesh(flakeGeometry, materials.paper, 110);
const dummy = new THREE.Object3D();

for (let index = 0; index < flakes.count; index += 1) {
  dummy.position.set(range(-9, 9), range(0.2, 8), range(-37, 12));
  dummy.rotation.set(range(0, Math.PI), range(0, Math.PI), range(0, Math.PI));
  dummy.scale.setScalar(range(0.4, 1.25));
  dummy.updateMatrix();
  flakes.setMatrixAt(index, dummy.matrix);
}

flakes.castShadow = false;
scene.add(flakes);

const hemisphere = new THREE.HemisphereLight(0xC5D0D2, 0x17110F, 2.05);
scene.add(hemisphere);

const keyLight = new THREE.DirectionalLight(0xF0ECE2, 5.2);
keyLight.position.set(-7, 11, 9);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.left = -14;
keyLight.shadow.camera.right = 14;
keyLight.shadow.camera.top = 14;
keyLight.shadow.camera.bottom = -14;
keyLight.shadow.camera.near = 0.1;
keyLight.shadow.camera.far = 55;
keyLight.shadow.bias = -0.0005;
scene.add(keyLight);

const blueRim = new THREE.PointLight(0x397EEB, 34, 22, 2);
blueRim.position.set(3, 3, -8);
scene.add(blueRim);

const warmRim = new THREE.PointLight(0xEF7618, 20, 15, 2);
warmRim.position.set(-2, 4, -13);
scene.add(warmRim);

const desktopCamera = {
  position: new THREE.Vector3(6.6, 5.6, 14.2),
  target: new THREE.Vector3(-0.15, 0.65, -11.5),
  fov: 44,
};
const mobileCamera = {
  position: new THREE.Vector3(3.2, 8.2, 16.5),
  target: new THREE.Vector3(0, -1.8, -10.8),
  fov: 49,
};

function updateCamera(time = 0) {
  const preset = window.innerWidth / window.innerHeight < 0.8 ? mobileCamera : desktopCamera;
  const drift = isCapture ? 0 : Math.sin(time * 0.00012) * 0.16;
  camera.position.copy(preset.position);
  camera.position.x += drift;
  camera.fov = preset.fov;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  camera.lookAt(preset.target);
}

function resize() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  composer.setSize(window.innerWidth, window.innerHeight);
  updateCamera();
}

window.addEventListener("resize", resize);
resize();

function render(time = 0) {
  if (!isCapture) {
    const baseY = pathCurve.getPoint(0.52).y + 0.16;
    explorer.position.y = baseY + Math.sin(time * 0.0016) * 0.025;
    updateCamera(time);
  }
  composer.render();
}

function reportScene() {
  render(1400);
  const context = renderer.getContext();
  const width = context.drawingBufferWidth;
  const height = context.drawingBufferHeight;
  const frame = new Uint8Array(width * height * 4);
  context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, frame);
  const stride = Math.max(4, Math.floor(Math.min(width, height) / 220));
  let visible = 0;
  let blue = 0;
  let orange = 0;
  let total = 0;

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const index = (y * width + x) * 4;
      const red = frame[index];
      const green = frame[index + 1];
      const blueValue = frame[index + 2];
      visible += red + green + blueValue > 42 ? 1 : 0;
      blue += blueValue > red * 1.35 && blueValue > green * 1.15 && blueValue > 55 ? 1 : 0;
      orange += red > green * 1.25 && red > blueValue * 1.8 && green > 28 && red > 80 ? 1 : 0;
      total += 1;
    }
  }

  return {
    canvas: [renderer.domElement.width, renderer.domElement.height],
    coverage: {
      blue: blue / total,
      orange: orange / total,
      visible: visible / total,
    },
    webgl: context.getParameter(context.VERSION),
  };
}

window.__sceneReport = reportScene;

if (isCapture) {
  render(1400);
  requestAnimationFrame(() => {
    render(1400);
    document.body.dataset.ready = "true";
    window.__sceneReady = true;
  });
} else {
  renderer.setAnimationLoop(render);
}
