---
category: "自瞄拆解 · 视觉"
title: "视觉 06 —— 位姿解算 Solver：PnP、坐标系变换与 yaw 优化"
publishDate: "2026-11-08"
description: "对应源码：`tasks/auto_aim/solver.cpp` / `solver.hpp` 职责：把像素坐标的 4 个角点变成世界系下的装甲板位置和朝向——这是\"看到\"变\"打到\"的桥梁。"
tags: ["RoboMaster", "自瞄", "PnP"]
---
> 对应源码：`tasks/auto_aim/solver.cpp` / `solver.hpp`
> 职责：把像素坐标的 4 个角点变成世界系下的装甲板位置和朝向——这是"看到"变"打到"的桥梁。

---

## 1. 3D 点集定义（solver.cpp:12-25）

```cpp
LIGHTBAR_LENGTH   = 56e-3;    // 灯条高 56mm
BIG_ARMOR_WIDTH   = 230e-3;   // 大装甲板宽
SMALL_ARMOR_WIDTH = 135e-3;   // 小装甲板宽

// 装甲板坐标系：x = 法向(朝外), y = 右, z = 上
BIG_ARMOR_POINTS = { {0, +W/2, +L/2}, {0, -W/2, +L/2},
                     {0, -W/2, -L/2}, {0, +W/2, -L/2} };
```

4 点共面，对应 `armor.points` 的 tl, tr, br, bl 顺序。

## 2. PnP：IPPE 平面专用算法（solver.cpp:61-63）

```cpp
cv::solvePnP(object_points, armor.points, camera_matrix_, distort_coeffs_,
             rvec, tvec, false, cv::SOLVEPNP_IPPE);
```

- IPPE（Infinitesimal Plane-Based Pose Estimation）专为**共面 4 点**设计，内部对平面目标返回两个解并按重投影误差取优，比通用迭代法快且稳；
- 内参/畸变来自 yaml（mvs.yaml 标注重投影误差 0.1322 px，fx≈1776.9）。

## 3. 坐标系变换链（solver.cpp:65-79）

```
xyz_gimbal = R_camera2gimbal · xyz_camera + t_camera2gimbal     // 手眼外参
xyz_world  = R_gimbal2world · xyz_gimbal                        // 仅旋转，云台原点=世界原点
R_armor2world = R_gimbal2world · R_camera2gimbal · R_armor2camera
ypr = tools::eulers(R_armor2world, 2, 1, 0)                     // 内旋 ZYX: yaw,pitch,roll
ypd = xyz2ypd(xyz_world)                                        // 球坐标
```

**R_gimbal2world 的构造**（:48-52）——一个相似变换：

```cpp
void Solver::set_R_gimbal2world(const Eigen::Quaterniond & q) {
  Eigen::Matrix3d R_imubody2imuabs = q.toRotationMatrix();
  R_gimbal2world_ = R_gimbal2imubody_.transpose() * R_imubody2imuabs * R_gimbal2imubody_;
}
```

`R_gimbal2imubody` 是云台机械系到 IMU 安装系的**固定**旋转（yaml 标定：mvs 为单位阵；demo 为 diag(−1,−1,1) 即 IMU 倒装）。共轭形式把 IMU 输出姿态重表达到"云台零位时与云台系重合"的世界系，**一次性补偿 IMU 安装角偏差**。每帧由主循环用 `imu_at(t−1ms)` 插值出的四元数更新。

## 4. yaw 优化：1° 网格暴力重投影搜索（:196-218）

IPPE 对小尺寸/远距离装甲板的法向（yaw）噪声大，用几何先验重搜：

```cpp
constexpr double SEARCH_RANGE = 140;                       // 度
yaw0 = limit_rad(云台当前yaw − 70°);
for (i = 0; i < 140; i++) {
  yaw = limit_rad(yaw0 + i·1°);
  error = armor_reprojection_error(armor, yaw, (i−70)·1°); // 4 点投回像素系的 L2 距离和
  取误差最小者为 best_yaw;
}
armor.yaw_raw = armor.ypr_in_world[0];    // 保留原始 IPPE yaw 供对比
armor.ypr_in_world[0] = best_yaw;
```

重投影时的**俯仰先验硬编码**（reproject_armor :90-127）：

```cpp
pitch = (name == outpost) ? −15° : +15°;   // 普通装甲板上仰15°，前哨站下俯15°
```

配套细节：

- **平衡步兵跳过 yaw 优化**（:81-85）——平衡车装甲板倾角不是 15°，先验不成立；
- `SJTU_cost`（:220-252，上交开源的边长差+角度差加权代价）存在但调用处被注释，**未启用**；
- `oupost_reprojection_error(armor, pitch)`（:129-194）：对给定 pitch 重解 PnP 返回误差，供 tracker 对前哨站做俯仰假设检验。

## 5. 外参从哪来（yaml）

| 项 | mvs.yaml | 含义 |
|---|---|---|
| `R_camera2gimbal` | [0,0,1, −1,0,0, 0,−1,0] | 理想正交：相机 z前 → 云台 x前 |
| `t_camera2gimbal` | [0.1, 0, 0.05] m | 相机在云台原点前方 10cm、上方 5cm |
| `R_gimbal2imubody` | 单位阵 | IMU 与云台无安装旋转 |

demo.yaml 则是**手眼标定实测**的满阵（含 yaw 0.46°/pitch 0.61°/roll −1.53° 安装偏角）与 `t=[0.095,0.095,0.051]`——理想阵与实测阵的差距就是标定流程的价值。标定程序见 [../opencv/02-PnP解算与标定.md](/posts/autoaim-17-pnp-calibration)。

## 6. 没有的东西

- **无自适应 angle-offset**：`yaw_offset_/pitch_offset_` 是 yaml 固定值；Aimer 的 left/right_yaw_offset_ 只是哨兵双枪管的模式切换静态偏置。
- **无在线手眼自标定**：外参全部离线标定写死 yaml。

## 7. 函数速查

| 函数 | 位置 | 作用 |
|---|---|---|
| `solve(armor)` | cpp:55-88 | PnP(IPPE) → 变换链 → yaw 优化 → 填充 armor |
| `set_R_gimbal2world(q)` | cpp:48-52 | 每帧更新世界系旋转 |
| `reproject_armor` | cpp:90-127 | 按 yaw(+15°俯仰先验) 投 4 点 |
| `oupost_reprojection_error` | cpp:129-194 | 前哨站俯仰假设检验 |
| `optimize_yaw` | cpp:196-218 | 140°/1° 网格搜索 |
| `SJTU_cost` | cpp:220-252 | 上交代价函数（未启用） |
| `world2pixel` | cpp:266-292 | 调试可视化用 |

