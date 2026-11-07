---
category: "自瞄拆解 · YOLO"
title: "YOLO 03 —— OpenVINO 部署与异步多线程推理"
publishDate: "2026-11-08"
description: "对应源码：`yolos/yolo11.cpp`（同构代表）、`tasks/auto_aim/multithread/mt_detector.cpp` 版本：OpenVINO 2024.6，硬编码安装路径 `/opt/…"
tags: ["OpenVINO", "YOLO", "部署"]
---
> 对应源码：`yolos/yolo11.cpp`（同构代表）、`tasks/auto_aim/multithread/mt_detector.cpp`
> 版本：OpenVINO 2024.6，硬编码安装路径 `/opt/intel/openvino_2024.6.0/runtime/cmake/`（根 CMakeLists.txt:15）。

---

## 1. 模型加载与编译（yolo11.cpp:33-53）

```cpp
auto model = core_.read_model(model_path_);              // OpenVINO IR: .xml+.bin
ov::preprocess::PrePostProcessor ppp(model);
auto & input = ppp.input();
input.tensor()
  .set_element_type(ov::element::u8)     // 输入给 u8，省拷贝
  .set_shape({1, 640, 640, 3})           // NHWC
  .set_layout("NHWC")
  .set_color_format(BGR);
input.model().set_layout("NCHW");        // 模型内部 NCHW
input.preprocess()
  .convert_element_type(f32)             // u8→f32
  .convert_color(RGB)                    // BGR→RGB
  .scale(255.0);                         // 归一化 [0,1]
model = ppp.build();
compiled_model_ = core_.compile_model(model, device_,
  ov::hint::performance_mode(LATENCY));
```

**核心技巧：预处理全部下沉到 PrePostProcessor**（u8 NHWC BGR → f32 NCHW RGB /255），CPU 侧零预处理代码，其余交给 GPU 算子融合。

- `device_` 来自 yaml（`device: GPU` = NUC 的 iGPU）；LATENCY 模式给单帧管线，THROUGHPUT 给异步流水线；
- 归一化不用 ImageNet 均值方差，仅 /255。

## 2. CPU 侧唯一的预处理：伪 letterbox（yolo11.cpp:77-87）

```cpp
scale = min(640/rows, 640/cols);
h = rows·scale;  w = cols·scale;
cv::Mat input(640, 640, CV_8UC3, Scalar(0,0,0));   // 黑底画布
cv::resize(bgr_img, input(Rect(0,0,w,h)), {w,h});  // 贴左上角
ov::Tensor input_tensor(u8, {1,640,640,3}, input.data);
```

**letterbox 的左上角变体**：等比缩放、右/下补零、不做 114 灰边、不记录 pad 偏移——坐标还原只需 `/scale`，无需减 pad。（注意变量命名反向：`x_scale` 用 rows 算。）

## 3. 同步推理（yolo11.cpp:90-97）

```cpp
auto infer_request = compiled_model_.create_infer_request();  // 每帧新建
infer_request.set_input_tensor(input_tensor);
infer_request.infer();                                        // 同步阻塞
auto output_tensor = infer_request.get_output_tensor();
cv::Mat output(shape[1], shape[2], CV_32F, output_tensor.data());  // 零拷贝包装
```

## 4. 异步多线程变体 MultiThreadDetector（mt_detector.cpp）

### 4.1 结构

```
detect_thread:  camera.read → push(img, t)
                  └─ resize 640 → create_infer_request → start_async()
                     → {img.clone(), t, request} 压入容量 16 的 ThreadSafeQueue
主线程:         debug_pop() → request.wait() → yolo_.postprocess(scale, output, img)
```

### 4.2 与同步版的差异

| | 同步（YOLO11.detect） | 异步（MultiThreadDetector） |
|---|---|---|
| 编译 hint | LATENCY | **THROUGHPUT**（mt_detector.cpp:37-38） |
| infer_request | 每帧新建 | push 时创建，随队列传递 |
| 推理时机 | 阻塞等完 | 与取图/后处理重叠 |
| 后处理入口 | 类内完成 | `postprocess()` 接口（YOLOBase 的存在意义） |
| 兼容 | 全部 | "暂时不支持 yolov8"（mt_detector.hpp:25，v5 后处理无共享状态依赖） |
| 队列满 | — | 打日志丢帧（容量 16，mt_detector.hpp:35-37） |

## 5. 模型资产清单（assets/）

| 文件 | 用途 | 输入 | 输出 |
|---|---|---|---|
| yolo11.xml/.bin | 装甲板 38 类 | u8 640² NHWC | [1,50,8400] |
| yolov8.xml/.bin | 装甲板 2 类+关键点 | u8 416² | [1,14,8400] |
| yolov5.xml/.bin | 装甲板双头（当前主用） | u8 640² | [1,8400,22] |
| yolo11_buff_int8.xml/.bin | 能量机关（int8，CPU） | 1×3×640×640 | [17,8400] |
| tiny_resnet.onnx | 数字分类（cv::dnn 读） | 1×1×32×32 | 1×9 |

装甲板模型全是 **IR 格式**；onnx 只有数字分类器。

## 6. GPU 环境搭建（readme 第 6 节）

NUC iGPU 跑 OpenVINO 需要装 Intel compute-runtime 全家桶（IGC + level-zero + opencl-icd + libigdgmm，deb 包 wget+dpkg）。⚠️ 使用 GPU async-infer 时最高显示分辨率限制 1920×1080@24Hz。

## 7. 性能账

- 相机 150fps 目标帧率（hikrobot 硬编码），主循环实际 ~100fps（readme：24 版 C++ 重写后）；
- 瓶颈排序：检测推理（GPU 10ms 级）> PnP+EKF（µs~ms 级）> 通信（µs 级）——所以优化焦点是推理流水线化（mt_detector 把"等推理"从主循环剥走）与丢帧策略（永远处理最新帧）。

