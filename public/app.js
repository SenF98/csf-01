/**
 * PCD 点云预览工具 —— 前端
 *
 * 功能：
 * - PCDLoader 加载 ascii / binary / binary_compressed 格式的 .pcd
 * - OrbitControls：左键旋转、右键平移、滚轮缩放
 * - 滑块实时调节点大小（像素尺寸，与缩放无关）
 * - 两种着色模式：单色 / 按 Z 高度渐变
 * - 文件列表、上传（点击 / 拖拽）、下载、删除
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PCDLoader } from 'three/addons/loaders/PCDLoader.js';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const fileListEl = $('file-list');
const fileCountEl = $('file-count');
const fileInput = $('file-input');
const dropZone = $('drop-zone');
const uploadStatus = $('upload-status');
const sizeSlider = $('size-slider');
const sizeValue = $('size-value');
const solidColorInput = $('solid-color');
const modeBtns = document.querySelectorAll('.mode-btn');
const legendRow = $('legend-row');
const legendMax = $('legend-max');
const legendMin = $('legend-min');
const solidColorRow = $('solid-color-row');
const resetViewBtn = $('reset-view-btn');
const refreshBtn = $('refresh-btn');
const hudEl = $('hud');
const hudName = $('hud-name');
const hudInfo = $('hud-info');
const loadingEl = $('loading');
const emptyTipEl = $('empty-tip');
const canvasEl = $('canvas');

// ---------------------------------------------------------------------------
// Three.js 场景
// ---------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({
  canvas: canvasEl,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = null; // 透出 CSS 的深色径向渐变

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 20000);
camera.position.set(300, 250, 300);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
// 显式约定鼠标按键：左键旋转、右键平移、滚轮缩放
controls.mouseButtons = {
  LEFT: THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.PAN,
};
controls.screenSpacePanning = true;

// 微弱的坐标轴提示（红 X / 绿 Y / 蓝 Z）
const axesHelper = new THREE.AxesHelper(20);
axesHelper.visible = false;
scene.add(axesHelper);

let pointCloud = null; // 当前 THREE.Points
let gridHelper = null; // 当前地面网格
let heightColors = null; // 当前高度颜色 attribute（切回单色时保留）
let zRange = null; // { min, max }

function resize() {
  const w = canvasEl.clientWidth;
  const h = canvasEl.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

// ---------------------------------------------------------------------------
// 着色：单色 / 高度渐变
// ---------------------------------------------------------------------------

// 与 CSS 图例保持一致的渐变色标（低 → 高）
const HEIGHT_STOPS = [
  [0.0, [0x2b, 0x10, 0x55]], // 深紫
  [0.3, [0x1f, 0x78, 0xb4]], // 蓝
  [0.55, [0x39, 0xd3, 0x53]], // 绿
  [0.78, [0xf2, 0xcc, 0x49]], // 黄
  [1.0, [0xf8, 0x51, 0x49]], // 红
];

function sampleGradient(t) {
  t = Math.min(1, Math.max(0, t));
  for (let i = 1; i < HEIGHT_STOPS.length; i++) {
    const [t1, c1] = HEIGHT_STOPS[i];
    if (t <= t1) {
      const [t0, c0] = HEIGHT_STOPS[i - 1];
      const k = (t - t0) / (t1 - t0);
      return [
        (c0[0] + (c1[0] - c0[0]) * k) / 255,
        (c0[1] + (c1[1] - c0[1]) * k) / 255,
        (c0[2] + (c1[2] - c0[2]) * k) / 255,
      ];
    }
  }
  const last = HEIGHT_STOPS[HEIGHT_STOPS.length - 1][1];
  return [last[0] / 255, last[1] / 255, last[2] / 255];
}

/** 根据包围盒 Z 范围，为每个点生成渐变色 */
function buildHeightColors(geometry) {
  geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox;
  zRange = { min: min.z, max: max.z };

  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const span = max.z - min.z || 1;

  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getZ(i) - min.z) / span;
    const [r, g, b] = sampleGradient(t);
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }

  heightColors = new THREE.BufferAttribute(colors, 3);
  heightColors.setUsage(THREE.StaticDrawUsage);
}

let colorMode = 'solid';

