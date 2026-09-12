/**
 * PCD 点云预览工具 —— 后端服务
 *
 * - Express 提供静态前端与 REST API
 * - 不引入数据库：文件元数据保存在 data/metadata.json
 * - PCD 文件本体保存在 storage/ 目录
 * - 首次启动时自动导入项目根目录下的 slam3d_map.pcd
 */

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const STORAGE_DIR = path.join(ROOT, 'storage');
const METADATA_FILE = path.join(DATA_DIR, 'metadata.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SAMPLE_PCD = path.join(ROOT, 'slam3d_map.pcd');
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// 元数据存储（JSON 文件，无数据库）
// ---------------------------------------------------------------------------

async function loadMetadata() {
  try {
    const raw = await fsp.readFile(METADATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.files)) return { files: [] };
    return data;
  } catch {
    return { files: [] };
  }
}

async function saveMetadata(meta) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = METADATA_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf8');
  await fsp.rename(tmp, METADATA_FILE); // 原子写入，避免写坏 JSON
}

// ---------------------------------------------------------------------------
// PCD 文件头解析（只读头部，不加载点数据，速度与文件大小无关）
// 头部规范：http://pointclouds.org/documentation/concepts/the-pcd-file-format.html
// ---------------------------------------------------------------------------

/**
 * @param {string} header
 * @returns {{points:number, width:number, height:number, fields:string[],
 *            dataType:'ascii'|'binary'|'binary_compressed', headerLength:number}|null}
 */
function parsePcdHeader(header) {
  // 魔数形如 "# .PCD v0.7 ..."，# 与 .PCD 之间可能有空格
  if (!/^#\s*\.PCD/.test(header)) return null;

  const lines = header.split(/\r?\n/);
  const get = (key) => {
    const line = lines.find((l) => l.startsWith(key + ' ') || l.startsWith(key + '\t'));
    return line ? line.slice(key.length).trim().split(/\s+/) : null;
  };

  const fields = get('FIELDS') || [];
  const width = parseInt((get('WIDTH') || ['0'])[0], 10);
  const height = parseInt((get('HEIGHT') || ['0'])[0], 10);
  const points = parseInt((get('POINTS') || ['0'])[0], 10) || width * height;
  const dataLine = lines.find((l) => l.startsWith('DATA '));
  const dataType = dataLine ? dataLine.slice(5).trim() : null;

  if (!['ascii', 'binary', 'binary_compressed'].includes(dataType)) return null;
  if (!Number.isFinite(points) || points <= 0) return null;

  // DATA 行之后的第一个字节即点数据起始位置
  const dataIdx = header.indexOf('DATA ');
  const lineEnd = header.indexOf('\n', dataIdx);

  return {
    points,
    width,
    height,
    fields,
    dataType,
    headerLength: lineEnd + 1,
  };
}

/** 只读取文件前 4KB，足以覆盖 PCD 头部 */
async function readPcdHeader(filePath) {
  const buf = Buffer.alloc(4096);
  const fd = await fsp.open(filePath, 'r');
  try {
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    return parsePcdHeader(buf.slice(0, bytesRead).toString('latin1'));
  } finally {
    await fd.close();
  }
}

// ---------------------------------------------------------------------------
// 目录初始化 & 示例文件自动导入
// ---------------------------------------------------------------------------

async function ensureDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(STORAGE_DIR, { recursive: true });
}

async function importSampleIfNeeded(meta) {
  const exists = await fs.promises
    .access(SAMPLE_PCD)
    .then(() => true)
    .catch(() => false);
  if (!exists) return;

  const already = meta.files.some(
    (f) => f.originalName === 'slam3d_map.pcd' && f.builtin === true,
  );
  if (already) return;

  const info = await readPcdHeader(SAMPLE_PCD);
  if (!info) {
    console.warn('[启动] slam3d_map.pcd 头部无法解析，跳过自动导入');
    return;
  }

  const stat = await fsp.stat(SAMPLE_PCD);
  const id = crypto.randomUUID();
  const storedName = `${id}.pcd`;
  await fsp.copyFile(SAMPLE_PCD, path.join(STORAGE_DIR, storedName));

  meta.files.push({
    id,
    originalName: 'slam3d_map.pcd',
    storedName,
    size: stat.size,
    points: info.points,
    fields: info.fields,
    dataType: info.dataType,
    builtin: true,
    uploadedAt: new Date().toISOString(),
  });
  await saveMetadata(meta);
  console.log(`[启动] 已自动导入示例文件 slam3d_map.pcd（${info.points.toLocaleString()} 点）`);
}

