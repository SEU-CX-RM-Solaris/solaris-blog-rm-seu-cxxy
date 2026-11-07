---
category: "自瞄拆解 · 学习笔记"
title: "学习笔记 07 —— 工程系统：Linux、CMake、通信与调试"
publishDate: "2026-11-08"
description: "目标：能把项目编译跑起来、知道它的硬件怎么连、出了问题从哪查。 这一篇全是\"动手知识\"，建议开着终端边看边敲。"
tags: ["Linux", "CMake", "多线程"]
---
> 目标：能把项目编译跑起来、知道它的硬件怎么连、出了问题从哪查。
> 这一篇全是"动手知识"，建议开着终端边看边敲。

---

## 1. Linux 基础（自瞄跑在 Ubuntu 22.04 上）

```bash
cd / ls / pwd                    # 导航三件套
sudo apt install libopencv-dev   # 装包（项目依赖一次装齐，见 readme）
chmod +x run_aim.sh              # 加可执行权限
ls /dev/ttyACM* /dev/video*      # 看设备：串口 / USB 相机
dmesg | tail                     # 内核日志：设备插拔第一时间看这里
```

### 设备权限（新手第一次必踩）

串口默认只有 root 能读：

```bash
sudo usermod -a -G dialout $USER   # 把自己加进 dialout 组
# 重新登录生效
```

### udev 规则（设备名固定化）

USB 设备每次插入编号可能变（ttyACM0 ↔ ttyACM1）。udev 规则按 VID:PID 固定命名（readme 第 5 节），相机驱动的 `vid_pid: "2bdf:0001"` 就是为它准备的。

### 后台运行与自启

```bash
screen -S aim      # 开一个可断开的会话（SSH 断了程序不死）
./run_aim.sh
# Ctrl+A D 退出会话；screen -r aim 回来
```

开机自启用 `.desktop` 文件放进 `~/.config/autostart/`（readme 第 4 节）——赛场上机器人上电即跑，没人来得及敲命令。

## 2. CMake：项目的构建系统

CMake 不编译代码，它**生成** Makefile。最小心智模型：

```cmake
cmake_minimum_required(VERSION 3.16)
project(sp_vision)
set(CMAKE_CXX_STANDARD 17)                    # C++17（optional/结构化绑定需要）

find_package(OpenCV REQUIRED)                 # 找已安装的库 → 得到 OpenCV_INCLUDE_DIRS 等
include_directories(${OpenCV_INCLUDE_DIRS})

add_library(tools OBJECT tools/crc.cpp ...)   # 编成库（OBJECT = 中间产物，不单独链接）
add_executable(standard src/standard.cpp)     # 每个可执行目标
target_link_libraries(standard tools io auto_aim ${OpenCV_LIBS})
```

**项目的可选依赖技巧**（根 CMakeLists.txt:105-131）——很值得学：

```cmake
find_package(rclcpp QUIET)     # QUIET = 找不到不报错
if(rclcpp_FOUND AND sp_msgs_FOUND)
    add_executable(sentry ...)          # 有 ROS 才编译哨兵
else()
    message(STATUS "ROS2 not found, skipping...")   # 没有 ROS 其他功能照常
endif()
```

常用命令：

```bash
cmake -B build                  # 配置（生成 build/）
make -C build -j$(nproc)        # 并行编译
cmake -B build -DCMAKE_BUILD_TYPE=Release   # ★ 不加这个是 Debug，慢 5~10 倍
```

## 3. 串口与 CAN：两种总线

### 3.1 串口（UART/USB 虚拟串口）

- 一根线一次发一个字节；约定**波特率**（每秒 bit 数，如 921600）、8N1（8 数据位/无校验/1 停止位）；
- 软件协议自己定：帧头 'SP' + 数据 + 帧尾 CRC16（Gimbal 协议）；
- Linux 下就是读写一个文件：`open("/dev/ttyACM0")`。

### 3.2 CAN（机器人内部高速总线）

- 多设备共享两根线，**按报文 ID 区分**，硬件自动仲裁（优先级）+ 硬件 CRC——所以项目 CAN 协议没有软件校验；
- 帧结构：ID(11bit) + 数据域 8 字节；
- Linux 标准接口 **SocketCAN**：把 CAN 当网络套接字用：

