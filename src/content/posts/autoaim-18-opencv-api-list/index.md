---
category: "自瞄拆解 · OpenCV"
title: "OpenCV 03 —— cv:: API 使用清单（按文件分组）"
publishDate: "2026-11-08"
description: "全仓库 `cv::` 调用普查结果。想找\"某功能用了哪个函数\"直接查表。"
tags: ["OpenCV", "API"]
---
> 全仓库 `cv::` 调用普查结果。想找"某功能用了哪个函数"直接查表。

---

## 1. tasks/auto_aim/detector.cpp（传统灯条检测）

| 函数/常量 | 用途 |
|---|---|
| `cv::cvtColor` / `COLOR_BGR2GRAY` ×2 | 全图与 ROI 灰度化（:37, :161） |
| `cv::threshold` / `THRESH_BINARY` ×2 | 二值化，阈值 yaml 150（:41, :164） |
| `cv::findContours` / `RETR_EXTERNAL` / `CHAIN_APPROX_NONE` ×2 | 灯条轮廓（:46, :168） |
| `cv::minAreaRect` ×3 | 灯条旋转矩形（:52, :173）、关键点外扩框（:144） |
| `RotatedRect::boundingRect()` ×2 | ROI 裁剪（:145, :395） |
| `cv::norm` ×5 | 关键点-灯条距离（:196-204）、轴向归一 |
| `cv::resize` ×2 | debug 缩半 |
| `cv::imshow` ×5 | binary/detection 调试窗 |
| `cv::imwrite` ×1 | 硬样本落盘 |
| `cv::mean` ×1 / `cv::normalize(NORM_MINMAX)` ×1 | ROI 亮度归一（PCA 矫正） |
| `cv::moments` ×1 | 质心 |
| `cv::PCA` ×2 | 灯条对称轴（:427-428，停用） |
| `at<cv::Vec3b>` 逐像素 | get_color 判敌我（:279-289） |
| 类型 | Mat / Point2f / Point / Rect / Vec3b / Point2i / Moments |

## 2. tasks/auto_aim/classifier.cpp（数字分类）

| 函数 | 用途 |
|---|---|
| `cv::dnn::readNetFromONNX` | 读 tiny_resnet.onnx（:11） |
| `cv::dnn::blobFromImage(img, 1/255.)` | 32×32 → NCHW f32 blob（:41） |
| `net_.setInput / forward` | cv::dnn 推理（:43-44） |
| `cv::cvtColor(BGR2GRAY)` ×2 | 图案灰度化 |
| `cv::resize` ×2 | 32×32 缩放 |
| `cv::exp` ×2 / `cv::sum` ×2 | 手写 softmax |
| `cv::minMaxLoc` ×2 | argmax |
| `convertTo(CV_32F, 1/255.)` | OpenVINO 分支归一化（:87） |

## 3. tasks/auto_aim/solver.cpp（PnP）

| 函数 | 用途 |
|---|---|
| `cv::solvePnP` / `SOLVEPNP_IPPE` ×2 | 主解算 + 前哨站俯仰检验（:60-63, :135-138） |
| `cv::Rodrigues` ×4 | rvec ↔ R（:71, :119, :146, :183） |
| `cv::projectPoints` ×3 | 重投影误差 / debug（:125 等） |
| `cv::eigen2cv` ×6 / `cv::cv2eigen` ×4 | Eigen ↔ cv 矩阵互转 |
| `cv::Point3f` | 3D 装甲板点集定义（:16-21） |

## 4. tasks/auto_aim/yolos/*（NN 前后处理）

| 函数 | 用途 |
|---|---|
| `cv::resize` 到 640/416 + ROI 贴左上 | 预处理 letterbox（yolo11.cpp:77-87 等） |
| `cv::transpose` ×2 | yolo11/yolov8 输出 [C,N]→[N,C]（yolov5 不转） |
| `cv::minMaxLoc` | 类分数 argmax |
| `cv::dnn::NMSBoxes` ×3 | 非极大值抑制（IoU 0.3） |
| `cv::Mat output(shape, CV_32F, tensor.data())` | 推理输出零拷贝包装 |
| `cv::imshow("detection")` | debug |

## 5. tasks/auto_buff/buff_detector.cpp（能量机关）

`threshold`、`findContours`、`minAreaRect`、**`cv::dilate` + `cv::getStructuringElement(MORPH_RECT)`**（全 tasks 唯一形态学）、`cvtColor`、`norm`、`imshow`。

## 6. tasks/auto_buff/yolo11_buff.cpp（符 YOLO）

`cv::warpAffine`（`cv::Matx23f{scale,0,0, 0,scale,0}` letterbox，:241-278）——全 tasks 唯一仿射；HWC→CHW 三重循环手工填充 f32（BGR→RGB，/255）。

## 7. src/（主程序层，只有 IO 无算法）

`cv::CommandLineParser` ×13（每 main 的 config 参数）、`cv::Mat`、`cv::waitKey/imshow/resize` 各 ×6、`cv::Point2f` ×8。

## 8. 全 tasks 汇总 Top（排除 yolos）

| 原语 | 次数 | | 原语 | 次数 |
|---|---|---|---|---|
| cv::Point2f | 89 | | cv::Rodrigues | 6 |
| cv::Mat | 84 | | cv::projectPoints | 5 |
| cv::norm | 33 | | cv::cvtColor | 5 |
| cv::Point3f | 28 | | cv::resize | 5 |
| cv::Rect | 16 | | cv::minAreaRect | 4 |
| cv::eigen2cv | 9 | | cv::solvePnP | 3 |
| cv::Vec3d | 9 | | cv::threshold / findContours | 3 |
| cv::imshow | 9 | | cv::PCA | 2 |

## 9. 观察结论

1. **算法层 cv 用得很克制**：矩阵/几何运算全用 Eigen（eigen2cv 只在 PnP 边界出现），cv 只负责图像 IO 与少数固有算法（PnP/NMS/轮廓）；
2. **没有用**：光流、模板匹配、背景建模、SIFT/ORB 等特征法——装甲板检测这个任务里几何判据 > 特征匹配；
3. **版本兼容面很小**：只依赖 imgproc + dnn 两个模块 + NMSBoxes，换版本移植成本低。

