---
category: "自瞄拆解 · 视觉"
title: "视觉 08 —— TinyMPC 轨迹规划器 Planner（管线 B，本项目创新点）"
publishDate: "2026-11-08"
description: "对应源码：`tasks/auto_aim/planner/planner.cpp`、`planner/tinympc/{tiny_api, admm, types, tiny_api_constants}` 一句话：…"
tags: ["RoboMaster", "自瞄", "MPC"]
---
> 对应源码：`tasks/auto_aim/planner/planner.cpp`、`planner/tinympc/{tiny_api, admm, types, tiny_api_constants}`
> 一句话：把云台 yaw/pitch 各建模为**加速度受限的双积分器**，用 TinyMPC（ADMM 求解）跟踪解析弹道生成的参考轨迹，输出**位置+速度+加速度前馈**，云台只做内环执行。

---

## 1. 问题建模（planner.cpp:117-154）

常量（planner.hpp:13-17）：`DT = 0.01s`，`HALF_HORIZON = 50`，`HORIZON = 100`——参考轨迹覆盖 **−0.5s ~ +0.5s，总长 1s，周期 10ms**。

yaw 与 pitch **各自独立**建模为 2 状态 1 输入的双积分器：

```
状态 x = [角度; 角速度]，控制 u = 角加速度
A = [[1, DT], [0, 1]]，B = [[0], [DT]]，f = 0
angle_{k+1} = angle_k + DT·ω_k
ω_{k+1}     = ω_k     + DT·α_k
```

**代价与约束**（权重来自 demo.yaml:85-91）：

```
min  Σ ‖x_k − Xref_k‖²_Q + ‖u_k‖²_R
Q_yaw = diag([9e6, 0])    // 只罚角度误差，不罚角速度
R_yaw = diag([1])         // 罚加速度（能耗/平滑）
|u| ≤ max_acc            // yaw 50 rad/s²，pitch 100 rad/s²（box 约束）
状态约束 ±1e17（等效无约束）；rho = 1；max_iter = 10；容差 1e-3
```

只启用 box 约束（`tiny_set_bound_constraints`，:124-128）；SOC/线性约束代码已实现但关闭。

## 2. TinyMPC 预计算（tiny_setup，tiny_api.cpp:21-137, 244-318）

构造时把 ρ 增广进代价 `Q += ρI, R += ρI`，然后 **Riccati 迭代至收敛**（≤1000 次，|ΔKinf|<1e-5）：

```
Kinf   = (R1 + BᵀPB)⁻¹·BᵀPA          // 终端 LQR 增益
Pinf   = Q1 + AᵀP(A − B·Kinf)
Quu_inv = (R1 + BᵀPinf·B)⁻¹
AmBKt  = (A − B·Kinf)ᵀ；APf、BPf 同理
```

这些缓存与 ADMM 迭代无关，**每帧只需极轻量的 backward/forward sweep**——TinyMPC "tiny" 的由来。自适应 rho 有实现但默认关闭（tiny_api.cpp:367）。

## 3. 每帧 plan 流程（planner.cpp:27-108）

