---
category: "自瞄拆解 · 视觉"
title: "视觉 01 —— 感知流水线总览"
publishDate: "2026-11-08"
description: "对应源码：`tasks/auto_aim/` 全目录、`src/standard.cpp` 本文是\"视觉\"文件夹的地图篇：先建立数据流、坐标系、核心数据结构的全局图，再进入各专题。"
tags: ["RoboMaster", "自瞄", "视觉算法"]
---
> 对应源码：`tasks/auto_aim/` 全目录、`src/standard.cpp`
> 本文是"视觉"文件夹的地图篇：先建立数据流、坐标系、核心数据结构的全局图，再进入各专题。

---

## 1. 一条帧的完整旅程

主入口 `src/standard.cpp:57-80` 的主循环定义了整条链路：

```cpp
camera.read(img, t);                       // ① 阻塞取图 + 主机时间戳
q = cboard.imu_at(t - 1ms);                // ② SLERP 插值出曝光时刻的云台姿态
mode = cboard.mode;                        //    电控模式（CAN 帧携带）
solver.set_R_gimbal2world(q);              // ③ 更新 云台系→世界系 旋转
ypr = tools::eulers(solver.R_gimbal2world(), 2, 1, 0);
auto armors = detector.detect(img);        // ④ YOLO（或传统）检测 → list<Armor>
auto targets = tracker.track(armors, t);   // ⑤ EKF 整车跟踪（内部调 solver.solve）
auto command = aimer.aim(targets, t, cboard.bullet_speed);  // ⑥ 弹道+选板+提前量
cboard.send(command);                      // ⑦ CAN 下发 yaw/pitch/开火
```

对象持有关系（谁包含谁）：

```
Detector ──内含──► Classifier          (detector.hpp:27，检测时直接 classify)
Tracker  ──引用──► Solver             (tracker.hpp:33，set/update 时调 solve 做 PnP)
Target   ──内含──► tools::ExtendedKalmanFilter   (target.hpp:55)
Aimer    ──只读──► Target             (ekf_x()、armor_xyza_list()、predict())
```

## 2. 坐标系与单位总约定

| 坐标系 | 定义 | 换算依据 |
|---|---|---|
| 图像系 | 像素，原点左上，x 右 y 下，单位 px | 全部检测代码 |
| 相机系 | OpenCV 约定：x 右、y 下、z 前，m | `solvePnP` 的 tvec（solver.cpp:59-61） |
| 云台系 | `xyz_gimbal = R_cam2gimbal·xyz_cam + t_cam2gimbal`，m | solver.cpp:61 |
| 世界系 | `xyz_world = R_gimbal2world·xyz_gimbal`，**重力对齐**（z 向上），m | solver.cpp:50-53,68 |
| 球坐标 ypd | `yaw=atan2(y,x), pitch=atan2(z,√(x²+y²)), d=\|xyz\|` | math_tools.cpp:100-106 |

- 所有角度为**弧度**；yaml 里的角度用 `/57.3` 手动转弧度（detector.cpp:19）。
- `tools::limit_rad` 把角度规范到 `(-π, π]`（math_tools.cpp:7-11）——EKF 角度卷绕的基础。
- 代码库中**没有** s2xyz/s2xyza 函数（上交命名习惯）；等价物是 `xyz2ypd/ypd2xyz` 与 `Target::armor_xyza_list()` 输出的 `{x,y,z,angle}` 四元组。

## 3. 核心数据结构：Lightbar 与 Armor

### 3.1 Lightbar（armor.hpp:67-78，armor.cpp:9-31）

| 字段 | 含义 |
|---|---|
| `id` | 本帧灯条编号（按轮廓出现顺序） |
| `color` | 轮廓内像素 R/B 均值判定（detector.cpp:279-289） |
| `center` | `minAreaRect` 中心 |
| `top`/`bottom` | 外接矩形 4 角点按 y 排序后，上两点均值 / 下两点均值 |
| `top2bottom` | `bottom - top`，指向图像下方 |
| `angle` | `atan2(top2bottom.y, top2bottom.x)`，竖直灯条 ≈ +π/2（图像 y 向下） |
| `angle_error` | `\|angle - π/2\|`，灯条竖直度 |
| `length`/`width` | 灯条长（px）/ 外接矩形短边 |
| `ratio` | `length/width`，真实灯条细长 |