// ---------------------------------------------------------------------------
// Express 应用
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// 前端静态资源
app.use(express.static(PUBLIC_DIR));

// 把 node_modules 里的 three 暴露给浏览器（importmap 方式引用，无需打包工具）
app.use('/vendor/three', express.static(path.join(ROOT, 'node_modules', 'three')));

// 上传配置：仅接受 .pcd，落盘到 storage/
const upload = multer({
  dest: STORAGE_DIR,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.pcd')) {
      return cb(new Error('仅支持 .pcd 文件'));
    }
    cb(null, true);
  },
});

/** 列出所有 PCD 文件元数据 */
app.get('/api/files', async (_req, res, next) => {
  try {
    const meta = await loadMetadata();
    res.json(
      meta.files
        .slice()
        .sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1)),
    );
  } catch (err) {
    next(err);
  }
});

/** 上传新的 PCD 文件 */
app.post('/api/files', upload.single('pcd'), async (req, res, next) => {
  const tempPath = req.file && req.file.path;
  try {
    if (!req.file) return res.status(400).json({ error: '未收到上传文件（字段名应为 pcd）' });

    const info = await readPcdHeader(tempPath);
    if (!info) {
      await fsp.unlink(tempPath);
      return res.status(400).json({ error: '不是有效的 PCD 文件（无法识别 PCD v0.7 头部）' });
    }

    const meta = await loadMetadata();
    const id = crypto.randomUUID();
    const storedName = `${id}.pcd`;
    await fsp.rename(tempPath, path.join(STORAGE_DIR, storedName));

    const record = {
      id,
      originalName: req.file.originalname,
      storedName,
      size: req.file.size,
      points: info.points,
      fields: info.fields,
      dataType: info.dataType,
      builtin: false,
      uploadedAt: new Date().toISOString(),
    };
    meta.files.push(record);
    await saveMetadata(meta);
    res.status(201).json(record);
  } catch (err) {
    if (tempPath) await fsp.unlink(tempPath).catch(() => {});
    next(err);
  }
});

/** 下载原始 PCD 文件 */
app.get('/api/files/:id/download', async (req, res, next) => {
  try {
    const meta = await loadMetadata();
    const record = meta.files.find((f) => f.id === req.params.id);
    if (!record) return res.status(404).json({ error: '文件不存在' });

    const filePath = path.join(STORAGE_DIR, record.storedName);
    res.download(filePath, record.originalName);
  } catch (err) {
    next(err);
  }
});

/** 删除 PCD 文件及其元数据（内置示例文件同样允许删除） */
app.delete('/api/files/:id', async (req, res, next) => {
  try {
    const meta = await loadMetadata();
    const idx = meta.files.findIndex((f) => f.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '文件不存在' });

    const [record] = meta.files.splice(idx, 1);
    await fsp.unlink(path.join(STORAGE_DIR, record.storedName)).catch(() => {});
    await saveMetadata(meta);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// multer / 普通错误统一处理
app.use((err, _req, res, _next) => {
  console.error('[错误]', err.message);
  const status = err.message && err.message.includes('仅支持') ? 400 : 500;
  res.status(status).json({ error: err.message || '服务器内部错误' });
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

(async () => {
  await ensureDirs();
  const meta = await loadMetadata();
  await importSampleIfNeeded(meta);

  app.listen(PORT, () => {
    console.log('');
    console.log('  PCD 点云预览工具已启动');
    console.log(`  本地访问:  http://localhost:${PORT}`);
    console.log('');
  });
})();
