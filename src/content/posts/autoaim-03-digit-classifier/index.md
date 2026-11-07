---
category: "自瞄拆解 · 视觉"
title: "视觉 03 —— 数字分类器 Classifier"
publishDate: "2026-11-08"
description: "对应源码：`tasks/auto_aim/classifier.cpp` / `classifier.hpp` 结论先行：**不是模板匹配、不是 MLP 特征工程，是一个 tiny ResNet ONNX 小网络 +…"
tags: ["RoboMaster", "自瞄", "视觉算法"]
---
> 对应源码：`tasks/auto_aim/classifier.cpp` / `classifier.hpp`
> 结论先行：**不是模板匹配、不是 MLP 特征工程，是一个 tiny ResNet ONNX 小网络 + softmax，双推理后端并存**。

---

## 1. 模型与双后端

- 模型：`assets/tiny_resnet.onnx`（yaml `classify_model`），输入 `1×1×32×32` 灰度，输出 `1×9`（对应 ArmorName 九枚举：one..base）。
- 构造（classifier.cpp:7-15）同时建两套引擎：

```cpp
net_ = cv::dnn::readNetFromONNX(model);                    // 后端A: cv::dnn
auto ovmodel = core_.read_model(model);
compiled_model_ = core_.compile_model(ovmodel, "AUTO",
  ov::hint::performance_mode(ov::hint::PerformanceMode::LATENCY));  // 后端B: OpenVINO
```

- `classify()` 走 **cv::dnn**（生产路径，detector.cpp:75 与 yolov8.cpp:165 都调它）；
- `ovclassify()` 走 OpenVINO（f32 `{1,1,32,32}`，device "AUTO"）——**全仓库无调用点**，属预留分支。

## 2. 预处理 `classify()`（classifier.cpp:17-59）

1. pattern 转灰度；
2. **等比缩放 + 左上角对齐 letterbox 进 32×32 黑底**：

```cpp
scale = min(32/w, 32/h);
resize(pattern, resized, {w*scale, h*scale});
resized.copyTo(input(Rect(0, 0, w*scale, h*scale)));   // 贴左上角，其余补 0
```

   ⚠️ 不是居中 letterbox——训练与推理必须保持同一对齐方式，否则分布漂移；
3. `cv::dnn::blobFromImage(input, 1/255.)` 归一化到 [0,1]，NCHW f32；
4. `net_.forward()` 得 9 维 logits。

## 3. 数值稳定 softmax + argmax（:47-58）

```cpp
float max = *std::max_element(outputs.begin<float>(), outputs.end<float>());
cv::exp(outputs - max, outputs);        // 减最大值防溢出
float sum = cv::sum(outputs)[0];
outputs /= sum;                          // softmax
cv::minMaxLoc(outputs, nullptr, &armor.confidence, nullptr, &label);
armor.name = (ArmorName)label_id;        // label 顺序 = ArmorName 枚举顺序
```

`armor.confidence` = softmax 最大概率，供 detector `check_name`（>0.8）过滤。

## 4. 与检测器的协作关系

```
Detector::detect(img)
   └─ 配对成 Armor 后:
        get_pattern(armor)          // 1.125 系数外推裁 32 附近的图案
        classifier_.classify(armor) // 填 name + confidence
        check_name(armor)           // 过滤 + 硬样本落盘 patterns/
```

YOLOV8 路径（只输出 2 类粗分类）也在后处理里对每个候选执行同样的 `get_pattern + classify`（yolov8.cpp:163-180），用小网络补出 9 类数字身份。

## 5. 设计要点小结

| 要点 | 说明 |
|---|---|
| 9 类输出 | one, two, three, four, five, sentry, outpost, base, not_armor |
| 输入对齐 | 左上角 letterbox，非居中 |
| 双后端 | cv::dnn 生产 / OpenVINO 预留 |
| 硬编码 9 | ovclassify 输出 reshape (1,9) 写死，改类别数要改代码 |
| 数据闭环 | 低置信度样本自动落盘，供下一轮训练 |

