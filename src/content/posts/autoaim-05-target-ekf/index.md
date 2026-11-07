---
category: "自瞄拆解 · 视觉"
title: "视觉 05 —— 整车 EKF 目标模型（Target，全项目算法核心）"
publishDate: "2026-11-08"
description: "对应源码：`tasks/auto_aim/target.cpp` / `target.hpp`、`tools/extended_kalman_filter.cpp` 思路一句话：不跟踪单块装甲板，而是把敌方整车建模为…"
tags: ["RoboMaster", "自瞄", "EKF"]
---
> 对应源码：`tasks/auto_aim/target.cpp` / `target.hpp`、`tools/extended_kalman_filter.cpp`
> 思路一句话：不跟踪单块装甲板，而是把敌方整车建模为 **"旋转中心 + 转速 + 装甲板几何"**，用 11 维 EKF 同时估计位置、速度、朝向相位、角速度和几何参数。

---

## 1. 状态向量（11 维，target.cpp:34-39）

```
x = [ x, vx,  y, vy,  z, vz,  a,  w,  r,  l,  h ]
      └─旋转中心位置/速度─┘   └相位┘└转速┘  └─装甲板几何─┘
```

| 下标 | 符号 | 含义 | 单位 |
|---|---|---|---|
| 0,1 | x, vx | 旋转中心世界系 x 位置/速度 | m, m/s |
| 2,3 | y, vy | 旋转中心世界系 y 位置/速度 | m, m/s |
| 4,5 | z, vz | 旋转中心世界系 z 位置/速度 | m, m/s |
| 6 | a | 整车 yaw 相位角 | rad（limit_rad 到 (-π,π]） |
| 7 | w | 角速度 vyaw | rad/s |
| 8 | r | 第一组装甲板旋转半径 | m |
| 9 | l | r2 − r1（长短轴差，仅 4 板车） | m |
| 10 | h | z2 − z1（对侧装甲板高度差） | m |

**初始化**（target.cpp:29-32）：由首帧装甲板反推旋转中心——

```cpp
center_x = xyz[0] + r * cos(ypr[0]);
center_y = xyz[1] + r * sin(ypr[0]);   // 装甲板 yaw 方向指向"从装甲板指向旋转中心"
center_z = xyz[2];
```

与观测方程 `armor = center − r·(cos a, sin a)`（:273-274）自洽。

## 2. 转移方程：匀速 + 匀角速度（predict，target.cpp:75-136）

11×11 常系数 F：x/y/z 三对 (位置,速度) 用 `[1 dt; 0 1]` 块；(a, w) 同样；**r、l、h 视为随机游走**。

过程噪声 Q 用 **Piecewise White Noise Model**（注释指向 rlabbe 教材）：`a=dt⁴/4, b=dt³/2, c=dt²`，

| 车型 | v1（加速度方差） | v2（角加速度方差） |
|---|---|---|
| 普通车 | 100 | 400 |
| 前哨站 | 10 | 0.1 |

**前哨站转速特判**（:131-133）：收敛后若 `|w| > 2`，直接钳到 ±2.51 rad/s——前哨站固定 2.5s/圈（2π/2.5≈2.513），硬编码先验。

角度卷绕三处齐全：`f` 对 `x_prior[6]` limit_rad（:125-129）、EKF `x_add`（:43-47）、残差 `z_subtract`（:210-216）。**漏掉任何一处都会在 ±π 附近发散**——EKF 角度状态的标准坑。

## 3. 观测更新（update，target.cpp:138-185）

### 3.1 装甲板匹配

1. `armor_xyza_list()` 生成模型预测的全部 N 块装甲板 `{xyz, angle}`；
2. 按观测距离升序，取**最近 3 块**参与匹配（:150-158）；
3. 匹配代价（:160-168）：

```cpp
angle_error = |limit_rad(armor.ypr_in_world[0] − xyza[3])|   // 朝向差
            + |limit_rad(armor.ypd_in_world[0] − ypd[0])|;   // 方位角差
```

   朝向差 + 方位差之和最小者胜出，得观测对应的装甲板编号 id。
4. 簿记：`jumped = (id != 0)`（供 Aimer 判断多板已知）；`is_switch_ = (id != last_id)`。

### 3.2 观测方程（4 维：球坐标 + 朝向，update_ypda :187-223）