```
plan(optional<Target>, bullet_speed)
 ├─ 无目标 → {false}
 ├─ delay_time = |vyaw| > decision_speed ? high : low   // 注意 abs，与 Aimer 带符号略不同
 ├─ target.predict(future)                                // 飞行时间只补偿一次（不迭代）
 ▼
plan(Target, bullet_speed)                                :27-94
 ① 弹速清洗：<10 或 >25 m/s → 22 m/s                      :30-32
 ② 水平距离最近装甲板 → Trajectory() → target.predict(fly_time) 一次性外推  :34-45
 ③ 参考轨迹生成 get_trajectory（:179-203）：
    把目标回退 −0.51s，之后每步 predict(10ms)，每步调 aim(target, bullet_speed)
    得解析 (yaw, pitch)；yaw_vel/pitch_vel 用中心差分：
      yaw_vel = limit_rad(yaw_{k+1} − yaw_{k−1}) / (2·DT)
    参考 yaw 全部相对 yaw0（基准角）存储 —— 避免角度回绕破坏 MPC 线性性
 ④ 分别求解 yaw/pitch 两个 MPC：x0 = 参考首列，Xref = 对应两行，tiny_solve
 ⑤ 取解（:76-85）：全部取 horizon 中心 HALF_HORIZON（参考时刻 = "now"）：
      plan.yaw     = limit_rad(x(0, 50) + yaw0)
      plan.yaw_vel = x(1, 50)
      plan.yaw_acc = u(0, 50)
    ⚠️ 直接读 work->x/u（前向滚动结果）而非 solution，不检查 solved 标志
 ⑥ 开火判据 fire_thresh（:87-92）：
      plan.fire = ‖[ref_yaw − mpc_yaw, ref_pitch − mpc_pitch]‖₂
                  @ HALF_HORIZON + 2（即 +20ms） < fire_thresh_(0.003 rad ≈ 0.17°)
    语义：云台按加速度受限动力学能在 ~20ms 内贴上理想瞄准方向，才打
```

## 4. ADMM 求解流程（admm.cpp:274-389，每轮迭代）

| 步骤 | 位置 | 内容 |
|---|---|---|
| backward_pass_grad | :13-20 | Riccati 反向扫掠线性项：`d_i = Quu_inv(Bᵀp_{i+1}+r_i+BPf)`；`p_i = q_i + AmBKt·p_{i+1} − Kinfᵀr_i + APf` |
| forward_pass | :25-32 | LQR 策略滚动：`u_i = −Kinf·x_i − d_i`；`x_{i+1} = Ax_i + Bu_i + f` |
| update_slack | :81-175 | 辅助变量投影到可行域：`v = clamp(x+g, x_min, x_max)`，`z = clamp(u+y, u_min, u_max)`（box 投影） |
| update_dual | :181-208 | 对偶上升：`g += x − v`；`y += u − z` |
| update_linear_cost | :214-247 | 把参考与拉格朗日项折进线性代价 |
| termination | :253-271 | 原始/对偶残差 < 1e-3 则收敛；否则跑满 max_iter=10 |

本应用 10ms 周期内 10 次 ADMM 迭代足够贴合。

## 5. 两条管线对比（本篇 vs 07）

| | 管线 A（Aimer+Shooter） | 管线 B（Planner） |
|---|---|---|
| 飞行时间 | 不动点迭代 ≤10 次 | 只外推一次 |
| 输出 | 单点 (yaw, pitch) | 轨迹 + vel/acc 前馈 |
| 开火 | 5 条角度/突变判据 | fire_thresh 联合 L2 误差 |
| 通信 | CAN（只发角度） | 串口 Gimbal（29 字节带前馈） |
| 下位机角色 | 自己闭环到目标角 | 只做内环跟踪（轨迹跟随） |
| 效果 | 常规 | 稳态误差 <0.01 rad，切换装甲板提前减速 |
| 入口 | standard / mt_standard | standard_mpc / 调试 / 打符 mpc_aim |

**设计哲学**：MPC 把"何时该转多快"算好，把最难的部分放在上位机；下位机从"位置伺服"降级为"轨迹执行"，控制难度和调参量都下降——这就是 readme 里"轨迹视角下的自瞄理论"的落地。

## 6. 配置（demo.yaml:83-91，standard3.yaml 同构）

```yaml
planner:
  fire_thresh: 0.003
  max_yaw_acc: 50        # rad/s²
  Q_yaw: [9e6, 0]
  R_yaw: [1]
  max_pitch_acc: 100
  Q_pitch: [9e6, 0]
  R_pitch: [1]
```

Q 只罚角度、速度项权重 0：参考轨迹本身含速度信息，MPC 只需贴住角度，速度由前馈通道直接下发。

