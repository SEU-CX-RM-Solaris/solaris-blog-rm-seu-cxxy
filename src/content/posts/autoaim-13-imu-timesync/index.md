---
category: "自瞄拆解 · 电控"
title: "电控 04 —— IMU（达妙 DM_IMU）与时间同步体系"
publishDate: "2026-11-08"
description: "对应源码：`io/dm_imu/dm_imu.cpp` / `dm_imu.hpp`、`tools/math_tools.cpp` 补充：C 板内置 BMI088 的姿态由下位机解算后经 CAN 发四元数（见 [02…"
tags: ["RoboMaster", "自瞄", "IMU"]
---
> 对应源码：`io/dm_imu/dm_imu.cpp` / `dm_imu.hpp`、`tools/math_tools.cpp`
> 补充：C 板内置 BMI088 的姿态由下位机解算后经 CAN 发四元数（见 [02-CAN协议](/posts/autoaim-11-can-cboard)）；本文的 DM_IMU 是**独立外置 IMU 备选**。

---

## 1. DM_IMU 数据链

### 1.1 物理链路

- `/dev/ttyACM0` USB CDC 虚拟串口，**921600 波特率**，8N1，20ms 超时（dm_imu.cpp:37-58）；
- 打开失败直接 `exit(0)`——**无重连守护**（与 Gimbal/HikRobot 的差异点）；
- 后台线程 `get_imu_data_thread`（:60-104）整帧循环读取。

### 1.2 帧结构（57 字节 = 3 段 × 19 字节，dm_imu.hpp:19-50）

每段布局：`0x55 + 0xAA + slave_id(0x01) + reg + 3×uint32(float 位型) + crc16 + FrameEnd`

| 段 | reg | 内容 |
|---|---|---|
| 1 | 0x01 | accx/y/z（加速度） |
| 2 | reg_gyro | gyrox/y/z |
| 3 | reg_euler | roll/pitch/yaw（**欧拉角，单位度**） |

读取：先读 4 字节判魔数，命中再补读 53 字节（:67-74）。

### 1.3 三段独立 CRC16（:76-93）

每段各自 `get_crc16(段首, 16) == 段crc`；**某段失败只跳过该段**（float 保持旧值），不影响其他段：

```cpp
if (get_crc16((uint8_t*)&receive_data.FrameHeader1, 16) == receive_data.crc1) {
  data.accx = *((float*)(&receive_data.accx_u32));   // uint32 位重解释为 IEEE float
  ...
}
```

### 1.4 欧拉角 → 四元数 → 入队（:94-99）

```cpp
q = AngleAxisd(yaw·π/180, UnitZ) · AngleAxisd(pitch·π/180, UnitY)
  · AngleAxisd(roll·π/180, UnitX);
q.normalize();
queue_.push({q, steady_clock::now()});   // 主机时间戳
```

### 1.5 零漂处理：没有

代码**无任何显式零漂估计/静止偏置标定/互补滤波**——姿态融合完全信任达妙 IMU 内部解算（直接输出积分后的欧拉角）。上位机仅做：CRC 过滤坏帧、每样本 normalize、imu_at 的 slerp 插值。潜在误差：时间戳取自串口收完时刻（57B@921600 ≈ 0.6ms + 读块延迟），未做传输延迟补偿。

## 2. 时间同步体系（全项目统一的哲学）

### 2.1 问题

图像有曝光时刻 t_img，IMU 姿态流有自己的到达时刻——自瞄要求**曝光瞬间的云台姿态**（否则 PnP 出的世界系是歪的）。

### 2.2 解法：主机时间戳 + 队列 + SLERP

```
CAN 回调线程:  收帧 → {q, steady_clock::now()} → queue_
主循环:        camera.read(img, t)            // 图像带主机时间戳
               q = cboard.imu_at(t − 1ms)     // 在姿态流中插值出 t 时刻姿态
               solver.set_R_gimbal2world(q)
```

- 时间戳全部是**主机侧 steady_clock**（不是 IMU 内部时间），传输+调度延迟由"队列深度 + slerp"吸收；
- `t − 1ms`：经验性的曝光/传输补偿（standard.cpp:64）；
- imu_at 阻塞 pop 直到跨越目标时刻，前后两帧 slerp——所以队列必须足够深（CBoard 5000）防"追不上"。

### 2.3 三个 imu_at 实现（行为一致，实现略异）

| 类 | 结构 | 特殊行为 |
|---|---|---|
| CBoard::imu_at | ahead/behind 两成员夹逼 | 标准实现 |
| Gimbal::q(t) | pop + front 窥探 | `t < t_a` 时负 k 反向外推仍返回 |
| DM_IMU::imu_at | 与 CBoard 逐行同构 | 同上 |

### 2.4 配套的录制回放

`tools/recorder` 把 `{图像, 四元数, 时间戳}` 落盘（MJPG avi + "秒 w x y z" 文本），离线回放时可以完全复现 imu_at 场景——"时间戳+视频+四元数"就是自瞄版 rosbag。详见 [05-相机驱动](/posts/autoaim-14-camera-multithread)。

## 3. 对电控组的启示（反向拆解）

视觉端对下位机的全部要求，其实只有四条：

1. 以固定 CAN ID / 帧格式发四元数（int16×1e4 大端）与弹速/模式；
2. 以固定 CAN ID 收 control/shoot/yaw/pitch（int16×1e4 大端）并执行；
3. 姿态解算频率要显著高于相机帧率（队列+slerp 才有得插）；
4. 云台执行器（配合视觉发的目标角）做位置伺服——或走串口协议接收 MPC 前馈只做内环。

