---
category: "自瞄拆解 · 视觉"
title: "视觉 09 —— 弹道模型 Trajectory"
publishDate: "2026-11-08"
description: "对应源码：`tools/trajectory.cpp` / `trajectory.hpp` 结论先行：**纯真空抛物线闭式解，无空气阻力、无数值迭代**；头文件注释明确写了\"不考虑空气阻力\"（trajectory.…"
tags: ["RoboMaster", "自瞄", "弹道"]
---
> 对应源码：`tools/trajectory.cpp` / `trajectory.hpp`
> 结论先行：**纯真空抛物线闭式解，无空气阻力、无数值迭代**；头文件注释明确写了"不考虑空气阻力"（trajectory.hpp:12）。

---

## 1. 物理模型

g 取 **9.7833**（trajectory.cpp:7，略小于标准 9.81 的实测修正值）。输入三元组：

- `v0`：弹速 m/s（来自 CAN 弹速帧，无效时兜底 23 或 22）
- `d`：目标水平距离 m
- `h`：目标相对枪口水平面的高度差 m

水平匀速、竖直匀加速：

```
d = v0·cosθ·t
h = v0·sinθ·t − ½·g·t²
```

## 2. 闭式解推导（trajectory.cpp:9-31）

消去 t：令 T = tanθ，利用 1/cos²θ = 1+T²：

```
h = d·T − (g·d² / 2v0²)·(1 + T²)
→ a·T² + b·T + c = 0，  a = g·d²/(2v0²)，  b = −d，  c = a + h
→ T = (−b ± √(b²−4ac)) / 2a = (d ± √(d² − 4a(a+h))) / 2a
```

代码：

```cpp
auto a = g * d * d / (2 * v0 * v0);
auto b = -d;
auto c = a + h;
auto delta = b*b - 4*a*c;
if (delta < 0) { unsolvable = true; return; }   // 目标超出弹道可达范围
tan_pitch_1 = (-b + √delta) / (2a);   // 高抛弹道
tan_pitch_2 = (-b - √delta) / (2a);   // 低伸弹道
```

## 3. 双解取短时（:25-31）

两解对应高抛/低伸两条弹道，取**飞行时间较短**的低伸弹道：

```cpp
t_1 = d / (v0·cos(pitch_1));
t_2 = d / (v0·cos(pitch_2));
pitch    = (t_1 < t_2) ? pitch_1 : pitch_2;    // 抬头为正
fly_time = (t_1 < t_2) ? t_1 : t_2;
```

`fly_time` 是给 Aimer/Planner 做目标外推用的关键输出。

## 4. "迭代"到底在哪

弹道本身**不迭代**。项目里的"迭代"发生在上层，是对**移动目标与飞行时间耦合**的处理：

| 层 | 迭代内容 |
|---|---|
| Aimer | fly_time 不动点迭代 ≤10 次、阈值 0.001s：`fly_time = T(aim_point(future + fly_time))` |
| Planner | 只按最近装甲板外推一次（不迭代），10ms 周期的 MPC 本身承担了闭环修正 |

## 5. 取舍说明

- 无空气阻力：RM 17mm 弹丸初速 ~23 m/s、距离通常 <8m，阻力影响在几 cm 级，用 yaml 的 pitch_offset 吸收即可；
- 若要上空气阻力（如 42mm 大弹丸、远距离狙击），需要换成弹道系数迭代积分或查表补偿——本项目的 Trajectory 接口（构造即得 pitch/fly_time）为将来替换留了缝。

## 6. 在整条链中的位置

```
Target(EKF).predict(future + fly_time)  →  选板  →  (d, h)  →  Trajectory(v0, d, h)
                                                                    │
                              aim 输出 yaw = atan2(y,x) + offset    │
                              pitch = −(traj.pitch + offset) ◄──────┘
```

