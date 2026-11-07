---
category: "自瞄拆解 · YOLO"
title: "YOLO 02 —— 三个模型的后处理对比（yolov5 / yolov8 / yolo11）"
publishDate: "2026-11-08"
description: "对应源码：`tasks/auto_aim/yolos/yolov5.cpp`、`yolov8.cpp`、`yolo11.cpp` 三个类推理流程完全同构（OpenVINO），**差异全部在后处理**。"
tags: ["YOLO", "后处理"]
---
> 对应源码：`tasks/auto_aim/yolos/yolov5.cpp`、`yolov8.cpp`、`yolo11.cpp`
> 三个类推理流程完全同构（OpenVINO），**差异全部在后处理**。

---

## 1. 总览表

| | YOLO11 | YOLOV8 | YOLOV5 |
|---|---|---|---|
| 输入 | u8 1×640×640×3 NHWC-BGR | u8 1×416×416×3 | u8 1×640×640×3 |
| 输出 shape | [1, 50, 8400] | [1, 14, 8400] | [1, 8400, 22] |
| 是否 transpose | ✅（:105） | ✅（:110） | ❌（行即候选） |
| bbox | xywh 4 列 | xywh 4 列 | **无**（4 关键点外接） |
| 类别 | 38 类（:4-42） | 2 类（:4-6） | 颜色 4 类 + 数字 9 类 |
| objectness | 无（v8 风格直出类分） | 无 | **有，需 sigmoid**（:8 列） |
| 关键点 | 4 点×2 列（:43-49） | 4 点×2 列（:6-14） | 前 8 列 |
| 数字来源 | NN 直接输出 | 外接 tiny_resnet 分类器 | NN 双头 one-hot |
| 预处理 | 同一 PrePostProcessor 下沉 | 同左 | 同左 |

## 2. 类别方案对比（本质是三种标注策略）

| 模型 | 方案 | 取舍 |
|---|---|---|
| yolov5 | obj + 颜色 one-hot + 数字 one-hot（双头） | 颜色/数字解耦学习，样本利用率高 |
| yolov8 | 2 类（≈blue/red 装甲板），**数字不可信** | 标注最省，数字交给 32×32 小网络补 |
| yolo11 | 38 类 = 颜色×数字×大小 联合 | 一次推理全出，无第二级网络 |

**38 类构成**（armor.hpp:52-64）：

| 组成 | 数量 |
|---|---|
| sentry/one/two/three/four/five/outpost × {blue,red,extinguish}（小） | 21 |
| base × {blue,red,extinguish,purple}（大）+ base × 同 4 色（小） | 8 |
| three/four/five × {blue,red,extinguish}（**大装甲，25 赛季平衡车**） | 9 |

`Armor` 的 NN 构造函数查表：`auto [color, name, type] = armor_properties[class_id]`（armor.cpp:118-127）。

## 3. 逐行后处理细节

### 3.1 YOLO11（yolo11.cpp:102-176）

```
output 包成 Mat(50, 8400) → cv::transpose → 8400 行
每行: [0-3] xywh(640尺度) | [4-42] 38类分 | [43-49] 4关键点×(x,y)
minMaxLoc 取最大类分，score < 0.7 跳过
坐标还原: left = (x − 0.5w)/scale …（无 pad 偏移，letterbox 贴左上）
关键点同 /scale
```

⚠️ **没有 DFL 解码**——说明 IR 导出时 head 已含 DFL 积分（或按 v8 风格导出为解码后输出），工程上拿到的直接是 xywh。

NMS 之后 `sort_keypoints()`（:209-235）：按 y 排序分上下两半、再各按 x 排序，固定为 [TL,TR,BR,BL]——**pose 模型输出的关键点顺序不保证**，必须重排。随后 check_name/check_type 过滤。

### 3.2 YOLOV8（yolov8.cpp:106-185）

```
输出 [1,14,8400]: xywh(4) + 2类分(4-6) + 4关键点(6-14)
2 类 id 直接 armor_properties[class_id]（class 0→blue sentry small，1→red sentry small）
★ 数字名不可信 → 每个候选:
    pattern = get_pattern(bgr_img, *it)   // 关键点延长灯条 1.125 倍裁图
    classifier_.classify(*it)             // tiny_resnet 9 分类补数字
    type = get_type(*it)                  // 英雄/基地=big，工程/哨兵/前哨=small
```

`get_pattern`（:236-267）：`1.125 = 0.5×126mm/56mm`，边界检查失败返回空 Mat。

### 3.3 YOLOV5（yolov5.cpp:102-157）

差异最大：

```cpp
// 不 transpose，直接逐行遍历
double score = output.at<float>(r, 8);
score = sigmoid(score);                        // 数值稳定写法（:254-260）
if (score < score_threshold_) continue;
color_scores   = output.row(r).colRange(9, 13);    // 颜色 4 类
classes_scores = output.row(r).colRange(13, 22);   // 数字 9 类
minMaxLoc 两次 → color_id, num_id
```

- **无 bbox**：框由 4 关键点 min/max 外接矩形构造（:138-150）；
- 关键点组装顺序特殊 `(0,1),(6,7),(4,5),(2,3)`——模型导出约定 LT/RT/RB/LB，代码重排；**不调 sort_keypoints**（信任导出约定）；
- 独有 `use_traditional_` 传统角点二次矫正（:183-184）。

## 4. 共性

- 置信度阈值 **0.7**、NMS IoU **0.3** 均硬编码 const（各 .hpp:32-33）；`min_confidence` 0.8 来自 yaml；
- NMS 一律 **`cv::dnn::NMSBoxes`**（不是自写、不是 OpenVINO NMS 节点）；
- NMS 之后才做 name/type 过滤、`center_norm = center/(w,h)`、debug 绘制；
- ROI 裁剪：`bgr_img = raw_img(roi_)`，`offset_=(x,y)` 构造 Armor 时加回全局坐标（yolo11.cpp:151-155）。

## 5. 颜色 id 的坑（重复强调）

`Color{red=0, blue=1}`（armor.hpp:11）与 YOLOV5 构造 `color_id==0 → blue`（armor.cpp:175）**顺序相反**；YOLOV5 的 num_id 映射也绕开了 one~five 与 sentry 编号冲突（`num_id==0→sentry, num_id>5→ArmorName(num_id), 否则 ArmorName(num_id−1)`，armor.cpp:176-178）。

## 6. 能量机关 YOLO（auto_buff/yolo11_buff.cpp，附带）

- `class_names = {"buff", "r"}`，6 关键点，int8 量化模型硬编码 **CPU** 推理；
- `get_onecandidatebox`：真 warpAffine letterbox，输出 [17,8400] 逐列找全局最大分列；
- ⚠️ `get_multicandidateboxes` 存在**疑似遗留 bug**：函数内新建局部 input_tensor 遮蔽成员但从未 `set_input_tensor()`，实际推理用的是从未填充数据的成员张量；且关键点切片越界。部署前需修复或绕开该路径。

