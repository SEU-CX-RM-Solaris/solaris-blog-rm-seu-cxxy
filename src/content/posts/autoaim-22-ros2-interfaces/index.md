---
category: "自瞄拆解 · ROS2"
title: "ROS 01 —— ROS2 接口拆解（哨兵专用：与导航协同）"
publishDate: "2026-11-08"
description: "对应源码：`io/ros2/{ros2, publish2nav, subscribe2nav}.{cpp,hpp}`、`src/sentry.cpp`、根 CMakeLists.txt:105-131 定位：本项目…"
tags: ["ROS2", "哨兵"]
---
> 对应源码：`io/ros2/{ros2, publish2nav, subscribe2nav}.{cpp,hpp}`、`src/sentry.cpp`、根 CMakeLists.txt:105-131
> 定位：本项目主打"无 ROS 依赖"，ROS2 **仅为哨兵"追击"功能预留**的导航通信接口——因此被设计成**纯可选编译**的薄封装。

---

## 1. 使用的中间件与消息

- 直接用 **rclcpp**（非自写协议封装），消息类型是自定义包 **sp_msgs**：
  - `sp_msgs/msg/EnemyStatusMsg`：`builtin_interfaces/Time timestamp` + `int8[] invincible_enemy_ids`（导航→视觉：无敌机列表）
  - `sp_msgs/msg/AutoaimTargetMsg`：`timestamp` + `int8[] target_ids`（导航→视觉：指定自瞄目标）
  - `std_msgs/String`（视觉→导航）

## 2. 节点与话题（QoS 全部默认深度 10，无显式 QoS）

| 节点 | 方向 | Topic | 类型 | 内容 |
|---|---|---|---|---|
| `auto_aim_target_pos_publisher` | 发 | `auto_aim_target_pos` | std_msgs/String | `Eigen::Vector4d` 逗号拼接 `"x,y,z,w"`（w 实为优先目标编号，publish_test.cpp:16 传 `ArmorName::sentry+1`） |
| `nav_subscriber` | 收 | `enemy_status` | sp_msgs/EnemyStatusMsg | 无敌机 id 列表 |
| 同一节点 | 收 | `autoaim_target` | sp_msgs/AutoaimTargetMsg | 指定自瞄目标 |

在哨兵主程序中的用法（sentry.cpp:45-104）：

```cpp
io::ROS2 ros2;                                   // 构造即 init + 双 spin 线程
...
decider.get_invincible_armor(ros2.subscribe_enemy_status());   // 无敌机过滤
ros2.publish(target_info);                       // 目标位置发导航
```

## 3. 生命周期管理（ros2.cpp:4-22）

```cpp
ROS2::ROS2() {
  rclcpp::init(0, nullptr);
  publish2nav_   = make_shared<Publish2Nav>();
  subscribe2nav_ = make_shared<Subscribe2Nav>();
  publish_spin_thread_   = thread([this]{ publish2nav_->start(); });
  subscribe_spin_thread_ = thread([this]{ subscribe2nav_->start(); });
}
ROS2::~ROS2() { rclcpp::shutdown(); 两个线程 join; }
```

`start()` 即 `rclcpp::spin(shared_from_this())`——**每个节点一个专用 spin 线程**。栈上构造即完成全部初始化，析构自动 shutdown，对主程序零侵入。

## 4. 收发两侧的工程策略

### 发布端（publish2nav.cpp:25-40）

`send_data()` 每次调用直接 publish，无队列、无节流——fire-and-forget。

### 订阅端（subscribe2nav.cpp:32-106）—— 三个防陈旧设计

1. 两个回调把最新消息写入容量 1 的 `ThreadSafeQueue`（push 前 `clear()`，取最新值语义）；
2. 收到第 2 条消息后建 **1500ms 看门狗 timer**：超时清空队列；每条新消息 `cancel()` 后重建——**导航停止发送后视觉不会用陈旧状态**；
3. 查询接口 `subscribe_enemy_status()/subscribe_autoaim_target()` **非阻塞**：队列空返回空 vector，否则取最新。

## 5. 模板测试接口（ros2.hpp:22-34）

```cpp
template<typename T>
create_publisher<T>(node_name, topic, queue)   // 临时建节点 + 分离线程 spin
```

供测试程序自发自收，不污染正式节点。

## 6. 配套测试程序

| 测试 | 内容 |
|---|---|
| tests/publish_test.cpp | 1Hz 发布 `{i, i+1, 1, sentry+1}` |
| tests/subscribe_test.cpp | 500µs 轮询打印 invincible_enemy_ids |
| tests/topic_loop_test.cpp | 自闭环：模板 publisher 每 5µs 发、循环内订阅自己，验证回调/队列/时间戳链路 |

## 7. CMake 可选编译（根 CMakeLists.txt:105-131）

```cmake
find_package(ament_cmake QUIET)
find_package(rclcpp QUIET) … find_package(sp_msgs QUIET)
if(全部 5 个包 FOUND)
    add_executable(sentry …)                    # 只有哨兵系列 + ROS 测试参与编译
    target_link_libraries(sentry … auto_aim omniperception tools io)
else()
    message(STATUS "ROS2 environment not found, skipping ROS2-related code.")
endif()
```

`io/CMakeLists.txt:40-59` 同样探测：找到才把 ros2 三个源文件加进 io 库并 `ament_target_dependencies`。

要点：

- **ROS2 是纯可选依赖**：无 ROS 环境时 standard/mt_standard/uav 照常编译（io 库只剩相机/串口/CAN）；
- 这套 CMake **不是 ament 包**（无 `ament_package()`），只是在普通 CMake 工程里条件性链接 ROS2——省去了把整个工程塞进 colcon 的成本；
- 若需重跑：装 ROS2 Humble + 编译 sp_msgs 包后重新 `cmake -B build` 即自动启用。

## 8. 哨兵整体数据流（含 ROS）

```
主相机(hikrobot) ─┐
后相机          ─┼─► Decider(全向感知: 复用同一 YOLO 检测 USB 图)
USB 相机 ×2    ─┘        │ 无敌机过滤 + 优先级决策 ◄── ros2.subscribe_enemy_status()
                         ▼
              Tracker.track(检测队列, …)   ← 全向感知版重载（switching 换目标）
                         ▼
              Aimer / Shooter ──► CBoard.send
                         └──► ros2.publish(目标位置) ──► 导航
```

