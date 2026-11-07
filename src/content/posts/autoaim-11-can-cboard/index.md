---
category: "自瞄拆解 · 电控"
title: "电控 02 —— CAN 下位机协议（io::CBoard）"
publishDate: "2026-11-08"
description: "对应源码：`io/cboard.cpp` / `cboard.hpp` / `io/socketcan.hpp` 特点：无帧头、无软件 CRC（CAN 控制器硬件校验）、CAN ID 区分报文、int16 定点数。"
tags: ["RoboMaster", "自瞄", "CAN"]
---
> 对应源码：`io/cboard.cpp` / `cboard.hpp` / `io/socketcan.hpp`
> 特点：无帧头、无软件 CRC（CAN 控制器硬件校验）、CAN ID 区分报文、int16 定点数。

---

## 1. CAN ID 配置（yaml 可配）

| 配置项 | mvs.yaml | demo.yaml | 作用 |
|---|---|---|---|
| `quaternion_canid` | 0x01 | 0x100 | 四元数帧 |
| `bullet_speed_canid` | 0x110 | 0x101 | 弹速/模式帧 |
| `send_canid` | 0xff | 0xff | 控制帧 |
| `can_interface` | can0 | can0 | SocketCAN 接口名 |

缺 `can_interface` 直接抛异常（cboard.cpp:106-119）。

## 2. 接收帧一：四元数（cboard.cpp:68-84）

8 字节数据域，**大端 int16，缩放 1e-4**：

| 字节 | 字段 |
|---|---|
| data[0..1] | q.x = int16 / 1e4 |
| data[2..3] | q.y |
| data[4..5] | q.z |
| data[6..7] | q.w |

合法性校验：模长平方偏离 1 超过 1e-2 则告警丢帧（:78-81）。通过后 `{q, steady_clock::now()}` 压入容量 5000 的队列——**时间戳是主机收到时刻**，含传输与回调延迟，靠 slerp 吸收。

## 3. 接收帧二：状态帧（:86-102）

| 字节 | 字段 | 单位/说明 |
|---|---|---|
| data[0..1] | bullet_speed | m/s，int16 /1e2 |
| data[2] | mode | 0 idle / 1 auto_aim / 2 small_buff / 3 big_buff / 4 outpost |
| data[3] | shoot_mode | 0 left / 1 right / 2 both（哨兵双枪口） |
| data[4..5] | ft_angle | rad，/1e4，无人机专有 |

## 4. 发送帧（send_canid，cboard.cpp:47-66）

```cpp
frame.data[0] = command.control ? 1 : 0;      // 云台交给视觉
frame.data[1] = command.shoot ? 1 : 0;        // 开火
frame.data[2..3] = int16(command.yaw  × 1e4); // 大端
frame.data[4..5] = int16(command.pitch× 1e4);
frame.data[6..7] = int16(command.horizon_distance × 1e4);  // 无人机吊射专有
```

- `Command` 结构（io/command.hpp:6-13）：`{bool control; bool shoot; double yaw; double pitch; double horizon_distance}`——纯 POD，非抽象接口。
- ⚠️ 量程限制：int16×1e4 → ±3.2767 rad，超出会溢出；
- ⚠️ `(int16_t)(负数) >> 8` 是有符号算术右移（实现定义行为），能工作但不可移植；
- 协议只发角度，**无角速度前馈**（MPC 用不了，需走 Gimbal 串口）。

## 5. imu_at()：时间对齐核心（cboard.cpp:22-45）

```
维护 data_ahead_（早于 t）/ data_behind_（晚于 t）两帧
循环 pop 直到 data_behind_.timestamp > t
k = t_ac / t_ab
q = q_a.slerp(k, q_b).normalized()
```

主程序 `imu_at(t − 1ms)`：把姿态对齐到曝光时刻再减 1ms 经验补偿（standard.cpp:64）。

## 6. 构造顺序防死锁（cboard.hpp:58-59）

```cpp
tools::ThreadSafeQueue<IMUData> queue_;   // 必须在 can_ 之前初始化，否则可能死锁
SocketCAN can_;
```

成员初始化列表里 `can_(..., bind(&CBoard::callback, this, ...))`：CAN 读线程可能在构造函数完成前就回调 push——`queue_` 声明在前保证先构造。构造函数还同步阻塞 pop 两次，保证前后夹逼帧有效（:16-18）。

## 7. 底层 SocketCAN（io/socketcan.hpp）

- `socket(PF_CAN, SOCK_RAW, CAN_RAW)` + ioctl 取接口索引 + bind（:81-96）；
- **双线程**：`read_thread_`（epoll_wait 2ms + recv MSG_DONTWAIT，取帧即调 rx_handler）+ `daemon_thread_`（每 100ms 检查 `ok_`，读线程异常时 close + 重连自愈，:38-49）；
- write 失败抛异常，CBoard::send 捕获记 warning（cboard.cpp:61-65）。

## 8. 参数来源核对

- 敌方颜色**不经过 CAN**：yaml `enemy_color`（人工配置）；
- 时间戳**不传输**：主机侧打点。