```bash
sudo ip link set can0 up type can bitrate 1000000   # 拉起 can0，1M 波特率
candump can0                                        # 监听：调试神器，先看再写
cansend can0 0FF#0100701E002C0F27                   # 手动发一帧测试
```

```cpp
// 代码里: socket(PF_CAN, SOCK_RAW, CAN_RAW) + bind("can0")
// 收: read() 得 can_frame{can_id, data[8]}；发: write()
```

**调试协议的黄金法则**：先用 `candump` 看下位机到底发了什么，再对着协议文档逐字节核对——比 print 大法快十倍。

### 3.3 CRC 校验（30 秒理解）

发送方对数据算出一个"指纹"（如 CRC16）附在末尾；接收方重算比对，不一致就丢帧。防的是线上的位翻转噪声。项目的表是**裁判系统串口协议同款** CRC8/CRC16（tools/crc.cpp）。

## 4. 时间：steady_clock 与时间戳

```cpp
using time_point = std::chrono::steady_clock::time_point;
auto now = std::chrono::steady_clock::now();
double dt = delta_time(t1, t2);   // 项目封装，单位秒
```

- **steady_clock**：单调时钟，不会因 NTP 校时倒退——一切耗时测量用它，不用 system_clock；
- 相机帧时间戳、IMU 时间戳全在**主机侧打点**，配 SLERP 插值做图像-姿态对齐（详见 [电控/04](/posts/autoaim-13-imu-timesync)）。

## 5. 调试工具箱（赛场上救命的）

| 工具 | 用途 | 项目对应 |
|---|---|---|
| spdlog 日志 | 崩溃前最后发生了什么 | `logs/日期.log`，flush_on(info) 保证落盘 |
| PlotJuggler | 实时曲线：yaw 跟踪误差、开火决策 | tools/plotter 用 UDP 发 JSON 到 127.0.0.1:9870 |
| 录制回放 | 复现现场 bug（自瞄版 rosbag） | tools/recorder：MJPG 视频 + 四元数文本 |
| gdb / 断点 | 段错误定位 | `g++ -g` 编译后 `gdb ./standard` |
| candump | CAN 协议调试 | 见上 |
| NoMachine | 远程桌面连机器人小电脑 | readme 推荐的调试方式 |

**项目的可靠性哲学**（值得抄到任何项目）：fail-fast 配置（yaml 缺键即退）+ 守护线程自愈（相机/CAN 挂了自动重启）+ 录制回放（赛后复盘）。

## 6. Git 最小集（团队协作前提）

```bash
git clone <url>            # 拿代码
git status / git diff      # 改了什么
git add -A && git commit -m "fix: tracker NIS threshold"
git pull --rebase          # 更新队友的代码
git checkout -b feature-aimer   # 开分支再改，别直接动 main
```

## 7. 把项目跑起来的完整清单（纸上谈兵→实战）

```
□ Ubuntu 22.04（实体机或双系统；WSL 跑不了相机/CAN）
□ 装依赖：readme 第 2 节的 apt 列表 + MindVision/海康 SDK + OpenVINO
□ cmake -B build -DCMAKE_BUILD_TYPE=Release && make -C build -j
□ 没有相机？先跑纯算法测试：
    ./build/auto_aim_test        # 离线图集上的检测+解算
    ./build/detector_video_test  # 视频回放检测
□ 有硬件：插相机+USB2CAN → ip link 拉起 can0 → candump 验证下位机在发
□ ./build/standard configs/standard4.yaml
```

## 过关自测

1. 为什么编译要加 `-DCMAKE_BUILD_TYPE=Release`？
2. CAN 和串口各怎么解决"数据传错"问题？
3. `candump can0` 里看到 `01#3FE8...`，对照 [电控/02](/posts/autoaim-11-can-cboard) 的帧格式，手算四元数 x。
4. 程序在现场崩了，日志文件被清空——你怎么保证下次崩溃前日志一定落了盘？（flush_on）
5. `screen` 解决什么问题？

---

*全部笔记完。回到 [00-学习路线图](/posts/autoaim-23-learning-roadmap) 检查通关情况，然后开始读 [../README.md](/posts/autoaim-00-overview) 与 [../视觉/](/posts/autoaim-01-perception-pipeline) 各篇拆解。*

