# Voice Assistant - 语音助手

> 手机扫码替代 PC 麦克风和喇叭

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 安装虚拟音频设备（Windows）

下载安装 [VB-Audio Virtual Cable](https://vb-audio.com/Cable/)，安装后重启。

### 3. 启动服务

```bash
npm start
```

终端会显示二维码，用手机扫描即可。

### 4. 配置视频会议

在腾讯会议/Zoom/飞书中：
- **麦克风** 选择 `CABLE Input (VB-Audio Virtual Cable)`
- **扬声器** 选择 `CABLE Output (VB-Audio Virtual Cable)` （双向模式时）

## 架构

```
手机浏览器 ←WebSocket→ PC Node.js 服务 → 虚拟音频设备 → 视频会议软件
```

## 状态

- [x] 项目初始化
- [x] PC 服务 + 二维码
- [x] 手机端 H5 页面
- [ ] 手机麦克风 → PC（单向验证）
- [ ] PC → 手机喇叭（双向）
- [ ] 延迟优化（Opus 编码）
- [ ] 自动重连
