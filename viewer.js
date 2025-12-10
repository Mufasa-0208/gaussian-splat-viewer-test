import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js';
import { loadSimpleSplatFromArrayBuffer } from './simple-splat-loader.js';

// DOM elements
const canvas = document.getElementById('canvas');
const overlay = document.getElementById('overlay');
const fileInput = document.getElementById('fileInput');
const urlInput = document.getElementById('urlInput');
const loadUrlBtn = document.getElementById('loadUrlBtn');
const exposureInput = document.getElementById('exposure');
const toolbar = document.getElementById('toolbar');
const exportStateBtn = document.getElementById('exportStateBtn');
const importStateBtn = document.getElementById('importStateBtn');
const stateText = document.getElementById('stateText');

let tool = 'select'; // 'select' | 'marker' | 'distance'

// Viewer state that can be exported/imported
let viewerState = {
  camera: { position: [2, 2, 2], target: [0, 0, 0] },
  annotations: [],
  renderSettings: {
    exposure: 1.0,
    backgroundColor: '#000000'
  },
  modelUrl: null
};

// Three.js setup
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ReinhardToneMapping;
renderer.toneMappingExposure = viewerState.renderSettings.exposure;

const scene = new THREE.Scene();
scene.background = new THREE.Color(viewerState.renderSettings.backgroundColor);

const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 1000);
camera.position.set(...viewerState.camera.position);

const controls = new OrbitControls(camera, canvas);
controls.target.set(...viewerState.camera.target);
controls.update();

// Groups
const splatGroup = new THREE.Group();
scene.add(splatGroup);

const annotationGroup = new THREE.Group();
scene.add(annotationGroup);

// Material for splats (placeholder: point sprites)
// Replace this with a custom ShaderMaterial for true Gaussians later
const splatMaterial = new THREE.PointsMaterial({
  size: 0.01,
  vertexColors: true,
  sizeAttenuation: true
});

let splatPoints = null;

// Handle resize
function resize() {
  const rect = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(rect.width, rect.height, false);
  camera.aspect = rect.width / rect.height;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// Animation loop
function animate() {
  requestAnimationFrame(animate);
  renderer.toneMappingExposure = viewerState.renderSettings.exposure;
  controls.update();
  renderer.render(scene, camera);
}
animate();

// --- Model loading ---

async function loadModelFromArrayBuffer(buffer) {
  const points = loadSimpleSplatFromArrayBuffer(buffer, splatMaterial);
  if (!points) return;

  if (splatPoints) {
    splatGroup.remove(splatPoints);
    if (splatPoints.geometry) splatPoints.geometry.dispose();
  }

  splatPoints = points;
  splatGroup.add(splatPoints);

  const geom = splatPoints.geometry;
  if (geom.boundingSphere) {
    const center = geom.boundingSphere.center;
    const radius = geom.boundingSphere.radius;
    controls.target.copy(center);
    const dist = radius * 2.5;
    camera.position.set(center.x + dist, center.y + dist, center.z + dist);
    controls.update();
  }
}

async function loadModelFromUrl(url) {
  viewerState.modelUrl = url;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    await loadModelFromArrayBuffer(buffer);
  } catch (err) {
    console.error('Failed to load model from URL:', err);
    alert('Failed to load model from URL: ' + err.message);
  }
}

// File input handler
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const buffer = await file.arrayBuffer();
  await loadModelFromArrayBuffer(buffer);
});

// URL input handler
loadUrlBtn.addEventListener('click', () => {
  const url = urlInput.value.trim();
  if (url) loadModelFromUrl(url);
});

// URL param ?model=
const params = new URLSearchParams(location.search);
if (params.get('model')) {
  loadModelFromUrl(params.get('model'));
}

// --- Tool selection ---

toolbar.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tool]');
  if (!btn) return;
  tool = btn.getAttribute('data-tool');
  for (const b of toolbar.querySelectorAll('button')) b.classList.remove('active');
  btn.classList.add('active');
});

// --- Mouse picking for measurements ---

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const distanceTemp = {
  pending: null // { p1: THREE.Vector3 }
};

function get3DPointFromClick(event) {
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  if (splatPoints) {
    const intersects = raycaster.intersectObject(splatPoints);
    if (intersects.length > 0) {
      return intersects[0].point.clone();
    }
  }
  return null;
}

canvas.addEventListener('pointerdown', (event) => {
  if (tool === 'select') return;

  const p = get3DPointFromClick(event);
  if (!p) return;

  if (tool === 'marker') {
    addMarkerAnnotation(p);
  } else if (tool === 'distance') {
    handleDistanceClick(p);
  }
});

