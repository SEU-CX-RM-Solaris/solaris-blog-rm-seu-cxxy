---
category: "自瞄拆解 · OpenCV"
title: "OpenCV 02 —— PnP 解算、重投影与相机标定"
publishDate: "2026-11-08"
description: "对应源码：`tasks/auto_aim/solver.cpp`、`calibration/`（标定工具）、`tests/handeye_test.cpp` 一句话：**4 个共面像素点 + 内参 + 畸变 + 官方…"
tags: ["OpenCV", "PnP", "标定"]
---
> 对应源码：`tasks/auto_aim/solver.cpp`、`calibration/`（标定工具）、`tests/handeye_test.cpp`
> 一句话：**4 个共面像素点 + 内参 + 畸变 + 官方 3D 尺寸 → 装甲板在世界系中的 6DoF 位姿**。

---

## 1. solvePnP 的三个关键选择（solver.cpp:61-63）

```cpp
cv::solvePnP(object_points,        // BIG/SMALL_ARMOR_POINTS：官方尺寸 3D 点
             armor.points,         // 检测出的 4 像素角点（tl,tr,br,bl）
             camera_matrix_, distort_coeffs_,
             rvec, tvec, false,
             cv::SOLVEPNP_IPPE);   // ★ 平面目标专用解析解
```

1. **IPPE**（Infinitesimal Plane-Based Pose Estimation）：专为共面 4 点设计，内部返回两个解按重投影误差取优，比通用迭代法（SOLVEPNP_ITERATIVE）快且对小目标更稳；
2. **3D 点用真实物理尺寸**（灯条 56mm、大装甲 230mm / 小装甲 135mm），tvec 直接是米制距离；
3. **3D 坐标系约定**：x = 装甲板法向（朝外）、y 右、z 上——所以 rvec 转出的 R_armor2camera 第一列方向就是装甲板朝向。

## 2. Rodrigues 与欧拉角（solver.cpp:71,119,146,183 + math_tools）

```
rvec ──cv::Rodrigues──► R_armor2camera (3×3)
R_armor2world = R_gimbal2world · R_camera2gimbal · R_armor2camera
tools::eulers(R, 2, 1, 0)   →  (yaw, pitch, roll)   内旋 Z-Y-X
tools::xyz2ypd(xyz)         →  (方位角, 俯仰角, 距离)
```

## 3. 重投影误差：既是标定指标也是运行时工具（cv::projectPoints）

| 用途 | 位置 | 说明 |
|---|---|---|
| 内参标定质量 | yaml 注释（0.1322 px） | 标定程序输出 |
| yaw 优化目标函数 | solver.cpp:254-263 | 把 4 个 3D 点按候选 yaw 投回像素，误差和最小者胜 |
| 前哨站俯仰检验 | :129-194 | 对给定 pitch 重解 PnP 再投影 |
| debug 画框 | reproject_armor / world2pixel | 可视化对齐质量 |

`world2pixel`（:266-292）内含 z>0 剔除——投影到相机背后的点无意义。

## 4. 标定体系（三层外参 + 一层内参）

```
内参 camera_matrix + distort_coeffs      ← 棋盘格标定（calibration/，pattern 10×7 内角点、40mm 间距）
        │
R_camera2gimbal + t_camera2gimbal        ← 手眼标定（相机装在云台上：eye-in-hand）
        │
R_gimbal2imubody                         ← IMU 安装角（多数车单位阵，demo 为 diag(−1,−1,1) 倒装）
        │
运行时 R_gimbal2world = R_g2ibᵀ · R_imubody2imuabs(q) · R_g2ib   ← 每帧由四元数更新
```

- `calibration.yaml`：标定采集专用配置——相机曝光略长（3ms，静态场景）、CAN 四元数照常接收（handeye/robot-world 标定需要姿态流打标签）；
- `tests/handeye_test.cpp`：手眼标定验证程序；
- mvs.yaml 用**理想正交阵** `R_camera2gimbal=[0,0,1, −1,0,0, 0,−1,0]`，demo.yaml 用**实测满阵**（含 0.46°/0.61°/−1.53° 安装偏角）——理想阵假设相机装得完美，实测阵把安装误差标出来，两者解算精度差异体现在远距离 yaw 偏移上。

## 5. 内参实测值（mvs.yaml:89-92）

```yaml
camera_matrix: [1776.95, 0, 756.31,
                0, 1776.06, 566.17,
                0, 0, 1]              # 重投影误差 0.1322px
distort_coeffs: [-0.0838, 0.0974, -0.00126, 0.00374, 0]   # k1 k2 p1 p2 k3
```

fx≈fy≈1777 对应海康 6mm 镜头 + 1440×1080 分辨率；k3=0（普通 6mm 镜头畸变小，5 参数足够）。

## 6. yaw 优化的本质：把 PnP 当"初值"，用先验重搜

IPPE 输出的 yaw 对小/远目标噪声大。solver 不信它，而是：

```
以云台 yaw 为中心 ±70°、1° 步长网格搜索
每个候选 yaw → 用 ±15° 俯仰先验构造 R_armor2world → projectPoints → 4 点误差和
取最小误差的 yaw 覆盖 armor.ypr_in_world[0]
```

俯仰先验硬编码：普通装甲板 **+15°** 上仰、前哨站 **−15°** 下俯；平衡步兵倾角不满足先验 → 跳过优化（solver.cpp:81-85）。

## 7. 相关测试程序

| 测试 | 验证内容 |
|---|---|
| tests/handeye_test.cpp | 手眼外参 |
| tests/gimbal_response_test.cpp | 姿态对齐后云台响应 |
| tests/detector_video_test.cpp | 离线视频上检测+解算 |
| calibration/split_video.cpp | 录制回放切帧 |

