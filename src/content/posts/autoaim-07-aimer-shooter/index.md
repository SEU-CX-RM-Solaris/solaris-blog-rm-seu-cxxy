---
category: "自瞄拆解 · 视觉"
title: "视觉 07 —— 决策器 Aimer 与开火 Shooter（管线 A）"
publishDate: "2026-11-08"
description: "对应源码：`tasks/auto_aim/aimer.cpp`、`shooter.cpp` 职责：Aimer 回答\"往哪瞄\"（含移动目标提前量），Shooter 回答\"现在开不开火\"。本篇是解析弹道 + 位置环管线；…"
tags: ["RoboMaster", "自瞄", "决策"]
---
> 对应源码：`tasks/auto_aim/aimer.cpp`、`shooter.cpp`
> 职责：Aimer 回答"往哪瞄"（含移动目标提前量），Shooter 回答"现在开不开火"。本篇是解析弹道 + 位置环管线；MPC 管线见 [08](/posts/autoaim-08-tinympc-planner)。

---

## 1. Aimer::aim() 完整逻辑（aimer.cpp:32-123）

```cpp
io::Command Aimer::aim(list<Target> targets, timestamp, bullet_speed, to_now=true)
```

逐步拆解：

**① 空目标** → `{control=false, shoot=false, 0, 0}`，云台还给操作手。

**② 发弹延时选择**（:40-41）：

```cpp
delay_time = ekf_x[7](vyaw) > decision_speed_ ? high_speed_delay_time_   // 0.066s
                                              : low_speed_delay_time_;   // 0.015s
```

目标角速度高（小陀螺）用长延时——补偿"图像采集→决策→下发→电机响应→弹丸出膛"整条延迟链（注释：含 detector-aimer 耗时 + 发弹延时 0.1s 的实测综合值）。

**③ 弹速兜底**（:43）：CAN 弹速无效（<14）时用默认 23 m/s。

**④ 时间外推**（:46-59）：

- `to_now=true`（在线）：`dt = delta_time(now, timestamp) + delay_time`——用真实时钟差精确补偿检测+跟踪耗时；
- `to_now=false`（离线回放）：固定 `dt = 0.005 + delay_time`；
- `future = timestamp + dt`，`target.predict(future)` 把 EKF 推到未来。

**⑤ 选瞄准点** `choose_aim_point`（见 §2），无效则退出。

**⑥ 首次弹道**：`d0 = √(x²+y²)` 水平距离，`Trajectory(bullet_speed, d0, z)`，不可解（超射程）则退出。

**⑦ 飞行时间不动点迭代**（:78-116，≤10 次，收敛阈 0.001s）——处理移动目标的"追时间"耦合：

```cpp
for (iter = 0; iter < 10; ++iter) {
  predict_time = future + prev_fly_time;             // 弹丸到达时刻
  iteration_target[iter].predict(predict_time);      // 目标外推到该时刻
  aim_point = choose_aim_point(iteration_target[iter]);
  d = √(x²+y²);  current_traj = Trajectory(bullet_speed, d, z);
  if (|current_traj.fly_time − prev_fly_time| < 0.001) break;
  prev_fly_time = current_traj.fly_time;
}
```

即求解 `fly_time = T(aim_point(future + fly_time))` 的不动点。每次迭代用独立 Target 副本，不污染原状态。

**⑧ 输出**（:119-122）：

```cpp
yaw   = atan2(aim_xyz.y(), aim_xyz.x()) + yaw_offset_;
pitch = −(traj.pitch + pitch_offset_);    // 世界系 pitch 向上为负
return {control=true, shoot=false, yaw, pitch};   // 开火交给 Shooter
```

**瞄准点就是装甲板几何中心**（含长短臂修正），无额外 xyz 偏移，只叠加 yaml 角度偏置。

**哨兵双枪管重载**（:125-142）：按 CAN 帧的 ShootMode（left/right_shoot）把 `yaw_offset_` 换成 `left/right_yaw_offset_`。

## 2. 选板逻辑 choose_aim_point（aimer.cpp:144-209）

`delta_angle_i = limit_rad(armor_angle_i − center_yaw)`，≈0 表示该面正对枪口。

### 分支一：单板已知 / 正对板选择（:150-190）

- `!target.jumped`（从未观测到跳变）→ 只有一块板已知，直接返回 0 号；
- 否则选 `|delta| ≤ 60°` 的可射击板；若两块都在范围内（各呈 ~45°），**锁定模式**：首次选 |delta| 较小者并锁定 `lock_id_`，防两面间来回跳；只剩一块时解锁。

> ⚠️ 疑点：进入小陀螺分支的条件写作 `|ekf_x[8]| <= 2`，而 x[8] 是旋转半径 r（恒 ≤2），按注释本意应为 x[7]（vyaw）。后果：非前哨站目标无论转速都走本分支，coming/leaving 窗口实际只对前哨站生效。

### 分支二：小陀螺 / 前哨站 coming-leaving 窗口（:192-208）

```cpp
for (i = 0; i < armor_num; i++) {
  if (|delta_i| > coming_angle) continue;            // 不在转入区
  if (w > 0 && delta_i < leaving_angle)  return armor_i;   // 即将正对
  if (w < 0 && delta_i > −leaving_angle) return armor_i;
}
return invalid;
```

参数：普通车 yaml 值 70°/30°（demo 60°/20°）；**前哨站硬编码 70°/30°**。物理含义：小陀螺时一侧板不断转入视野（coming）、另一侧不断转出（leaving），打"刚转入、即将正对"的那一面命中概率最高。

`debug_aim_point` 公有成员暴露给 Shooter 与调参画图。

## 3. Shooter 开火判据（shooter.cpp:19-41）

参数：`first_tolerance=3°`（近）、`second_tolerance=2°`（远）、`judge_distance=2m`、`auto_fire=true`。**全部满足**才开火：

```
① command.control && 有目标 && auto_fire_            // 总开关
② tolerance = 水平距离 > 2m ? 2° : 3°               // 远距收紧、近距放宽提射速
③ |last_command_.yaw − command.yaw| < 2×tolerance    // 命令未突变（防切换瞬间甩枪走火）
④ |gimbal_pos[0] − last_command_.yaw| < tolerance    // 云台已跟上
⑤ aimer.debug_aim_point.valid                        // 瞄准点有效
```

细节讲究：

- ④ 用 **last_command_** 而非本次 command——子弹打的是上一拍瞄准的方向（注释说明）；
- **没有**弹速判据、射频冷却、模式判据（仅 auto_fire 布尔）；
- `last_command_` 无论开火与否都更新（:35,39）。

## 4. 与 Planner 管线的关系

**Aimer 与 Planner 无任何代码耦合**。Aimer 输出的是单点目标角（位置环），Planner 输出的是整条轨迹（状态环 + 前馈）。两者共用 yaml 的 yaw/pitch_offset；standard3.yaml 注释表明 planner 分支复用 `low_speed_delay_time`（设为 0）。完整对比见 [08-TinyMPC轨迹规划器](/posts/autoaim-08-tinympc-planner)。