function applyColorMode() {
  if (!pointCloud) return;
  const mat = pointCloud.material;

  if (colorMode === 'height') {
    if (!heightColors) buildHeightColors(pointCloud.geometry);
    pointCloud.geometry.setAttribute('color', heightColors);
    mat.vertexColors = true;
    legendRow.hidden = false;
    solidColorRow.style.opacity = '0.35';
    solidColorRow.style.pointerEvents = 'none';
    if (zRange) {
      legendMax.textContent = `高  ${zRange.max.toFixed(2)} m`;
      legendMin.textContent = `低  ${zRange.min.toFixed(2)} m`;
    }
  } else {
    mat.vertexColors = false;
    legendRow.hidden = true;
    solidColorRow.style.opacity = '';
    solidColorRow.style.pointerEvents = '';
  }
  mat.needsUpdate = true;
}

modeBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    modeBtns.forEach((b) => {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', active ? 'true' : 'false');
    });
    colorMode = btn.dataset.mode;
    applyColorMode();
  });
});

// 点大小（像素单位，不随距离衰减）——滑块实时生效
sizeSlider.addEventListener('input', () => {
  sizeValue.textContent = Number(sizeSlider.value).toFixed(1);
  if (pointCloud) pointCloud.material.size = Number(sizeSlider.value);
});

// 单色取色器实时生效
solidColorInput.addEventListener('input', () => {
  if (pointCloud && colorMode === 'solid') {
    pointCloud.material.color.set(solidColorInput.value);
  }
});

// ---------------------------------------------------------------------------
// 视角自适应
// ---------------------------------------------------------------------------

const DEFAULT_VIEW_DIR = new THREE.Vector3(1.1, 0.9, 0.75).normalize();

function fitViewToCloud() {
  if (!pointCloud) return;
  const geo = pointCloud.geometry;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  const center = geo.boundingSphere.center.clone();
  const radius = geo.boundingSphere.radius || 1;

  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(DEFAULT_VIEW_DIR, radius * 2.1);
  camera.near = Math.max(radius / 1000, 0.01);
  camera.far = radius * 100;
  camera.updateProjectionMatrix();
  controls.update();
}

resetViewBtn.addEventListener('click', fitViewToCloud);

// ---------------------------------------------------------------------------
// 点云加载 / 卸载
// ---------------------------------------------------------------------------

const pcdLoader = new PCDLoader();

function disposeCloud() {
  if (pointCloud) {
    scene.remove(pointCloud);
    pointCloud.geometry.dispose();
    pointCloud.material.dispose();
    pointCloud = null;
  }
  if (gridHelper) {
    scene.remove(gridHelper);
    gridHelper.geometry.dispose();
    gridHelper.material.dispose();
    gridHelper = null;
  }
  heightColors = null;
  zRange = null;
  axesHelper.visible = false;
}

/**
 * @param {object} file /api/files 返回的文件元数据
 */
function loadCloud(file) {
  disposeCloud();
  loadingEl.hidden = false;
  emptyTipEl.hidden = true;

  const url = `/api/files/${file.id}/download?t=${Date.now()}`;
  pcdLoader.load(
    url,
    (points) => {
      pointCloud = points;

      // 统一点材质：像素尺寸、不随深度衰减，滑块调节最直观
      points.material.dispose();
      points.material = new THREE.PointsMaterial({
        size: Number(sizeSlider.value),
        sizeAttenuation: false,
        color: new THREE.Color(solidColorInput.value),
        vertexColors: false,
      });

      scene.add(points);

      // 地面参考网格：包围盒最短轴视为高度轴
      // （SLAM/ROS 数据通常 Z 朝上，PCL 显示惯例可能 Y 朝上）
      points.geometry.computeBoundingBox();
      const box = points.geometry.boundingBox;
      const size = new THREE.Vector3();
      box.getSize(size);
      const gridSize = Math.ceil(Math.max(size.x, size.y) / 10) * 10;
      const divisions = Math.min(60, Math.round(gridSize / 10));
      if (Number.isFinite(gridSize) && gridSize > 0) {
        gridHelper = new THREE.GridHelper(gridSize, divisions, 0x3a4452, 0x232a33);
        if (size.z < size.y) {
          // Z 朝上：把默认 XZ 平面网格旋到 XY 平面，垫在最低点下方
          gridHelper.rotateX(Math.PI / 2);
          gridHelper.position.set(
            (box.min.x + box.max.x) / 2,
            (box.min.y + box.max.y) / 2,
            box.min.z - 0.5,
          );
        } else {
          gridHelper.position.set(
            (box.min.x + box.max.x) / 2,
            box.min.y - 0.5,
            (box.min.z + box.max.z) / 2,
          );
        }
        scene.add(gridHelper);
      }
      axesHelper.visible = true;

      buildHeightColors(points.geometry);
      applyColorMode();
      fitViewToCloud();

      // HUD 信息
      hudName.textContent = file.originalName;
      const sizeMB = (file.size / 1024 / 1024).toFixed(2);
      hudInfo.textContent =
        `${file.points.toLocaleString()} 点 · ${file.dataType} · ` +
        `字段 [${(file.fields || []).join(', ')}] · ${sizeMB} MB`;
      hudEl.hidden = false;
      loadingEl.hidden = true;
    },
    undefined,
    (err) => {
      console.error('PCD 加载失败', err);
      loadingEl.hidden = true;
      emptyTipEl.hidden = false;
      alert('点云加载失败，请确认文件为有效的 PCD 格式');
    },
  );
}

