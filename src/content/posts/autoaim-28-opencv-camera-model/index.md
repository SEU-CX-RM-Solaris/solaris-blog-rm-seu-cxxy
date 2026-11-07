---
category: "自瞄拆解 · 学习笔记"
title: "学习笔记 05 —— OpenCV 核心与相机模型"
publishDate: "2026-11-08"
description: "目标：能独立写出灯条检测 demo；理解 PnP 在算什么。 环境：Windows 装 OpenCV（vcpkg 或官方预编译包），或直接在 Linux 用 `sudo apt install libopencv-d…"
tags: ["OpenCV", "相机模型"]
---
> 目标：能独立写出灯条检测 demo；理解 PnP 在算什么。
> 环境：Windows 装 OpenCV（vcpkg 或官方预编译包），或直接在 Linux 用 `sudo apt install libopencv-dev`。

---

## 1. Mat：OpenCV 的一切

```cpp
cv::Mat img = cv::imread("armor.jpg");      // 读图
// img 是一个矩阵：1440×1080×3 通道，元素类型 CV_8UC3（8bit 无符号 × 3通道）
cv::Vec3b px = img.at<cv::Vec3b>(y, x);     // 取像素：注意是 (y, x)！
uchar blue = px[0], green = px[1], red = px[2];   // ★ OpenCV 是 BGR 顺序，不是 RGB
```

新手三大坑：**(1) 坐标是 (y,x)**、**(2) 通道是 BGR**、**(3) at<T> 的 T 必须匹配类型**。

浅拷贝 vs 深拷贝：

```cpp
cv::Mat b = a;            // 浅拷贝：共享同一块像素内存！
cv::Mat c = a.clone();    // 深拷贝：独立内存
// 多线程传图必须 clone（mt_detector 的 img.clone() 就是这个原因）
```

## 2. 检测四件套（灯条 demo 的全部）

```cpp
// ① 灰度化：3 通道 → 1 通道
cv::cvtColor(img, gray, cv::COLOR_BGR2GRAY);

// ② 二值化：>150 变 255，其余 0 —— "把亮的东西抠出来"
cv::threshold(gray, binary, 150, 255, cv::THRESH_BINARY);

// ③ 找轮廓：把连通的白色像素圈成一条条闭合曲线
std::vector<std::vector<cv::Point>> contours;
cv::findContours(binary, contours, cv::RETR_EXTERNAL, cv::CHAIN_APPROX_NONE);
//   RETR_EXTERNAL: 只要最外层轮廓；CHAIN_APPROX_NONE: 保留所有点（拟合更准）

// ④ 旋转矩形：任一点集的最小面积外接矩形（可以是斜的！）
cv::RotatedRect rect = cv::minAreaRect(contours[i]);
//   rect.center（中心）、rect.size（长宽）、rect.angle（角度）
```

### 从 RotatedRect 到灯条端点（项目的做法，armor.cpp:14-20）

`minAreaRect` 不直接给"上端点/下端点"。项目做法：

```cpp
// 取 4 个角点 → 按 y 排序 → 上 2 个的均值 = top，下 2 个的均值 = bottom
std::vector<cv::Point2f> pts(4);
rect.points(pts.data());
std::sort(pts.begin(), pts.end(), [](auto &a, auto &b){ return a.y < b.y; });
top    = (pts[0] + pts[1]) / 2;
bottom = (pts[2] + pts[3]) / 2;
```

比直接用矩形角点稳：灯条微斜时，"上下两点的均值"抵抗矩形旋转。

### 几何判据（把"像灯条"写成数字条件）

```
angle_error = |atan2(bottom−top) − π/2|  < 45°     // 够竖直
length / width ∈ (1.5, 20)                          // 够细长
length > 8 px                                       // 不是噪点
两灯条: ratio ∈ (1,5), side_ratio < 1.5, 矩形度误差 < 25°
```

颜色判定（detector.cpp:279-289）：遍历轮廓内像素累加 R 通道和 B 通道，谁大就是谁——发光灯条整条都是单色，所以这么粗暴有效。

**动手任务就是这节**：拿装甲板照片跑通这四步 + 判据 + 画框。

## 3. 相机模型：像素怎么变成米

### 3.1 针孔模型

```
        ┌─────┐
  P(X,Y,Z) │相机│ → 成像平面
  ────────►│    │────► p(u, v)
        └─────┘

u = fx·X/Z + cx
v = fy·Y/Z + cy
```

- **fx, fy**：焦距（像素单位）——Z 相同时，fx 越大物体成像越大；
- **cx, cy**：主点——光轴穿过图像的位置（≈图像中心，但标定后不一定正好）；
- **Z（深度）是分母**：同一像素误差，距离越远位置误差越大——这就是为什么远处 PnP 不准、为什么 EKF 要给距离观测更大的噪声。

