---
category: "自瞄拆解 · YOLO"
title: "YOLO 01 —— 模块架构与接口设计"
publishDate: "2026-11-08"
description: "对应源码：`tasks/auto_aim/yolo.cpp` / `yolo.hpp`、`yolos/`、`tasks/auto_aim/armor.cpp` 设计模式：**YOLOBase 抽象接口 + YOLO…"
tags: ["YOLO", "自瞄"]
---
> 对应源码：`tasks/auto_aim/yolo.cpp` / `yolo.hpp`、`yolos/`、`tasks/auto_aim/armor.cpp`
> 设计模式：**YOLOBase 抽象接口 + YOLO 门面工厂 + 策略切换**。

---

## 1. 接口（yolo.hpp:10-17）

```cpp
class YOLOBase {
public:
  // 端到端：内部完成预处理、推理、后处理
  virtual std::list<Armor> detect(const cv::Mat & img, int frame_count) = 0;
  // 只做后处理：专为多线程流水线准备（推理已由 mt_detector 异步完成）
  virtual std::list<Armor> postprocess(
    double scale, cv::Mat & output, const cv::Mat & bgr_img, int frame_count) = 0;
};
```

两个虚函数对应两种使用形态：`detect()` 给单线程主循环；`postprocess()` 给异步推理（`MultiThreadDetector` 用 `start_async()` 完成推理后，把输出张量包成 cv::Mat 传进来，见 mt_detector.cpp:65-80）。

## 2. 门面工厂（yolo.cpp:11-31）

```cpp
class YOLO {  // 持有 unique_ptr<YOLOBase>
  读 yaml["yolo_name"]:
    "yolov8"  → YOLOV8(config_path, debug)
    "yolo11"  → YOLO11(config_path, debug)
    "yolov5"  → YOLOV5(config_path, debug)
    其它      → throw
};
```

切换模型 = 改一行 yaml（`yolo_name: yolov5`），主程序零改动。

## 3. 与传统检测的三种关系（重点）

| 形态 | 入口 | 说明 |
|---|---|---|
| 纯传统 | `Detector::detect(img)` | 灰度→二值→轮廓→灯条→配对→Classifier（tests 单独用） |
| 纯 NN | `YOLO.detect(img)` | standard.cpp:44,73 主循环直接用 |
| **NN 主检测 + 传统二次矫正** | YOLOV5 + `use_traditional: true` | yolov5.cpp:184：`detector_.detect(*it, bgr_img)` 对 NN 4 关键点做 ROI 灯条精修 |

融合模式的原理：`Detector::detect(Armor&, img)`（detector.cpp:122-231）由 NN 关键点外扩 0.75/1.125 倍构造 ROI，在 ROI 内重新找灯条，取与原关键点距离最近的左右灯条顶/底点替换 `armor.points`，**距离和 <15px 才接受**——传统几何判据成为 NN 的后验校验。

三个 YOLO 类都内嵌 `Detector detector_(config_path, false)`，但只有 YOLOV5 走融合路径。

## 4. 检出后的 Armor 填充路径

```
NN 输出 class_id（+关键点+置信度）
  → armor_properties[class_id] 查表得 (Color, ArmorName, ArmorType)   armor.cpp:118-127
  → 关键点/框 → points[4]、center、ratio 等几何量（NN 版构造函数重算）
  → check_name（name≠not_armor 且 confidence>min_confidence 0.8）
  → check_type（大小装甲与编号一致性）
  →（YOLOV5 融合）传统 ROI 精修 points
```

## 5. 检测结果的下游

```
list<Armor> ──► Tracker.track()     EKF 跟踪（对每块板 Solver.solve）
            └► omniperception::Decider::decide(yolo, ...)
               复用同一个 YOLO 对象对 USB 相机/后相机做全向感知检测
               （decider.cpp:28-44,72-77）——一个模型两处推理
```

## 6. 参数（yaml）

```yaml
yolo_name: yolov5                # 模型选择
classify_model: assets/tiny_resnet.onnx
yolo11_model_path: assets/yolo11.xml     # OpenVINO IR
yolov8_model_path:  assets/yolov8.xml
yolov5_model_path:  assets/yolov5.xml
device: GPU                      # OpenVINO 设备（iGPU）
use_traditional: true            # YOLOV5 融合开关
use_roi: false                   # ROI 裁剪（x/y/w/h，-1=该维不裁）
min_confidence: 0.8
```

模型文件全部是 **OpenVINO IR（.xml+.bin）**，不是 onnx；唯一 onnx 的是数字分类器。

## 7. 三个实现类的速览（详见下一篇）

| 类 | 输入 | 输出 shape | 类别方案 |
|---|---|---|---|
| YOLO11 | 640×640 | [1,50,8400] | 38 类联合（颜色×数字×大小） |
| YOLOV8 | 416×416 | [1,14,8400] | 2 类粗分 + 外接 tiny_resnet 补数字 |
| YOLOV5 | 640×640 | [1,8400,22] | objectness + 颜色 4 类 + 数字 9 类双头 |

