---
category: "自瞄拆解 · 总索引"
title: "机甲大师步兵自瞄拆解 —— 基于同济 SuperPower sp_vision_25"
publishDate: "2026-11-08"
description: "源项目：`sp_vision_25`（同济大学 SuperPower 战队 25 赛季自瞄算法开源） 本文件夹是对该项目的**逐模块代码拆解文档**，全部结论均标注了源码 `文件:行号`，可对照阅读。"
tags: ["RoboMaster", "自瞄", "开源拆解"]
---
> 源项目：`sp_vision_25`（同济大学 SuperPower 战队 25 赛季自瞄算法开源）
> 本文件夹是对该项目的**逐模块代码拆解文档**，全部结论均标注了源码 `文件:行号`，可对照阅读。

---

## 一、项目是什么

针对 RoboMaster 步兵的**自动瞄准 + 自动火控**软件：操作手切换自瞄模式后，视觉程序接管云台，对敌方装甲板做识别 → 跟踪 → 预测 → 弹道解算 → 轨迹规划，最终通过 CAN/串口下发控制量并决定开火时机。

- **运行平台**：NUC12（i7-1260P）+ 海康 MV-CS016-10UC 工业相机（6mm 镜头）+ RM 开发板 C 型（STM32F407，内置 BMI088）
- **技术栈**：C++17 / CMake、OpenCV、OpenVINO 2024（YOLO 推理）、Eigen、Ceres、spdlog、yaml-cpp、SocketCAN、（可选）ROS2
- **实测成绩**：国赛 3/4 号步兵命中率最高 39.6%（正常 ≥30%）；2m 处 300HP、7 rad/s 陀螺约 8s 击杀，14 rad/s 约 10s
- **核心创新**："自瞄轨迹规划算法"（TinyMPC），云台跟随稳态误差 <0.01 rad，装甲板切换可提前减速

## 二、文件夹导航

| 文件夹 | 内容 |
|---|---|
| [视觉/](/posts/autoaim-01-perception-pipeline) | 自瞄算法全链路：检测 → 分类 → 跟踪 → EKF → 解算 → 决策 → MPC → 弹道（9 篇） |
| [电控/](/posts/autoaim-10-comm-overview) | 视觉-下位机通信（CAN/串口）、IMU、相机驱动、多线程工具链（6 篇） |
| [opencv/](/posts/autoaim-16-cv-classic-algorithms) | 传统视觉算法、PnP 解算与标定、cv:: API 使用清单（3 篇） |
| [yolo/](/posts/autoaim-19-yolo-module) | YOLO 模块接口、三模型后处理对比、OpenVINO 部署与异步推理（3 篇） |
| [ros/](/posts/autoaim-22-ros2-interfaces) | ROS2 与导航的通信接口（哨兵专用，1 篇） |

建议阅读顺序：本 README → `视觉/01-感知流水线总览` → 按需深入各篇。

## 三、整体架构与数据流

### 3.1 标准步兵主循环（src/standard.cpp:57-80）

```
┌─────────────── 感知 ───────────────┐   ┌──── 估计 ────┐   ┌──── 决策 ────┐   ┌── 执行 ──┐
│                                    │   │              │   │              │   │          │
io::Camera.read(img, t)               │   │              │   │              │   │          │
        │ 图像 + 时间戳 t              │   │              │   │              │   │          │
        ▼                            │   │              │   │              │   │          │
q = cboard.imu_at(t - 1ms) ───────────┼──►│ Solver       │──►│ Tracker      │──►│ Aimer    │──►│ CBoard.send(command)
        │ SLERP 插值四元数             │   │ set_R_gimbal2world(q) │ (内部调 Solver.solve 做 PnP) │ (弹道+选板+提前量) │   │ CAN 下发   │
        ▼                            │   │              │   │              │   │ Shooter  │   │          │
armors = YOLO.detect(img)            │   │              │   │              │   │ (开火判据) │   │          │
```

每帧串行完成：取图 → 姿态对齐 → 更新云台→世界旋转 → 检测 → 跟踪 → 决策 → 发送。

### 3.2 两条并行的"瞄准-开火"管线（重要！）