内参矩阵：

```
K = ⎡fx  0  cx⎤
    ⎢ 0 fy  cy⎥
    ⎣ 0  0   1⎦
```

### 3.2 畸变

真实镜头不是理想针孔：桶形/枕形弯曲（径向 k1,k2,k3）+ 长方形歪斜（切向 p1,p2）。标定求出 5 个系数，`cv::undistort` 或在 solvePnP 内部补偿。项目值：`[-0.0838, 0.0974, -0.00126, 0.00374, 0]`（6mm 镜头畸变不大，k3=0）。

## 4. PnP：4 个对应点 → 6DoF 位姿

**问题**：已知 3D 点在物体坐标系的位置 + 它们在图像的像素位置 + 相机内参 → 求物体相对相机的旋转 R 和平移 t。

```cpp
cv::solvePnP(object_points,     // 4 个 3D 点：官方尺寸（灯条 56mm、大装甲 230mm 宽…）
             image_points,      // 检测出的 4 个像素角点 tl, tr, br, bl
             camera_matrix, dist_coeffs,
             rvec, tvec,
             false,
             cv::SOLVEPNP_IPPE); // ★ 平面目标专用解析解
cv::Rodrigues(rvec, R);          // 旋转向量 ↔ 3×3 矩阵
```

- 为什么 4 个点够？共面 4 点（非共线）恰好约束 6DoF 位姿；
- **IPPE**：专为"共面点"设计的快速解法，内部给出两个候选解按重投影误差取优；
- **tvec 单位 = 你 3D 点的单位**（项目用米）——所以官方尺寸（毫米）必须换算成米（56e-3）。

### 3D 点的坐标系约定（solver.cpp:12-25）

```
装甲板坐标系：x = 法向(朝外), y = 右, z = 上
→ 解出的 R 第一列方向 = 装甲板朝向
```

### 重投影：验证一切的尺子

```cpp
std::vector<cv::Point2f> reproj;
cv::projectPoints(object_points, rvec, tvec, K, dist, reproj);
error = Σ |reproj[i] − image_points[i]|;      // 把 3D 点按估计位姿投回图像，比差
```

项目的 **yaw 优化**就是它驱动的：IPPE 的 yaw 噪声大 → 用"±15° 俯仰先验 + 1° 网格搜索重投影误差最小"的 yaw 覆盖它（solver.cpp:196-218）。

## 5. 标定：内参从哪来

```
打印棋盘格(项目: 10×7 内角点, 40mm 间距)
→ 从不同角度拍 15~30 张 → cv::findChessboardCorners 找角点
→ cv::calibrateCamera 输出 K + 畸变 + 每张图的重投影误差
→ 手眼标定（相机装云台上）：解 R_camera2gimbal, t_camera2gimbal
```

重投影误差 <0.3px 算很好，项目 0.1322px。外参的意义见 [视觉/06](/posts/autoaim-06-solver-yaw)。

## 6. letterbox：给神经网络喂图的统一姿势

神经网络输入固定 640×640，原图 1440×1080 比例不同。直接拉伸会变形 → 用等比缩放 + 补边：

```
项目用"左上角变体"（yolo11.cpp:77-87）：
scale = min(640/1080高, 640/1440宽)
缩放后贴在 640×640 黑画布左上角，右/下补 0
坐标还原只需除以 scale（不需要减 pad 偏移——这是选左上角而不是居中的原因）
```

## 7. cv::dnn：不装深度学习框架也能跑模型

```cpp
cv::dnn::Net net = cv::dnn::readNetFromONNX("tiny_resnet.onnx");
cv::Mat blob = cv::dnn::blobFromImage(input, 1/255.0);
//             → 变成 NCHW float blob（N批量 C通道 H高 W宽）
net.setInput(blob);
cv::Mat out = net.forward();       // 1×9 → softmax → 类别
```

项目用它跑数字分类小网络；大模型走 OpenVINO（见 [06](/posts/autoaim-29-nn-yolo-deploy)）。

## 8. NMS：非极大值抑制

检测器对同一个目标常输出一堆重叠框。NMS 规则：

```
按置信度排序 → 保留最高分框 → 删掉与它 IoU(交并比) > 0.3 的框 → 重复
cv::dnn::NMSBoxes(boxes, confidences, 0.7, 0.3, indices);
```

## 过关自测

1. `img.at<cv::Vec3b>(100, 200)` 取的是第几行第几列？
2. 灯条 ratio = length/width，为什么真灯条这个值大？
3. fx=1777 表示什么？目标从 2m 移到 4m，它在图上的大小怎么变？
4. PnP 输入的 3D 点用毫米和用米，输出的 tvec 有什么区别？
5. 重投影误差是什么？它在项目里被用来做哪三件事？