// ---------------------------------------------------------------------------
// 文件管理（列表 / 上传 / 下载 / 删除）
// ---------------------------------------------------------------------------

let files = [];
let currentId = null;

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  return (bytes / 1024).toFixed(1) + ' KB';
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function renderFileList() {
  fileCountEl.textContent = `共 ${files.length} 个文件`;
  fileListEl.innerHTML = '';

  for (const f of files) {
    const li = document.createElement('li');
    li.className = 'file-item' + (f.id === currentId ? ' active' : '');
    li.dataset.id = f.id;
    li.innerHTML = `
      <div class="fi-body">
        <div class="fi-name">${escapeHtml(f.originalName)}
          ${f.builtin ? '<span class="builtin-tag">示例</span>' : ''}
        </div>
        <div class="fi-sub">${f.points.toLocaleString()} 点 · ${formatSize(f.size)}</div>
      </div>
      <div class="fi-actions">
        <button class="fi-btn" data-action="download" title="下载">⤓</button>
        <button class="fi-btn danger" data-action="delete" title="删除">✕</button>
      </div>
    `;
    fileListEl.appendChild(li);
  }
}

fileListEl.addEventListener('click', async (e) => {
  const li = e.target.closest('.file-item');
  if (!li) return;
  const file = files.find((f) => f.id === li.dataset.id);
  if (!file) return;

  const action = e.target.closest('[data-action]')?.dataset.action;

  if (action === 'download') {
    window.location.href = `/api/files/${file.id}/download`;
    return;
  }

  if (action === 'delete') {
    if (!confirm(`确定删除「${file.originalName}」吗？此操作不可恢复。`)) return;
    const res = await fetch(`/api/files/${file.id}`, { method: 'DELETE' });
    if (!res.ok) {
      alert('删除失败');
      return;
    }
    if (currentId === file.id) {
      currentId = null;
      disposeCloud();
      hudEl.hidden = true;
      emptyTipEl.hidden = false;
    }
    await refreshFiles(false);
    return;
  }

  // 点击条目本体：加载预览
  if (file.id !== currentId) {
    currentId = file.id;
    renderFileList();
    loadCloud(file);
  }
});

async function refreshFiles(autoSelectFirst = false) {
  const res = await fetch('/api/files');
  files = await res.json();
  renderFileList();

  if (autoSelectFirst && files.length > 0) {
    currentId = files[0].id;
    renderFileList();
    loadCloud(files[0]);
  }
}

refreshBtn.addEventListener('click', () => refreshFiles(false));

// ---- 上传 ----------------------------------------------------------------

function showUploadStatus(ok, msg) {
  uploadStatus.hidden = false;
  uploadStatus.className = 'upload-status ' + (ok ? 'ok' : 'err');
  uploadStatus.textContent = msg;
  if (ok) setTimeout(() => { uploadStatus.hidden = true; }, 4000);
}

async function uploadFile(file) {
  if (!file.name.toLowerCase().endsWith('.pcd')) {
    showUploadStatus(false, '仅支持 .pcd 文件');
    return;
  }

  showUploadStatus(true, `正在上传 ${file.name}（${formatSize(file.size)}）…`);

  const form = new FormData();
  form.append('pcd', file);

  let record;
  try {
    const res = await fetch('/api/files', { method: 'POST', body: form });
    record = await res.json();
    if (!res.ok) throw new Error(record.error || '上传失败');
  } catch (err) {
    showUploadStatus(false, err.message);
    return;
  }

  showUploadStatus(true, `上传成功：${file.name}`);
  await refreshFiles(false);
  currentId = record.id;
  renderFileList();
  loadCloud(record);
}

fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    uploadFile(fileInput.files[0]);
    fileInput.value = '';
  }
});

['dragenter', 'dragover'].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  }),
);
['dragleave', 'drop'].forEach((evt) =>
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
  }),
);
dropZone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files?.[0];
  if (file) uploadFile(file);
});

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

refreshFiles(true);