| | 管线 A：解析弹道 + 位置环 | 管线 B：MPC 轨迹规划 + 状态环 |
|---|---|---|
| 决策器 | `Aimer`（解析抛物线 + fly_time 不动点迭代） | `Planner`（TinyMPC ADMM） |
| 开火 | `Shooter`（5 条判据） | `plan.fire`（fire_thresh 判据） |
| 下发 | `Command{control, shoot, yaw, pitch}` 经 **CAN**（CBoard） | `Plan{yaw, yaw_vel, yaw_acc, pitch, pitch_vel, pitch_acc}` 经**串口**（Gimbal，带前馈） |
| 入口 | `standard.cpp`、`mt_standard.cpp` | `standard_mpc.cpp`、`auto_aim_debug_mpc.cpp`、打符 `buff_aimer.mpc_aim` |
| 耦合关系 | **Aimer 与 Planner 无任何代码耦合** | 共用同一感知前端与 yaml 偏置参数 |

### 3.3 多线程版（src/mt_standard.cpp）线程划分

| 线程 | 职责 | 衔接方式 |
|---|---|---|
| detect_thread | 取图 → `MultiThreadDetector.push`（OpenVINO `start_async`） | 容量 16 的 `ThreadSafeQueue`（满则丢新帧） |
| 主线程 | `debug_pop` → wait 推理 → 后处理 → EKF 跟踪 → push 决策 | 同上队列 |
| CommandGener 决策线程（≈500Hz） | 取最新目标 → Aimer + Shooter → CAN 发送 | **最新值信箱**（0.2s 新鲜度，覆盖式） |
| CAN 回调线程 | 收四元数/弹速 | 5000 深队列 + SLERP |
| 保存线程（Recorder） | 落盘 视频+四元数文本 | 容量 1 队列 + 空帧哨兵退出 |

### 3.4 坐标系约定（全项目统一）

```
图像系(px, 左上原点) ──solvePnP──► 相机系(x右,y下,z前, m)
      ──R_camera2gimbal(手眼外参)──► 云台系(x前,y左,z上, m)
      ──R_gimbal2world(IMU四元数)──► 世界系(重力对齐: z向上, m)
      ──xyz2ypd──► 球坐标 (yaw, pitch, distance)
```

`R_gimbal2world = R_gimbal2imubodyᵀ · R_imubody2imuabs · R_gimbal2imubody`（相似变换，一次补偿 IMU 安装角）。

## 四、关键参数速查（configs/mvs.yaml，standard4 同构）

| 参数 | 值 | 位置 |
|---|---|---|
| enemy_color | blue（人工配置，不来自下位机） | mvs.yaml:2 |
| yolo_name / device | yolov5 / GPU（OpenVINO） | mvs.yaml:5,11 |
| 传统检测 threshold | 150（灰度二值化） | mvs.yaml:46 |
| min_confidence | 0.8 | mvs.yaml:55 |
| tracker: min_detect / temp_lost / outpost_lost | 5 / 15 / 75 帧 | mvs.yaml:64-66 |
| aimer: yaw/pitch_offset | -2.5° / 0° | mvs.yaml:69-70 |
| aimer: comming/leaving_angle | 70° / 30° | mvs.yaml:71-72 |
| aimer: high/low_speed_delay_time | 0.066 / 0.015 s | mvs.yaml:74-75 |
| shooter: 近/远容差 | 3°（<2m）/ 2° | mvs.yaml:78-80 |
| planner: fire_thresh / max_acc | 0.003 rad / 50·100 rad/s² | demo.yaml:83,85,89 |
| 相机内参 fx≈1776.95（重投影误差 0.1322px） | | mvs.yaml:89 |
| CAN ID：四元数/弹速/发送 | 0x01(或0x100) / 0x110(或0x101) / 0xff | mvs.yaml:58-60 |

## 五、阅读时的三个"避坑提示"（拆解中发现的疑点）

1. **两套颜色 id 顺序不一致**：`Color{red=0, blue=1}`（armor.hpp:11）vs YOLOV5 构造 `color_id==0 → blue`（armor.cpp:175）——混淆会直接瞄错阵营。
2. **aimer.cpp:163 疑似状态位误用**：`|ekf_x[8]| <= 2` 中 x[8] 是旋转半径 r（恒 ≤2），按注释本意应是 x[7]（vyaw）。后果：非前哨站目标无论转速都走"正对板+锁定"分支，小陀螺 coming/leaving 窗口实际只对前哨站生效。
3. **EKF 卡方阈值 0.711 是 χ²(4) 的 5% 下分位**（非 95% 上分位 9.488），配合"失败率 ≥40% 才触发"成对使用，属激进一致性报警，不能单独照抄（tools/extended_kalman_filter.cpp:58-89）。

---
*全部 22 篇拆解文档基于源码逐文件阅读整理，行号对应 `sp_vision_25` 原始仓库。*