### 3.2 Armor（armor.hpp:80-121）

| 字段 | 含义 | 单位 |
|---|---|---|
| `left`, `right` | 两根灯条 | — |
| `center` | **两灯条中点连线的中点，不是对角线交点**（armor.hpp:84 原注释强调，不能当实际中心） | px |
| `center_norm` | center/(w,h) 归一化，供决策 | 0~1 |
| `points[4]` | 顺序固定 `[left.top, right.top, right.bottom, left.bottom]` = tl,tr,br,bl，**PnP 输入** | px |
| `ratio` | 灯条中点连线长 / 较长灯条长 → 判大小装甲 | — |
| `side_ratio` | 长灯条/短灯条，应 ≈1 | — |
| `rectangular_error` | 灯条轴与中点连线夹角偏离 90° 的量（取左右较大者） | rad |
| `pattern` | 裁出的数字图案 | cv::Mat |
| `confidence` | 分类器 softmax 最大概率 | 0~1 |
| `xyz_in_gimbal/world` | 装甲板中心位置（Solver 填充） | m |
| `ypr_in_gimbal/world` | 装甲板朝向欧拉角（ZYX） | rad |
| `ypd_in_world` | 球坐标 | rad,rad,m |
| `yaw_raw` | yaw 优化前的原始 IPPE yaw（保留对比） | rad |

构造函数 5 个重载（armor.cpp:34-219）：传统双灯条版、NN class_id 版、NN+ROI 偏移版、YOLOV5 color/num id 版 ×2。NN 版几何量改由 4 关键点计算：`ratio = max(上下边)/max(左右边)`（armor.cpp:84），`center` 为 4 点均值。

### 3.3 枚举与查找表

- `Color {red, blue, extinguish, purple}`（armor.hpp:11-17）
- `ArmorType {big, small}`、`ArmorName {one..five, sentry, outpost, base, not_armor}`（9 类）
- `ArmorPriority {first=1...}`，**数字越小优先级越高**（tracker.cpp:60）
- `armor_properties` 表（armor.hpp:52-64）：`class_id → (Color, ArmorName, ArmorType)` 的 38 类映射（详见 yolo/02）

## 4. 两条检测路径如何共存

```
路径1 纯传统:  Detector::detect(img)    灰度→二值→轮廓→灯条→配对→Classifier
路径2 纯 NN:   YOLO.detect(img)         standard.cpp:44,73 直接使用
路径3 融合:    YOLOV5 + use_traditional:true
               NN 输出 4 关键点 → Detector::detect(Armor&, img) 在 ROI 内重找灯条精修角点
               (yolov5.cpp:184 → detector.cpp:122-231, 距离阈值 15px)
```

yaml 开关 `yolo_name` 选择 NN 模型，`use_traditional` 控制 YOLOV5 是否做传统二次矫正。

## 5. 后续环节的路标

| 环节 | 文件 | 拆解文档 |
|---|---|---|
| 灯条检测 | detector.cpp | [02-传统检测器](/posts/autoaim-02-traditional-detector) |
| 数字分类 | classifier.cpp | [03-数字分类器](/posts/autoaim-03-digit-classifier) |
| 跟踪状态机 | tracker.cpp | [04-跟踪器](/posts/autoaim-04-tracker-fsm) |
| 整车 EKF | target.cpp | [05-整车EKF模型](/posts/autoaim-05-target-ekf) |
| PnP + yaw 优化 | solver.cpp | [06-位姿解算](/posts/autoaim-06-solver-yaw) |
| 瞄准决策/开火 | aimer.cpp, shooter.cpp | [07-决策器与开火](/posts/autoaim-07-aimer-shooter) |
| MPC 规划 | planner/ | [08-TinyMPC规划器](/posts/autoaim-08-tinympc-planner) |
| 弹道 | tools/trajectory.cpp | [09-弹道模型](/posts/autoaim-09-ballistic-trajectory) |