```cpp
z = { ypd[0], ypd[1], ypd[2], ypr[0] };    // yaw, pitch, distance, armor_yaw（世界系）

h(x):  xyz = h_armor_xyz(x, id);           // 模型装甲板位置
       ypd = xyz2ypd(xyz);
       angle = limit_rad(x[6] + id·2π/armor_num_);
```

**装甲板几何（长短轴切换）**（h_armor_xyz :267-278）：

```cpp
angle = limit_rad(x[6] + id·2π/N);
use_l_h = (N==4) && (id==1 || id==3);      // 与 0 号相隔 90°/270° 的那对
r = use_l_h ? x[8]+x[9] : x[8];
armor_x = x[0] − r·cos(angle);  armor_y = x[2] − r·sin(angle);
armor_z = use_l_h ? x[4]+x[10] : x[4];
```

这就是 25 赛季流行的**"长短轴全姿态模型"**：普通 4 板车两组对边半径不同、高度不同，用 l、h 两个状态量在线估计其差值。

### 3.3 自适应测量噪声 R（:191-199）

```cpp
delta_angle = limit_rad(armor.ypr_in_world[0] − atan2(y_world, x_world));
R = diag( 4e-3,                    // yaw     σ≈0.063 rad
          4e-3,                    // pitch
          log(|Δangle|+1)+1,       // distance: 装甲板越侧对，PnP 深度越不可信
          log(d+1)/200 + 0.09 );   // armor_yaw: 随距离缓慢放大
```

本质是对 **PnP 深度不可信性**的建模：侧对角 →π/2 时 distance 噪声 σ≈1.2 m。

### 3.4 雅可比（h_jacobian :280-317）

链式两段相乘：

```
H_armor_xyza (4×11)：装甲板 xyz+angle 对 11 维状态的解析偏导
   dx/da = r·sin(angle),  dx/dr = −cos(angle),  dx/dl = −cos·use_l_h
   dz/dh = use_l_h,       da/da = 1 …
H_armor_ypda (4×4)：xyz2ypd_jacobian 拼成的分块矩阵（math_tools.cpp:110-127）
H = H_armor_ypda · H_armor_xyza
```

## 4. 收敛与发散判据

| 判据 | 条件 | 用途 |
|---|---|---|
| `diverged()`（:241-250） | r 或 r+l 超出 (0.05, 0.5) m | 半径不合理 → 模型崩坏 → tracker 强制 lost |
| `convergened()`（:252-264） | 普通车 update_count>3；前哨站 >10 | 允许全向感知换目标；启用前哨转速钳位 |

## 5. 通用 EKF（tools/extended_kalman_filter.cpp）

- 接口：`x/P` 公开；三个可注入函数 `x_add`（角度加法卷绕）、`f`（非线性转移）、`h`/`z_subtract`。
- `predict`：`P = FPFᵀ + Q; x = f(x)`（:28-35）。
- `update`（:44-91）：

```cpp
K = P·Hᵀ·(H·P·Hᵀ + R)⁻¹;
P = (I−KH)·P·(I−KH)ᵀ + K·R·Kᵀ;      // Joseph 形式，保证 P 对称半正定
x = x_add(x, K·z_subtract(z, h(x)));
```

- **内嵌一致性监控**（:58-89）：每次更新算 NIS 与 NEES，滑窗 100 次失败率暴露给上层（tracker 的 40% 判据）与日志面板。

## 6. voter.hpp 说明

`auto_aim/voter.cpp` 是个 72 桶（4色×9名×2型）三维直方图计数器，设计意图是跨帧投票确认敌方兵种构成——但**全仓库无调用点**，属预留/半退役组件；真正在跑的投票逻辑在 `auto_buff/buff_target.cpp:7-18`（用相邻帧角度差投票判断符旋转方向）。

## 7. 值得抄走的工程细节

1. 同帧多观测循环 update（一次 predict 多次 update）；
2. R 自适应建模 PnP 深度不可信；
3. 前哨站"半径当常量 + 转速钳位 + 丢失上限放宽"三重特化；
4. EKF 角度状态必须三处卷绕（x_add / f / z_subtract）；
5. Joseph 协方差更新比 `(I−KH)P` 普通形式更稳；
6. NIS 阈值 + 失败率滑窗 = 松弛版模型失配报警。

