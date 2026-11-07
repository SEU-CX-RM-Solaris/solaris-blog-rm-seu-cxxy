---
category: "自瞄拆解 · 电控"
title: "电控 03 —— 串口云台协议（io::Gimbal，MPC 变体专用）"
publishDate: "2026-11-08"
description: "对应源码：`io/gimbal/gimbal.cpp` / `gimbal.hpp`、`tools/crc.cpp` 特点：帧头 'SP' + packed 结构体 + 帧尾 CRC16 + float 定位 + *…"
tags: ["RoboMaster", "自瞄", "串口"]
---
> 对应源码：`io/gimbal/gimbal.cpp` / `gimbal.hpp`、`tools/crc.cpp`
> 特点：帧头 'SP' + packed 结构体 + 帧尾 CRC16 + float 定位 + **速度/加速度前馈**——为 TinyMPC 量身定制。

---

## 1. 帧格式（packed 结构体 + static_assert ≤64，可整帧读写，gimbal.hpp:17-46）

### 下位机 → 视觉：`GimbalToVision`（43 字节）

```cpp
struct __attribute__((packed)) GimbalToVision {
  uint8_t  head[2] = {'S','P'};
  uint8_t  mode;            // 0 空闲 / 1 自瞄 / 2 小符 / 3 大符
  float    q[4];            // 四元数 wxyz 顺序
  float    yaw,   yaw_vel;
  float    pitch, pitch_vel;   // 云台反馈角与角速度
  float    bullet_speed;       // m/s
  uint16_t bullet_count;       // 累计发弹数
  uint16_t crc16;
};
static_assert(sizeof(GimbalToVision) <= 64);
```

### 视觉 → 下位机：`VisionToGimbal`（29 字节）

```cpp
struct __attribute__((packed)) VisionToGimbal {
  uint8_t  head[2] = {'S','P'};
  uint8_t  mode;            // 0 不控制 / 1 控制不开火 / 2 控制且开火
  float    yaw,   yaw_vel,  yaw_acc;
  float    pitch, pitch_vel, pitch_acc;   // 位置+速度+加速度前馈
  uint16_t crc16;
};
```

与 CBoard 的关键差异：四元数 float（非 int16 定点）；回传云台反馈闭环量与累计发弹数；发送侧多 vel/acc 前馈——**TinyMPC 的 Plan 结构可以原样下发**。

## 2. CRC16：帧尾 2 字节（gimbal.cpp:89-90, 159）

```cpp
// 发送：对除 crc16 外的全部字节计算
tx_data_.crc16 = tools::get_crc16((uint8_t*)&tx_data_, sizeof(tx_data_) - sizeof(tx_data_.crc16));

// 接收：check_crc16 按小端还原比较
crc16 = (data[len-1] << 8) | data[len-2];
```

CRC 失败仅记 debug 日志丢帧，**不清缓冲**——靠下一轮 'SP' 头重新滑窗同步。

## 3. 读线程与断线重连（gimbal.cpp:130-221）

```
read_thread:
  ① 读 2 字节，head != 'SP' 继续读（逐字节滑窗同步）
  ② 帧头命中 → 取 steady_clock::now() 为帧时间戳
  ③ 读剩余字节 → CRC16 校验
  ④ 四元数入 queue_{1000}；yaw/pitch/弹速/弹量加锁写 state_

连续读失败 >5000 次 → reconnect()：
  close → 睡 1s → open 重试最多 10 次 → 成功后 queue_.clear()（丢弃陈旧姿态）
```

析构置 `quit_` 并 join。`mode()/state()` 访问加互斥锁。

## 4. q(t) 插值（gimbal.cpp:64-78）—— 与 CBoard::imu_at 的实现差异

不是维护 ahead/behind 成员，而是 `pop()` 取 q_a、`front()` 窥探 q_b：

```cpp
k = t_ac / t_ab;
q_c = q_a.slerp(k, q_b).normalized();
if (t < t_a) return q_c;   // 负 k 即反向外推，仍然返回
```

front() 不弹出——括住目标时刻后队列头还是 q_b，后续数据保留。

## 5. send() 模式映射（gimbal.cpp:99-118）

```cpp
tx_data_.mode = control ? (fire ? 2 : 1) : 0;   // 0 不控 / 1 控不开火 / 2 控且开火
serial_.write 整帧一次写出
```

## 6. CBoard vs Gimbal 的角色结论

二者是**同一角色的两套实现**（都提供"任意时刻姿态 q(t) + mode + bullet_speed"，都是"接收线程 + 时间戳队列 + slerp"范式），主程序二选一：

| | CBoard | Gimbal |
|---|---|---|
| 总线 | CAN | 串口 |
| 数值 | int16 定点 | float |
| 校验 | CAN 硬件 CRC | 软件 CRC16 |
| 控制量 | 角度 | 角度 + 角速度 + 角加速度 |
| 反馈 | 无云台角 | yaw/pitch + vel |
| 自愈 | daemon 重连 SocketCAN | 连续失败重连 + 清队列 |

**选型规则**：走管线 A（Aimer/位置环）用 CBoard；走管线 B（Planner/MPC）必须用 Gimbal——因为需要下发速度与加速度前馈。

