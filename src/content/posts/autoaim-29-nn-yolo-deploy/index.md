---
category: "自瞄拆解 · 学习笔记"
title: "学习笔记 06 —— 神经网络与 YOLO 部署"
publishDate: "2026-11-08"
description: "目标：理解\"一张图进去，一串装甲板框+4 个角点出来\"中间发生了什么；会在 NUC 上部署模型。 你不需要会训练大模型——项目用的都是别人训好/自己微调的小模型。**重点是推理与部署**。"
tags: ["神经网络", "YOLO"]
---
> 目标：理解"一张图进去，一串装甲板框+4 个角点出来"中间发生了什么；会在 NUC 上部署模型。
> 你不需要会训练大模型——项目用的都是别人训好/自己微调的小模型。**重点是推理与部署**。

---

## 1. 神经网络最小概念

一个"神经元" = 加权求和 + 激活：

```
y = σ(w₁x₁ + w₂x₂ + b)     σ 是激活函数（如 ReLU：负数归零）
```

成千上万个神经元按层排列 → 前一层输出是后一层输入 → **前向传播**。训练 = 用数据调整 w 和 b；推理（部署）= 只做前向传播。自瞄只做推理。

## 2. CNN：为什么卷积适合看图

全连接层看 1440×1080 图需要亿级参数。卷积神经网络（CNN）改用**小滑窗**：

```
3×3 卷积核在图上滑动，每个位置算一次 9 参数加权和 → 输出"特征图"
不同卷积核找不同模式：边缘 / 角点 / 灯条形状 / 数字纹理…
层数越深，特征越抽象：像素 → 边缘 → 灯条 → "这是一块装甲板"
```

关键性质：卷积核**平移不变**——灯条在图左还是图右都能被同一个核找到，且参数量极小。

## 3. 分类头：logits 与 softmax

网络最后输出 9 个原始分数（logits，可正可负），softmax 变成概率：

```
softmax(z)ᵢ = exp(zᵢ) / Σexp(zⱼ)    → 9 个非负数，和为 1
```

项目代码（classifier.cpp:47-50）的数值稳定写法：先减最大值再 exp（防溢出）。置信度 = 概率最大值，阈值 0.8 过滤——低于它的样本还自动存盘（数据回流，见 [视觉/03](/posts/autoaim-03-digit-classifier)）。

## 4. 目标检测：分类 + 定位 + 去重

图像分类只回答"这是什么"；检测还要回答"在哪"。

### 4.1 YOLO 的核心思想（You Only Look Once）

一次前向传播，在整张图上同时输出所有目标的框：

```
图被划成网格（如 80×80 = 6400 个格），每个格负责检测落在它中心的物体
每个预测 = [框中心x, 中心y, 宽w, 高h, 类别分数…]
最终输出张量: [1, 类别数+4(+关键点), 8400]   ← 8400 = 所有格子×几种形状的预测总数
```

### 4.2 后处理三步（对照 yolos/*.cpp）

```
① 置信度过滤: score < 0.7 的预测直接扔
② NMS:        cv::dnn::NMSBoxes，IoU>0.3 的重叠框去重
③ 坐标还原:   框和关键点除以 scale（letterbox 缩放因子）→ 原图像素坐标
```

### 4.3 关键点检测（本项目的特色）

除了框，还输出**装甲板 4 个角点**（lightbar 端点）的精确位置——它们是 PnP 的直接输入，比"从框边角推"准得多。

⚠️ 关键点顺序不保证 → 项目有 `sort_keypoints()` 按"先分上下、再按左右"重排成 TL,TR,BR,BL（yolo11.cpp:209-235）。

## 5. 三个模型的三种类别方案（对照 yolo/02）

| 模型 | 输出 | 方案 |
|---|---|---|
| yolov5 | [1,8400,22] | objectness + 颜色 4 类 + 数字 9 类（双头 one-hot） |
| yolov8 | [1,14,8400] | 2 类粗分，数字交给 32×32 小网络补（两阶段） |
| yolo11 | [1,50,8400] | 38 类联合（颜色×数字×大小 一次全出） |

