---
category: "自瞄拆解 · 学习笔记"
title: "学习笔记 01 —— C++ 进阶必备（从课堂 C++ 到项目 C++）"
publishDate: "2026-11-08"
description: "你会的：变量、循环、函数、类的基础。 本篇补上：读这个项目真正需要的那 30%，全部配项目真实代码片段。"
tags: ["C++", "学习路线"]
---
> 你会的：变量、循环、函数、类的基础。
> 本篇补上：读这个项目真正需要的那 30%，全部配项目真实代码片段。

---

## 1. 引用、const 与"只读传参"

项目的函数签名长这样：

```cpp
virtual std::list<Armor> detect(const cv::Mat & img, int frame_count);
```

三个知识点：

- **`const cv::Mat&`** = "传引用 + 只读"。传引用避免拷贝大图像（一张 1440×1080 图 4MB，值传递每次拷 4MB）；`const` 承诺"我不改它"。
- 规则：**大对象一律 `const T&` 传参**；需要修改就用普通引用 `T&`。
- `const` 成员函数：`double ekf_x() const;` 表示"这个函数不修改成员"——读代码时看到 const 就知道它是纯查询。

## 2. STL 容器选型（项目里的真实选择）

| 容器 | 项目用在哪 | 为什么 |
|---|---|---|
| `std::vector` | 3D 点集、装甲板列表 | 随机访问快，默认首选 |
| `std::list` | `std::list<Armor>`（检测返回值） | 中间**频繁删除**（去重要 remove_if），list 删除 O(1) |
| `std::deque` | EKF 的 NIS 滑窗（长度 100） | 两端进出，固定窗口 |
| `std::map` | EKF 的 `data`（调试数据） | 按字符串键取值 |

`remove_if` + erase 惯用法（detector.cpp 去重的写法）：

```cpp
armors.remove_if([](const Armor & a) { return a.duplicated; });
// remove_if 把不满足的元素移到前面，真正删除靠容器的 erase
// std::list::remove_if 是特化版，直接真删
```

**lambda**（`[](...){...}`）：匿名函数，常用作回调或谓词。捕获语法：

```cpp
[capture](params) -> return_type { body; }
[=]  // 按值捕获全部用到的变量
[&]  // 按引用捕获
[this]  // 捕获 this 指针（成员函数回调常用）
```

项目实例（SocketCAN 回调注册，cboard.cpp:12-13）：

```cpp
can_(..., std::bind(&CBoard::callback, this, std::placeholders::_1));
// 等价 lambda 写法: can_(..., [this](auto frame){ this->callback(frame); });
```

## 3. 智能指针：现代 C++ 的内存管理

```cpp
std::unique_ptr<YOLOBase> yolo_;                  // 独占所有权
yolo_ = std::make_unique<YOLOV5>(config_path, debug);   // 创建
// yolo_ 离开作用域时自动 delete —— 这就是 RAII
```

- **RAII 原则**：资源（内存/文件/线程/锁）的生命周期绑定到对象生命周期。构造时获取，析构时释放。
- 项目实例：`Gimbal` 析构时置 `quit_` 并 `join()` 读线程（gimbal.cpp:29-34）——对象一死，线程必停，绝不泄漏。
- `std::shared_ptr`：引用计数共享。ROS2 节点用 `std::make_shared<Publish2Nav>()`，因为 rclcpp 内部也要持有节点引用。
- **规则**：新代码永远不要裸 `new/delete`。

## 4. 多线程四件套（本项目到处都是）

```cpp
#include <thread> <mutex> <condition_variable> <atomic>
```

### 4.1 thread + join

```cpp
std::thread t([this]{ this->read_loop(); });  // 立即开始跑
t.join();   // 等它结束 —— 析构前必须 join，否则程序崩溃
```

### 4.2 mutex（互斥锁）

两个线程同时写同一个变量 = 数据竞争 = 结果不可预测。解决：

```cpp
std::mutex mtx_;
{   // 用花括号限定锁的范围（lock_guard 构造加锁、析构解锁 —— 又是 RAII）
    std::lock_guard<std::mutex> lock(mtx_);
    shared_data_ = new_value;
}
```

项目实例：Gimbal 的 `state_` 被读线程写、主线程读，全部走 `std::lock_guard`。

### 4.3 condition_variable（条件变量）

"没数据就睡，有数据再醒"——忙等（while 空转烧 CPU）的正确替代：

```cpp
std::unique_lock<std::mutex> lock(mtx_);
cv_.wait(lock, []{ return !queue.empty(); });  // 假醒会自动重查条件
```

项目里的 `ThreadSafeQueue::pop()` 就是 mutex + condition_variable 封装（thread_safe_queue.hpp）。

### 4.4 atomic

