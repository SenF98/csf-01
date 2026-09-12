# PCD 点云预览工具

基于 **Three.js + Node.js (Express)** 的三维点云（.pcd）预览与文件管理工具。
无需数据库，文件元数据以 JSON 文件存储。

## 功能

- **PCD 文件管理**：上传（点击 / 拖拽）、列表、下载、删除；元数据存于 `data/metadata.json`，文件本体存于 `storage/`
- **格式支持**：PCD v0.7 的 ascii / binary / binary_compressed，字段通用解析（xyz / rgb / intensity / label 等）
- **三维交互**：鼠标左键旋转、右键（或中键）平移、滚轮缩放，带阻尼；一键重置视角
- **点大小调节**：滑块实时调节（0.5–10 px，像素尺寸不随缩放变化）
- **两种着色模式**，可随时切换：
  - **单色**：颜色可通过取色器自定义
  - **高度渐变**：按 Z 轴高度映射 紫→蓝→绿→黄→红，带高度图例
- 自动适应点云包围盒取景，附带地面参考网格与坐标轴
- 首次启动自动导入项目根目录下的 `slam3d_map.pcd` 作为示例

## 快速开始

```bash
npm install
npm start
```

浏览器打开 http://localhost:3000 （端口可用环境变量 `PORT` 修改）

## 目录结构

```
├── server.js              # Express 后端：REST API + PCD 头解析 + JSON 存储
├── public/
│   ├── index.html         # 前端页面
│   ├── app.js             # Three.js 场景、PCDLoader、交互与文件管理逻辑
│   └── style.css          # 样式
├── data/
│   └── metadata.json      # 文件元数据（自动生成，相当于"数据库"）
├── storage/               # 上传的 PCD 文件本体（自动生成）
└── slam3d_map.pcd         # 示例点云（首次启动自动导入，可在页面中删除）
```

## API

| 方法   | 路径                          | 说明                             |
| ------ | ----------------------------- | -------------------------------- |
| GET    | `/api/files`                  | 获取全部 PCD 文件元数据列表      |
| POST   | `/api/files`                  | 上传 PCD（multipart 字段 `pcd`） |
| GET    | `/api/files/:id/download`     | 下载原始 PCD 文件                |
| DELETE | `/api/files/:id`              | 删除文件及其元数据               |

元数据记录示例：

```json
{
  "id": "uuid",
  "originalName": "slam3d_map.pcd",
  "storedName": "uuid.pcd",
  "size": 11078154,
  "points": 923165,
  "fields": ["x", "y", "z"],
  "dataType": "binary",
  "builtin": true,
  "uploadedAt": "2026-09-12T08:44:47.453Z"
}
```

## 操作说明

| 操作       | 鼠标          |
| ---------- | ------------- |
| 旋转视角   | 左键拖拽      |
| 平移视角   | 右键拖拽      |
| 缩放       | 滚轮          |
| 重置视角   | 左侧「重置视角」按钮 |
