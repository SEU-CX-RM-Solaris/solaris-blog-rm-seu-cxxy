---
category: "自瞄拆解 · 电控"
title: "电控 01 —— 视觉-电控通信总览"
publishDate: "2026-11-08"
description: "对应源码：`io/` 全目录、`io/command.hpp` ⚠️ 一个重要纠偏：**cboard 走的是 CAN 总线（SocketCAN），不是串口**；真正用串口的是 `io::Gimbal` 和 `io::…"
tags: ["RoboMaster", "自瞄", "电控"]
---
> 对应源码：`io/` 全目录、`io/command.hpp`
> ⚠️ 一个重要纠偏：**cboard 走的是 CAN 总线（SocketCAN），不是串口**；真正用串口的是 `io::Gimbal` 和 `io::DM_IMU`。

---

## 1. 两套并行的下位机通信方案

| | `io::CBoard` | `io::Gimbal` | `io::DM_IMU` |
|---|---|---|---|
| 物理链路 | SocketCAN（can0，USB2CAN 或 C 板） | 串口（/dev/gimbal） | 串口（/dev/ttyACM0，921600） |
| 协议特征 | 无帧头、**无软件 CRC**（靠 CAN 硬件校验）、CAN ID 区分报文、int16 定点 | 帧头 'SP' + packed 结构体 + **帧尾 CRC16**、float | 达妙官方 0x55/0xAA 帧 + 每段 CRC16 |
| 收 | 四元数（int16×1e4）、弹速/模式/枪口 | 四元数（float wxyz）、云台反馈角+角速度、弹速、累计发弹数 | 欧拉角+加速度+角速度 |
| 发 | control/shoot/yaw/pitch（int16×1e4） | control/yaw+vel+acc/pitch+vel+acc | — |
| 使用者 | standard / mt_standard / sentry / uav | **standard_mpc / debug_mpc**（MPC 变体） | 独立 IMU 备选 |

**为什么 MPC 变体用 Gimbal？** CAN 协议只发 yaw/pitch 角度，而 Gimbal 协议额外带 `yaw_vel/yaw_acc/pitch_vel/pitch_acc` 前馈量——这正是 TinyMPC 规划器需要的控制量形式。demo.yaml:80-91 同时配了 cboard 与 gimbal、planner 参数，固件侧两路并存。

## 2. 共同的通信范式（三个类同构）

```
后台接收线程 ──► 带主机时间戳的队列 ──► 消费侧 imu_at(t)/q(t)
                                        弹出-窥视-夹逼-SLERP 插值
```

- 时间戳全部取**主机侧 steady_clock**（不是 IMU 内部时间），包含传输+调度延迟，靠队列 + slerp 吸收；
- 主循环用 `imu_at(t − 1ms)` 经验补偿曝光延迟（standard.cpp:64）。

## 3. 交换的数据全景

### 下位机 → 视觉

| 数据 | CBoard | Gimbal |
|---|---|---|
| 云台姿态 | 四元数 int16×1e4（0x01/0x100） | 四元数 float wxyz |
| 弹速 | int16×0.01 m/s | float |
| 模式 | idle/auto_aim/small_buff/big_buff/outpost | 同（IDLE/AUTO_AIM/SMALL_BUFF/BIG_BUFF） |
| 枪口 | shoot_mode（哨兵左/右/双） | — |
| 云台反馈 | — | yaw/pitch + 角速度 |
| 发弹数 | — | bullet_count 累计 |

### 视觉 → 下位机

| 字段 | CBoard（8 字节） | Gimbal（29 字节） |
|---|---|---|
| control | 1 字节 | mode: 0 不控/1 控不开火/2 控且开火 |
| shoot | 1 字节 | 并入 mode |
| yaw | int16×1e4（量程 ±3.277 rad） | float + vel + acc |
| pitch | int16×1e4 | float + vel + acc |

**不经过通信的战场先验**：敌方颜色来自 yaml `enemy_color`（人工按比赛确定）；所有时间戳主机侧打点。

## 4. 各篇导航

| 主题 | 文档 |
|---|---|
| CAN 协议逐字节 + imu_at 插值 | [02-CAN协议cboard](/posts/autoaim-11-can-cboard) |
| 串口协议帧格式 + CRC16 | [03-串口协议gimbal](/posts/autoaim-12-uart-gimbal) |
| 达妙 IMU + 时间同步哲学 | [04-IMU与时间同步](/posts/autoaim-13-imu-timesync) |
| 工业相机驱动 + 多线程取流 | [05-相机驱动与多线程](/posts/autoaim-14-camera-multithread) |
| CRC/PID/线程队列等工具链 | [06-工具链](/posts/autoaim-15-toolchain-crc-pid) |