`std::atomic<io::Mode> mode;`——单个变量的无锁读写（mt_standard.cpp:61）。规则：**简单标志位用 atomic，复杂数据用 mutex**。

### 4.5 本项目的三个线程协作模式（背下来，很常用）

| 模式 | 项目实例 | 一句话 |
|---|---|---|
| 生产者-消费者队列 | 相机线程产帧 → 主线程消费 | 容量有限的 ThreadSafeQueue |
| **单槽邮箱**（最新值覆盖） | CommandGener 决策线程 | 不排队，永远只处理最新数据 |
| 守护线程自愈 | SocketCAN/相机 daemon | 100ms 轮询健康状态，挂了自动重启 |

## 5. 模板初体验

你不用会写复杂模板，但要会**用**：

```cpp
tools::ThreadSafeQueue<CameraData> queue_(1);   // 一个类，装什么类型都行
yaml["exposure_ms"].as<double>();
auto [color, name, type] = armor_properties[class_id];  // C++17 结构化绑定
```

`std::optional`（C++17）："可能有值可能没有"的容器，比魔法值-1 干净：

```cpp
std::optional<Input> latest_;        // CommandGener 的信箱
if (latest_) { use(*latest_); }      // 有值才用
```

## 6. 写通信协议需要的两个"黑魔法"

### 6.1 内存对齐与 packed（gimbal.hpp:17-46）

```cpp
struct __attribute__((packed)) VisionToGimbal {
  uint8_t  head[2];
  uint8_t  mode;
  float    yaw, yaw_vel, yaw_acc;
  ...
  uint16_t crc16;
};
static_assert(sizeof(VisionToGimbal) == 29);  // 编译期断言大小
```

- 默认情况下编译器会**插空填充**字节让成员对齐（比如 uint8 后面插 3 字节对齐 float）——这样发给下位机的帧就多了废字节。`__attribute__((packed))` 禁止填充，成员严丝合缝。
- `static_assert` 在**编译期**检查：帧大小错了直接编译不过，而不是现场调试两小时。

### 6.2 位级重解释（float ↔ uint32）

```cpp
data.accx = *((float *)(&receive_data.accx_u32));
// 同一段 32 位内存：按 uint32 读出来，重新解释成 IEEE754 float
```

CAN/串口传 float 的标准做法：把 float 的 4 字节当整数传输，收到后重解释回来。理解它需要知道 float 的二进制表示，用的时候记住套路即可。

### 6.3 定点数（int16 传角度）

```cpp
frame.data[2] = (int16_t)(command.yaw * 1e4) >> 8;  // 高字节
frame.data[3] = (int16_t)(command.yaw * 1e4);       // 低字节
```

把 double 弧度 ×1e4 变成整数（保留 4 位小数精度），拆成 2 字节大端发送——省带宽的标准手法。⚠️ 注意量程：int16 最大 32767，所以 yaw 最多 ±3.2767 rad。

## 7. 其他高频语法速查

```cpp
namespace io { ... }                 // io::CBoard —— 防命名冲突
constexpr double DT = 0.01;          // 编译期常量
auto xyz = eigen_vec;                // auto 自动推导类型
struct __attribute__((packed)) F;    // 见上
override / virtual                   // 多态：YOLOBase 接口 → 三个实现类
enum class Color { red, blue };      // 强类型枚举
reinterpret_cast / static_cast       // 显式类型转换
```

**多态**值得单独说：`YOLOBase` 定义接口，`YOLOV5/YOLOV8/YOLO11` 各自实现 `detect()`，调用方只认 `YOLOBase*`——换模型不改主程序。这是"面向接口编程"，工程里最有用的一条。

## 8. 常见坑清单（新手真实踩过的）

1. **有符号数右移** `(int16_t)(-100) >> 8`：负数右移是算术移位，实现定义行为——项目里这么写能跑，但别在新代码里模仿（cboard.cpp:54-59）；
2. **未 join 的线程**：`std::thread` 对象析构时如果还在跑 → `std::terminate` 直接崩；
3. **锁的粒度**：持锁做 IO（打印/写文件）= 性能灾难，先拷贝再释放锁再处理；
4. **悬空引用**：lambda 捕获局部变量的引用，函数返回后 lambda 再被调用 → 崩溃。回调一律捕获 `[this]` 或值；
5. **`std::list` 里存大对象**：注意 `push_back` 是拷贝；C++11 后会优先移动（move 语义），所以 `img.clone()` 后再 push 是安全惯例。

## 过关自测

1. 写出"两个线程安全地共享一个 `std::vector`"的完整最小代码（mutex 版）。
2. `const cv::Mat&` 传参比值传参好在哪？
3. `__attribute__((packed))` 不加会发生什么？
4. 单槽邮箱模式和队列模式分别适合什么场景？（提示：决策线程为什么不用队列）

