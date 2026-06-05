# ReplayManager — B 站直播录播自动下载工具

![Status](https://img.shields.io/badge/Status-Active-brightgreen) ![UI](https://img.shields.io/badge/UI-React_Vite-blue) ![Runtime](https://img.shields.io/badge/Runtime-Electron_+_Node.js-cyan)

基于 Electron + Node.js/TypeScript 构建的桌面应用，用于自动监听和下载 B 站指定直播间的录播回放。纯 JS 技术栈，零外部二进制依赖。

## 技术栈

- **桌面壳**：Electron — 跨平台桌面窗口，内嵌 React 前端
- **后端**：Node.js / Express — 本地 HTTP API + SQLite 数据持久化
- **前端**：React 18 + Vite + TailwindCSS + i18n 国际化
- **下载引擎**：纯 JS 流式下载 + TS 流拼接 + mp4-muxer 无损重封装为 MP4
- **无外部依赖**：不需要安装 Go、FFmpeg 或任何其他工具，解压即用

## 核心功能

- **后台扫描**：定时轮询 B 站 API，发现新录播自动入库，已有记录保留不动
- **任务队列**：支持单任务下载 / 一键批量下载，可暂停、恢复、取消
- **断点续传**：分片下载带 `.tmp` 追踪，重启后自动跳过已完成片段
- **自动重试**：网络异常自动退避重试，多次失败降级为 `failed` 状态
- **封面下载**：自动拉取直播间封面保存到本地
- **磁盘感知**：实时统计输出目录空间占用

## 快速开始

### 开发者运行

```bash
# 安装依赖
npm install
npm --prefix frontend install

# 开发构建
npm run build

# 启动应用
npm start
```

### 打包发布

```bash
.\build_release.ps1
```

产物在 `release/ReplayManager-Windows-Portable.zip`。

### 用户使用

1. 解压便携包，双击 `ReplayManager.exe`
2. 首次使用需在设置页配置 B 站 Cookie 和目标主播 ID
3. 点击「扫描」拉取最近录播列表
4. 选择需要下载的录播，点击下载按钮

## 配置

配置文件 `config.yaml`（首次运行自动生成默认模板）：

```yaml
bilibili:
  anchor_id: 0          # 主播 UID
  cookies: {}            # 登录 Cookie（通过浏览器获取）
  cookie_file: cookies.json

download:
  output_dir: downloads  # 下载输出目录
  max_concurrent_tasks: 2
  concurrent_segments: 5

database:
  dsn: replays.db
```

## 项目结构

```
├── electron/
│   └── src/
│       ├── main.ts      # Electron 主进程，窗口管理
│       ├── preload.ts   # 预加载脚本，桥接前后端
│       └── backend.ts   # 后端 API、下载引擎、数据库
├── frontend/
│   └── src/
│       ├── App.tsx      # React 主组件
│       ├── components/  # UI 组件
│       └── locales/     # i18n 多语言
├── build_release.ps1    # 发布打包脚本
├── package.json
└── config.yaml          # 用户配置
```