// --- Annotations ---

function addMarkerAnnotation(position) {
  const id = 'marker-' + Date.now();
  viewerState.annotations.push({
    type: 'marker',
    id,
    position: [position.x, position.y, position.z],
    label: id,
    color: '#ff0000'
  });
  rebuildAnnotations();
}

function handleDistanceClick(position) {
  if (!distanceTemp.pending) {
    distanceTemp.pending = { p1: position.clone() };
  } else {
    const p1 = distanceTemp.pending.p1;
    const p2 = position.clone();
    const id = 'dist-' + Date.now();

    viewerState.annotations.push({
      type: 'distance',
      id,
      p1: [p1.x, p1.y, p1.z],
      p2: [p2.x, p2.y, p2.z]
    });

    distanceTemp.pending = null;
    rebuildAnnotations();
  }
}

function rebuildAnnotations() {
  while (annotationGroup.children.length) {
    const c = annotationGroup.children.pop();
    if (c.geometry) c.geometry.dispose();
    if (c.material) c.material.dispose();
  }
  overlay.innerHTML = '';

  for (const ann of viewerState.annotations) {
    if (ann.type === 'marker') {
      const sphereGeom = new THREE.SphereGeometry(0.01, 12, 12);
      const sphereMat = new THREE.MeshBasicMaterial({ color: ann.color || '#ff0000' });
      const mesh = new THREE.Mesh(sphereGeom, sphereMat);
      mesh.position.set(...ann.position);
      annotationGroup.add(mesh);

      createLabelFor3DPoint(mesh.position, ann.label || ann.id);
    } else if (ann.type === 'distance') {
      const p1 = new THREE.Vector3(...ann.p1);
      const p2 = new THREE.Vector3(...ann.p2);
      const geom = new THREE.BufferGeometry().setFromPoints([p1, p2]);
      const mat = new THREE.LineBasicMaterial({ color: 0x00ff00 });
      const line = new THREE.Line(geom, mat);
      annotationGroup.add(line);

      const dist = p1.distanceTo(p2);
      const mid = p1.clone().add(p2).multiplyScalar(0.5);
      createLabelFor3DPoint(mid, dist.toFixed(3));
    }
  }
}

function createLabelFor3DPoint(position, text) {
  const div = document.createElement('div');
  div.className = 'label';
  div.textContent = text;
  overlay.appendChild(div);

  function updatePosition() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const pos = position.clone().project(camera);
    const x = (pos.x * 0.5 + 0.5) * width;
    const y = (-pos.y * 0.5 + 0.5) * height;
    div.style.left = `${x}px`;
    div.style.top = `${y}px`;
    div.style.display = pos.z > 1 ? 'none' : 'block';
  }

  function loop() {
    if (!div.parentElement) return;
    updatePosition();
    requestAnimationFrame(loop);
  }
  loop();
}

// --- Exposure / render settings ---

exposureInput.addEventListener('input', () => {
  viewerState.renderSettings.exposure = parseFloat(exposureInput.value);
});

// --- Import / export viewer state ---

exportStateBtn.addEventListener('click', () => {
  viewerState.camera.position = [camera.position.x, camera.position.y, camera.position.z];
  viewerState.camera.target = [controls.target.x, controls.target.y, controls.target.z];

  stateText.value = JSON.stringify(viewerState, null, 2);
});

importStateBtn.addEventListener('click', () => {
  try {
    const obj = JSON.parse(stateText.value);
    viewerState = obj;

    camera.position.set(...viewerState.camera.position);
    controls.target.set(...viewerState.camera.target);
    controls.update();

    exposureInput.value = viewerState.renderSettings.exposure ?? 1.0;

    rebuildAnnotations();

    if (viewerState.modelUrl) {
      loadModelFromUrl(viewerState.modelUrl);
    }
  } catch (e) {
    alert('Failed to parse state JSON: ' + e.message);
  }
});

// --- postMessage API for iframe embedding ---

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'loadModel' && msg.url) {
    loadModelFromUrl(msg.url);
  } else if (msg.type === 'setCamera' && msg.position && msg.target) {
    camera.position.set(...msg.position);
    controls.target.set(...msg.target);
    controls.update();
  } else if (msg.type === 'addAnnotation' && msg.annotation) {
    viewerState.annotations.push(msg.annotation);
    rebuildAnnotations();
  }
});