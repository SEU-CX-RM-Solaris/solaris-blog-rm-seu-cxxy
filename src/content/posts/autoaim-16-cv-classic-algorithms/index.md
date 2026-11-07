---
category: "自瞄拆解 · OpenCV"
title: "OpenCV 01 —— 传统视觉算法拆解（不依赖神经网络的检测链）"
publishDate: "2026-11-08"
description: "本篇从 **OpenCV 原语**的视角重看传统装甲板检测与能量机关识别——每一步用了什么 cv:: 函数、为什么这么用。 业务逻辑详见 [../视觉/02-传统检测器detector.md](../视觉/02-传统…"
tags: ["OpenCV", "视觉算法"]
---
> 本篇从 **OpenCV 原语**的视角重看传统装甲板检测与能量机关识别——每一步用了什么 cv:: 函数、为什么这么用。
> 业务逻辑详见 [../视觉/02-传统检测器detector.md](/posts/autoaim-02-traditional-detector)。

---

## 1. 装甲板检测：一条 5 原语流水线（tasks/auto_aim/detector.cpp）

```
① cv::cvtColor(BGR2GRAY)            :37     灰度化
② cv::threshold(gray, 150, BINARY)  :41     全局二值化
③ cv::findContours(EXTERNAL, NONE)  :45     轮廓提取
④ cv::minAreaRect(contour)          :52     轮廓 → 旋转矩形（灯条）
⑤ 几何判据（纯数学，无 cv）                  ratio / side_ratio / rectangular_error
```

**关键取舍**：

- 二值化用**灰度**而非红蓝通道相减：红蓝白色灯条中段都亮，一把阈值全提出来，颜色交给后续 `get_color`（`at<cv::Vec3b>` 逐像素累加 R/B 通道，:279-289）区分；
- `RETR_EXTERNAL` 只要外轮廓，`CHAIN_APPROX_NONE` 保留全部点（minAreaRect 精度需要）；
- `minAreaRect` 的 4 角点按 y 排序取上两均值/下两均值得到灯条端点（Lightbar 构造，armor.cpp:14-20）——比直接用矩形角点更抗倾斜。

## 2. 数字图案裁剪：纯几何外推（detector.cpp:291-309）

```cpp
角点 = lightbar.center ± 1.125 · top2bottom
// 1.125 = 0.5 × 126mm(装甲板高) / 56mm(灯条长)
```

裁出 pattern 后交给小网络分类。**这里没有任何 cv 函数**，靠官方尺寸比例外推——说明传统方案里"知道物理尺寸"比"知道像素"更重要。

## 3. ROI 二次精修（:122-231）

NN 路径回来精修角点时复用同一套原语：

```
NN 4 关键点 → 外扩(灯条向量×1, 横向×0.75) → minAreaRect → boundingRect() 取 ROI
→ ROI 内重跑 ①~④ → cv::norm 算与原关键点的欧氏距离 → <15px 接受
```

`boundingRect()`（RotatedRect 成员）与 `cv::norm` 是这里唯二的新原语。

## 4. PCA 灯条矫正（:386-489，停用但值得学）

```
cv::mean + cv::normalize(NORM_MINMAX)   ROI 亮度归一化
cv::moments                             求质心
cv::PCA(点云, 无均值矩阵, DATA_AS_ROW)   第一主成分 = 灯条对称轴
沿轴逐像素扫描                            找亮度跳变最大点 → 端点
```

思路：把灯条看作 2D 点云，主成分方向即其长轴——比"外接矩形长边方向"更稳（斜灯条时矩形会失真）。

## 5. 能量机关识别（tasks/auto_buff/buff_detector.cpp，传统路线）

在标准检测原语之外，多了**形态学**（全 tasks 唯一一处）：

```
cv::threshold          通道偏置后二值化（blue −120 / red −100 偏置，yaml 可调）
cv::dilate + cv::getStructuringElement(MORPH_RECT, size)   膨胀连接断开的扇叶
cv::findContours       提取中心 R 标 / 扇叶头 / 扇叶体三类轮廓
cv::minAreaRect        几何筛选（面积上下限见 yaml buff_detector 段）
```

## 6. 颜色与图像 IO 杂项

| 函数 | 位置 | 用途 |
|---|---|---|
| cv::resize | detector.cpp:379 等 | debug 显示缩半 |
| cv::imshow / waitKey | 各 debug 分支 | 调试窗 |
| cv::imwrite | detector.cpp:351 | 硬样本落盘 patterns/ |
| cv::Mat(640,640,BLACK) + resize 到 ROI | yolos/*.cpp | letterbox 画布 |

## 7. 一张表总结：传统方案的 cv 原语消耗

| 原语 | 次数(tasks) | 场景 |
|---|---|---|
| threshold | 3 | 装甲板×2 + buff |
| findContours | 3 | 同上 |
| minAreaRect | 4 | 灯条 + ROI 框 + buff |
| cvtColor | 5 | 灰度×4 + Bayer 去马赛克(相机驱动) |
| dilate/getStructuringElement | 1 | buff 形态学 |
| PCA / moments / mean / normalize | 各 1 | 灯条矫正（停用） |

结论：传统方案的全部感知能力建立在 **阈值 + 轮廓 + 旋转矩形** 三件套上，计算量极小（这也是它能在 640×640 ROI 内实时精修角点的原因），难点全在**几何判据的设计与调参**。

