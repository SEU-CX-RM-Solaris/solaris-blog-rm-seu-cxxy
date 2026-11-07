---
category: "自瞄拆解 · 学习笔记"
title: "学习笔记 02 —— 数学基础：坐标系、旋转矩阵与四元数"
publishDate: "2026-11-08"
description: "自瞄的一半数学都在这：**把\"像素里的敌人\"换算成\"世界里的方位\"**。 先修：会矩阵乘法即可。先看 3Blue1Brown《线性代数的本质》第 3 集（线性变换与矩阵）。"
tags: ["数学", "坐标系"]
---
> 自瞄的一半数学都在这：**把"像素里的敌人"换算成"世界里的方位"**。
> 先修：会矩阵乘法即可。先看 3Blue1Brown《线性代数的本质》第 3 集（线性变换与矩阵）。

---

## 1. 从 2D 旋转开始（最重要的一步）

把点 (1,0) 绕原点逆时针转 θ，落在哪？

```
(1,0) → (cosθ, sinθ)
(0,1) → (−sinθ, cosθ)
```

写成矩阵 × 向量：

```
⎡ cosθ  −sinθ ⎤ ⎡x⎤   ⎡x·cosθ − y·sinθ⎤
⎣ sinθ   cosθ ⎦ ⎣y⎦ = ⎣x·sinθ + y·cosθ⎦
```

这个 2×2 矩阵就是**旋转矩阵**。3D 同理，绕 z 轴转 θ：

```
Rz(θ) = ⎡cosθ −sinθ  0⎤
        ⎢sinθ  cosθ  0⎥
        ⎣  0     0   1⎦
```

**三个关键性质**（自瞄全程依赖）：

1. **正交**：Rᵀ = R⁻¹。所以"世界系看相机系"和"相机系看世界系"互为转置——`R_gimbal2world = R_gimbal2imubodyᵀ · R_imubody2imuabs · R_gimbal2imubody` 里的转置就是这个用途；
2. **行列式 = 1**（没有镜像/缩放）；
3. **旋转 + 平移** = `y = R·x + t`（仿射变换），这就是一个坐标系到另一个坐标系的完整表达。

## 2. 自瞄的坐标系链（背下来）

```
图像系(px) ──solvePnP──► 相机系(x右,y下,z前, m)
  ──R_camera2gimbal, t_camera2gimbal──► 云台系(x前,y左,z上, m)
  ──R_gimbal2world(由IMU四元数算)──► 世界系(重力对齐: z向上, m)
  ──xyz2ypd──► 球坐标(yaw, pitch, distance)
```

每一步都是 `y = R·x + t`（solver.cpp:65-79）：

```cpp
xyz_in_gimbal = R_camera2gimbal_ * xyz_in_camera + t_camera2gimbal_;
xyz_in_world  = R_gimbal2world_ * xyz_in_gimbal;   // 只有旋转：云台原点=世界原点
```

**为什么必须这么换**：
- 相机系原点在镜头，随云台乱转——在里面算"敌人往哪跑"毫无意义；
- 世界系固定（z 向上），敌车的运动模型（匀速直线、原地陀螺）只有在这里才成立；
- 球坐标 (yaw, pitch, distance) 直接对应云台两个关节角 + 弹道距离。

## 3. IMU 安装角的补偿：相似变换（理解这个就赢过大多数队）

IMU 焊在云台上，但装配总有偏差（歪了 1° 也是常见）。IMU 输出的姿态 q 表示"IMU 体坐标 → 绝对坐标"。想让世界系**对齐云台零位**而不是对齐 IMU：

```
R_gimbal2world = R_g2ibᵀ · R_ib2ia · R_g2ib     (solver.cpp:48-52)
```

这就是**相似变换**：在"IMU 坐标"里做的旋转，先转回云台坐标、再转回去。类比：一把尺子斜着刻了度（R_g2ib），读数时先按斜度换算。

`R_gimbal2imubody` 是固定值，标定一次写进 yaml（多数车是单位阵；demo.yaml 是 diag(−1,−1,1)——IMU 倒装 180°）。

## 4. 三种姿态表示（都要会用）

| 表示 | 优点 | 缺点 | 项目用在哪 |
|---|---|---|---|
| 旋转矩阵 | 无奇异，乘法快 | 9 个数，难读 | 内部运算 |
| 欧拉角 (yaw,pitch,roll) | 人好读 | **万向节锁**，加法会绕圈 | 显示/下发目标角 |
| 四元数 (x,y,z,w) | 无奇异、可插值 | 4 个数不好理解 | IMU 传输、姿态插值 |