38 类 = sentry/one~five/outpost × 3 色 + base × 4 色（大小各计）+ 平衡大装甲 nine 种——类别设计本身就是一种算法决策。

## 6. 模型格式转换链

```
训练框架 (PyTorch .pt)
   │ ultralytics: yolo export format=onnx
   ▼
ONNX (.onnx)  —— 通用中间格式，跨框架
   │ OpenVINO: ovc / mo 工具
   ▼
OpenVINO IR (.xml 结构 + .bin 权重)  —— 针对 Intel 硬件优化
```

项目 assets/ 里全是 IR；只有数字分类器是 onnx（用 cv::dnn 读）。

## 7. OpenVINO 部署四步（yolo11.cpp 全流程）

```cpp
ov::Core core;
auto model = core.read_model("yolo11.xml");

// ① 用 PrePostProcessor 把预处理"焊进"模型 —— CPU 零预处理代码
ov::preprocess::PrePostProcessor ppp(model);
input.tensor().set_element_type(u8).set_shape({1,640,640,3}).set_layout("NHWC")
              .set_color_format(BGR);
input.preprocess().convert_element_type(f32).convert_color(RGB).scale(255.0);
model = ppp.build();

// ② 编译到设备
auto compiled = core.compile_model(model, "GPU",
                  ov::hint::performance_mode(LATENCY));   // 或 THROUGHPUT

// ③ 推理
ov::Tensor in(u8, {1,640,640,3}, img.data);   // 零拷贝：直接包住 Mat 的内存
auto req = compiled.create_infer_request();
req.set_input_tensor(in);
req.infer();                                    // 同步；或 req.start_async()+wait()

// ④ 输出 → cv::Mat 零拷贝包装 → 走后处理
auto out = req.get_output_tensor();
cv::Mat m(shape[1], shape[2], CV_32F, out.data());
```

**设备选择**：`"GPU"` = NUC 核显（iGPU）、`"CPU"`、`"AUTO"` 自动挑。LATENCY 模式为单帧最快；THROUGHPUT 为流水线吞吐最大（异步多线程版用这个）。

### 异步推理（mt_detector 的核心）

```
push(): create_infer_request → start_async() → {img, t, request} 入队(容量16)
pop():  request.wait() → postprocess()
```

GPU 在后台算上一帧时，CPU 同时取图/准备下一帧——**推理和取图重叠**，这就是多线程版比同步版快的原因。

## 8. int8 量化（能量机关模型用）

float32 权重 → int8（乘一个缩放系数），模型体积 ÷4、CPU 推理提速明显，精度损失通常 <1%。yolo11_buff_int8.xml 就是量化模型，所以它反而选 CPU 跑。

## 9. 新手部署排错清单

| 症状 | 原因 |
|---|---|
| 输出全是乱框 | 预处理错了：BGR/RGB 顺序、/255 没除、NHWC/NCHW 搞反 |
| 检测框偏移 | letterbox 没记录 pad/偏移，坐标还原公式不匹配 |
| 帧率上不去 | 没 compile 到 GPU / 用了同步推理 / 后处理里逐像素循环 |
| `read_model` 崩溃 | .xml 和 .bin 不在同一目录或版本不匹配 |
| GPU 推理报错 | NUC 没装 compute-runtime（readme 第 6 节的 deb 包） |

## 过关自测

1. softmax 输入 [2, 1, 0.1]，手算三个概率（用计算器）。
2. 8400 个候选框是怎么来的？（网格 × anchor 形状）
3. NMS 的 IoU 怎么算？两个完全相同位置的框 IoU=?
4. LATENCY 和 THROUGHPUT 模式分别适合哪种程序结构？
5. 为什么异步推理更快？"重叠"重叠的是什么？

