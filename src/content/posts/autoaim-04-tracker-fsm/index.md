---
category: "自瞄拆解 · 视觉"
title: "视觉 04 —— 跟踪器 Tracker：状态机与目标管理"
publishDate: "2026-11-08"
description: "对应源码：`tasks/auto_aim/tracker.cpp` / `tracker.hpp` 职责：把每帧孤立的 `list<Armor>` 变成连续的 `Target`——决定何时建目标、何时丢目标、何时换目标。"
tags: ["RoboMaster", "自瞄", "视觉算法"]
---
> 对应源码：`tasks/auto_aim/tracker.cpp` / `tracker.hpp`
> 职责：把每帧孤立的 `list<Armor>` 变成连续的 `Target`——决定何时建目标、何时丢目标、何时换目标。

---

## 1. 状态机（tracker.cpp:180-229）

状态用字符串表示：`lost / detecting / tracking / temp_lost / switching`。

```
lost      --found-->  detecting (detect_count_=1)
detecting --found-->  count++；>= min_detect_count_(5) → tracking
          --!found--> count=0 → lost        （一次失败即打回）
tracking  --!found--> temp_lost_count_=1 → temp_lost
          --found-->  保持
temp_lost --found-->  tracking
          --!found--> count++；前哨站上限 75，其余 15；超限 → lost
switching --found-->  detecting
          --!found--> count++；> 200 → lost
```

配置（mvs.yaml:64-66）：`min_detect_count=5`、`max_temp_lost_count=15`、`outpost_max_temp_lost_count=75`。

**设计要点**：detecting 要求**连续 5 帧**命中才转正（防误检）；tracking 后允许丢 15 帧（前哨站三叶轮换遮挡，放宽到 75 帧）。

## 2. 主入口 `track(armors, t)`（tracker.cpp:31-96）

```
① dt = delta_time(t, last_timestamp_)；tracking 中 dt>0.1s 直接置 lost   :38-41
   （相机离线保护）
② 颜色过滤：非敌方颜色装甲板全部移除                                    :43
③ 两级稳定排序：先按到图像中心距离(硬编码 1440×1080 中心)，再按 priority  :53-62
   → 队首 = "优先级最高的里面离中心最近的"
④ lost → set_target；否则 → update_target                               :64-71
⑤ state_machine(found)                                                  :73
⑥ 发散检测：target_.diverged() → 强制 lost 返回空                       :76-80
⑦ 收敛质量检测：EKF 滑窗 NIS 失败率 ≥40%（window=100）→ "Bad Converge" 置 lost  :83-90
```

**NIS 失败率判据**：EKF 每次更新计算 NIS（新息平方），>0.711 记一次失败；最近 100 次更新失败率 ≥40% 说明观测残差长期不匹配模型 → 放弃该目标。⚠️ 阈值 0.711 是 χ²(4) 的 5% 下分位而非 95% 上分位，与"40% 失败率"成对使用，属激进的工程组合，不能单独照抄（详见 tools/extended_kalman_filter.cpp:58-89）。

## 3. 建目标 `set_target`（tracker.cpp:231-264）—— 按兵种给先验

取排序后队首装甲板，先 `solver_.solve(armor)`（PnP+yaw 优化），再按兵种初始化 Target：

| 兵种 | 半径 r 初值 | 装甲板数 N | P0 对角线 |
|---|---|---|---|
| 平衡（big 且 three/four/five） | 0.2 m | 2 | {1,64,1,64,1,64,0.4,100,1,1,1} |
| 前哨站 outpost | **0.2765 m（已知常量）** | 3 | r/l/h 方差 1e-4/0/0 |
| 基地 base | **0.3205 m（已知常量）** | 3 | r/l/h 方差 1e-4/0/0 |
| 普通车 | 0.2 m | 4 | {1,64,1,64,1,64,0.4,100,1,1,1} |

前哨/基地把 r、l、h 的先验方差压到 ≈0——**半径视为已知常量，不让 EKF 估计**（0.2765/0.3205 是官方尺寸量测的旋转半径）。

## 4. 更新目标 `update_target`（tracker.cpp:266-293）

- 先 `target_.predict(t)` 时间推进；
- 统计 name 与 armor_type 都匹配的装甲板数，为 0 返回 false；
- **对每一块匹配装甲板都执行 solve + update**（:280-290）——小陀螺同帧常见 2 块同车装甲板，全部进 EKF，一次 predict 多次 update，信息量更大。

## 5. 带全向感知的重载 `track(detection_queue, ...)`（:98-178）

多出 `switching` 状态，服务于哨兵"优先级换目标"：

- tracking 中主相机出现**更高优先级**装甲板（`priority < target_.priority`）→ 直接 set_target 换；
- tracking 中**全向感知队列队首**出现更高优先级目标、且当前目标已收敛 → 置 switching，把全向感知的 `delta_yaw/delta_pitch` 封进返回的 `switch_target`（云台先转过去），found=false；
- switching 中：主相机出现优先级等于 `omni_target_priority_` 的装甲板才算 found。

## 6. 函数速查

| 函数 | 位置 | 作用 |
|---|---|---|
| `track(armors, t)` | cpp:31-96 | 单相机主入口 |
| `track(queue, ...)` | cpp:98-178 | 全向感知版（换目标逻辑） |
| `state_machine(found)` | cpp:180-229 | 五态转移 |
| `set_target` | cpp:231-264 | 兵种分参建 Target |
| `update_target` | cpp:266-293 | predict + 多板循环 update |