### 4.1 万向节锁一例

欧拉角下 pitch=±90° 时 yaw 和 roll 轴重合，丢一个自由度；且 yaw 从 179° 转到 −179° 直接做减法会得 358° 而不是 −2°。所以：

```cpp
tools::limit_rad(a);   // 把角度卷绕到 (−π, π]
// EKF 的角度状态必须三处卷绕: x_add / f / z_subtract —— 漏一处就在 ±π 附近发散
```

### 4.2 四元数与 slerp

四元数 q=(x,y,z,w)：单位四元数表示一个旋转，模长应为 1（项目收到帧后校验 |q|²≈1，cboard.cpp:78）。

**slerp（球面插值）**：两个姿态之间平滑过渡——时间对齐的核心：

```cpp
auto k = t_ac / t_ab;                          // 目标时刻落在两帧间的比例
Eigen::Quaterniond q_c = q_a.slerp(k, q_b).normalized();
```

为什么不能用欧拉角线性插值？——大角度旋转时路径会"抄近路穿过奇异点"，slerp 沿球面走最短弧。

### 4.3 欧拉角提取（math_tools）

```cpp
auto ypr = tools::eulers(R_gimbal2world_, 2, 1, 0);
// 参数 2,1,0 = 内旋 Z(2)-Y(1)-X(0) 顺序 → 依次取出 yaw, pitch, roll
```

## 5. 球坐标与雅可比

直角 → 球坐标（math_tools.cpp:100-106）：

```
yaw      = atan2(y, x)          // 方位角
pitch    = atan2(z, √(x²+y²))   // 俯仰角
distance = √(x²+y²+z²)
```

**雅可比**：多元函数的"导数矩阵"，第 (i,j) 元 = 第 i 个输出对第 j 个输入的偏导。EKF 需要它把非线性观测"局部拉直"：

```
H = ∂(yaw,pitch,dist) / ∂(x,y,z)     —— xyz2ypd_jacobian（math_tools.cpp:110-127）
```

现在不需要会推雅可比，只要知道：**EKF 的 h(x) 是非线性函数时，就配一个解析雅可比给线性化用**。

## 6. Eigen 速查表（项目的数学库）

```cpp
#include <Eigen/Dense>
Eigen::Vector3d v(1, 2, 3);              // 3×1 向量
Eigen::Matrix3d R;                        // 3×3 矩阵
Eigen::Quaterniond q(x, y, z, w);         // 注意构造顺序是 xyzw！
R = q.toRotationMatrix();                 // 四元数→矩阵
R.transpose();  R.inverse();
v.norm();  v.normalized();
R * v + t;                                // 矩阵乘向量
Eigen::Matrix<double, 11, 11> P;          // 固定尺寸（编译期，快）
Eigen::VectorXd x(11);                    // 动态尺寸
x.head(3);  x.segment(6, 2);  x[7];       // 取块
```

⚠️ 两个易错点：
- `Quaterniond(x,y,z,w)` 构造是 **xyzw**，但很多协议/文件按 **wxyz** 存（Gimbal 帧、Recorder 落盘都是 wxyz）——项目里两次踩过这个坑，代码里都有注释；
- Eigen 固定尺寸矩阵对齐问题：作为类成员时偶尔报对齐错误，加 `EIGEN_MAKE_ALIGNED_OPERATOR_NEW` 即可。

## 7. 装甲板朝向的物理直觉

`armor.ypr_in_world[0]`（装甲板 yaw）的含义：装甲板法向在世界系的水平朝向。它和"从枪口看向装甲板"的视线角 `atan2(y,x)` 的**差**决定你能看到装甲板多"正"：

```
delta_angle = 装甲板yaw − 视线yaw
delta ≈ 0     → 正对你（最好打）
delta ≈ ±90°  → 侧对你（PnP 深度不可信 → EKF 把此刻的距离噪声调大）
```

这个 delta 同时用于：EKF 观测噪声自适应、小陀螺选板（coming/leaving 窗口）、开火决策。

## 过关自测

1. 手算 Rz(90°) 乘 (1,0,0)。
2. 为什么"相机系→云台系"要有平移 t，而"云台系→世界系"没有？
3. 四元数模长不是 1 会怎样？代码里怎么处理？
4. yaw 从 3.1 rad 变到 −3.1 rad，直接相减是多少？limit_rad 后呢？
5. （进阶）为什么 IMU 安装补偿用 Rᵀ·A·R 而不是 R·A·Rᵀ？

