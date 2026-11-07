---
category: "自瞄拆解 · 视觉"
title: "视觉 02 —— 传统装甲板检测器 Detector"
publishDate: "2026-11-08"
description: "对应源码：`tasks/auto_aim/detector.cpp` / `detector.hpp` 思路一句话：**灰度二值化 → 找轮廓 → 灯条几何筛选 → 两两配对 → 数字分类 → 去重**。 传统 Op…"
tags: ["RoboMaster", "自瞄", "视觉算法"]
---
> 对应源码：`tasks/auto_aim/detector.cpp` / `detector.hpp`
> 思路一句话：**灰度二值化 → 找轮廓 → 灯条几何筛选 → 两两配对 → 数字分类 → 去重**。

---

## 1. 参数表（构造读 yaml，detector.cpp:13-31）

| 参数 | 默认值 | 用途 |
|---|---|---|
| `threshold` | 150 | 灰度二值化阈值 |
| `max_angle_error` | 45° → 0.785 rad | 灯条竖直程度容差 |
| `min/max_lightbar_ratio` | 1.5 / 20 | 灯条长宽比范围 |
| `min_lightbar_length` | 8 px | 灯条长度下限 |
| `min/max_armor_ratio` | 1 / 5 | 装甲板宽高比范围 |
| `max_side_ratio` | 1.5 | 两灯条等长容差 |
| `max_rectangular_error` | 25° → 0.436 rad | 矩形度容差 |
| `min_confidence` | 0.8 | 数字分类置信度下限 |

## 2. 主流程 `detect(bgr_img, frame_count)`（detector.cpp:33-120）

```
① 灰度化 cvtColor(BGR2GRAY)                       :37
② 全局二值化 threshold(gray, 150, THRESH_BINARY)  :41
   —— 用灰度而非通道相减，红蓝白色灯条都亮，颜色靠 get_color 区分
③ findContours(RETR_EXTERNAL, CHAIN_APPROX_NONE)  :45
④ 每个轮廓 → minAreaRect → Lightbar
   → check_geometry(灯条三判据) → get_color        :52-57
⑤ 按 x 从左到右排序                                :63
⑥ 双重循环两两配对 → Armor，逐级过滤：              :67-84
     颜色一致
     check_geometry(Armor): ratio∈(1,5) 且 side_ratio<1.5 且 rectangular_error<25°
     get_pattern 裁图 + classifier_.classify 数字识别
     check_name: name≠not_armor 且 confidence>0.8
     get_type + check_type: 大小装甲与编号一致性
⑦ 共用灯条去重 remove_if(duplicated)               :87-115
⑧ debug 画图                                       :117
```

### 2.1 灯条几何判据 `check_geometry(Lightbar)`（:233-239）

```
angle_error < 45°（竖直）
min_lightbar_ratio < length/width < max_lightbar_ratio（细长）
length > 8 px（不是噪点）
```

### 2.2 颜色判定 `get_color`（:279-289）

遍历轮廓全部像素，累加 R 通道与 B 通道：`blue_sum > red_sum ? blue : red`。简单但对白色灯条中段有效，因为发光颜色覆盖整个轮廓。

### 2.3 共用灯条去重（:87-115）—— 两种情况

| 情况 | 判定 | 保留谁 |
|---|---|---|
| **重叠** | 同侧灯条相同（left==left 或 right==right） | pattern **面积小**的（裁得更贴合） |
| **相连** | 交叉共用（left==right，相邻两块装甲板） | **置信度大**的 |

## 3. 大小装甲判据 `get_type`（:311-338）

```
ratio > 3.0        → big
ratio < 2.5        → small
否则按 name：one/base → big，其余 → small
```

ratio 是"灯条中点连线长 / 灯条长"——大装甲（230mm）物理上更宽，阈值 2.5/3.0 区分。

## 4. 数字图案裁剪 `get_pattern`（:291-309）

把左右灯条沿 `top2bottom` 方向各向外延长，角点 = `lightbar.center ± 1.125·top2bottom`。系数来源（:294 注释）：

```
1.125 = 0.5 × armor_height / lightbar_length = 0.5 × 126mm / 56mm
```

即装甲板半高是灯条半长的 1.125 倍，由此外推装甲板四角，取包围矩形裁剪。56mm（灯条长）、126mm（装甲板高）与 solver.cpp:10 的 `LIGHTBAR_LENGTH=56e-3` 同源。

## 5. check_name 的"数据回流"（:249-261）

对"认识但置信度不够"（name_ok && !confidence_ok）的 pattern 自动 `save()` 到 `patterns/` 目录——**硬样本挖掘闭环**：现场跑一局，落盘的样本拿去补充训练下一轮分类器。

## 6. ROI 角点精修 `detect(Armor&, bgr_img)`（:122-231）

给神经网络路径用的"二次精修"（YOLOV5 融合模式的核心，被 yolov5.cpp:184 调用）：

1. 用 NN 4 关键点构造外扩四边形：灯条向量向上下各延长 1 倍、横向扩 0.75 倍（:130-141），`minAreaRect` 取包围框；
2. 越界检查（:147-151）；
3. 在 ROI 内重跑 灰度→二值→轮廓→灯条 流水线（:160-182）；
4. 找与原始 tl/bl/br/tr 关键点**欧氏距离和最小**的左右灯条（:190-209）；
5. 距离和 < 15 px 才接受，精修后的 4 角点（加 boundingBox 偏移回全图坐标）写回 `armor.points`（:223-226）。

设计意图：NN 关键点定位有 1~2px 抖动，传统灯条几何在同一 ROI 内可以给出亚像素级的稳定端点——**传统几何判据成为 NN 的后验校验**。

## 7. PCA 灯条角点回归（:386-489，参考 CSU-FYT，当前已停用）

主流程 :179 注释关闭，但代码完整、教学价值高：

- 参数：`MAX_BRIGHTNESS=25`（归一化最大亮度）、`ROI_SCALE=0.07`、搜索区间为灯条中部 40%~60%；
- 步骤：ROI 亮度归一化 → `cv::moments` 求质心 → 亮度>1e-3 的像素点云做 `cv::PCA`，第一主成分 = 灯条对称轴（统一 y 分量朝上）→ 沿轴逐像素找**亮度跳变最大点**（要求前一点亮度高于 ROI 均值），跳变点均值即端点。

## 8. 函数速查表

| 函数 | 位置 | 作用 |
|---|---|---|
| `Detector(config, debug)` | cpp:13-31 | 读 yaml（角度 /57.3），建 patterns 目录 |
| `detect(img, frame)` | cpp:33-120 | 主流水线 |
| `detect(Armor&, img)` | cpp:122-231 | NN 角点 ROI 精修 |
| `check_geometry(Lightbar/Armor)` | cpp:233-247 | 灯条/装甲板几何判据 |
| `check_name` | cpp:249-261 | 分类过滤 + 硬样本落盘 |
| `check_type` | cpp:263-277 | 大小装甲一致性过滤 |
| `get_color` | cpp:279-289 | R/B 通道判色 |
| `get_pattern` | cpp:291-309 | 1.125 系数外推裁图 |
| `get_type` | cpp:311-338 | 2.5/3.0 阈值判大小 |
| `lightbar_points_corrector` | cpp:386-489 | PCA 角点回归（停用） |

> 传统 OpenCV 原语的完整清单见 [../opencv/01-传统视觉算法.md](../opencv/01-传统视觉算法.md)。

