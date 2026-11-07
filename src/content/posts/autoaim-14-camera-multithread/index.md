---
category: "自瞄拆解 · 电控"
title: "电控 05 —— 相机驱动与多线程取流（io/camera + hikrobot + mindvision + usbcamera + recorder）"
publishDate: "2026-11-08"
description: "对应源码：`io/camera.cpp/hpp`、`io/hikrobot/`、`io/mindvision/`、`io/usbcamera/`、`tools/recorder.cpp` 核心设计：**工厂封装 +…"
tags: ["RoboMaster", "自瞄", "电控"]
---
> 对应源码：`io/camera.cpp/hpp`、`io/hikrobot/`、`io/mindvision/`、`io/usbcamera/`、`tools/recorder.cpp`
> 核心设计：**工厂封装 + 三线程架构 + 容量 1 的"单槽邮箱"队列 + USB 级自愈**。

---

## 1. 抽象层与工厂（io/camera.cpp:11-37）

```cpp
class CameraBase {  virtual void read(cv::Mat&, time_point&) = 0; };

// Camera = 配置驱动工厂
读 yaml: camera_name + exposure_ms
  mindvision → MindVision(exposure_ms, gamma, vid_pid)
  hikrobot   → HikRobot(exposure_ms, gain, vid_pid)
  其它       → 抛异常
```

`read()` 一行转发。注意 `io::USBCamera` 不在工厂里，是独立类（open_name 指定 /dev 节点），由多相机程序（哨兵）直接实例化。

## 2. HikRobot 海康驱动 —— 三线程架构

| 线程 | 位置 | 职责 |
|---|---|---|
| daemon_thread_ | hikrobot.cpp:17-35 | 每 100ms 检查 `capturing_`，发现取流线程死亡就执行 `capture_stop → reset_usb → capture_start` 完整自愈 |
| capture_thread_ | :98-155 | 1ms 轮询 + `MV_CC_GetImageBuffer(100ms 超时)`；失败 break 退出（`capturing_=false`）交 daemon 复活 |
| 消费者 | read() :45-52 | 阻塞 `queue_.pop(data)` |

**初始化参数链**（:79-92）：关自动白平衡/曝光/增益，写固定值：

```cpp
set_enum_value("ExposureAuto", OFF);  set_enum_value("GainAuto", OFF);
set_float_value("ExposureTime", exposure_ms × 1e3);   // us
set_float_value("Gain", gain_);
MV_CC_SetFrameRate(handle_, 150);                     // 目标帧率 150（硬编码，不随 yaml）
```

**像素处理**（:112-144）：时间戳取 GetImageBuffer 返回后立刻打点；SDK 缓冲包成 CV_8U（Bayer 8bit），ISP 转换不用 SDK 的 `MV_CC_ConvertPixelType`（被注释），改用 OpenCV `cvtColor` 按 `enPixelType` 查 GR/RG/GB/BG 映射表做 Bayer 去马赛克，深拷贝后才 FreeImageBuffer。

## 3. 丢帧策略：容量 1 的单槽邮箱（hikrobot.hpp:40）

```cpp
ThreadSafeQueue<CameraData> queue_(1);   // 模板参数 PopWhenFull=false
```

- false = **队列满时丢弃新帧、保留旧帧**（thread_safe_queue.hpp:26-33）；
- 容量 1 的效果："消费端没取走上一帧时新帧直接被丢"——主循环永远拿到**最新可得帧**，处理耗时导致的积压以丢帧消化，无需再判断帧龄。

## 4. USB 级自愈（hikrobot.cpp:208-244）

- `set_vid_pid("2bdf:0001")` 解析设备号；
- `reset_usb()`：libusb 打开设备 + `libusb_reset_device()`——工业相机 USB 掉线后无需重新上电的痛点解法。

## 5. MindVision / USBCamera（同构简述）

| | MindVision | USBCamera（V4L） |
|---|---|---|
| 线程架构 | daemon + capture 同构、queue_(1)、libusb reset | 同左，但连续打开失败 20 次后放弃 |
| API | CameraSetAeState(FALSE)、CameraSetExposureTime、CameraSetGamma；SDK `CameraImageProcess` 做 ISP，输出 BGR8 | `cap.open(name, CAP_V4L)`，MJPG fourcc、AUTO_EXPOSURE=1（手动）、GAMMA/GAIN |
| 特殊 | 预分配最大分辨率 CV_8UC3 目标缓冲 | 用 CAP_PROP_SHARPNESS 读数（2=left, 3=right）区分双 USB 相机；cap_mutex_ 保护直接读帧 |

## 6. Recorder：自瞄版 rosbag（tools/recorder.cpp）

`record(img, q, timestamp)` 三元组：

- **视频**：`cv::VideoWriter` MJPG，按构造 fps（默认 30）；
- **文本**：每帧一行 `"<相对起点秒> <w> <x> <y> <z>"`（注意 coeffs() 是 xyzw 序，代码取 `[3],[0],[1],[2]` 重排成 wxyz 落盘）；
- **降帧**：`since_last < 1/fps` 直接 return，不占主循环带宽；
- **懒初始化**：首帧才开文件并启动 saving_thread_；
- **优雅退出**：析构 push 一帧空 Mat 哨兵解除阻塞再 join——条件变量队列的退出范式。

用途：离线回放/拟合（配 calibration/split_video.cpp、各 *_test），实现"赛前问题排查、赛后问题重现"。

## 7. 配置参数（mvs.yaml:40-43 工业相机段）

```yaml
camera_name: "hikrobot"
exposure_ms: 2      # 强光下短曝光压住灯条周围
gain: 16
vid_pid: "2bdf:0001"
```

曝光是自瞄图像质量的第一旋钮：太长拖影、太短噪点——2ms 是这个 6mm 镜头组合的赛场实测值。

