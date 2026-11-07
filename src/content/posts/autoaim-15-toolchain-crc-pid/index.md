---
category: "自瞄拆解 · 电控"
title: "电控 06 —— 工具链：CRC、PID、线程安全队列与基础设施"
publishDate: "2026-11-08"
description: "对应源码：`tools/` 全目录 这一层是全项目的\"地基\"：通信校验、备用控制器、线程间数据流原语、配置/日志/调试。"
tags: ["RoboMaster", "自瞄", "电控"]
---
> 对应源码：`tools/` 全目录
> 这一层是全项目的"地基"：通信校验、备用控制器、线程间数据流原语、配置/日志/调试。

---

## 1. CRC（tools/crc.cpp / crc.hpp）

标准查表实现，两套表：

| | CRC8 | CRC16 |
|---|---|---|
| 初值 | 0xff | 0xffff |
| 表 | 256 项（poly 0x31 系，**裁判系统串口协议同款**） | 反射 poly（0x8408 系，CRC-16/CCITT-FALSE 反射变体） |
| 迭代 | `crc8 = TABLE[crc8 ^ byte]` | `crc16 = (crc16>>8) ^ TABLE[(crc16 ^ byte) & 0xff]` |

使用位置：

| 协议 | 校验方式 |
|---|---|
| Gimbal 串口帧 | 帧尾 2 字节，`check_crc16` 按小端还原（crc.cpp:87） |
| DM_IMU 三段帧 | 每段 16 字节 vs 段内 crc |
| CBoard CAN 帧 | **无软件 CRC**，靠 CAN 硬件 |

⚠️ 易踩坑：`get` 与 `check` 的 len 语义相反——`check` 的 len **包含**末尾 crc 字节（crc.hpp:8-18 注释明确）。

## 2. PID（tools/pid.cpp / pid.hpp）

位置式 PID，**固定控制周期 dt**（构造传入，7 参构造：`PID(dt, kp, ki, kd, max_out, max_iout, angular=false)`）：

```cpp
float e  = angular_ ? limit_rad(set − fdb) : (set − fdb);   // 角度模式误差卷绕
float de = angular_ ? limit_rad(last_fdb_ − fdb) : (last_fdb_ − fdb);
pout = e · kp;
iout = clip(iout + e·dt·ki, ±max_iout);                     // 积分限幅抗饱和
dout = de / dt · kd;                                        // ★ 微分先行：对测量值微分
return clip(pout + iout + dout, ±max_out);
```

三个亮点：

1. **角度模式**：误差与微分项都过 `limit_rad`，专用于 yaw 这类循环量；
2. **微分先行**（对测量值微分而非误差）：目标突变时无微分冲击；
3. `pout/iout/dout` 三成员公开，配 Plotter 打包上传调试。

在自瞄链路中 PID 是**备用控制器**（主链路是 Aimer 目标角 + 下位机伺服 / Planner 前馈），供 gimbal 测试与调试程序使用。

## 3. ThreadSafeQueue（tools/thread_safe_queue.hpp）—— 全项目线程原语

`mutex + condition_variable` 队列，模板 `<T, PopWhenFull=false>`：

| 场景 | 配置 | 行为 |
|---|---|---|
| 相机帧 | `queue_(1)`，PopWhenFull=false | 满时**丢新帧**（单槽邮箱，永远最新帧） |
| IMU 四元数 | `queue_(5000/1000)` | 带时间戳深队列，供 slerp 插值 |
| 推理流水线 | `queue_(16)` | 检测线程产帧、主线程消费 |
| Recorder | `queue_(1)` | + 空帧哨兵优雅退出 |

带 `full_handler_` 回调钩子；`pop()/front()` 阻塞，`clear()` 唤醒等待者。

## 4. 其余基础设施速览

| 工具 | 要点 |
|---|---|
| **logger** | spdlog 单例，双 sink（`logs/日期.log` + 彩色控制台），debug 级别，`flush_on(info)` 保证崩溃前落盘 |
| **plotter** | UDP JSON 发送器（默认 127.0.0.1:9870），互斥保护 sendto——配合 PlotJuggler 实时画曲线（云台 yaw 执行情况、开火决策、目标角速度） |
| **yaml** | `load()` 失败即 exit；模板 `read<T>` 键缺失即 error+exit——**fail-fast 配置哲学**，杜绝静默默认值 |
| **exiter** | 构造注册 SIGINT → 置全局 `exit_`，主循环 `while(!exiter.exit())` 优雅退出；重复构造抛异常防多实例 |
| **extended_kalman_filter** | 见 [视觉/05](/posts/autoaim-05-target-ekf) |
| **trajectory** | 见 [视觉/09](/posts/autoaim-09-ballistic-trajectory) |
| **math_tools** | `limit_rad`（±π 卷绕）、`xyz2ypd/ypd2xyz` 及雅可比、`eulers(R, 2,1,0)`（ZYX 欧拉角）、`delta_time` |
| **img_tools / thread_pool** | 图像调试辅助 / 通用线程池 |

## 5. 设计模式总结（可复用经验）

1. **后台线程 + 单槽邮箱**：相机/IMU/录制全部建立在 ThreadSafeQueue 上；
2. **守护线程自愈**：SocketCAN（100ms 轮询 ok_）、HikRobot（100ms 轮询 capturing_ + libusb reset）三处同构——硬件故障不靠人重启；
3. **时间对齐哲学**：姿态样本带主机时间戳，消费侧弹出-窥视-夹逼-slerp；
4. **fail-fast**：配置缺键即退、串口打不开即退（dm_imu）。

